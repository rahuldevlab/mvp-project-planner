import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Plus,
  RotateCcw,
  Send,
  Trash2,
} from 'lucide-react';
import type {
  ChatMessage,
  ProjectBlueprint,
  Sprint,
  TaskCategory,
  TaskItem,
  TaskPriority,
  TechStackItem,
} from '../types/workspace';
import { createId } from '../utils/scheduleUtils';

interface MvpGrillerViewProps {
  blueprint: ProjectBlueprint;
  sprints: Sprint[];
  tasks: TaskItem[];
  messages: ChatMessage[];
  activeDate: string;
  onUpdateBlueprint: (patch: Partial<ProjectBlueprint>) => void;
  onReplaceSprintsAndTasks: (sprints: Sprint[], sprintTasks: TaskItem[]) => void;
  onAddMessages: (msgs: ChatMessage[]) => void;
  onStartFreshGrill: () => void;
  onOpenSprintBoard: () => void;
  onNotify: (message: string, tone?: 'info' | 'error') => void;
}

export const MvpGrillerView: React.FC<MvpGrillerViewProps> = ({
  blueprint,
  sprints,
  tasks,
  messages,
  activeDate,
  onUpdateBlueprint,
  onReplaceSprintsAndTasks,
  onAddMessages,
  onStartFreshGrill,
  onOpenSprintBoard,
  onNotify,
}) => {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [rightTab, setRightTab] = useState<'blueprint' | 'stack' | 'roadmap'>('blueprint');
  const [newNonGoal, setNewNonGoal] = useState('');
  const [newLayer, setNewLayer] = useState('');
  const [newChoice, setNewChoice] = useState('');
  const [newRationale, setNewRationale] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  const sprintTasks = tasks.filter((t) => t.scope === 'sprint');

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function sendGrillMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const nowTime = new Date().toTimeString().slice(0, 5);
    const userMsg: ChatMessage = {
      id: createId('gm'),
      role: 'user',
      content: trimmed,
      timestamp: nowTime,
    };

    onAddMessages([userMsg]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/agent/grill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          history: [...messages, userMsg].map((m) => ({ role: m.role, content: m.content })),
          currentBlueprint: blueprint,
          currentSprints: sprints,
          currentSprintTasks: sprintTasks,
          activeDate,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'MVP Griller request failed');

      if (data.blueprintPatch) {
        const patch = data.blueprintPatch;
        const nextStack: TechStackItem[] = Array.isArray(patch.techStack)
          ? patch.techStack.map((item: { layer: string; choice: string; rationale: string }) => ({
              id: createId('ts'),
              layer: item.layer,
              choice: item.choice,
              rationale: item.rationale,
            }))
          : blueprint.techStack;

        onUpdateBlueprint({
          ...(patch.title ? { title: patch.title } : {}),
          ...(patch.pitch ? { pitch: patch.pitch } : {}),
          ...(patch.problemStatement ? { problemStatement: patch.problemStatement } : {}),
          ...(patch.targetPersona ? { targetPersona: patch.targetPersona } : {}),
          ...(patch.coreMvpLoop ? { coreMvpLoop: patch.coreMvpLoop } : {}),
          ...(Array.isArray(patch.nonGoals) ? { nonGoals: patch.nonGoals } : {}),
          ...(patch.deploymentTarget ? { deploymentTarget: patch.deploymentTarget } : {}),
          techStack: nextStack,
          grillingStage: data.grillingStage || blueprint.grillingStage,
          readiness: data.readiness || blueprint.readiness,
        });
      } else if (data.readiness || data.grillingStage) {
        onUpdateBlueprint({
          grillingStage: data.grillingStage || blueprint.grillingStage,
          readiness: data.readiness || blueprint.readiness,
        });
      }

      if (data.shouldUpdateSprints && Array.isArray(data.sprints) && data.sprints.length > 0) {
        const keyToId: Record<string, string> = {};
        const nextSprints: Sprint[] = data.sprints.map(
          (sp: {
            key: string;
            name: string;
            goal: string;
            startDate: string;
            endDate: string;
            capacityPoints: number;
            status: string;
          }) => {
            const id = createId('sp');
            keyToId[sp.key] = id;
            return {
              id,
              name: sp.name,
              goal: sp.goal,
              startDate: sp.startDate,
              endDate: sp.endDate,
              capacityPoints: sp.capacityPoints || 15,
              status: (['planned', 'active', 'completed'].includes(sp.status)
                ? sp.status
                : 'planned') as Sprint['status'],
            };
          }
        );

        const nextTasks: TaskItem[] = (data.sprintTasks || []).map(
          (t: {
            sprintKey: string;
            title: string;
            description: string;
            category: string;
            priority: string;
            points: number;
            estimatedMinutes: number;
            acceptanceCriteria: string;
          }) => ({
            id: createId('tsk'),
            scope: 'sprint',
            sprintId: keyToId[t.sprintKey] || nextSprints[0]?.id,
            title: t.title,
            description: t.description || '',
            category: (['engineering', 'design', 'devops', 'admin', 'operations', 'personal'].includes(
              t.category
            )
              ? t.category
              : 'engineering') as TaskCategory,
            priority: (['critical', 'high', 'medium', 'low'].includes(t.priority)
              ? t.priority
              : 'medium') as TaskPriority,
            status: 'backlog',
            points: t.points || 3,
            estimatedMinutes: t.estimatedMinutes || 60,
            subtasks: [],
            acceptanceCriteria: t.acceptanceCriteria || '',
            createdAt: new Date().toISOString(),
          })
        );

        onReplaceSprintsAndTasks(nextSprints, nextTasks);
        onNotify(`Updated live sprint roadmap (${nextSprints.length} sprints, ${nextTasks.length} tasks)`);
      }

      const aiMsg: ChatMessage = {
        id: createId('gm'),
        role: 'assistant',
        content: data.assistantReply,
        timestamp: new Date().toTimeString().slice(0, 5),
        quickReplies: Array.isArray(data.quickReplies) ? data.quickReplies : [],
      };
      onAddMessages([aiMsg]);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'MVP Griller error', 'error');
    } finally {
      setLoading(false);
    }
  }

  const readinessItems = [
    { key: 'problemDefined', label: 'Problem & Pain', done: blueprint.readiness.problemDefined },
    { key: 'personaClear', label: 'Target Persona', done: blueprint.readiness.personaClear },
    { key: 'mvpLoopScoped', label: 'Core MVP Loop', done: blueprint.readiness.mvpLoopScoped },
    { key: 'stackSelected', label: 'Tech Stack', done: blueprint.readiness.stackSelected },
    { key: 'sprintsDrafted', label: 'Sprint Model', done: blueprint.readiness.sprintsDrafted },
  ];

  const completedChecks = readinessItems.filter((r) => r.done).length;

  function handleAddNonGoal(e: React.FormEvent) {
    e.preventDefault();
    if (!newNonGoal.trim()) return;
    onUpdateBlueprint({ nonGoals: [...blueprint.nonGoals, newNonGoal.trim()] });
    setNewNonGoal('');
  }

  function handleAddTechRow(e: React.FormEvent) {
    e.preventDefault();
    if (!newLayer.trim() || !newChoice.trim()) return;
    onUpdateBlueprint({
      techStack: [
        ...blueprint.techStack,
        {
          id: createId('ts'),
          layer: newLayer.trim(),
          choice: newChoice.trim(),
          rationale: newRationale.trim() || 'Selected for rapid MVP deployment.',
        },
      ],
    });
    setNewLayer('');
    setNewChoice('');
    setNewRationale('');
  }

  return (
    <div className="mx-auto max-w-[1360px] p-6 space-y-5">
      {/* Studio Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#212836] pb-4">
        <div className="space-y-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-[#F1F5F9]">
            MVP Griller & Live Blueprint Studio
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#8B949E]">
            <span>Stage: {blueprint.grillingStage.replace('_', ' ')}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{completedChecks}/5 blueprint pillars locked</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{sprints.length} sprints drafted</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onStartFreshGrill}
            className="inline-flex items-center gap-1.5 rounded-md border border-[#2E3748] bg-[#121720] px-3.5 py-2 text-xs font-medium text-[#F1F5F9] transition-colors hover:bg-[#181E29] whitespace-nowrap shrink-0"
          >
            <RotateCcw className="h-3.5 w-3.5 text-[#8B949E]" />
            Reset to Fresh Grill
          </button>
          <button
            type="button"
            onClick={onOpenSprintBoard}
            className="inline-flex items-center gap-1.5 rounded-md bg-[#3B82F6] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] whitespace-nowrap shrink-0"
          >
            Open Sprint Board
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 2-Column Split Studio */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-stretch">
        {/* Left: Guided Interrogation Stream */}
        <section className="flex flex-col rounded-lg border border-[#212836] bg-[#121720] lg:col-span-5 lg:h-[680px]">
          <div className="border-b border-[#212836] px-4 py-3">
            <h2 className="font-display text-sm font-semibold text-[#F1F5F9]">
              Interrogation Session
            </h2>
            <p className="text-xs text-[#8B949E]">
              Describe your MVP idea—each answer refines the blueprint, tech stack, and sprint model on the right.
            </p>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`space-y-2 ${
                  msg.role === 'user' ? 'ml-8 text-right' : 'mr-4 text-left'
                }`}
              >
                <div
                  className={`inline-block rounded-lg border px-3.5 py-2.5 text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'border-[#2563EB]/40 bg-[#17253B] text-[#F1F5F9]'
                      : 'border-[#212836] bg-[#0D1117] text-[#F1F5F9]'
                  }`}
                >
                  <p className="whitespace-pre-wrap text-left">{msg.content}</p>
                </div>
                <div className="font-mono text-[11px] tabular-nums text-[#6E7681]">
                  {msg.role === 'user' ? 'You' : 'Griller Agent'} · {msg.timestamp}
                </div>

                {msg.role === 'assistant' &&
                  msg.quickReplies &&
                  msg.quickReplies.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {msg.quickReplies.map((reply) => (
                        <button
                          key={reply}
                          type="button"
                          onClick={() => sendGrillMessage(reply)}
                          disabled={loading}
                          className="rounded-md border border-[#2E3748] bg-[#090C10] px-2.5 py-1.5 text-left text-xs text-[#93C5FD] transition-colors hover:border-[#3B82F6] hover:bg-[#181E29] disabled:opacity-50"
                        >
                          {reply}
                        </button>
                      ))}
                    </div>
                  )}
              </div>
            ))}

            {loading && (
              <div className="mr-4 space-y-2 rounded-lg border border-[#212836] bg-[#0D1117] p-3.5">
                <div className="h-3 w-2/3 animate-pulse rounded bg-[#212836]" />
                <div className="h-3 w-5/6 animate-pulse rounded bg-[#212836]" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-[#212836]" />
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendGrillMessage(input);
            }}
            className="border-t border-[#212836] p-3 flex items-center gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g., I want to work on an MVP for automated fleet compliance..."
              className="flex-1 rounded-md border border-[#212836] bg-[#090C10] px-3 py-2 text-sm text-[#F1F5F9] placeholder-[#6E7681] focus:border-[#3B82F6] focus:outline-none"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#3B82F6] px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Send className="h-3.5 w-3.5" />
              Send
            </button>
          </form>
        </section>

        {/* Right: Live Editable Blueprint, Tech Stack & Sprint Model */}
        <section className="flex flex-col rounded-lg border border-[#212836] bg-[#121720] lg:col-span-7 lg:h-[680px]">
          {/* Readiness Bar + Tab Switcher */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#212836] px-4 py-3">
            <div className="flex items-center gap-1 rounded-md border border-[#212836] bg-[#090C10] p-1">
              {(['blueprint', 'stack', 'roadmap'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setRightTab(tab)}
                  className={`rounded px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    rightTab === tab
                      ? 'bg-[#181E29] text-[#F1F5F9]'
                      : 'text-[#8B949E] hover:text-[#F1F5F9]'
                  }`}
                >
                  {tab === 'blueprint'
                    ? 'Project Blueprint'
                    : tab === 'stack'
                    ? `Tech Stack (${blueprint.techStack.length})`
                    : `Sprint Model (${sprints.length})`}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs text-[#8B949E]">
              {readinessItems.map((item) => (
                <span key={item.key} className="inline-flex items-center gap-1">
                  {item.done ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-[#16A34A]" />
                  ) : (
                    <Circle className="h-3.5 w-3.5 text-[#6E7681]" />
                  )}
                  <span className={item.done ? 'text-[#F1F5F9]' : 'text-[#6E7681]'}>
                    {item.label}
                  </span>
                </span>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-5">
            {rightTab === 'blueprint' && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-[#8B949E]">Project Name</span>
                    <input
                      type="text"
                      value={blueprint.title}
                      onChange={(e) => onUpdateBlueprint({ title: e.target.value })}
                      className="w-full rounded-md border border-[#212836] bg-[#090C10] px-3 py-2 text-sm text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-[#8B949E]">Deployment Target</span>
                    <input
                      type="text"
                      value={blueprint.deploymentTarget}
                      onChange={(e) => onUpdateBlueprint({ deploymentTarget: e.target.value })}
                      placeholder="e.g., Cloud Run + Managed Postgres"
                      className="w-full rounded-md border border-[#212836] bg-[#090C10] px-3 py-2 text-sm text-[#F1F5F9] placeholder-[#6E7681] focus:border-[#3B82F6] focus:outline-none"
                    />
                  </label>
                </div>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-[#8B949E]">One-Line Pitch</span>
                  <input
                    type="text"
                    value={blueprint.pitch}
                    onChange={(e) => onUpdateBlueprint({ pitch: e.target.value })}
                    className="w-full rounded-md border border-[#212836] bg-[#090C10] px-3 py-2 text-sm text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
                  />
                </label>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-[#8B949E]">Problem Statement</span>
                    <textarea
                      rows={3}
                      value={blueprint.problemStatement}
                      onChange={(e) => onUpdateBlueprint({ problemStatement: e.target.value })}
                      placeholder="What urgent pain does this solve?"
                      className="w-full rounded-md border border-[#212836] bg-[#090C10] px-3 py-2 text-sm text-[#F1F5F9] placeholder-[#6E7681] focus:border-[#3B82F6] focus:outline-none"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-[#8B949E]">Target Persona</span>
                    <textarea
                      rows={3}
                      value={blueprint.targetPersona}
                      onChange={(e) => onUpdateBlueprint({ targetPersona: e.target.value })}
                      placeholder="Who is the exact initial user?"
                      className="w-full rounded-md border border-[#212836] bg-[#090C10] px-3 py-2 text-sm text-[#F1F5F9] placeholder-[#6E7681] focus:border-[#3B82F6] focus:outline-none"
                    />
                  </label>
                </div>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-[#8B949E]">Core MVP Loop</span>
                  <textarea
                    rows={2}
                    value={blueprint.coreMvpLoop}
                    onChange={(e) => onUpdateBlueprint({ coreMvpLoop: e.target.value })}
                    placeholder="Input -> Processing -> Output -> User value..."
                    className="w-full rounded-md border border-[#212836] bg-[#090C10] px-3 py-2 text-sm text-[#F1F5F9] placeholder-[#6E7681] focus:border-[#3B82F6] focus:outline-none"
                  />
                </label>

                <div className="space-y-2 border-t border-[#212836] pt-4">
                  <span className="text-xs font-medium text-[#8B949E]">
                    Explicit v1 Non-Goals (Scope Cut-Line)
                  </span>
                  {blueprint.nonGoals.length === 0 ? (
                    <p className="text-xs text-[#6E7681]">
                      No non-goals logged yet. The Griller will challenge scope creep here.
                    </p>
                  ) : (
                    <ul className="divide-y divide-[#212836] rounded-md border border-[#212836] bg-[#090C10]">
                      {blueprint.nonGoals.map((ng, idx) => (
                        <li
                          key={`${ng}_${idx}`}
                          className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-[#F1F5F9]"
                        >
                          <span>{ng}</span>
                          <button
                            type="button"
                            aria-label="Remove non-goal"
                            onClick={() =>
                              onUpdateBlueprint({
                                nonGoals: blueprint.nonGoals.filter((_, i) => i !== idx),
                              })
                            }
                            className="text-[#6E7681] hover:text-[#F87171]"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <form onSubmit={handleAddNonGoal} className="flex items-center gap-2 pt-1">
                    <input
                      type="text"
                      value={newNonGoal}
                      onChange={(e) => setNewNonGoal(e.target.value)}
                      placeholder="Add explicit non-goal for v1..."
                      className="flex-1 rounded-md border border-[#212836] bg-[#090C10] px-3 py-1.5 text-xs text-[#F1F5F9] placeholder-[#6E7681] focus:border-[#3B82F6] focus:outline-none"
                    />
                    <button
                      type="submit"
                      className="inline-flex items-center gap-1 rounded-md border border-[#2E3748] bg-[#181E29] px-3 py-1.5 text-xs text-[#F1F5F9] hover:bg-[#212836]"
                    >
                      <Plus className="h-3 w-3" />
                      Add
                    </button>
                  </form>
                </div>
              </div>
            )}

            {rightTab === 'stack' && (
              <div className="space-y-4">
                {blueprint.techStack.length === 0 ? (
                  <p className="text-xs text-[#8B949E]">
                    Tech stack recommendations will populate automatically as you answer deployment and architecture questions.
                  </p>
                ) : (
                  <div className="overflow-hidden rounded-md border border-[#212836]">
                    <table className="w-full border-collapse text-left text-xs">
                      <thead className="border-b border-[#212836] bg-[#090C10] text-[#8B949E]">
                        <tr>
                          <th className="px-3 py-2.5 font-medium">Layer</th>
                          <th className="px-3 py-2.5 font-medium">Choice</th>
                          <th className="px-3 py-2.5 font-medium">Rationale</th>
                          <th className="w-10 px-2 py-2.5"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#212836] bg-[#0D1117]">
                        {blueprint.techStack.map((item) => (
                          <tr key={item.id}>
                            <td className="px-3 py-2.5 font-medium text-[#F1F5F9] whitespace-nowrap">
                              {item.layer}
                            </td>
                            <td className="px-3 py-2.5 font-mono text-[#93C5FD]">{item.choice}</td>
                            <td className="px-3 py-2.5 text-[#8B949E]">{item.rationale}</td>
                            <td className="px-2 py-2.5 text-right">
                              <button
                                type="button"
                                aria-label="Remove stack item"
                                onClick={() =>
                                  onUpdateBlueprint({
                                    techStack: blueprint.techStack.filter((s) => s.id !== item.id),
                                  })
                                }
                                className="text-[#6E7681] hover:text-[#F87171]"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <form
                  onSubmit={handleAddTechRow}
                  className="grid grid-cols-1 gap-2 border-t border-[#212836] pt-4 sm:grid-cols-12"
                >
                  <input
                    type="text"
                    value={newLayer}
                    onChange={(e) => setNewLayer(e.target.value)}
                    placeholder="Layer (e.g. Cache)"
                    className="rounded-md border border-[#212836] bg-[#090C10] px-2.5 py-1.5 text-xs text-[#F1F5F9] placeholder-[#6E7681] sm:col-span-3"
                  />
                  <input
                    type="text"
                    value={newChoice}
                    onChange={(e) => setNewChoice(e.target.value)}
                    placeholder="Technology choice"
                    className="rounded-md border border-[#212836] bg-[#090C10] px-2.5 py-1.5 text-xs text-[#F1F5F9] placeholder-[#6E7681] sm:col-span-4"
                  />
                  <input
                    type="text"
                    value={newRationale}
                    onChange={(e) => setNewRationale(e.target.value)}
                    placeholder="Rationale"
                    className="rounded-md border border-[#212836] bg-[#090C10] px-2.5 py-1.5 text-xs text-[#F1F5F9] placeholder-[#6E7681] sm:col-span-4"
                  />
                  <button
                    type="submit"
                    className="rounded-md bg-[#181E29] border border-[#2E3748] px-3 py-1.5 text-xs font-medium text-[#F1F5F9] hover:bg-[#212836] sm:col-span-1"
                  >
                    Add
                  </button>
                </form>
              </div>
            )}

            {rightTab === 'roadmap' && (
              <div className="space-y-4">
                {sprints.length === 0 ? (
                  <div className="rounded-md border border-[#212836] bg-[#090C10] p-6 text-center space-y-2">
                    <p className="text-sm font-medium text-[#F1F5F9]">No sprints drafted yet</p>
                    <p className="text-xs text-[#8B949E]">
                      Answer 1–2 grilling prompts or click below to ask the Griller to generate Sprint 0–2 from your blueprint.
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        sendGrillMessage(
                          'Draft the full 3-sprint model and tech stack based on what we have so far.'
                        )
                      }
                      className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-[#3B82F6] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-[#2563EB]"
                    >
                      Generate Sprint Roadmap
                    </button>
                  </div>
                ) : (
                  sprints.map((sp) => {
                    const spTasks = sprintTasks.filter((t) => t.sprintId === sp.id);
                    const totalPts = spTasks.reduce((sum, t) => sum + (t.points || 0), 0);
                    return (
                      <div
                        key={sp.id}
                        className="rounded-md border border-[#212836] bg-[#090C10] p-4 space-y-3"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <h3 className="font-display text-sm font-semibold text-[#F1F5F9]">
                            {sp.name}
                          </h3>
                          <span className="font-mono text-xs tabular-nums text-[#8B949E]">
                            {sp.startDate} – {sp.endDate} · {totalPts}/{sp.capacityPoints} pts
                          </span>
                        </div>
                        <p className="text-xs text-[#8B949E]">{sp.goal}</p>
                        <ul className="divide-y divide-[#212836] border-t border-[#212836] pt-1">
                          {spTasks.map((t) => (
                            <li
                              key={t.id}
                              className="flex items-center justify-between gap-3 py-2 text-xs"
                            >
                              <span className="text-[#F1F5F9]">{t.title}</span>
                              <span className="font-mono tabular-nums text-[#8B949E] whitespace-nowrap">
                                {t.points || 0} pts · {t.estimatedMinutes}m
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
