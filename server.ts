import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { GoogleGenAI, Modality, ThinkingLevel, Type } from '@google/genai';
import type { FunctionDeclaration, LiveServerMessage } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const MODEL_ID = 'gemini-4-hydrogen';

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured. Please check Settings > Secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function getLiveAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured. Please check Settings > Secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function handleApiError(res: Response, err: unknown) {
  const message = err instanceof Error ? err.message : 'Unexpected server error';
  const statusMatch = message.match(/\b(400|401|403|404|429|500|503)\b/);
  const statusCode = statusMatch ? Number(statusMatch[1]) : 500;
  res.status(statusCode).json({ error: message });
}

async function generateWithRetry(
  ai: GoogleGenAI,
  params: Parameters<GoogleGenAI['models']['generateContent']>[0],
  maxAttempts = 4
) {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = /\b(429|503|502|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(msg);
      if (!isTransient || attempt === maxAttempts) {
        throw err;
      }
      const delayMs = 1000 * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

const app = express();
app.use(express.json({ limit: '4mb' }));

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, model: MODEL_ID, liveModel: LIVE_MODEL_ID });
});

// 1. General Tasks: Parse messy notes into structured tasks OR break down a task into subtasks
app.post('/api/agent/tasks', async (req: Request, res: Response) => {
  try {
    const ai = getAiClient();
    const { mode, rawNotes, taskTitle, taskDescription, activeDate } = req.body as {
      mode: 'parse_dump' | 'breakdown_subtasks';
      rawNotes?: string;
      taskTitle?: string;
      taskDescription?: string;
      activeDate?: string;
    };

    if (mode === 'breakdown_subtasks') {
      const response = await generateWithRetry(ai, {
        model: MODEL_ID,
        contents: `Break down this general task into 3 to 6 concrete, sequential, 10-30 minute actionable subtasks.
Task Title: ${taskTitle ?? ''}
Context: ${taskDescription ?? ''}`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              subtasks: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Concise actionable checklist items.',
              },
            },
            required: ['subtasks'],
          },
        },
      });
      const parsed = JSON.parse((response.text ?? '{}').trim());
      res.json(parsed);
      return;
    }

    const response = await generateWithRetry(ai, {
      model: MODEL_ID,
      contents: `Today's date is ${activeDate || '2026-11-14'}.
Extract structured general tasks from the user's unstructured notes or brain-dump below.
Infer realistic estimatedMinutes (15, 30, 45, 60, or 90), category (engineering | design | devops | admin | operations | personal), priority (critical | high | medium | low), optional YYYY-MM-DD dueDate if implied, and recurrence (none | daily | weekly).

User notes:
${rawNotes ?? ''}`,
      config: {
        systemInstruction:
          'You are a sharp operations triage parser. Convert unstructured notes into clean, crisp, non-overlapping tasks.',
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            tasks: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  category: { type: Type.STRING },
                  priority: { type: Type.STRING },
                  estimatedMinutes: { type: Type.INTEGER },
                  dueDate: { type: Type.STRING },
                  recurrence: { type: Type.STRING },
                },
                required: ['title', 'description', 'category', 'priority', 'estimatedMinutes'],
              },
            },
            summary: { type: Type.STRING },
          },
          required: ['tasks', 'summary'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim());
    res.json(parsed);
  } catch (err) {
    handleApiError(res, err);
  }
});

