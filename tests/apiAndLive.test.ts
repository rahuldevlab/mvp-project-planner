import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { WebSocket } from 'ws';
import { createFreshMvpBlueprint, createInitialWorkspace } from '../src/data/initialWorkspace';
import type { ScheduleBlock } from '../src/types/workspace';
import { detectScheduleConflicts } from '../src/utils/scheduleUtils';

const BASE_URL = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000/ws/live';

describe('Cadence Ops API & Gemini Live Integration', { concurrency: 1 }, () => {
  test('GET /api/health responds with active models', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean; model: string; liveModel: string };
    assert.equal(data.ok, true);
    assert.equal(data.model, 'gemini-4-hydrogen');
    assert.equal(data.liveModel, 'gemini-3.8-live');
  });

  test('Initial workspace and fresh MVP blueprint factories produce valid structures', () => {
    const ws = createInitialWorkspace();
    assert.ok(ws.tasks.some((t) => t.scope === 'general'));
    assert.ok(ws.tasks.some((t) => t.scope === 'sprint'));
    assert.ok(ws.sprints.length >= 3);
    assert.ok(ws.blueprint.techStack.length >= 3);

    const fresh = createFreshMvpBlueprint();
    assert.equal(fresh.grillingStage, 'discovery');
    assert.equal(fresh.readiness.problemDefined, false);
    assert.equal(fresh.techStack.length, 0);
  });

  test('Gemini Live /ws/live connects, initializes session, and streams 24kHz PCM audio', async () => {
    const ws = new WebSocket(WS_URL);

    const result = await new Promise<{
      readyReceived: boolean;
      audioChunks: number;
      transcript: string;
      errorMessage?: string;
    }>((resolve, reject) => {
      let readyReceived = false;
      let audioChunks = 0;
      let transcript = '';
      let settled = false;

      const finish = (payload: {
        readyReceived: boolean;
        audioChunks: number;
        transcript: string;
        errorMessage?: string;
      }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // ignore
        }
        resolve(payload);
      };

      const timer = setTimeout(() => {
        finish({
          readyReceived,
          audioChunks,
          transcript,
          errorMessage: 'Timed out waiting for Gemini Live turn_complete',
        });
      }, 20000);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'init',
            voiceName: 'Zephyr',
            workspaceSnapshot: {
              activeDate: '2026-11-14',
              tasks: [{ id: 'gen_1', scope: 'general', title: 'Renew SSL cert', status: 'backlog' }],
            },
          })
        );
      });

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          type: string;
          audio?: string;
          text?: string;
          message?: string;
        };

        if (msg.type === 'ready') {
          readyReceived = true;
          ws.send(JSON.stringify({ type: 'text', text: 'Say hello in three words.' }));
        } else if (msg.type === 'audio' && msg.audio) {
          audioChunks += 1;
        } else if (msg.type === 'output_transcript' && msg.text) {
          transcript += msg.text;
        } else if (msg.type === 'turn_complete') {
          finish({ readyReceived, audioChunks, transcript });
        } else if (msg.type === 'error') {
          finish({ readyReceived, audioChunks, transcript, errorMessage: msg.message });
        }
      });

      ws.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
    });

    assert.equal(result.errorMessage, undefined, `Live WebSocket error: ${result.errorMessage}`);
    assert.equal(result.readyReceived, true, 'Expected ready frame from /ws/live');
    assert.ok(result.audioChunks > 0, 'Expected at least 1 24kHz PCM audio chunk from Gemini Live');
  });

  test('Gemini Live /ws/live executes add_general_task tool call', async () => {
    const ws = new WebSocket(WS_URL);

    const result = await new Promise<{
      toolAction?: { action: string; args: Record<string, unknown> };
      errorMessage?: string;
    }>((resolve, reject) => {
      let toolAction: { action: string; args: Record<string, unknown> } | undefined;
      let settled = false;

      const finish = (payload: {
        toolAction?: { action: string; args: Record<string, unknown> };
        errorMessage?: string;
      }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // ignore
        }
        resolve(payload);
      };

      const timer = setTimeout(() => {
        finish({
          toolAction,
          errorMessage: toolAction ? undefined : 'Timed out waiting for Gemini Live tool_action',
        });
      }, 20000);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'init',
            voiceName: 'Puck',
            workspaceSnapshot: { activeDate: '2026-11-14', tasks: [] },
          })
        );
      });

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          type: string;
          action?: string;
          args?: Record<string, unknown>;
          message?: string;
        };

        if (msg.type === 'ready') {
          ws.send(
            JSON.stringify({
              type: 'text',
              text: 'Please add a general task titled Audit AWS billing with high priority for 30 minutes today.',
            })
          );
        } else if (msg.type === 'tool_action' && msg.action) {
          toolAction = { action: msg.action, args: msg.args || {} };
          finish({ toolAction });
        } else if (msg.type === 'error') {
          finish({ errorMessage: msg.message });
        }
      });

      ws.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
    });

    assert.equal(result.errorMessage, undefined, `Live tool test error: ${result.errorMessage}`);
    assert.equal(result.toolAction?.action, 'add_general_task');
    assert.ok(String(result.toolAction?.args?.title || '').length > 0);
  });

  test('POST /api/agent/tasks parses general tasks or propagates 429 error cleanly', async (t) => {
    const res = await fetch(`${BASE_URL}/api/agent/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'parse_dump',
        rawNotes: 'Email finance about AWS credits 20m urgent, renew staging domain cert 30m',
        activeDate: '2026-11-14',
      }),
    });
    const data = (await res.json()) as {
      tasks?: Array<{ title: string; estimatedMinutes: number }>;
      error?: string;
    };
    if (res.status === 429) {
      assert.ok(typeof data.error === 'string' && data.error.length > 0);
      t.skip('Gemini 429 RPM limit reached during repeated test burst');
      return;
    }
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(data.tasks) && data.tasks.length >= 2);
  });

  test('POST /api/agent/grill updates blueprint or propagates 429 error cleanly', async (t) => {
    const ws = createInitialWorkspace();
    const res = await fetch(`${BASE_URL}/api/agent/grill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'I want to work on an MVP for an automated warehouse pallet scanner for small 3PL teams.',
        history: [],
        currentBlueprint: { ...ws.blueprint, title: 'Untitled MVP', problemStatement: '', targetPersona: '' },
        currentSprints: [],
        currentSprintTasks: [],
        activeDate: '2026-11-14',
      }),
    });
    const data = (await res.json()) as {
      assistantReply?: string;
      quickReplies?: string[];
      blueprintPatch?: { title?: string };
      error?: string;
    };
    if (res.status === 429) {
      assert.ok(typeof data.error === 'string' && data.error.length > 0);
      t.skip('Gemini 429 RPM limit reached during repeated test burst');
      return;
    }
    assert.equal(res.status, 200);
    assert.ok((data.assistantReply || '').length > 20);
    assert.ok(Array.isArray(data.quickReplies) && data.quickReplies.length > 0);
    assert.ok(data.blueprintPatch?.title);
  });

  test('POST /api/agent/schedule eliminates conflicts while preserving locked meetings', async (t) => {
    const ws = createInitialWorkspace();
    const dayBlocks = ws.scheduleBlocks.filter((b) => b.date === ws.activeDate);
    const lockedMeetings = dayBlocks.filter((b) => b.locked);

    const res = await fetch(`${BASE_URL}/api/agent/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activeDate: ws.activeDate,
        workdayStartMinute: ws.workdayStartMinute,
        workdayEndMinute: ws.workdayEndMinute,
        existingBlocks: dayBlocks,
        candidateTasks: ws.tasks
          .filter((t) => t.status !== 'done')
          .slice(0, 4)
          .map((t) => ({
            id: t.id,
            scope: t.scope,
            title: t.title,
            priority: t.priority,
            estimatedMinutes: t.estimatedMinutes,
            category: t.category,
            dueDate: t.dueDate,
          })),
      }),
    });
    const data = (await res.json()) as {
      blocks?: Array<Omit<ScheduleBlock, 'date'>>;
      error?: string;
    };
    if (res.status === 429) {
      assert.ok(typeof data.error === 'string' && data.error.length > 0);
      t.skip('Gemini 429 RPM limit reached during repeated test burst');
      return;
    }
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(data.blocks) && data.blocks.length >= lockedMeetings.length);

    const datedBlocks: ScheduleBlock[] = data.blocks.map((b) => ({ ...b, date: ws.activeDate }));
    const remainingConflicts = detectScheduleConflicts(datedBlocks, ws.activeDate);
    assert.equal(remainingConflicts.length, 0, 'Optimized schedule must have zero overlaps');

    for (const meeting of lockedMeetings) {
      const match = datedBlocks.find(
        (b) => b.startMinute === meeting.startMinute && b.endMinute === meeting.endMinute
      );
      assert.ok(match, `Locked meeting "${meeting.title}" must stay at exact time`);
    }
  });

  test('POST /api/agent/admin generates grounded daily standup digest', async (t) => {
    const ws = createInitialWorkspace();
    const res = await fetch(`${BASE_URL}/api/agent/admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'standup',
        blueprint: ws.blueprint,
        sprints: ws.sprints,
        tasks: ws.tasks,
        scheduleBlocks: ws.scheduleBlocks,
        activeDate: ws.activeDate,
      }),
    });
    const data = (await res.json()) as { title?: string; content?: string; error?: string };
    if (res.status === 429) {
      assert.ok(typeof data.error === 'string' && data.error.length > 0);
      t.skip('Gemini 429 RPM limit reached during repeated test burst');
      return;
    }
    assert.equal(res.status, 200);
    assert.ok((data.title || '').length > 0);
    assert.ok((data.content || '').length > 40);
  });
});
