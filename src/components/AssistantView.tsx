import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Mic, MicOff, PhoneOff, Send, Volume2 } from 'lucide-react';
import type {
  ChatMessage,
  ScheduleBlock,
  ScheduleBlockType,
  TaskCategory,
  TaskItem,
  TaskPriority,
  WorkspaceState,
} from '../types/workspace';
import {
  decodePcm24kToAudioBuffer,
  float32ToPcm16Base64,
  resampleFloat32,
} from '../utils/liveAudio';
import { createId, formatMinutesToTime } from '../utils/scheduleUtils';

interface AssistantViewProps {
  workspace: WorkspaceState;
  onAddMessages: (msgs: ChatMessage[]) => void;
  onAddGeneralTasks: (tasks: TaskItem[]) => void;
  onCompleteTasks: (taskIds: string[]) => void;
  onAddScheduleBlocks: (blocks: ScheduleBlock[]) => void;
  onLaunchMvpGrillWithPrompt: (initialPrompt: string) => void;
  onNotify: (message: string, tone?: 'info' | 'error') => void;
}

type LiveStatus = 'off' | 'connecting' | 'listening' | 'speaking';
type VoiceOption = 'Zephyr' | 'Puck' | 'Kore' | 'Charon' | 'Fenrir';

const VOICES: VoiceOption[] = ['Zephyr', 'Puck', 'Kore', 'Charon', 'Fenrir'];