// 2. MVP Griller: Guided interrogation + live blueprint, tech stack, and sprint model updates
app.post('/api/agent/grill', async (req: Request, res: Response) => {
  try {
    const ai = getAiClient();
    const { message, history, currentBlueprint, currentSprints, currentSprintTasks, activeDate } =
      req.body as {
        message: string;
        history: Array<{ role: string; content: string }>;
        currentBlueprint: unknown;
        currentSprints: unknown;
        currentSprintTasks: unknown;
        activeDate?: string;
      };

    const transcript = (history ?? [])
      .slice(-10)
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');

    const prompt = `Current Date: ${activeDate || '2026-11-14'}
Current Blueprint State: ${JSON.stringify(currentBlueprint)}
Current Sprints: ${JSON.stringify(currentSprints)}
Current Sprint Tasks Count: ${Array.isArray(currentSprintTasks) ? currentSprintTasks.length : 0}

Conversation History:
${transcript}

Latest User Message:
${message}

Instructions:
1. Act as a ruthless yet constructive Staff Product Architect & Technical Program Manager ("MVP Griller").
2. Grill the user to clarify gaps in: problem statement, exact target persona, the single core MVP loop, explicit non-goals (what to cut from v1), tech stack choices & deployment target, and sprint capacity.
3. Ask 2-3 sharp, pointed questions in assistantReply (concise, scannable prose—no markdown walls). Also provide 3 clickable quickReplies representing likely concrete answers the user could choose.
4. IMMEDIATELY update blueprintPatch with everything known or strongly inferred from the user's message so the live blueprint updates in real time. Do NOT wipe existing confirmed fields unless the user pivots.
5. Whenever enough core scope is clear (even after 1-2 turns, or immediately if the user gives rich detail or asks to draft sprints), generate or refine techStack and a complete Sprint Model (Sprint 0: Foundation & Setup, Sprint 1: Core MVP Loop, Sprint 2: Polish, Testing & Deployment) with concrete sprint tasks (title, description, category, priority, points 1/2/3/5/8, estimatedMinutes, acceptanceCriteria).
6. Only include sprints and tasks in sprintPlan if you are creating or updating the sprint model on this turn; otherwise set shouldUpdateSprints to false so manual user edits are preserved.`;

    const response = await generateWithRetry(ai, {
      model: MODEL_ID,
      contents: prompt,
      config: {
        systemInstruction:
          'You are Cadence Ops MVP Griller. You turn vague MVP ideas into crisp blueprints, pragmatic deployment-ready tech stacks, and sprint-modeled execution plans through pointed questioning.',
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            assistantReply: { type: Type.STRING },
            quickReplies: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            grillingStage: {
              type: Type.STRING,
              description: 'One of: discovery, architecture, sprint_design, ready',
            },
            readiness: {
              type: Type.OBJECT,
              properties: {
                problemDefined: { type: Type.BOOLEAN },
                personaClear: { type: Type.BOOLEAN },
                mvpLoopScoped: { type: Type.BOOLEAN },
                stackSelected: { type: Type.BOOLEAN },
                sprintsDrafted: { type: Type.BOOLEAN },
              },
              required: [
                'problemDefined',
                'personaClear',
                'mvpLoopScoped',
                'stackSelected',
                'sprintsDrafted',
              ],
            },
            blueprintPatch: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                pitch: { type: Type.STRING },
                problemStatement: { type: Type.STRING },
                targetPersona: { type: Type.STRING },
                coreMvpLoop: { type: Type.STRING },
                nonGoals: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                deploymentTarget: { type: Type.STRING },
                techStack: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      layer: { type: Type.STRING },
                      choice: { type: Type.STRING },
                      rationale: { type: Type.STRING },
                    },
                    required: ['layer', 'choice', 'rationale'],
                  },
                },
              },
            },
            shouldUpdateSprints: { type: Type.BOOLEAN },
            sprints: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  key: { type: Type.STRING, description: 'e.g. sp_0, sp_1, sp_2' },
                  name: { type: Type.STRING },
                  goal: { type: Type.STRING },
                  startDate: { type: Type.STRING },
                  endDate: { type: Type.STRING },
                  capacityPoints: { type: Type.INTEGER },
                  status: { type: Type.STRING },
                },
                required: ['key', 'name', 'goal', 'startDate', 'endDate', 'capacityPoints', 'status'],
              },
            },
            sprintTasks: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  sprintKey: { type: Type.STRING },
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  category: { type: Type.STRING },
                  priority: { type: Type.STRING },
                  points: { type: Type.INTEGER },
                  estimatedMinutes: { type: Type.INTEGER },
                  acceptanceCriteria: { type: Type.STRING },
                },
                required: [
                  'sprintKey',
                  'title',
                  'description',
                  'category',
                  'priority',
                  'points',
                  'estimatedMinutes',
                  'acceptanceCriteria',
                ],
              },
            },
          },
          required: ['assistantReply', 'quickReplies', 'grillingStage', 'readiness', 'shouldUpdateSprints'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim());
    res.json(parsed);
  } catch (err) {
    handleApiError(res, err);
  }
});

