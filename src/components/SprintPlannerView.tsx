import React, { useMemo, useState } from 'react';
import {
  CalendarPlus,
  Columns3,
  Plus,
  Search,
  Sparkles,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import type {
  ProjectBlueprint,
  Sprint,
  TaskCategory,
  TaskItem,
  TaskPriority,
  TaskStatus,
} from '../types/workspace';
import { createId, formatDuration } from '../utils/scheduleUtils';

interface SprintPlannerViewProps {
  blueprint: ProjectBlueprint;
  sprints: Sprint[];
  tasks: TaskItem[];
  activeDate: string;
  onAddTask: (task: TaskItem) => void;
  onUpdateTask: (taskId: string, patch: Partial<TaskItem>) => void;
  onDeleteTask: (taskId: string) => void;
  onReplaceSprintsAndTasks: (sprints: Sprint[], sprintTasks: TaskItem[]) => void;
  onScheduleTask: (task: TaskItem) => void;
  onNotify: (message: string, tone?: 'info' | 'error') => void;
}

const STATUS_COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'in_review', label: 'In Review' },
  { key: 'done', label: 'Done' },
];

export const SprintPlannerView: React.FC<SprintPlannerViewProps> = ({
  blueprint,
  sprints,
  tasks,
  activeDate,
  onAddTask,
  onUpdateTask,
  onDeleteTask,
  onReplaceSprintsAndTasks,
  onScheduleTask,
  onNotify,
}) => {
  const sprintTasks = useMemo(() => tasks.filter((t) => t.scope === 'sprint'), [tasks]);

  const [selectedSprintId, setSelectedSprintId] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'board' | 'table'>('board');
  const [search, setSearch] = useState('');
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [rebalancing, setRebalancing] = useState(false);

  // Add task drawer
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSprintId, setNewSprintId] = useState(sprints[0]?.id || '');
  const [newCategory, setNewCategory] = useState<TaskCategory>('engineering');
  const [newPriority, setNewPriority] = useState<TaskPriority>('high');
  const [newPoints, setNewPoints] = useState(3);
  const [newMinutes, setNewMinutes] = useState(60);
  const [newCriteria, setNewCriteria] = useState('');

  const filteredTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sprintTasks.filter((t) => {
      if (selectedSprintId !== 'all' && t.sprintId !== selectedSprintId) return false;
      if (q && !t.title.toLowerCase().includes(q) && !t.description.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [sprintTasks, selectedSprintId, search]);

  const activeSprint = sprints.find((s) => s.id === selectedSprintId);
  const totalPoints = filteredTasks.reduce((acc, t) => acc + (t.points || 0), 0);
  const completedPoints = filteredTasks
    .filter((t) => t.status === 'done')
    .reduce((acc, t) => acc + (t.points || 0), 0);

  const editingTask = sprintTasks.find((t) => t.id === editingTaskId) || null;

  async function handleAiRebalance() {
    setRebalancing(true);
    try {
      const res = await fetch('/api/agent/sprint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blueprint,
          sprints,
          tasks: sprintTasks,
          activeDate,
          instruction:
            'Rebalance sprint capacities, sharpen acceptance criteria, and ensure Sprint 0->2 sequence leads to production deployment.',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sprint rebalance failed');

      const keyToId: Record<string, string> = {};
      const nextSprints: Sprint[] = (data.sprints || []).map(
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

      const nextTasks: TaskItem[] = (data.tasks || []).map(
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

      if (nextSprints.length > 0) {
        onReplaceSprintsAndTasks(nextSprints, nextTasks);
        setSelectedSprintId('all');
        onNotify(data.summary || 'Sprints rebalanced for deployment');
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Rebalance failed', 'error');
    } finally {
      setRebalancing(false);
    }
  }

  function handleCreateSprintTask(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    onAddTask({
      id: createId('tsk'),
      scope: 'sprint',
      sprintId: newSprintId || sprints[0]?.id,
      title: newTitle.trim(),
      description: '',
      category: newCategory,
      priority: newPriority,
      status: 'backlog',
      points: newPoints,
      estimatedMinutes: newMinutes,
      subtasks: [],
      acceptanceCriteria: newCriteria.trim(),
      createdAt: new Date().toISOString(),
    });
    setNewTitle('');
    setNewCriteria('');
    setShowAddForm(false);
    onNotify('Sprint task created');
  }

  function sprintNameById(id?: string): string {
    return sprints.find((s) => s.id === id)?.name.split(':')[0] || 'Unassigned';
  }

  return (
    <div className="mx-auto max-w-[1360px] space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#212836] pb-5">
        <div className="space-y-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-[#F1F5F9]">
            Sprint Planner — {blueprint.title}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#8B949E]">
            <span>{activeSprint ? activeSprint.goal : 'All active and planned sprints'}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              {completedPoints}/{totalPoints} story points done
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleAiRebalance}
            disabled={rebalancing}
            className="inline-flex items-center gap-1.5 rounded-md border border-[#2E3748] bg-[#121720] px-3.5 py-2 text-xs font-medium text-[#F1F5F9] transition-colors hover:bg-[#181E29] disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Sparkles className="h-3.5 w-3.5 text-[#3B82F6]" />
            {rebalancing ? 'Rebalancing...' : 'AI Rebalance Sprints'}
          </button>
          <button
            type="button"
            onClick={() => {
              setNewSprintId(
                selectedSprintId !== 'all' ? selectedSprintId : sprints[0]?.id || ''
              );
              setShowAddForm((v) => !v);
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-[#3B82F6] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            New Sprint Task
          </button>
        </div>
      </div>

      {/* Add Sprint Task Form */}
      {showAddForm && (
        <form
          onSubmit={handleCreateSprintTask}
          className="grid grid-cols-1 gap-3 rounded-lg border border-[#212836] bg-[#121720] p-4 sm:grid-cols-12"
        >
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Deliverable title..."
            className="rounded-md border border-[#212836] bg-[#090C10] px-3 py-2 text-sm text-[#F1F5F9] placeholder-[#6E7681] sm:col-span-5"
          />
          <select
            aria-label="Sprint"
            value={newSprintId}
            onChange={(e) => setNewSprintId(e.target.value)}
            className="rounded-md border border-[#212836] bg-[#090C10] px-2.5 py-2 text-xs text-[#F1F5F9] sm:col-span-3"
          >
            {sprints.map((sp) => (
              <option key={sp.id} value={sp.id}>
                {sp.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Category"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value as TaskCategory)}
            className="rounded-md border border-[#212836] bg-[#090C10] px-2.5 py-2 text-xs text-[#F1F5F9] sm:col-span-2"
          >
            <option value="engineering">Engineering</option>
            <option value="design">Design</option>
            <option value="devops">DevOps</option>
            <option value="admin">Admin</option>
          </select>
          <select
            aria-label="Priority"
            value={newPriority}
            onChange={(e) => setNewPriority(e.target.value as TaskPriority)}
            className="rounded-md border border-[#212836] bg-[#090C10] px-2.5 py-2 text-xs text-[#F1F5F9] sm:col-span-2"
          >
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>

          <input
            type="text"
            value={newCriteria}
            onChange={(e) => setNewCriteria(e.target.value)}
            placeholder="Acceptance criteria..."
            className="rounded-md border border-[#212836] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9] placeholder-[#6E7681] sm:col-span-6"
          />
          <div className="flex items-center gap-2 sm:col-span-3">
            <label className="text-xs text-[#8B949E]">Pts:</label>
            <select
              value={newPoints}
              onChange={(e) => setNewPoints(Number(e.target.value))}
              className="rounded-md border border-[#212836] bg-[#090C10] px-2 py-2 font-mono text-xs tabular-nums text-[#F1F5F9]"
            >
              {[1, 2, 3, 5, 8].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <label className="text-xs text-[#8B949E]">Est:</label>
            <select
              value={newMinutes}
              onChange={(e) => setNewMinutes(Number(e.target.value))}
              className="rounded-md border border-[#212836] bg-[#090C10] px-2 py-2 font-mono text-xs tabular-nums text-[#F1F5F9]"
            >
              {[30, 60, 90, 120].map((m) => (
                <option key={m} value={m}>
                  {m}m
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-end gap-2 sm:col-span-3">
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="px-3 py-2 text-xs text-[#8B949E] hover:text-[#F1F5F9]"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-md bg-[#3B82F6] px-4 py-2 text-xs font-medium text-white hover:bg-[#2563EB]"
            >
              Create Task
            </button>
          </div>
        </form>
      )}

      {/* Sprint Selector + View Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-[#212836] bg-[#121720] p-1">
          <button
            type="button"
            onClick={() => setSelectedSprintId('all')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              selectedSprintId === 'all'
                ? 'bg-[#181E29] text-[#F1F5F9]'
                : 'text-[#8B949E] hover:text-[#F1F5F9]'
            }`}
          >
            All Sprints
          </button>
          {sprints.map((sp) => (
            <button
              key={sp.id}
              type="button"
              onClick={() => setSelectedSprintId(sp.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                selectedSprintId === sp.id
                  ? 'bg-[#181E29] text-[#F1F5F9]'
                  : 'text-[#8B949E] hover:text-[#F1F5F9]'
              }`}
            >
              {sp.name.split(':')[0]}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#6E7681]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sprint tasks..."
              className="w-52 rounded-md border border-[#212836] bg-[#121720] py-1.5 pl-8 pr-3 text-xs text-[#F1F5F9] placeholder-[#6E7681] focus:border-[#3B82F6] focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-1 rounded-md border border-[#212836] bg-[#121720] p-1">
            <button
              type="button"
              onClick={() => setViewMode('board')}
              className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                viewMode === 'board'
                  ? 'bg-[#181E29] text-[#F1F5F9]'
                  : 'text-[#8B949E] hover:text-[#F1F5F9]'
              }`}
            >
              <Columns3 className="h-3.5 w-3.5" />
              Board
            </button>
            <button
              type="button"
              onClick={() => setViewMode('table')}
              className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                viewMode === 'table'
                  ? 'bg-[#181E29] text-[#F1F5F9]'
                  : 'text-[#8B949E] hover:text-[#F1F5F9]'
              }`}
            >
              <Table2 className="h-3.5 w-3.5" />
              Table
            </button>
          </div>
        </div>
      </div>

      {/* Board or Table */}
      {viewMode === 'board' ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {STATUS_COLUMNS.map((col) => {
            const colTasks = filteredTasks.filter((t) => t.status === col.key);
            return (
              <div
                key={col.key}
                className="flex flex-col rounded-lg border border-[#212836] bg-[#0D1117]"
              >
                <div className="flex items-center justify-between border-b border-[#212836] px-3.5 py-2.5">
                  <span className="font-display text-xs font-semibold text-[#F1F5F9]">
                    {col.label}
                  </span>
                  <span className="font-mono text-xs tabular-nums text-[#8B949E]">
                    {colTasks.length}
                  </span>
                </div>

                <div className="flex-1 divide-y divide-[#212836]">
                  {colTasks.length === 0 ? (
                    <div className="p-6 text-center text-xs text-[#6E7681]">No tasks</div>
                  ) : (
                    colTasks.map((task) => (
                      <div
                        key={task.id}
                        className="space-y-2 p-3.5 transition-colors hover:bg-[#121720]"
                      >
                        <button
                          type="button"
                          onClick={() => setEditingTaskId(task.id)}
                          className="block w-full text-left text-sm font-medium text-[#F1F5F9] hover:text-[#93C5FD]"
                        >
                          {task.title}
                        </button>

                        <div className="flex flex-wrap items-center gap-2 text-xs text-[#8B949E]">
                          <span>{sprintNameById(task.sprintId)}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">{task.points || 0} pts</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            {formatDuration(task.estimatedMinutes)}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="capitalize">{task.priority}</span>
                        </div>

                        <div className="flex items-center justify-between pt-1">
                          <select
                            aria-label={`Change status for ${task.title}`}
                            value={task.status}
                            onChange={(e) =>
                              onUpdateTask(task.id, { status: e.target.value as TaskStatus })
                            }
                            className="rounded border border-[#212836] bg-[#090C10] px-2 py-1 text-[11px] text-[#8B949E] focus:border-[#3B82F6] focus:outline-none"
                          >
                            {STATUS_COLUMNS.map((s) => (
                              <option key={s.key} value={s.key}>
                                {s.label}
                              </option>
                            ))}
                          </select>

                          <button
                            type="button"
                            onClick={() => onScheduleTask(task)}
                            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-[#8B949E] hover:bg-[#181E29] hover:text-[#93C5FD]"
                          >
                            <CalendarPlus className="h-3 w-3" />
                            Schedule
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[#212836] bg-[#121720]">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="border-b border-[#212836] bg-[#090C10] text-[#8B949E]">
              <tr>
                <th className="px-4 py-3 font-medium">Deliverable</th>
                <th className="px-3 py-3 font-medium">Sprint</th>
                <th className="px-3 py-3 font-medium">Category</th>
                <th className="px-3 py-3 font-medium">Priority</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-3 py-3 text-right font-medium">Points</th>
                <th className="px-3 py-3 text-right font-medium">Est.</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#212836]">
              {filteredTasks.map((task) => (
                <tr key={task.id} className="transition-colors hover:bg-[#151B26]">
                  <td className="px-4 py-2.5">
                    <button
                      type="button"
                      onClick={() => setEditingTaskId(task.id)}
                      className="text-left text-sm font-medium text-[#F1F5F9] hover:text-[#93C5FD]"
                    >
                      {task.title}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-[#8B949E] whitespace-nowrap">
                    {sprintNameById(task.sprintId)}
                  </td>
                  <td className="px-3 py-2.5 capitalize text-[#8B949E]">{task.category}</td>
                  <td className="px-3 py-2.5 capitalize text-[#F1F5F9]">{task.priority}</td>
                  <td className="px-3 py-2.5">
                    <select
                      aria-label={`Status for ${task.title}`}
                      value={task.status}
                      onChange={(e) =>
                        onUpdateTask(task.id, { status: e.target.value as TaskStatus })
                      }
                      className="rounded border border-[#212836] bg-[#090C10] px-2 py-1 text-xs text-[#F1F5F9]"
                    >
                      {STATUS_COLUMNS.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-[#F1F5F9]">
                    {task.points || 0}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-[#8B949E]">
                    {formatDuration(task.estimatedMinutes)}
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => onScheduleTask(task)}
                      className="mr-2 text-[#93C5FD] hover:underline"
                    >
                      Schedule
                    </button>
                    <button
                      type="button"
                      aria-label="Delete sprint task"
                      onClick={() => onDeleteTask(task.id)}
                      className="text-[#6E7681] hover:text-[#F87171]"
                    >
                      <Trash2 className="inline h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Slide-over Task Detail Editor */}
      {editingTask && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/60">
          <div className="flex h-full w-full max-w-md flex-col border-l border-[#212836] bg-[#121720] p-6 space-y-4 overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[#212836] pb-3">
              <h2 className="font-display text-base font-semibold text-[#F1F5F9]">
                Edit Sprint Deliverable
              </h2>
              <button
                type="button"
                aria-label="Close drawer"
                onClick={() => setEditingTaskId(null)}
                className="rounded p-1 text-[#8B949E] hover:bg-[#181E29] hover:text-[#F1F5F9]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <label className="block space-y-1">
              <span className="text-xs font-medium text-[#8B949E]">Title</span>
              <input
                type="text"
                value={editingTask.title}
                onChange={(e) => onUpdateTask(editingTask.id, { title: e.target.value })}
                className="w-full rounded-md border border-[#212836] bg-[#090C10] px-3 py-2 text-sm text-[#F1F5F9]"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs font-medium text-[#8B949E]">Description</span>
              <textarea
                rows={3}
                value={editingTask.description}
                onChange={(e) => onUpdateTask(editingTask.id, { description: e.target.value })}
                className="w-full rounded-md border border-[#212836] bg-[#090C10] px-3 py-2 text-sm text-[#F1F5F9]"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-xs font-medium text-[#8B949E]">Sprint</span>
                <select
                  value={editingTask.sprintId || ''}
                  onChange={(e) => onUpdateTask(editingTask.id, { sprintId: e.target.value })}
                  className="w-full rounded-md border border-[#212836] bg-[#090C10] px-2.5 py-2 text-xs text-[#F1F5F9]"
                >
                  {sprints.map((sp) => (
                    <option key={sp.id} value={sp.id}>
                      {sp.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-[#8B949E]">Status</span>
                <select
                  value={editingTask.status}
                  onChange={(e) =>
                    onUpdateTask(editingTask.id, { status: e.target.value as TaskStatus })
                  }
                  className="w-full rounded-md border border-[#212836] bg-[#090C10] px-2.5 py-2 text-xs text-[#F1F5F9]"
                >
                  {STATUS_COLUMNS.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-[#8B949E]">Story Points</span>
                <input
                  type="number"
                  min={1}
                  max={21}
                  value={editingTask.points || 3}
                  onChange={(e) =>
                    onUpdateTask(editingTask.id, { points: Number(e.target.value) || 1 })
                  }
                  className="w-full rounded-md border border-[#212836] bg-[#090C10] px-3 py-2 font-mono text-xs tabular-nums text-[#F1F5F9]"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-[#8B949E]">Est. Minutes</span>
                <input
                  type="number"
                  min={15}
                  step={15}
                  value={editingTask.estimatedMinutes}
                  onChange={(e) =>
                    onUpdateTask(editingTask.id, {
                      estimatedMinutes: Number(e.target.value) || 30,
                    })
                  }
                  className="w-full rounded-md border border-[#212836] bg-[#090C10] px-3 py-2 font-mono text-xs tabular-nums text-[#F1F5F9]"
                />
              </label>
            </div>

            <label className="block space-y-1">
              <span className="text-xs font-medium text-[#8B949E]">Acceptance Criteria</span>
              <textarea
                rows={3}
                value={editingTask.acceptanceCriteria || ''}
                onChange={(e) =>
                  onUpdateTask(editingTask.id, { acceptanceCriteria: e.target.value })
                }
                className="w-full rounded-md border border-[#212836] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9]"
              />
            </label>

            <div className="flex items-center justify-between border-t border-[#212836] pt-4">
              <button
                type="button"
                onClick={() => {
                  onUpdateTask(editingTask.id, { scope: 'general', sprintId: undefined });
                  setEditingTaskId(null);
                  onNotify('Moved task to General Tasks');
                }}
                className="text-xs text-[#8B949E] hover:text-[#F1F5F9]"
              >
                Move to General Tasks
              </button>

              <button
                type="button"
                onClick={() => setEditingTaskId(null)}
                className="rounded-md bg-[#3B82F6] px-4 py-2 text-xs font-medium text-white hover:bg-[#2563EB]"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