export const AssistantView: React.FC<AssistantViewProps> = ({
  workspace,
  onAddMessages,
  onAddGeneralTasks,
  onCompleteTasks,
  onAddScheduleBlocks,
  onLaunchMvpGrillWithPrompt,
  onNotify,
}) => {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  // Gemini Live voice state
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('off');
  const [voiceName, setVoiceName] = useState<VoiceOption>('Zephyr');
  const [muted, setMuted] = useState(false);
  const [liveUserCaption, setLiveUserCaption] = useState('');
  const [liveModelCaption, setLiveModelCaption] = useState('');

  const bottomRef = useRef<HTMLDivElement>(null);

  // Refs to prevent stale closures inside WebSocket and audio callbacks
  const wsRef = useRef<WebSocket | null>(null);
  const mutedRef = useRef(false);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const zeroGainRef = useRef<GainNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const userCaptionBufRef = useRef('');
  const modelCaptionBufRef = useRef('');
  const pendingActionsBufRef = useRef<string[]>([]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [workspace.assistantMessages, loading, liveUserCaption, liveModelCaption]);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  // Clean up audio & WebSocket on unmount
  useEffect(() => {
    return () => {
      teardownLiveSession();
    };
  }, []);

  function buildWorkspaceSnapshot() {
    return {
      activeDate: workspace.activeDate,
      blueprintTitle: workspace.blueprint.title,
      sprints: workspace.sprints.map((s) => ({ id: s.id, name: s.name, status: s.status })),
      tasks: workspace.tasks.map((t) => ({
        id: t.id,
        scope: t.scope,
        title: t.title,
        status: t.status,
        priority: t.priority,
        estimatedMinutes: t.estimatedMinutes,
        dueDate: t.dueDate,
      })),
      todayBlocks: workspace.scheduleBlocks
        .filter((b) => b.date === workspace.activeDate)
        .map((b) => ({
          id: b.id,
          title: b.title,
          startMinute: b.startMinute,
          endMinute: b.endMinute,
          locked: b.locked,
        })),
    };
  }

  function clearScheduledAudioPlayback() {
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
      } catch {
        // Ignore already stopped sources
      }
    }
    activeSourcesRef.current = [];
    nextStartTimeRef.current = 0;
  }

  function commitLiveTurnToHistory() {
    const userText = userCaptionBufRef.current.trim();
    const modelText = modelCaptionBufRef.current.trim();
    const actions = pendingActionsBufRef.current.slice();

    const committed: ChatMessage[] = [];
    const nowTime = new Date().toTimeString().slice(0, 5);

    if (userText) {
      committed.push({
        id: createId('am'),
        role: 'user',
        content: userText,
        timestamp: nowTime,
      });
    }
    if (modelText || actions.length > 0) {
      committed.push({
        id: createId('am'),
        role: 'assistant',
        content: modelText || actions.join(' · '),
        timestamp: nowTime,
        actionSummary: actions.length > 0 ? actions : undefined,
      });
    }

    if (committed.length > 0) {
      onAddMessages(committed);
    }

    userCaptionBufRef.current = '';
    modelCaptionBufRef.current = '';
    pendingActionsBufRef.current = [];
    setLiveUserCaption('');
    setLiveModelCaption('');
  }

  function teardownLiveSession() {
    clearScheduledAudioPlayback();

    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.disconnect();
      } catch {
        // Ignore
      }
      sourceNodeRef.current = null;
    }

    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch {
        // Ignore
      }
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }

    if (zeroGainRef.current) {
      try {
        zeroGainRef.current.disconnect();
      } catch {
        // Ignore
      }
      zeroGainRef.current = null;
    }

    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
    }

    if (inputAudioCtxRef.current) {
      inputAudioCtxRef.current.close().catch(() => {});
      inputAudioCtxRef.current = null;
    }

    if (outputAudioCtxRef.current) {
      outputAudioCtxRef.current.close().catch(() => {});
      outputAudioCtxRef.current = null;
    }

    if (wsRef.current) {
      const ws = wsRef.current;
      wsRef.current = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'stop' }));
        }
        ws.close();
      } catch {
        // Ignore
      }
    }

    setLiveStatus('off');
    setMuted(false);
  }

  function handleLiveToolAction(action: string, args: Record<string, unknown>) {
    if (action === 'add_general_task') {
      const title = String(args.title || '').trim();
      if (!title) return;
      const category = (['engineering', 'design', 'devops', 'admin', 'operations', 'personal'].includes(
        String(args.category)
      )
        ? String(args.category)
        : 'operations') as TaskCategory;
      const priority = (['critical', 'high', 'medium', 'low'].includes(String(args.priority))
        ? String(args.priority)
        : 'medium') as TaskPriority;
      const estimatedMinutes = Number(args.estimatedMinutes) || 30;

      const task: TaskItem = {
        id: createId('gen'),
        scope: 'general',
        title,
        description: '',
        category,
        priority,
        status: 'backlog',
        estimatedMinutes,
        dueDate: typeof args.dueDate === 'string' && args.dueDate ? args.dueDate : workspace.activeDate,
        recurrence: 'none',
        subtasks: [],
        createdAt: new Date().toISOString(),
      };
      onAddGeneralTasks([task]);
      pendingActionsBufRef.current.push(`Added task: ${title}`);
      onNotify(`Voice added general task: ${title}`);
      return;
    }

    if (action === 'complete_task') {
      const taskId = String(args.taskId || '');
      const taskTitle = String(args.taskTitle || '').toLowerCase();
      const matched =
        workspace.tasks.find((t) => t.id === taskId) ||
        workspace.tasks.find((t) => taskTitle && t.title.toLowerCase().includes(taskTitle));
      if (matched) {
        onCompleteTasks([matched.id]);
        pendingActionsBufRef.current.push(`Completed: ${matched.title}`);
        onNotify(`Marked done: ${matched.title}`);
      }
      return;
    }

    if (action === 'add_schedule_block') {
      const title = String(args.title || '').trim();
      const startMinute = Number(args.startMinute);
      const endMinute = Number(args.endMinute);
      if (!title || Number.isNaN(startMinute) || Number.isNaN(endMinute)) return;
      const type = (['deep_work', 'meeting', 'admin', 'buffer'].includes(String(args.type))
        ? String(args.type)
        : 'admin') as ScheduleBlockType;
      const block: ScheduleBlock = {
        id: createId('blk'),
        date: workspace.activeDate,
        startMinute,
        endMinute: Math.max(startMinute + 15, endMinute),
        title,
        type,
        locked: Boolean(args.locked),
      };
      onAddScheduleBlocks([block]);
      pendingActionsBufRef.current.push(
        `Scheduled ${title} (${formatMinutesToTime(block.startMinute)})`
      );
      onNotify(`Scheduled "${title}" at ${formatMinutesToTime(block.startMinute)}`);
      return;
    }

    if (action === 'trigger_mvp_grill') {
      const idea = String(args.ideaSummary || 'New MVP idea');
      commitLiveTurnToHistory();
      teardownLiveSession();
      onLaunchMvpGrillWithPrompt(idea);
    }
  }

  async function startLiveSession() {
    if (liveStatus !== 'off') return;
    setLiveStatus('connecting');
    userCaptionBufRef.current = '';
    modelCaptionBufRef.current = '';
    pendingActionsBufRef.current = [];
    setLiveUserCaption('');
    setLiveModelCaption('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const inputCtx = new AudioContext({ sampleRate: 16000 });
      const outputCtx = new AudioContext({ sampleRate: 24000 });
      await inputCtx.resume();
      await outputCtx.resume();
      inputAudioCtxRef.current = inputCtx;
      outputAudioCtxRef.current = outputCtx;

      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${wsProtocol}//${location.host}/ws/live`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'init',
            voiceName,
            workspaceSnapshot: buildWorkspaceSnapshot(),
          })
        );
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as {
            type: string;
            audio?: string;
            text?: string;
            action?: string;
            args?: Record<string, unknown>;
            message?: string;
          };

          if (msg.type === 'ready') {
            setLiveStatus('listening');
            // Wire microphone PCM capture resampled cleanly to 16kHz
            const source = inputCtx.createMediaStreamSource(stream);
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            const zeroGain = inputCtx.createGain();
            zeroGain.gain.value = 0;

            processor.onaudioprocess = (e) => {
              if (mutedRef.current) return;
              if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
              const rawChannel = e.inputBuffer.getChannelData(0);
              const resampled = resampleFloat32(rawChannel, inputCtx.sampleRate, 16000);
              const pcmBase64 = float32ToPcm16Base64(resampled);
              wsRef.current.send(JSON.stringify({ type: 'audio', audio: pcmBase64 }));
            };

            source.connect(processor);
            processor.connect(zeroGain);
            zeroGain.connect(inputCtx.destination);
            sourceNodeRef.current = source;
            processorRef.current = processor;
            zeroGainRef.current = zeroGain;
            onNotify(`Gemini Live connected (${voiceName})`);
            return;
          }

          if (msg.type === 'audio' && msg.audio && outputAudioCtxRef.current) {
            setLiveStatus('speaking');
            const outCtx = outputAudioCtxRef.current;
            const buffer = decodePcm24kToAudioBuffer(outCtx, msg.audio);
            const sourceNode = outCtx.createBufferSource();
            sourceNode.buffer = buffer;
            sourceNode.connect(outCtx.destination);

            const startAt = Math.max(outCtx.currentTime, nextStartTimeRef.current);
            sourceNode.start(startAt);
            nextStartTimeRef.current = startAt + buffer.duration;

            activeSourcesRef.current.push(sourceNode);
            sourceNode.onended = () => {
              activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== sourceNode);
              if (activeSourcesRef.current.length === 0 && wsRef.current) {
                setLiveStatus('listening');
              }
            };
            return;
          }

          if (msg.type === 'interrupted') {
            clearScheduledAudioPlayback();
            setLiveStatus('listening');
            return;
          }

          if (msg.type === 'input_transcript' && msg.text) {
            userCaptionBufRef.current += msg.text;
            setLiveUserCaption(userCaptionBufRef.current);
            return;
          }

          if (msg.type === 'output_transcript' && msg.text) {
            modelCaptionBufRef.current += msg.text;
            setLiveModelCaption(modelCaptionBufRef.current);
            return;
          }

          if (msg.type === 'turn_complete') {
            commitLiveTurnToHistory();
            if (activeSourcesRef.current.length === 0) {
              setLiveStatus('listening');
            }
            return;
          }

          if (msg.type === 'tool_action' && msg.action) {
            handleLiveToolAction(msg.action, msg.args || {});
            return;
          }

          if (msg.type === 'error') {
            onNotify(msg.message || 'Gemini Live error', 'error');
            teardownLiveSession();
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onerror = () => {
        onNotify('Gemini Live WebSocket connection failed', 'error');
        teardownLiveSession();
      };

      ws.onclose = () => {
        commitLiveTurnToHistory();
        teardownLiveSession();
      };
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'Microphone permission is required for Gemini Live',
        'error'
      );
      teardownLiveSession();
    }
  }

  function stopLiveSession() {
    commitLiveTurnToHistory();
    teardownLiveSession();
    onNotify('Gemini Live voice session ended');
  }

  async function sendAssistantMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    // If a Gemini Live voice session is open, also allow sending text directly into Live
    if (liveStatus !== 'off' && wsRef.current?.readyState === WebSocket.OPEN) {
      const userMsg: ChatMessage = {
        id: createId('am'),
        role: 'user',
        content: trimmed,
        timestamp: new Date().toTimeString().slice(0, 5),
      };
      onAddMessages([userMsg]);
      wsRef.current.send(JSON.stringify({ type: 'text', text: trimmed }));
      setInput('');
      return;
    }

    const userMsg: ChatMessage = {
      id: createId('am'),
      role: 'user',
      content: trimmed,
      timestamp: new Date().toTimeString().slice(0, 5),
    };
    onAddMessages([userMsg]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/agent/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          history: [...workspace.assistantMessages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
          })),
          workspaceSnapshot: buildWorkspaceSnapshot(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Assistant request failed');

      const actionsApplied: string[] = [];

      if (Array.isArray(data.newGeneralTasks) && data.newGeneralTasks.length > 0) {
        const added: TaskItem[] = data.newGeneralTasks.map(
          (t: {
            title: string;
            description?: string;
            category: string;
            priority: string;
            estimatedMinutes: number;
            dueDate?: string;
          }) => ({
            id: createId('gen'),
            scope: 'general',
            title: t.title,
            description: t.description || '',
            category: (['engineering', 'design', 'devops', 'admin', 'operations', 'personal'].includes(
              t.category
            )
              ? t.category
              : 'operations') as TaskCategory,
            priority: (['critical', 'high', 'medium', 'low'].includes(t.priority)
              ? t.priority
              : 'medium') as TaskPriority,
            status: 'backlog',
            estimatedMinutes: t.estimatedMinutes || 30,
            dueDate: t.dueDate || workspace.activeDate,
            recurrence: 'none',
            subtasks: [],
            createdAt: new Date().toISOString(),
          })
        );
        onAddGeneralTasks(added);
        actionsApplied.push(`Added ${added.length} general task${added.length > 1 ? 's' : ''}`);
      }

      if (Array.isArray(data.completeTaskIds) && data.completeTaskIds.length > 0) {
        onCompleteTasks(data.completeTaskIds);
        actionsApplied.push(`Marked ${data.completeTaskIds.length} task(s) done`);
      }

      if (Array.isArray(data.newScheduleBlocks) && data.newScheduleBlocks.length > 0) {
        const blocks: ScheduleBlock[] = data.newScheduleBlocks.map(
          (b: {
            title: string;
            startMinute: number;
            endMinute: number;
            type: string;
            locked: boolean;
          }) => ({
            id: createId('blk'),
            date: workspace.activeDate,
            startMinute: b.startMinute,
            endMinute: b.endMinute,
            title: b.title,
            type: (['deep_work', 'meeting', 'admin', 'buffer'].includes(b.type)
              ? b.type
              : 'admin') as ScheduleBlockType,
            locked: Boolean(b.locked),
          })
        );
        onAddScheduleBlocks(blocks);
        actionsApplied.push(`Added ${blocks.length} schedule block(s)`);
      }

      if (actionsApplied.length > 0) {
        onNotify(actionsApplied.join(' · '));
      }

      const aiMsg: ChatMessage = {
        id: createId('am'),
        role: 'assistant',
        content: data.assistantReply,
        timestamp: new Date().toTimeString().slice(0, 5),
        quickReplies: Array.isArray(data.quickReplies) ? data.quickReplies : [],
        actionSummary: actionsApplied,
        triggersMvpGrill: data.intent === 'mvp_grill',
      };
      onAddMessages([aiMsg]);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Assistant failed', 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-56px)] max-w-[960px] flex-col p-6">
      {/* Header + Gemini Live Voice Bar */}
      <div className="space-y-4 border-b border-[#212836] pb-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="font-display text-2xl font-semibold tracking-tight text-[#F1F5F9]">
              Operations Assistant & Gemini Live Voice
            </h1>
            <p className="text-xs text-[#8B949E]">
              Speak naturally in real time via Gemini Live or type commands to manage general tasks, block calendar slots, or launch an MVP grill.
            </p>
          </div>
        </div>

        {/* Gemini Live Control Strip */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#212836] bg-[#121720] px-4 py-3">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="inline-flex items-center gap-1.5 font-medium text-[#F1F5F9]">
              <Volume2 className="h-4 w-4 text-[#3B82F6]" />
              Gemini Live Audio
            </span>
            <span aria-hidden="true" className="text-[#6E7681]">
              ·
            </span>
            <span
              className={`font-mono text-xs ${
                liveStatus === 'speaking'
                  ? 'text-[#93C5FD]'
                  : liveStatus === 'listening'
                  ? 'text-[#4ADE80]'
                  : liveStatus === 'connecting'
                  ? 'text-[#FBBF24]'
                  : 'text-[#8B949E]'
              }`}
            >
              {liveStatus === 'off'
                ? 'Voice off'
                : liveStatus === 'connecting'
                ? 'Connecting 16kHz/24kHz PCM...'
                : liveStatus === 'speaking'
                ? 'Assistant speaking (barge-in enabled)'
                : muted
                ? 'Mic muted'
                : 'Listening live'}
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            <select
              aria-label="Gemini Live voice"
              value={voiceName}
              disabled={liveStatus !== 'off'}
              onChange={(e) => setVoiceName(e.target.value as VoiceOption)}
              className="rounded-md border border-[#212836] bg-[#090C10] px-2.5 py-1.5 text-xs text-[#F1F5F9] disabled:opacity-50"
            >
              {VOICES.map((v) => (
                <option key={v} value={v}>
                  Voice: {v}
                </option>
              ))}
            </select>

            {liveStatus === 'off' ? (
              <button
                type="button"
                onClick={startLiveSession}
                className="inline-flex items-center gap-1.5 rounded-md bg-[#3B82F6] px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] whitespace-nowrap shrink-0"
              >
                <Mic className="h-3.5 w-3.5" />
                Start Live Voice
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setMuted((m) => !m)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#2E3748] bg-[#090C10] px-3 py-1.5 text-xs font-medium text-[#F1F5F9] hover:bg-[#181E29] whitespace-nowrap shrink-0"
                >
                  {muted ? (
                    <>
                      <MicOff className="h-3.5 w-3.5 text-[#FBBF24]" />
                      Unmute
                    </>
                  ) : (
                    <>
                      <Mic className="h-3.5 w-3.5 text-[#4ADE80]" />
                      Mute
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={stopLiveSession}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#DC2626]/50 bg-[#2A1215] px-3 py-1.5 text-xs font-medium text-[#FCA5A5] hover:bg-[#3A171B] whitespace-nowrap shrink-0"
                >
                  <PhoneOff className="h-3.5 w-3.5" />
                  End Voice
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Conversation & Live Transcript Stream */}
      <div className="flex-1 space-y-4 overflow-y-auto py-5">
        {workspace.assistantMessages.map((msg) => (
          <div
            key={msg.id}
            className={`space-y-2 ${msg.role === 'user' ? 'ml-12 text-right' : 'mr-8 text-left'}`}
          >
            <div
              className={`inline-block rounded-lg border px-4 py-3 text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'border-[#2563EB]/40 bg-[#17253B] text-[#F1F5F9]'
                  : 'border-[#212836] bg-[#121720] text-[#F1F5F9]'
              }`}
            >
              <p className="whitespace-pre-wrap text-left">{msg.content}</p>

              {msg.actionSummary && msg.actionSummary.length > 0 && (
                <div className="mt-2.5 border-t border-[#212836] pt-2 text-xs text-[#4ADE80]">
                  Applied: {msg.actionSummary.join(' · ')}
                </div>
              )}

              {msg.triggersMvpGrill && (
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => {
                      const prevUser = [...workspace.assistantMessages]
                        .reverse()
                        .find((m) => m.role === 'user');
                      onLaunchMvpGrillWithPrompt(
                        prevUser?.content || 'I want to work on a new MVP.'
                      );
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[#3B82F6] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-[#2563EB]"
                  >
                    Open MVP Griller Studio
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>

            <div className="font-mono text-[11px] tabular-nums text-[#6E7681]">
              {msg.role === 'user' ? 'You' : 'Operations Agent'} · {msg.timestamp}
            </div>

            {msg.role === 'assistant' && msg.quickReplies && msg.quickReplies.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {msg.quickReplies.map((reply) => (
                  <button
                    key={reply}
                    type="button"
                    onClick={() => sendAssistantMessage(reply)}
                    disabled={loading}
                    className="rounded-md border border-[#2E3748] bg-[#0D1117] px-3 py-1.5 text-xs text-[#93C5FD] transition-colors hover:border-[#3B82F6] hover:bg-[#181E29]"
                  >
                    {reply}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

        {/* In-progress Live Voice Captions */}
        {liveUserCaption && (
          <div className="ml-12 text-right space-y-1">
            <div className="inline-block rounded-lg border border-[#2563EB]/40 bg-[#17253B]/80 px-4 py-2.5 text-sm text-[#F1F5F9]">
              <p className="text-left">{liveUserCaption}</p>
            </div>
            <div className="font-mono text-[11px] text-[#8B949E]">You (live transcript)</div>
          </div>
        )}

        {liveModelCaption && (
          <div className="mr-8 text-left space-y-1">
            <div className="inline-block rounded-lg border border-[#212836] bg-[#121720] px-4 py-2.5 text-sm text-[#F1F5F9]">
              <p className="text-left">{liveModelCaption}</p>
            </div>
            <div className="font-mono text-[11px] text-[#93C5FD]">
              Gemini Live ({voiceName})
            </div>
          </div>
        )}

        {loading && (
          <div className="mr-8 space-y-2 rounded-lg border border-[#212836] bg-[#121720] p-4">
            <div className="h-3 w-1/2 animate-pulse rounded bg-[#212836]" />
            <div className="h-3 w-3/4 animate-pulse rounded bg-[#212836]" />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Text Input Bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendAssistantMessage(input);
        }}
        className="flex items-center gap-2 border-t border-[#212836] pt-4"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            liveStatus !== 'off'
              ? 'Speak into your mic or type a follow-up to Gemini Live...'
              : "Ask anything: add general tasks, check schedule, or 'I want to work on an MVP for...'"
          }
          className="flex-1 rounded-md border border-[#212836] bg-[#121720] px-3.5 py-2.5 text-sm text-[#F1F5F9] placeholder-[#6E7681] focus:border-[#3B82F6] focus:outline-none"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-[#3B82F6] px-4 py-2.5 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] disabled:opacity-50 whitespace-nowrap shrink-0"
        >
          <Send className="h-3.5 w-3.5" />
          Send
        </button>
      </form>
    </div>
  );
};