// 3. Sprint Planner: Generate or rebalance sprint model & task breakdown
app.post('/api/agent/sprint', async (req: Request, res: Response) => {
  try {
    const ai = getAiClient();
    const { blueprint, sprints, tasks, instruction, activeDate } = req.body as {
      blueprint: unknown;
      sprints: unknown;
      tasks: unknown;
      instruction?: string;
      activeDate?: string;
    };

    const response = await generateWithRetry(ai, {
      model: MODEL_ID,
      contents: `Current Date: ${activeDate || '2026-11-14'}
Blueprint: ${JSON.stringify(blueprint)}
Existing Sprints: ${JSON.stringify(sprints)}
Existing Sprint Tasks: ${JSON.stringify(tasks)}
User Instruction: ${instruction || 'Optimize and rebalance sprints cleanly for successful MVP deployment.'}

Return a cohesive 3-sprint plan (Sprint 0 Foundation/Infra, Sprint 1 Core MVP Loop, Sprint 2 Hardening & Deployment) with well-scoped engineering/design/devops tasks, balanced story points, realistic estimatedMinutes (30-120), and crisp acceptance criteria.`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            sprints: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  key: { type: Type.STRING },
                  name: { type: Type.STRING },
                  goal: { type: Type.STRING },
                  startDate: { type: Type.STRING },
                  endDate: { type: Type.STRING },
                  capacityPoints: { type: Type.INTEGER },
                  status: { type: Type.STRING },
                },
                required: ['key', 'name', 'goal', 'startDate', 'endDate', 'capacityPoints', 'status'],
              },
            },
            tasks: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  sprintKey: { type: Type.STRING },
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  category: { type: Type.STRING },
                  priority: { type: Type.STRING },
                  points: { type: Type.INTEGER },
                  estimatedMinutes: { type: Type.INTEGER },
                  acceptanceCriteria: { type: Type.STRING },
                },
                required: [
                  'sprintKey',
                  'title',
                  'description',
                  'category',
                  'priority',
                  'points',
                  'estimatedMinutes',
                  'acceptanceCriteria',
                ],
              },
            },
          },
          required: ['summary', 'sprints', 'tasks'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim());
    res.json(parsed);
  } catch (err) {
    handleApiError(res, err);
  }
});

// 4. Smart Schedule & Conflict Resolver
app.post('/api/agent/schedule', async (req: Request, res: Response) => {
  try {
    const ai = getAiClient();
    const {
      activeDate,
      workdayStartMinute,
      workdayEndMinute,
      existingBlocks,
      candidateTasks,
      preferences,
    } = req.body as {
      activeDate: string;
      workdayStartMinute: number;
      workdayEndMinute: number;
      existingBlocks: Array<{
        id: string;
        title: string;
        startMinute: number;
        endMinute: number;
        type: string;
        locked: boolean;
        linkedTaskId?: string;
        linkedTaskScope?: string;
        notes?: string;
      }>;
      candidateTasks: Array<{
        id: string;
        scope: string;
        title: string;
        priority: string;
        estimatedMinutes: number;
        category: string;
        dueDate?: string;
      }>;
      preferences?: string;
    };

    const prompt = `Date: ${activeDate}
Workday Window (minutes from midnight): ${workdayStartMinute} (${Math.floor(workdayStartMinute / 60)}:00) to ${workdayEndMinute} (${Math.floor(workdayEndMinute / 60)}:00).

Existing Blocks for today:
${JSON.stringify(existingBlocks, null, 2)}

Unscheduled Candidate Tasks (both General & Sprint tasks):
${JSON.stringify(candidateTasks, null, 2)}

User Preferences: ${preferences || 'Protect 90m+ deep work blocks for critical engineering tasks, group short admin tasks, include a midday lunch/reset break if space permits, and eliminate ALL overlaps.'}

Hard Constraints:
1. Any block with locked=true MUST stay at its exact startMinute and endMinute.
2. Zero overlaps between ANY two blocks in the returned schedule (for every pair, either A.endMinute <= B.startMinute or B.endMinute <= A.startMinute).
3. All movable blocks must fit strictly within [${workdayStartMinute}, ${workdayEndMinute}].
4. Resolve all existing conflicts by shifting movable blocks into open gaps, and schedule the highest-priority candidate tasks (both general and sprint tasks) that fit cleanly without creating new overlaps.
5. List concrete human-readable explanations in "resolutions" describing each conflict fixed or task placed.`;

    const response = await generateWithRetry(ai, {
      model: MODEL_ID,
      contents: prompt,
      config: {
        systemInstruction:
          'You are an exact constraint-solving executive scheduler. Never emit overlapping time blocks.',
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            resolutions: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            blocks: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  title: { type: Type.STRING },
                  startMinute: { type: Type.INTEGER },
                  endMinute: { type: Type.INTEGER },
                  type: { type: Type.STRING, description: 'deep_work | meeting | admin | buffer' },
                  linkedTaskId: { type: Type.STRING },
                  linkedTaskScope: { type: Type.STRING },
                  locked: { type: Type.BOOLEAN },
                  notes: { type: Type.STRING },
                },
                required: ['id', 'title', 'startMinute', 'endMinute', 'type', 'locked'],
              },
            },
            unscheduledTaskIds: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
          required: ['summary', 'resolutions', 'blocks', 'unscheduledTaskIds'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim());
    res.json(parsed);
  } catch (err) {
    handleApiError(res, err);
  }
});

