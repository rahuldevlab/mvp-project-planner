import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Clock,
  Lock,
  Plus,
  Sparkles,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';
import type {
  ProposedSchedulePlan,
  ScheduleBlock,
  ScheduleBlockType,
  TaskItem,
} from '../types/workspace';
import {
  calculateDailyLoad,
  createId,
  detectScheduleConflicts,
  formatDuration,
  formatMinutesToTime,
  parseTimeToMinutes,
} from '../utils/scheduleUtils';

interface ScheduleViewProps {
  activeDate: string;
  workdayStartMinute: number;
  workdayEndMinute: number;
  blocks: ScheduleBlock[];
  tasks: TaskItem[];
  onChangeActiveDate: (date: string) => void;
  onAddBlock: (block: ScheduleBlock) => void;
  onUpdateBlock: (blockId: string, patch: Partial<ScheduleBlock>) => void;
  onDeleteBlock: (blockId: string) => void;
  onReplaceDayBlocks: (date: string, nextBlocks: ScheduleBlock[]) => void;
  onNotify: (message: string, tone?: 'info' | 'error') => void;
}

export const ScheduleView: React.FC<ScheduleViewProps> = ({
  activeDate,
  workdayStartMinute,
  workdayEndMinute,
  blocks,
  tasks,
  onChangeActiveDate,
  onAddBlock,
  onUpdateBlock,
  onDeleteBlock,
  onReplaceDayBlocks,
  onNotify,
}) => {
  const dayBlocks = useMemo(
    () =>
      blocks
        .filter((b) => b.date === activeDate)
        .slice()
        .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute),
    [blocks, activeDate]
  );

  const conflicts = useMemo(
    () => detectScheduleConflicts(blocks, activeDate),
    [blocks, activeDate]
  );

  const conflictBlockIds = useMemo(() => {
    const set = new Set<string>();
    for (const c of conflicts) {
      set.add(c.blockAId);
      set.add(c.blockBId);
    }
    return set;
  }, [conflicts]);

  const load = useMemo(
    () => calculateDailyLoad(blocks, activeDate, workdayStartMinute, workdayEndMinute),
    [blocks, activeDate, workdayStartMinute, workdayEndMinute]
  );

  const scheduledTaskIds = useMemo(() => {
    const set = new Set<string>();
    for (const b of dayBlocks) {
      if (b.linkedTaskId) set.add(b.linkedTaskId);
    }
    return set;
  }, [dayBlocks]);

  const [queueFilter, setQueueFilter] = useState<'all' | 'general' | 'sprint'>('all');
  const unscheduledTasks = useMemo(
    () =>
      tasks.filter((t) => {
        if (t.status === 'done') return false;
        if (scheduledTaskIds.has(t.id)) return false;
        if (queueFilter !== 'all' && t.scope !== queueFilter) return false;
        return true;
      }),
    [tasks, scheduledTaskIds, queueFilter]
  );

  // Manual block form
  const [showAddBlock, setShowAddBlock] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newStart, setNewStart] = useState('15:00');
  const [newEnd, setNewEnd] = useState('16:00');
  const [newType, setNewType] = useState<ScheduleBlockType>('meeting');
  const [newLocked, setNewLocked] = useState(true);

  // AI Auto-Schedule state
  const [preferences, setPreferences] = useState('');
  const [optimizing, setOptimizing] = useState(false);
  const [proposedPlan, setProposedPlan] = useState<ProposedSchedulePlan | null>(null);

  function handleCreateBlock(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    const startMinute = parseTimeToMinutes(newStart);
    const endMinute = Math.max(startMinute + 15, parseTimeToMinutes(newEnd));

    onAddBlock({
      id: createId('blk'),
      date: activeDate,
      startMinute,
      endMinute,
      title: newTitle.trim(),
      type: newType,
      locked: newLocked,
    });
    setNewTitle('');
    setShowAddBlock(false);
    onNotify('Schedule block added');
  }

  function handleQuickPlaceTask(task: TaskItem) {
    // Find earliest conflict-free slot starting at workdayStartMinute
    const duration = Math.max(15, task.estimatedMinutes);
    const sorted = dayBlocks.slice().sort((a, b) => a.startMinute - b.startMinute);
    let candidateStart = workdayStartMinute;

    for (const b of sorted) {
      if (candidateStart + duration <= b.startMinute) {
        break;
      }
      if (candidateStart < b.endMinute) {
        candidateStart = b.endMinute;
      }
    }

    onAddBlock({
      id: createId('blk'),
      date: activeDate,
      startMinute: candidateStart,
      endMinute: candidateStart + duration,
      title: task.title,
      type: task.category === 'admin' || task.category === 'operations' ? 'admin' : 'deep_work',
      linkedTaskId: task.id,
      linkedTaskScope: task.scope,
      locked: false,
    });
    onNotify(`Scheduled "${task.title}" at ${formatMinutesToTime(candidateStart)}`);
  }

  async function handleAutoSchedule() {
    setOptimizing(true);
    try {
      const candidateTasks = tasks
        .filter((t) => t.status !== 'done' && !scheduledTaskIds.has(t.id))
        .slice(0, 10)
        .map((t) => ({
          id: t.id,
          scope: t.scope,
          title: t.title,
          priority: t.priority,
          estimatedMinutes: t.estimatedMinutes,
          category: t.category,
          dueDate: t.dueDate,
        }));

      const res = await fetch('/api/agent/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activeDate,
          workdayStartMinute,
          workdayEndMinute,
          existingBlocks: dayBlocks,
          candidateTasks,
          preferences,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to optimize schedule');

      const nextBlocks: ScheduleBlock[] = (data.blocks || []).map(
        (b: {
          id?: string;
          title: string;
          startMinute: number;
          endMinute: number;
          type: string;
          linkedTaskId?: string;
          linkedTaskScope?: string;
          locked: boolean;
          notes?: string;
        }) => ({
          id: b.id || createId('blk'),
          date: activeDate,
          startMinute: b.startMinute,
          endMinute: b.endMinute,
          title: b.title,
          type: (['deep_work', 'meeting', 'admin', 'buffer'].includes(b.type)
            ? b.type
            : 'deep_work') as ScheduleBlockType,
          linkedTaskId: b.linkedTaskId || undefined,
          linkedTaskScope:
            b.linkedTaskScope === 'general' || b.linkedTaskScope === 'sprint'
              ? b.linkedTaskScope
              : undefined,
          locked: Boolean(b.locked),
          notes: b.notes || undefined,
        })
      );

      setProposedPlan({
        blocks: nextBlocks.sort((a, b) => a.startMinute - b.startMinute),
        resolutions: data.resolutions || [],
        unscheduledTaskIds: data.unscheduledTaskIds || [],
        summary: data.summary || 'Conflict-free schedule prepared.',
      });
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Auto-schedule failed', 'error');
    } finally {
      setOptimizing(false);
    }
  }

  function applyProposedPlan() {
    if (!proposedPlan) return;
    onReplaceDayBlocks(activeDate, proposedPlan.blocks);
    setProposedPlan(null);
    onNotify('Conflict-free schedule applied');
  }

  return (
    <div className="mx-auto max-w-[1360px] space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#212836] pb-5">
        <div className="space-y-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-[#F1F5F9]">
            Daily Schedule & Conflict Resolver
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#8B949E]">
            <span className="font-mono tabular-nums">
              {formatDuration(load.scheduledMinutes)} scheduled / {formatDuration(load.capacityMinutes)} window
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              {formatDuration(load.focusMinutes)} deep work
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              {formatDuration(load.meetingMinutes)} meetings
            </span>
            <span aria-hidden="true">·</span>
            <span
              className={`font-mono tabular-nums font-medium ${
                conflicts.length > 0 ? 'text-[#FBBF24]' : 'text-[#4ADE80]'
              }`}
            >
              {conflicts.length > 0
                ? `${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} detected`
                : '0 conflicts'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input
            aria-label="Schedule date"
            type="date"
            value={activeDate}
            onChange={(e) => onChangeActiveDate(e.target.value)}
            className="rounded-md border border-[#212836] bg-[#121720] px-3 py-2 font-mono text-xs tabular-nums text-[#F1F5F9]"
          />
          <button
            type="button"
            onClick={() => setShowAddBlock((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md border border-[#2E3748] bg-[#121720] px-3.5 py-2 text-xs font-medium text-[#F1F5F9] hover:bg-[#181E29] whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Block
          </button>
          <button
            type="button"
            onClick={handleAutoSchedule}
            disabled={optimizing}
            className="inline-flex items-center gap-1.5 rounded-md bg-[#3B82F6] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {optimizing ? 'Resolving...' : 'Auto-Schedule & Resolve Conflicts'}
          </button>
        </div>
      </div>

      {/* Conflict Alert Banner */}
      {conflicts.length > 0 && (
        <div className="rounded-lg border border-[#D97706]/40 bg-[#D97706]/10 p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-[#FBBF24]">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              Schedule Overlaps Detected ({conflicts.length}) — Click "Auto-Schedule & Resolve Conflicts" to automatically repack movable blocks.
            </span>
          </div>
          <ul className="space-y-1 pl-6 text-xs text-[#F1F5F9]">
            {conflicts.map((c) => (
              <li key={c.id} className="list-disc font-mono tabular-nums">
                {c.summary}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Proposed AI Plan Preview */}
      {proposedPlan && (
        <div className="rounded-lg border border-[#3B82F6]/50 bg-[#121720] p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#212836] pb-3">
            <div>
              <h2 className="font-display text-sm font-semibold text-[#F1F5F9]">
                Proposed Conflict-Free Schedule
              </h2>
              <p className="text-xs text-[#8B949E]">{proposedPlan.summary}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setProposedPlan(null)}
                className="inline-flex items-center gap-1 rounded-md border border-[#2E3748] px-3 py-1.5 text-xs text-[#8B949E] hover:text-[#F1F5F9]"
              >
                <X className="h-3.5 w-3.5" />
                Discard
              </button>
              <button
                type="button"
                onClick={applyProposedPlan}
                className="inline-flex items-center gap-1 rounded-md bg-[#16A34A] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-[#15803D]"
              >
                <Check className="h-3.5 w-3.5" />
                Apply Plan ({proposedPlan.blocks.length} blocks)
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-[#8B949E]">Resolutions & Changes</h3>
              <ul className="space-y-1.5 text-xs text-[#F1F5F9]">
                {proposedPlan.resolutions.map((r, i) => (
                  <li key={i} className="rounded border border-[#212836] bg-[#090C10] px-3 py-2">
                    {r}
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-[#8B949E]">Preview Timeline</h3>
              <div className="divide-y divide-[#212836] rounded border border-[#212836] bg-[#090C10]">
                {proposedPlan.blocks.map((b) => (
                  <div
                    key={b.id}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                  >
                    <span className="font-mono tabular-nums text-[#93C5FD]">
                      {formatMinutesToTime(b.startMinute)}–{formatMinutesToTime(b.endMinute)}
                    </span>
                    <span className="flex-1 truncate text-[#F1F5F9]">{b.title}</span>
                    <span className="capitalize text-[#8B949E]">
                      {b.type.replace('_', ' ')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Manual Block Creator */}
      {showAddBlock && (
        <form
          onSubmit={handleCreateBlock}
          className="grid grid-cols-1 gap-3 rounded-lg border border-[#212836] bg-[#121720] p-4 sm:grid-cols-12"
        >
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Block or meeting title..."
            className="rounded-md border border-[#212836] bg-[#090C10] px-3 py-2 text-sm text-[#F1F5F9] placeholder-[#6E7681] sm:col-span-4"
          />
          <input
            aria-label="Start time"
            type="time"
            value={newStart}
            onChange={(e) => setNewStart(e.target.value)}
            className="rounded-md border border-[#212836] bg-[#090C10] px-2.5 py-2 font-mono text-xs tabular-nums text-[#F1F5F9] sm:col-span-2"
          />
          <input
            aria-label="End time"
            type="time"
            value={newEnd}
            onChange={(e) => setNewEnd(e.target.value)}
            className="rounded-md border border-[#212836] bg-[#090C10] px-2.5 py-2 font-mono text-xs tabular-nums text-[#F1F5F9] sm:col-span-2"
          />
          <select
            aria-label="Block type"
            value={newType}
            onChange={(e) => setNewType(e.target.value as ScheduleBlockType)}
            className="rounded-md border border-[#212836] bg-[#090C10] px-2.5 py-2 text-xs text-[#F1F5F9] sm:col-span-2"
          >
            <option value="meeting">Meeting</option>
            <option value="deep_work">Deep Work</option>
            <option value="admin">Admin</option>
            <option value="buffer">Buffer</option>
          </select>
          <div className="flex items-center justify-end gap-2 sm:col-span-2">
            <label className="inline-flex items-center gap-1 text-xs text-[#8B949E]">
              <input
                type="checkbox"
                checked={newLocked}
                onChange={(e) => setNewLocked(e.target.checked)}
                className="accent-[#3B82F6]"
              />
              Lock
            </label>
            <button
              type="submit"
              className="rounded-md bg-[#3B82F6] px-3.5 py-2 text-xs font-medium text-white hover:bg-[#2563EB]"
            >
              Add
            </button>
          </div>
        </form>
      )}

      {/* Main 2-Column Timeline + Unscheduled Queue */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left: Day Timeline */}
        <section className="space-y-3 lg:col-span-7">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-[#F1F5F9]">
              Time-Blocked Agenda ({activeDate})
            </h2>
            <span className="font-mono text-xs tabular-nums text-[#8B949E]">
              {dayBlocks.length} blocks
            </span>
          </div>

          {dayBlocks.length === 0 ? (
            <div className="rounded-lg border border-[#212836] bg-[#121720] p-10 text-center space-y-2">
              <p className="text-sm font-medium text-[#F1F5F9]">No time blocks scheduled for {activeDate}.</p>
              <p className="text-xs text-[#8B949E]">
                Add tasks from the queue on the right or click "Auto-Schedule & Resolve Conflicts" to populate your day.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-[#212836] rounded-lg border border-[#212836] bg-[#121720]">
              {dayBlocks.map((block) => {
                const isConflict = conflictBlockIds.has(block.id);
                const duration = block.endMinute - block.startMinute;

                return (
                  <div
                    key={block.id}
                    className={`flex flex-wrap items-center justify-between gap-3 p-4 transition-colors ${
                      isConflict ? 'bg-[#D97706]/8' : 'hover:bg-[#151B26]'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-1.5 font-mono text-xs tabular-nums text-[#93C5FD]">
                        <Clock className="h-3.5 w-3.5 text-[#8B949E]" />
                        <input
                          aria-label={`Start time for ${block.title}`}
                          type="time"
                          value={formatMinutesToTime(block.startMinute)}
                          onChange={(e) => {
                            const nextStart = parseTimeToMinutes(e.target.value);
                            onUpdateBlock(block.id, {
                              startMinute: nextStart,
                              endMinute: Math.max(nextStart + 15, block.endMinute),
                            });
                          }}
                          className="rounded border border-[#212836] bg-[#090C10] px-1.5 py-1 text-xs text-[#F1F5F9]"
                        />
                        <span>–</span>
                        <input
                          aria-label={`End time for ${block.title}`}
                          type="time"
                          value={formatMinutesToTime(block.endMinute)}
                          onChange={(e) => {
                            const nextEnd = parseTimeToMinutes(e.target.value);
                            onUpdateBlock(block.id, {
                              endMinute: Math.max(block.startMinute + 15, nextEnd),
                            });
                          }}
                          className="rounded border border-[#212836] bg-[#090C10] px-1.5 py-1 text-xs text-[#F1F5F9]"
                        />
                      </div>
                    </div>

                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-[#F1F5F9]">
                          {block.title}
                        </span>
                        {isConflict && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#FBBF24] whitespace-nowrap">
                            <AlertTriangle className="h-3 w-3" />
                            Conflict
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-[#8B949E]">
                        <span className="capitalize">{block.type.replace('_', ' ')}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">{formatDuration(duration)}</span>
                        {block.linkedTaskScope && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="capitalize">{block.linkedTaskScope} task</span>
                          </>
                        )}
                        <span aria-hidden="true">·</span>
                        <span>{block.locked ? 'Locked commitment' : 'Movable'}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onUpdateBlock(block.id, { locked: !block.locked })}
                        title={block.locked ? 'Unlock block' : 'Lock block'}
                        className="rounded p-1.5 text-[#8B949E] hover:bg-[#181E29] hover:text-[#F1F5F9]"
                      >
                        {block.locked ? (
                          <Lock className="h-3.5 w-3.5 text-[#93C5FD]" />
                        ) : (
                          <Unlock className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        aria-label="Remove block"
                        onClick={() => onDeleteBlock(block.id)}
                        className="rounded p-1.5 text-[#6E7681] hover:bg-[#181E29] hover:text-[#F87171]"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Scheduler Preference Hint */}
          <div className="rounded-lg border border-[#212836] bg-[#121720] p-3.5 space-y-2">
            <label className="block text-xs font-medium text-[#8B949E]">
              Scheduling Constraint / Preference for AI Auto-Scheduler
            </label>
            <input
              type="text"
              value={preferences}
              onChange={(e) => setPreferences(e.target.value)}
              placeholder="e.g., Keep 12:00–12:45 open for lunch; prioritize critical SSL renewal before 17:00..."
              className="w-full rounded-md border border-[#212836] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9] placeholder-[#6E7681] focus:border-[#3B82F6] focus:outline-none"
            />
          </div>
        </section>

        {/* Right: Unscheduled Tasks Queue (General + Sprint) */}
        <section className="space-y-3 lg:col-span-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-sm font-semibold text-[#F1F5F9]">
              Unscheduled Task Queue
            </h2>
            <div className="flex items-center gap-1 rounded-md border border-[#212836] bg-[#121720] p-0.5">
              {(['all', 'general', 'sprint'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setQueueFilter(tab)}
                  className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    queueFilter === tab
                      ? 'bg-[#181E29] text-[#F1F5F9]'
                      : 'text-[#8B949E] hover:text-[#F1F5F9]'
                  }`}
                >
                  {tab === 'all' ? 'All' : tab === 'general' ? 'General' : 'Sprint'}
                </button>
              ))}
            </div>
          </div>

          <div className="divide-y divide-[#212836] rounded-lg border border-[#212836] bg-[#121720]">
            {unscheduledTasks.length === 0 ? (
              <div className="p-8 text-center text-xs text-[#8B949E]">
                All open tasks in this view are already scheduled or completed.
              </div>
            ) : (
              unscheduledTasks.map((task) => (
                <div
                  key={task.id}
                  className="flex items-center justify-between gap-3 p-3.5 hover:bg-[#151B26]"
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="truncate text-xs font-medium text-[#F1F5F9]">{task.title}</p>
                    <div className="flex items-center gap-2 text-[11px] text-[#8B949E]">
                      <span className="capitalize">{task.scope}</span>
                      <span aria-hidden="true">·</span>
                      <span className="capitalize">{task.priority}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {formatDuration(task.estimatedMinutes)}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleQuickPlaceTask(task)}
                    className="rounded border border-[#2E3748] bg-[#090C10] px-2.5 py-1 text-[11px] font-medium text-[#93C5FD] transition-colors hover:border-[#3B82F6] hover:bg-[#181E29] whitespace-nowrap shrink-0"
                  >
                    Place Today
                  </button>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
