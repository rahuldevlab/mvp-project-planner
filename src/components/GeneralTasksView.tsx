import React, { useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  CalendarPlus,
  ListTree,
  Plus,
  Search,
  Sparkles,
  Trash2,
  ArrowUpRight,
} from 'lucide-react';
import type {
  Sprint,
  TaskCategory,
  TaskItem,
  TaskPriority,
  TaskRecurrence,
  TaskStatus,
} from '../types/workspace';
import { createId, formatDuration } from '../utils/scheduleUtils';

interface GeneralTasksViewProps {
  tasks: TaskItem[];
  sprints: Sprint[];
  activeDate: string;
  onAddTasks: (newTasks: TaskItem[]) => void;
  onUpdateTask: (taskId: string, patch: Partial<TaskItem>) => void;
  onDeleteTask: (taskId: string) => void;
  onScheduleTask: (task: TaskItem) => void;
  onPromoteToSprint: (taskId: string, sprintId: string) => void;
  onNotify: (message: string, tone?: 'info' | 'error') => void;
}

const CATEGORIES: TaskCategory[] = [
  'admin',
  'operations',
  'engineering',
  'devops',
  'design',
  'personal',
];

const PRIORITIES: TaskPriority[] = ['critical', 'high', 'medium', 'low'];

export const GeneralTasksView: React.FC<GeneralTasksViewProps> = ({
  tasks,
  sprints,
  activeDate,
  onAddTasks,
  onUpdateTask,
  onDeleteTask,
  onScheduleTask,
  onPromoteToSprint,
  onNotify,
}) => {
  const generalTasks = useMemo(
    () => tasks.filter((t) => t.scope === 'general'),
    [tasks]
  );

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'done'>('open');
  const [categoryFilter, setCategoryFilter] = useState<'all' | TaskCategory>('all');

  // Quick Add state
  const [newTitle, setNewTitle] = useState('');
  const [newCategory, setNewCategory] = useState<TaskCategory>('admin');
  const [newPriority, setNewPriority] = useState<TaskPriority>('medium');
  const [newMinutes, setNewMinutes] = useState(30);
  const [newDueDate, setNewDueDate] = useState(activeDate);
  const [newRecurrence, setNewRecurrence] = useState<TaskRecurrence>('none');

  // AI Brain-Dump state
  const [showBrainDump, setShowBrainDump] = useState(false);
  const [rawNotes, setRawNotes] = useState('');
  const [parsingDump, setParsingDump] = useState(false);

  // Expanded subtasks & AI breakdown loading
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({ gen_1: true, gen_2: true });
  const [breakingDownId, setBreakingDownId] = useState<string | null>(null);
  const [promotingId, setPromotingId] = useState<string | null>(null);

  const filteredTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return generalTasks.filter((t) => {
      if (statusFilter === 'open' && t.status === 'done') return false;
      if (statusFilter === 'done' && t.status !== 'done') return false;
      if (categoryFilter !== 'all' && t.category !== categoryFilter) return false;
      if (q && !t.title.toLowerCase().includes(q) && !t.description.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [generalTasks, search, statusFilter, categoryFilter]);

  const openCount = generalTasks.filter((t) => t.status !== 'done').length;
  const doneCount = generalTasks.filter((t) => t.status === 'done').length;
  const totalOpenMinutes = generalTasks
    .filter((t) => t.status !== 'done')
    .reduce((acc, t) => acc + t.estimatedMinutes, 0);

  function handleQuickAdd(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = newTitle.trim();
    if (!trimmed) return;

    const item: TaskItem = {
      id: createId('gen'),
      scope: 'general',
      title: trimmed,
      description: '',
      category: newCategory,
      priority: newPriority,
      status: 'backlog',
      estimatedMinutes: Math.max(10, Number(newMinutes) || 30),
      dueDate: newDueDate || undefined,
      recurrence: newRecurrence,
      subtasks: [],
      createdAt: new Date().toISOString(),
    };
    onAddTasks([item]);
    setNewTitle('');
    onNotify('General task added');
  }

  async function handleParseBrainDump() {
    if (!rawNotes.trim()) return;
    setParsingDump(true);
    try {
      const res = await fetch('/api/agent/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'parse_dump',
          rawNotes,
          activeDate,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to parse notes');

      const parsedTasks: TaskItem[] = (data.tasks || []).map(
        (raw: {
          title: string;
          description?: string;
          category?: string;
          priority?: string;
          estimatedMinutes?: number;
          dueDate?: string;
          recurrence?: string;
        }) => ({
          id: createId('gen'),
          scope: 'general',
          title: raw.title,
          description: raw.description || '',
          category: (CATEGORIES.includes(raw.category as TaskCategory)
            ? raw.category
            : 'operations') as TaskCategory,
          priority: (PRIORITIES.includes(raw.priority as TaskPriority)
            ? raw.priority
            : 'medium') as TaskPriority,
          status: 'backlog' as TaskStatus,
          estimatedMinutes: raw.estimatedMinutes || 30,
          dueDate: raw.dueDate || undefined,
          recurrence: (['none', 'daily', 'weekly'].includes(raw.recurrence || '')
            ? raw.recurrence
            : 'none') as TaskRecurrence,
          subtasks: [],
          createdAt: new Date().toISOString(),
        })
      );

      if (parsedTasks.length === 0) {
        onNotify('No actionable tasks found in notes', 'error');
      } else {
        onAddTasks(parsedTasks);
        setRawNotes('');
        setShowBrainDump(false);
        onNotify(`Extracted ${parsedTasks.length} general tasks`);
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to parse notes', 'error');
    } finally {
      setParsingDump(false);
    }
  }

  async function handleBreakdownTask(task: TaskItem) {
    setBreakingDownId(task.id);
    try {
      const res = await fetch('/api/agent/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'breakdown_subtasks',
          taskTitle: task.title,
          taskDescription: task.description,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate subtasks');

      const newSubtasks = (data.subtasks || []).map((title: string) => ({
        id: createId('sub'),
        title,
        done: false,
      }));

      onUpdateTask(task.id, {
        subtasks: [...task.subtasks, ...newSubtasks],
      });
      setExpandedIds((prev) => ({ ...prev, [task.id]: true }));
      onNotify(`Added ${newSubtasks.length} actionable steps`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Breakdown failed', 'error');
    } finally {
      setBreakingDownId(null);
    }
  }

  function priorityColor(priority: TaskPriority): string {
    if (priority === 'critical') return 'text-[#F87171]';
    if (priority === 'high') return 'text-[#FBBF24]';
    if (priority === 'medium') return 'text-[#93C5FD]';
    return 'text-[#8B949E]';
  }

  return (
    <div className="mx-auto max-w-[1200px] space-y-6 p-6">
      {/* Header & Summary Strip */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#212836] pb-5">
        <div className="space-y-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-[#F1F5F9]">
            General Tasks & Daily Inbox
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#8B949E]">
            <span className="font-mono tabular-nums">{openCount} open</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{doneCount} completed</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{formatDuration(totalOpenMinutes)} estimated remaining</span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowBrainDump((v) => !v)}
          className="inline-flex items-center gap-2 rounded-lg border border-[#2E3748] bg-[#121720] px-4 py-2 text-xs font-medium text-[#F1F5F9] transition-colors hover:bg-[#181E29] whitespace-nowrap shrink-0"
        >
          <Sparkles className="h-3.5 w-3.5 text-[#3B82F6]" />
          {showBrainDump ? 'Hide AI Brain-Dump' : 'AI Parse Brain-Dump'}
        </button>
      </div>

      {/* AI Brain-Dump Extractor Panel */}
      {showBrainDump && (
        <section className="rounded-lg border border-[#212836] bg-[#121720] p-5 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-sm font-semibold text-[#F1F5F9]">
                Extract Tasks from Unstructured Notes
              </h2>
              <p className="text-xs text-[#8B949E]">
                Paste meeting follow-ups, Slack reminders, or daily errands. The assistant infers duration, priority, category, and due dates.
              </p>
            </div>
          </div>
          <textarea
            value={rawNotes}
            onChange={(e) => setRawNotes(e.target.value)}
            rows={4}
            placeholder="Example: Follow up with AWS rep on credits by tomorrow, fix staging Redis timeout (60m, urgent), schedule dentist next week, send Q4 hiring budget sheet to Elena..."
            className="w-full rounded-md border border-[#212836] bg-[#090C10] px-3 py-2.5 text-sm text-[#F1F5F9] placeholder-[#6E7681] focus:border-[#3B82F6] focus:outline-none"
          />
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => setShowBrainDump(false)}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-[#8B949E] hover:text-[#F1F5F9]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleParseBrainDump}
              disabled={parsingDump || !rawNotes.trim()}
              className="inline-flex items-center gap-2 rounded-md bg-[#3B82F6] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {parsingDump ? 'Extracting Tasks...' : 'Extract & Add Tasks'}
            </button>
          </div>
        </section>
      )}

      {/* Quick Manual Add Bar */}
      <form
        onSubmit={handleQuickAdd}
        className="grid grid-cols-1 gap-3 rounded-lg border border-[#212836] bg-[#121720] p-4 md:grid-cols-12"
      >
        <div className="md:col-span-5">
          <label htmlFor="quick-task-title" className="sr-only">
            New general task title
          </label>
          <input
            id="quick-task-title"
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Add a general task (e.g., Audit vendor contract, review PRs)..."
            className="w-full rounded-md border border-[#212836] bg-[#090C10] px-3 py-2 text-sm text-[#F1F5F9] placeholder-[#6E7681] focus:border-[#3B82F6] focus:outline-none"
          />
        </div>
        <div className="md:col-span-2">
          <select
            aria-label="Task category"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value as TaskCategory)}
            className="w-full rounded-md border border-[#212836] bg-[#090C10] px-2.5 py-2 text-xs text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c.charAt(0).toUpperCase() + c.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div className="md:col-span-2">
          <select
            aria-label="Task priority"
            value={newPriority}
            onChange={(e) => setNewPriority(e.target.value as TaskPriority)}
            className="w-full rounded-md border border-[#212836] bg-[#090C10] px-2.5 py-2 text-xs text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                Priority: {p.charAt(0).toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 md:col-span-3">
          <select
            aria-label="Estimated duration"
            value={newMinutes}
            onChange={(e) => setNewMinutes(Number(e.target.value))}
            className="w-24 rounded-md border border-[#212836] bg-[#090C10] px-2 py-2 font-mono text-xs tabular-nums text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
          >
            <option value={15}>15m</option>
            <option value={30}>30m</option>
            <option value={45}>45m</option>
            <option value={60}>60m</option>
            <option value={90}>90m</option>
          </select>
          <input
            aria-label="Due date"
            type="date"
            value={newDueDate}
            onChange={(e) => setNewDueDate(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-[#212836] bg-[#090C10] px-2 py-2 font-mono text-xs tabular-nums text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
          />
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-md bg-[#3B82F6] px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </button>
        </div>
        <div className="flex items-center gap-4 text-xs text-[#8B949E] md:col-span-12">
          <span className="font-medium text-[#8B949E]">Recurrence:</span>
          {(['none', 'daily', 'weekly'] as TaskRecurrence[]).map((rec) => (
            <button
              key={rec}
              type="button"
              onClick={() => setNewRecurrence(rec)}
              className={`rounded px-2 py-1 text-xs transition-colors ${
                newRecurrence === rec
                  ? 'bg-[#181E29] text-[#F1F5F9] border border-[#2E3748]'
                  : 'text-[#8B949E] hover:text-[#F1F5F9]'
              }`}
            >
              {rec === 'none' ? 'One-off' : rec.charAt(0).toUpperCase() + rec.slice(1)}
            </button>
          ))}
        </div>
      </form>

      {/* Filter & Search Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 rounded-lg border border-[#212836] bg-[#121720] p-1">
          {(['open', 'all', 'done'] as const).map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setStatusFilter(status)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                statusFilter === status
                  ? 'bg-[#181E29] text-[#F1F5F9]'
                  : 'text-[#8B949E] hover:text-[#F1F5F9]'
              }`}
            >
              {status === 'open' ? 'Open' : status === 'all' ? 'All Tasks' : 'Completed'}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Filter by category"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as 'all' | TaskCategory)}
            className="rounded-md border border-[#212836] bg-[#121720] px-3 py-1.5 text-xs text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
          >
            <option value="all">All Categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c.charAt(0).toUpperCase() + c.slice(1)}
              </option>
            ))}
          </select>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#6E7681]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter general tasks..."
              className="w-56 rounded-md border border-[#212836] bg-[#121720] py-1.5 pl-8 pr-3 text-xs text-[#F1F5F9] placeholder-[#6E7681] focus:border-[#3B82F6] focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Task List */}
      {filteredTasks.length === 0 ? (
        <div className="rounded-lg border border-[#212836] bg-[#121720] p-10 text-center space-y-3">
          <p className="text-sm font-medium text-[#F1F5F9]">No general tasks match this filter.</p>
          <p className="text-xs text-[#8B949E]">
            Add a task above, paste messy notes into AI Brain-Dump, or switch to All Tasks.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-[#212836] rounded-lg border border-[#212836] bg-[#121720]">
          {filteredTasks.map((task) => {
            const isDone = task.status === 'done';
            const isExpanded = !!expandedIds[task.id];
            const completedSubtasks = task.subtasks.filter((s) => s.done).length;

            return (
              <div key={task.id} className="p-4 transition-colors hover:bg-[#151B26]">
                <div className="flex items-start gap-3">
                  {/* Completion Checkbox */}
                  <button
                    type="button"
                    aria-label={isDone ? 'Mark task open' : 'Mark task complete'}
                    onClick={() =>
                      onUpdateTask(task.id, { status: isDone ? 'backlog' : 'done' })
                    }
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
                      isDone
                        ? 'border-[#16A34A] bg-[#16A34A] text-white'
                        : 'border-[#2E3748] bg-[#090C10] text-transparent hover:border-[#3B82F6]'
                    }`}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>

                  {/* Main Task Info */}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedIds((prev) => ({ ...prev, [task.id]: !prev[task.id] }))
                        }
                        className={`text-left text-sm font-medium transition-colors ${
                          isDone ? 'text-[#6E7681] line-through' : 'text-[#F1F5F9]'
                        }`}
                      >
                        {task.title}
                      </button>

                      {/* Inline Action Controls */}
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleBreakdownTask(task)}
                          disabled={breakingDownId === task.id}
                          title="AI Break Down into Subtasks"
                          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-[#8B949E] transition-colors hover:bg-[#181E29] hover:text-[#F1F5F9] whitespace-nowrap shrink-0"
                        >
                          <ListTree className="h-3.5 w-3.5" />
                          {breakingDownId === task.id ? 'Splitting...' : 'Subtasks'}
                        </button>

                        <button
                          type="button"
                          onClick={() => onScheduleTask(task)}
                          title="Place onto Today's Schedule"
                          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-[#8B949E] transition-colors hover:bg-[#181E29] hover:text-[#93C5FD] whitespace-nowrap shrink-0"
                        >
                          <CalendarPlus className="h-3.5 w-3.5" />
                          Schedule
                        </button>

                        {sprints.length > 0 && (
                          <div className="relative">
                            <button
                              type="button"
                              onClick={() =>
                                setPromotingId((cur) => (cur === task.id ? null : task.id))
                              }
                              title="Promote to Sprint"
                              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-[#8B949E] transition-colors hover:bg-[#181E29] hover:text-[#F1F5F9] whitespace-nowrap shrink-0"
                            >
                              <ArrowUpRight className="h-3.5 w-3.5" />
                              To Sprint
                            </button>
                            {promotingId === task.id && (
                              <div className="absolute right-0 top-8 z-20 w-56 rounded-md border border-[#2E3748] bg-[#0D1117] py-1 shadow-lg">
                                {sprints.map((sp) => (
                                  <button
                                    key={sp.id}
                                    type="button"
                                    onClick={() => {
                                      onPromoteToSprint(task.id, sp.id);
                                      setPromotingId(null);
                                    }}
                                    className="block w-full px-3 py-1.5 text-left text-xs text-[#F1F5F9] hover:bg-[#181E29]"
                                  >
                                    {sp.name}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        <button
                          type="button"
                          aria-label="Delete task"
                          onClick={() => onDeleteTask(task.id)}
                          className="rounded p-1.5 text-[#6E7681] transition-colors hover:bg-[#181E29] hover:text-[#F87171]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Clean Unboxed Metadata */}
                    <div className="flex flex-wrap items-center gap-2 text-xs text-[#8B949E]">
                      <span className="capitalize">{task.category}</span>
                      <span aria-hidden="true">·</span>
                      <span className={`capitalize font-medium ${priorityColor(task.priority)}`}>
                        {task.priority}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {formatDuration(task.estimatedMinutes)}
                      </span>
                      {task.dueDate && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">Due {task.dueDate}</span>
                        </>
                      )}
                      {task.recurrence && task.recurrence !== 'none' && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="capitalize">{task.recurrence}</span>
                        </>
                      )}
                      {task.subtasks.length > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedIds((prev) => ({ ...prev, [task.id]: !prev[task.id] }))
                            }
                            className="inline-flex items-center gap-1 font-mono tabular-nums text-[#8B949E] hover:text-[#F1F5F9]"
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-3 w-3" />
                            ) : (
                              <ChevronRight className="h-3 w-3" />
                            )}
                            {completedSubtasks}/{task.subtasks.length} steps
                          </button>
                        </>
                      )}
                    </div>

                    {/* Expanded Details & Subtasks */}
                    {isExpanded && (
                      <div className="mt-3 space-y-2.5 border-t border-[#212836] pt-3">
                        {task.description && (
                          <p className="text-xs leading-relaxed text-[#8B949E]">
                            {task.description}
                          </p>
                        )}
                        {task.subtasks.length > 0 && (
                          <div className="space-y-1.5">
                            {task.subtasks.map((sub) => (
                              <label
                                key={sub.id}
                                className="flex cursor-pointer items-center gap-2.5 text-xs text-[#F1F5F9]"
                              >
                                <input
                                  type="checkbox"
                                  checked={sub.done}
                                  onChange={() =>
                                    onUpdateTask(task.id, {
                                      subtasks: task.subtasks.map((s) =>
                                        s.id === sub.id ? { ...s, done: !s.done } : s
                                      ),
                                    })
                                  }
                                  className="h-3.5 w-3.5 rounded border-[#2E3748] bg-[#090C10] accent-[#3B82F6]"
                                />
                                <span className={sub.done ? 'text-[#6E7681] line-through' : ''}>
                                  {sub.title}
                                </span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