// 5. Daily Admin & Standup Draft Generator
app.post('/api/agent/admin', async (req: Request, res: Response) => {
  try {
    const ai = getAiClient();
    const { kind, customInstructions, blueprint, sprints, tasks, scheduleBlocks, activeDate } =
      req.body as {
        kind: 'standup' | 'stakeholder_update' | 'follow_up_email' | 'meeting_agenda';
        customInstructions?: string;
        blueprint: unknown;
        sprints: unknown;
        tasks: unknown;
        scheduleBlocks: unknown;
        activeDate: string;
      };

    const response = await generateWithRetry(ai, {
      model: MODEL_ID,
      contents: `Generate a crisp, ready-to-send "${kind}" administrative document grounded strictly in the real workspace snapshot below.
Date: ${activeDate}
Custom Instructions: ${customInstructions || 'Keep it concise, executive-ready, and directly actionable.'}

Blueprint: ${JSON.stringify(blueprint)}
Sprints: ${JSON.stringify(sprints)}
Tasks (both General and Sprint): ${JSON.stringify(tasks)}
Today Schedule: ${JSON.stringify(scheduleBlocks)}`,
      config: {
        systemInstruction:
          'You are an executive engineering operations chief of staff. Write clear, factual, jargon-free administrative updates with concrete next steps.',
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            content: { type: Type.STRING },
            sourceSnapshotSummary: { type: Type.STRING },
          },
          required: ['title', 'content', 'sourceSnapshotSummary'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim());
    res.json(parsed);
  } catch (err) {
    handleApiError(res, err);
  }
});

// 6. Unified Assistant Agent: Routes between general task ops, schedule queries, or launching MVP Griller
app.post('/api/agent/assist', async (req: Request, res: Response) => {
  try {
    const ai = getAiClient();
    const { message, history, workspaceSnapshot } = req.body as {
      message: string;
      history: Array<{ role: string; content: string }>;
      workspaceSnapshot: unknown;
    };

    const transcript = (history ?? [])
      .slice(-8)
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');

    const response = await generateWithRetry(ai, {
      model: MODEL_ID,
      contents: `Workspace Snapshot: ${JSON.stringify(workspaceSnapshot)}

Recent Chat:
${transcript}

User Message:
${message}

Instructions:
1. Detect intent:
   - If the user says they want to work on an MVP / build a new product / start an MVP (e.g. "I want to work on an MVP..."), set intent="mvp_grill" and explain that you're switching them into the MVP Griller Studio to interrogate scope, define the tech stack, and build the sprint plan.
   - Otherwise set intent="general_ops" and help with general tasks, sprint questions, schedule triage, or admin actions.
2. When the user asks to add, complete, or update general tasks (or add a schedule block), emit structured mutations in "taskMutations" and/or "scheduleAdditions" so the UI executes them immediately!
3. Keep assistantReply concise, actionable, and grounded in actual tasks/blocks from the snapshot.`,
      config: {
        systemInstruction:
          'You are Cadence Ops Assistant. You manage both everyday general tasks and complex sprint schedules, and immediately trigger MVP Griller mode whenever the user wants to work on an MVP.',
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            intent: { type: Type.STRING, description: 'mvp_grill | general_ops' },
            assistantReply: { type: Type.STRING },
            quickReplies: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            newGeneralTasks: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  category: { type: Type.STRING },
                  priority: { type: Type.STRING },
                  estimatedMinutes: { type: Type.INTEGER },
                  dueDate: { type: Type.STRING },
                },
                required: ['title', 'category', 'priority', 'estimatedMinutes'],
              },
            },
            completeTaskIds: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            newScheduleBlocks: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  startMinute: { type: Type.INTEGER },
                  endMinute: { type: Type.INTEGER },
                  type: { type: Type.STRING },
                  locked: { type: Type.BOOLEAN },
                },
                required: ['title', 'startMinute', 'endMinute', 'type', 'locked'],
              },
            },
          },
          required: ['intent', 'assistantReply', 'quickReplies'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim());
    res.json(parsed);
  } catch (err) {
    handleApiError(res, err);
  }
});

const LIVE_MODEL_ID = 'gemini-3.8-live';
const ALLOWED_VOICES = new Set(['Zephyr', 'Puck', 'Kore', 'Charon', 'Fenrir']);

const LIVE_TOOLS: FunctionDeclaration[] = [
  {
    name: 'add_general_task',
    description:
      'Adds a new general task to the user inbox when the user asks to create, remember, or log a task.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: 'Short actionable task title.' },
        category: {
          type: Type.STRING,
          description: 'One of: engineering, design, devops, admin, operations, personal',
        },
        priority: {
          type: Type.STRING,
          description: 'One of: critical, high, medium, low',
        },
        estimatedMinutes: {
          type: Type.INTEGER,
          description: 'Estimated minutes (e.g., 15, 30, 45, 60, 90).',
        },
        dueDate: { type: Type.STRING, description: 'Optional YYYY-MM-DD due date.' },
      },
      required: ['title', 'category', 'priority', 'estimatedMinutes'],
    },
  },
  {
    name: 'complete_task',
    description: 'Marks an existing general or sprint task as completed (done).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        taskId: { type: Type.STRING, description: 'Exact ID of the task from workspace snapshot.' },
        taskTitle: { type: Type.STRING, description: 'Title of the task if ID is uncertain.' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'add_schedule_block',
    description: 'Adds a time-blocked event or focus block to today schedule.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING },
        startMinute: {
          type: Type.INTEGER,
          description: 'Start time in minutes from midnight (e.g., 15:00 = 900).',
        },
        endMinute: {
          type: Type.INTEGER,
          description: 'End time in minutes from midnight (e.g., 16:00 = 960).',
        },
        type: {
          type: Type.STRING,
          description: 'One of: deep_work, meeting, admin, buffer',
        },
        locked: {
          type: Type.BOOLEAN,
          description: 'True for fixed meetings, false for movable focus blocks.',
        },
      },
      required: ['title', 'startMinute', 'endMinute', 'type', 'locked'],
    },
  },
  {
    name: 'trigger_mvp_grill',
    description:
      'Opens the MVP Griller Studio when the user says they want to work on an MVP or start scoping a new product.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        ideaSummary: {
          type: Type.STRING,
          description: 'Short summary of the MVP idea the user described.',
        },
      },
      required: ['ideaSummary'],
    },
  },
];

function setupLiveWebSocket(server: http.Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const reqUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (reqUrl.pathname === '/ws/live') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', (clientWs: WebSocket) => {
    let sessionPromise: Promise<Awaited<ReturnType<GoogleGenAI['live']['connect']>>> | null =
      null;
    let activeSession: Awaited<ReturnType<GoogleGenAI['live']['connect']>> | null = null;
    let closed = false;

    const sendJson = (payload: Record<string, unknown>) => {
      if (!closed && clientWs.readyState === 1) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    const startLiveSession = (workspaceSnapshot: unknown, requestedVoice?: string) => {
      if (sessionPromise) return;
      try {
        const ai = getLiveAiClient();
        const voiceName =
          requestedVoice && ALLOWED_VOICES.has(requestedVoice) ? requestedVoice : 'Zephyr';

        const systemInstruction = `You are Cadence Ops Live Voice Assistant. You speak naturally, concisely, and directly like a sharp engineering chief of staff—no markdown formatting or bullet reading aloud unless brief.
You help the user manage general tasks, sprint deliverables, daily schedule blocks, and administrative priorities.
If the user says they want to work on an MVP or build a new product, immediately call trigger_mvp_grill and tell them you're opening the MVP Griller Studio.
When the user asks to add or complete tasks or block time on their schedule, call the corresponding workspace tool immediately and confirm verbally.

Current Workspace Snapshot:
${JSON.stringify(workspaceSnapshot ?? {})}`;

        sessionPromise = ai.live.connect({
          model: LIVE_MODEL_ID,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName } },
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            tools: [{ functionDeclarations: LIVE_TOOLS }],
            systemInstruction,
          },
          callbacks: {
            onmessage: (message: LiveServerMessage) => {
              const content = message.serverContent;
              if (content?.inputTranscription?.text) {
                sendJson({ type: 'input_transcript', text: content.inputTranscription.text });
              }
              if (content?.outputTranscription?.text) {
                sendJson({ type: 'output_transcript', text: content.outputTranscription.text });
              }
              for (const part of content?.modelTurn?.parts ?? []) {
                if (part.inlineData?.data) {
                  sendJson({ type: 'audio', audio: part.inlineData.data });
                }
              }
              if (content?.interrupted) {
                sendJson({ type: 'interrupted' });
              }
              if (content?.turnComplete) {
                sendJson({ type: 'turn_complete' });
              }

              for (const call of message.toolCall?.functionCalls ?? []) {
                sendJson({
                  type: 'tool_action',
                  action: call.name,
                  args: call.args ?? {},
                });
                sessionPromise?.then((session) => {
                  session.sendToolResponse({
                    functionResponses: [
                      {
                        id: call.id,
                        name: call.name,
                        response: { result: 'Executed successfully in Cadence Ops workspace.' },
                      },
                    ],
                  });
                });
              }
            },
            onerror: (err: unknown) => {
              const maybeErr = err as { message?: string; error?: { message?: string } };
              const msg =
                err instanceof Error
                  ? err.message
                  : maybeErr?.message || maybeErr?.error?.message || 'Gemini Live session error';
              sendJson({ type: 'error', message: msg });
            },
            onclose: () => {
              sendJson({ type: 'closed' });
            },
          },
        });

        sessionPromise
          .then((session) => {
            activeSession = session;
            if (closed) {
              session.close();
              return;
            }
            sendJson({ type: 'ready', model: LIVE_MODEL_ID, voiceName });
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : 'Failed to connect Gemini Live';
            sendJson({ type: 'error', message: msg });
          });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to initialize Gemini Live';
        sendJson({ type: 'error', message: msg });
      }
    };

    clientWs.on('message', (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString()) as {
          type?: string;
          audio?: string;
          text?: string;
          workspaceSnapshot?: unknown;
          voiceName?: string;
        };

        if (msg.type === 'init') {
          startLiveSession(msg.workspaceSnapshot, msg.voiceName);
          return;
        }

        if (msg.type === 'audio' && msg.audio && sessionPromise) {
          sessionPromise.then((session) => {
            if (!closed) {
              session.sendRealtimeInput({
                audio: { data: msg.audio as string, mimeType: 'audio/pcm;rate=16000' },
              });
            }
          });
          return;
        }

        if (msg.type === 'text' && msg.text && sessionPromise) {
          sessionPromise.then((session) => {
            if (!closed) {
              session.sendRealtimeInput({ text: msg.text as string });
            }
          });
          return;
        }

        if (msg.type === 'stop') {
          closed = true;
          activeSession?.close();
          clientWs.close();
        }
      } catch {
        // Ignore malformed client frames
      }
    });

    clientWs.on('close', () => {
      closed = true;
      try {
        activeSession?.close();
      } catch {
        // Ignore close errors
      }
    });
  });
}

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('/{*path}', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = http.createServer(app);
  setupLiveWebSocket(server);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Cadence Ops server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
