import React, { useMemo, useRef, useState } from 'react';
import {
  Bot,
  CalendarClock,
  CheckSquare,
  Download,
  FileText,
  Flame,
  Kanban,
  Menu,
  RotateCcw,
  Upload,
  X,
} from 'lucide-react';
import { AdminDraftsView } from './components/AdminDraftsView';
import { AssistantView } from './components/AssistantView';
import { GeneralTasksView } from './components/GeneralTasksView';
import { MvpGrillerView } from './components/MvpGrillerView';
import { ScheduleView } from './components/ScheduleView';
import { SprintPlannerView } from './components/SprintPlannerView';
import { createFreshMvpBlueprint, createInitialWorkspace } from './data/initialWorkspace';
import type {
  AdminDraft,
  ChatMessage,
  ProjectBlueprint,
  ScheduleBlock,
  Sprint,
  TaskItem,
  WorkspaceState,
  WorkspaceView,
} from './types/workspace';
import {
  createId,
  detectScheduleConflicts,
  formatMinutesToTime,
  validateImportedWorkspace,
} from './utils/scheduleUtils';

interface ToastState {
  id: string;
  message: string;
  tone: 'info' | 'error';
}

const VIEW_LABELS: Record<WorkspaceView, string> = {
  'general-tasks': 'General Tasks',
  'mvp-griller': 'MVP Griller',
  'sprint-plan': 'Sprint Plan',
  schedule: 'Daily Schedule',
  'admin-drafts': 'Admin Drafts',
  assistant: 'Operations Assistant',
};

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => createInitialWorkspace());
  const [activeView, setActiveView] = useState<WorkspaceView>('general-tasks');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function notify(message: string, tone: 'info' | 'error' = 'info') {
    const id = createId('toast');
    setToast({ id, message, tone });
    setTimeout(() => {
      setToast((cur) => (cur?.id === id ? null : cur));
    }, 3500);
  }

  const openGeneralCount = useMemo(
    () => workspace.tasks.filter((t) => t.scope === 'general' && t.status !== 'done').length,
    [workspace.tasks]
  );

  const sprintTaskCount = useMemo(
    () => workspace.tasks.filter((t) => t.scope === 'sprint').length,
    [workspace.tasks]
  );

  const readinessDone = useMemo(() => {
    const r = workspace.blueprint.readiness;
    return [r.problemDefined, r.personaClear, r.mvpLoopScoped, r.stackSelected, r.sprintsDrafted].filter(
      Boolean
    ).length;
  }, [workspace.blueprint.readiness]);

  const conflicts = useMemo(
    () => detectScheduleConflicts(workspace.scheduleBlocks, workspace.activeDate),
    [workspace.scheduleBlocks, workspace.activeDate]
  );

  function handleAddTasks(newTasks: TaskItem[]) {
    setWorkspace((prev) => ({
      ...prev,
      tasks: [...newTasks, ...prev.tasks],
    }));
  }

  function handleUpdateTask(taskId: string, patch: Partial<TaskItem>) {
    setWorkspace((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)),
    }));
  }

  function handleDeleteTask(taskId: string) {
    setWorkspace((prev) => ({
      ...prev,
      tasks: prev.tasks.filter((t) => t.id !== taskId),
      scheduleBlocks: prev.scheduleBlocks.filter((b) => b.linkedTaskId !== taskId),
    }));
    notify('Task deleted');
  }

  function handlePromoteToSprint(taskId: string, sprintId: string) {
    setWorkspace((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              scope: 'sprint',
              sprintId,
              points: t.points || 3,
            }
          : t
      ),
    }));
    notify('Promoted task to sprint backlog');
  }

  function handleScheduleTask(task: TaskItem) {
    const dayBlocks = workspace.scheduleBlocks
      .filter((b) => b.date === workspace.activeDate)
      .slice()
      .sort((a, b) => a.startMinute - b.startMinute);

    const existing = dayBlocks.find((b) => b.linkedTaskId === task.id);
    if (existing) {
      setActiveView('schedule');
      notify(`Already scheduled at ${formatMinutesToTime(existing.startMinute)}`);
      return;
    }

    const duration = Math.max(15, task.estimatedMinutes);
    let candidateStart = workspace.workdayStartMinute;
    for (const blk of dayBlocks) {
      if (candidateStart + duration <= blk.startMinute) break;
      if (candidateStart < blk.endMinute) candidateStart = blk.endMinute;
    }

    const newBlock: ScheduleBlock = {
      id: createId('blk'),
      date: workspace.activeDate,
      startMinute: candidateStart,
      endMinute: candidateStart + duration,
      title: task.title,
      type:
        task.category === 'admin' || task.category === 'operations'
          ? 'admin'
          : 'deep_work',
      linkedTaskId: task.id,
      linkedTaskScope: task.scope,
      locked: false,
    };

    setWorkspace((prev) => ({
      ...prev,
      scheduleBlocks: [...prev.scheduleBlocks, newBlock],
    }));
    notify(`Scheduled "${task.title}" at ${formatMinutesToTime(candidateStart)}`);
  }

  function handleUpdateBlueprint(patch: Partial<ProjectBlueprint>) {
    setWorkspace((prev) => ({
      ...prev,
      workspaceName: patch.title ? `${patch.title} Operations` : prev.workspaceName,
      blueprint: { ...prev.blueprint, ...patch },
    }));
  }

  function handleReplaceSprintsAndTasks(sprints: Sprint[], sprintTasks: TaskItem[]) {
    setWorkspace((prev) => ({
      ...prev,
      sprints,
      tasks: [...prev.tasks.filter((t) => t.scope === 'general'), ...sprintTasks],
    }));
  }

  function handleStartFreshMvpGrill(initialUserSeed?: string) {
    const nowTime = new Date().toTimeString().slice(0, 5);
    const introMsg: ChatMessage = {
      id: createId('gm'),
      role: 'assistant',
      content: initialUserSeed
        ? `Starting a fresh MVP grill for: "${initialUserSeed}". Tell me who the exact first user is, what the single core loop looks like, and any deployment or timeline constraints you're working with.`
        : 'Fresh MVP grill initialized. Tell me what you want to build (e.g., "I want to work on an MVP for...") and I will challenge the scope, lock your tech stack, and generate a sprint plan.',
      timestamp: nowTime,
      quickReplies: initialUserSeed
        ? [
            'B2B engineering teams, web app on Cloud Run, 3-week launch',
            'Solo founders, simple SaaS dashboard + Postgres, 2 sprints',
            'Internal ops tool, Node + React + minimal auth',
          ]
        : [
            'I want to work on an MVP for a client onboarding portal',
            'I want to work on an MVP for an AI release-notes generator',
            'I want to work on an MVP for an internal hardware inventory tracker',
          ],
    };

    setWorkspace((prev) => ({
      ...prev,
      workspaceName: 'New MVP Session',
      blueprint: createFreshMvpBlueprint(),
      sprints: [],
      tasks: prev.tasks.filter((t) => t.scope === 'general'),
      grillerMessages: [introMsg],
    }));
    setActiveView('mvp-griller');
    notify('Started fresh MVP grilling session');
  }

  function handleExportJson() {
    const blob = new Blob([JSON.stringify(workspace, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cadence-ops-${workspace.activeDate}.json`;
    a.click();
    URL.revokeObjectURL(url);
    notify('Exported workspace snapshot (.json)');
  }

  function handleImportJson(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!validateImportedWorkspace(parsed)) {
          throw new Error('Invalid Cadence Ops JSON snapshot format');
        }
        setWorkspace(parsed);
        notify(`Imported "${parsed.workspaceName}"`);
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Failed to import JSON', 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  const navItems: {
    id: WorkspaceView;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    meta: string;
    metaAlert?: boolean;
  }[] = [
    {
      id: 'general-tasks',
      label: 'General Tasks',
      icon: CheckSquare,
      meta: `${openGeneralCount}`,
    },
    {
      id: 'mvp-griller',
      label: 'MVP Griller',
      icon: Flame,
      meta: `${readinessDone}/5`,
    },
    {
      id: 'sprint-plan',
      label: 'Sprint Plan',
      icon: Kanban,
      meta: `${sprintTaskCount}`,
    },
    {
      id: 'schedule',
      label: 'Schedule',
      icon: CalendarClock,
      meta: conflicts.length > 0 ? `${conflicts.length} conflict` : 'Clear',
      metaAlert: conflicts.length > 0,
    },
    {
      id: 'admin-drafts',
      label: 'Admin Drafts',
      icon: FileText,
      meta: `${workspace.adminDrafts.length}`,
    },
    {
      id: 'assistant',
      label: 'Assistant',
      icon: Bot,
      meta: '',
    },
  ];

  return (
    <div className="flex min-h-screen bg-[#090C10] text-[#F1F5F9]">
      {/* Hidden JSON File Input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        onChange={handleImportJson}
        className="hidden"
      />

      {/* Desktop Left Sidebar */}
      <aside className="hidden w-[248px] shrink-0 flex-col border-r border-[#212836] bg-[#0D1117] lg:flex">
        <div className="flex h-14 items-center border-b border-[#212836] px-5">
          <span className="font-display text-base font-bold tracking-tight text-[#F1F5F9] whitespace-nowrap shrink-0">
            Cadence Ops
          </span>
        </div>

        <nav className="flex-1 space-y-1 p-3" aria-label="Workspace navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveView(item.id)}
                className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-[#181E29] text-[#F1F5F9]'
                    : 'text-[#8B949E] hover:bg-[#121720] hover:text-[#F1F5F9]'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className={`h-4 w-4 ${active ? 'text-[#3B82F6]' : 'text-[#8B949E]'}`} />
                  <span>{item.label}</span>
                </span>
                {item.meta && (
                  <span
                    className={`font-mono text-[11px] tabular-nums ${
                      item.metaAlert ? 'text-[#FBBF24]' : 'text-[#6E7681]'
                    }`}
                  >
                    {item.meta}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Session Scratchpad Controls */}
        <div className="border-t border-[#212836] p-3 space-y-1.5">
          <div className="px-2 pb-1 text-[11px] font-medium text-[#6E7681]">
            Session Scratchpad
          </div>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-[#8B949E] transition-colors hover:bg-[#121720] hover:text-[#F1F5F9]"
          >
            <Upload className="h-3.5 w-3.5" />
            Import JSON
          </button>
          <button
            type="button"
            onClick={() => {
              setWorkspace(createInitialWorkspace());
              notify('Restored sample BeaconFlow workspace');
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-[#8B949E] transition-colors hover:bg-[#121720] hover:text-[#F1F5F9]"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset Sample Data
          </button>
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="fixed inset-0 bg-black/60"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="relative z-10 flex w-64 flex-col border-r border-[#212836] bg-[#0D1117]">
            <div className="flex h-14 items-center justify-between border-b border-[#212836] px-4">
              <span className="font-display text-base font-bold text-[#F1F5F9]">
                Cadence Ops
              </span>
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setMobileNavOpen(false)}
                className="rounded p-1 text-[#8B949E] hover:text-[#F1F5F9]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <nav className="flex-1 space-y-1 p-3">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = activeView === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveView(item.id);
                      setMobileNavOpen(false);
                    }}
                    className={`flex w-full items-center justify-between rounded-md px-3 py-2.5 text-xs font-medium ${
                      active
                        ? 'bg-[#181E29] text-[#F1F5F9]'
                        : 'text-[#8B949E] hover:bg-[#121720]'
                    }`}
                  >
                    <span className="flex items-center gap-2.5">
                      <Icon className="h-4 w-4" />
                      <span>{item.label}</span>
                    </span>
                    {item.meta && (
                      <span className="font-mono text-[11px] tabular-nums text-[#8B949E]">
                        {item.meta}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
            <div className="border-t border-[#212836] p-3 space-y-1">
              <button
                type="button"
                onClick={() => {
                  fileInputRef.current?.click();
                  setMobileNavOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-xs text-[#8B949E]"
              >
                <Upload className="h-3.5 w-3.5" />
                Import JSON
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Bar (SaaS Top Bar Contract: Breadcrumb Left, 1-2 Actions Right) */}
        <header className="flex h-14 shrink-0 items-center justify-between gap-8 border-b border-[#212836] bg-[#090C10] px-5">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              aria-label="Open menu"
              onClick={() => setMobileNavOpen(true)}
              className="rounded p-1.5 text-[#8B949E] hover:bg-[#121720] hover:text-[#F1F5F9] lg:hidden"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div className="flex min-w-0 items-center gap-2 text-xs text-[#8B949E]">
              <span className="truncate font-medium text-[#8B949E]">
                {workspace.workspaceName}
              </span>
              <span aria-hidden="true">/</span>
              <span className="truncate font-medium text-[#F1F5F9] whitespace-nowrap">
                {VIEW_LABELS[activeView]}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={handleExportJson}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#2E3748] bg-[#121720] px-3 py-1.5 text-xs font-medium text-[#F1F5F9] transition-colors hover:bg-[#181E29] whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5 text-[#8B949E]" />
              Export JSON
            </button>
            <button
              type="button"
              onClick={() => handleStartFreshMvpGrill()}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#3B82F6] px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] whitespace-nowrap shrink-0"
            >
              <Flame className="h-3.5 w-3.5" />
              New MVP Grill
            </button>
          </div>
        </header>

        {/* Active Operational View */}
        <main className="flex-1 overflow-y-auto">
          {activeView === 'general-tasks' && (
            <GeneralTasksView
              tasks={workspace.tasks}
              sprints={workspace.sprints}
              activeDate={workspace.activeDate}
              onAddTasks={handleAddTasks}
              onUpdateTask={handleUpdateTask}
              onDeleteTask={handleDeleteTask}
              onScheduleTask={handleScheduleTask}
              onPromoteToSprint={handlePromoteToSprint}
              onNotify={notify}
            />
          )}

          {activeView === 'mvp-griller' && (
            <MvpGrillerView
              blueprint={workspace.blueprint}
              sprints={workspace.sprints}
              tasks={workspace.tasks}
              messages={workspace.grillerMessages}
              activeDate={workspace.activeDate}
              onUpdateBlueprint={handleUpdateBlueprint}
              onReplaceSprintsAndTasks={handleReplaceSprintsAndTasks}
              onAddMessages={(msgs) =>
                setWorkspace((prev) => ({
                  ...prev,
                  grillerMessages: [...prev.grillerMessages, ...msgs],
                }))
              }
              onStartFreshGrill={() => handleStartFreshMvpGrill()}
              onOpenSprintBoard={() => setActiveView('sprint-plan')}
              onNotify={notify}
            />
          )}

          {activeView === 'sprint-plan' && (
            <SprintPlannerView
              blueprint={workspace.blueprint}
              sprints={workspace.sprints}
              tasks={workspace.tasks}
              activeDate={workspace.activeDate}
              onAddTask={(task) => handleAddTasks([task])}
              onUpdateTask={handleUpdateTask}
              onDeleteTask={handleDeleteTask}
              onReplaceSprintsAndTasks={handleReplaceSprintsAndTasks}
              onScheduleTask={handleScheduleTask}
              onNotify={notify}
            />
          )}

          {activeView === 'schedule' && (
            <ScheduleView
              activeDate={workspace.activeDate}
              workdayStartMinute={workspace.workdayStartMinute}
              workdayEndMinute={workspace.workdayEndMinute}
              blocks={workspace.scheduleBlocks}
              tasks={workspace.tasks}
              onChangeActiveDate={(date) =>
                setWorkspace((prev) => ({ ...prev, activeDate: date }))
              }
              onAddBlock={(block) =>
                setWorkspace((prev) => ({
                  ...prev,
                  scheduleBlocks: [...prev.scheduleBlocks, block],
                }))
              }
              onUpdateBlock={(blockId, patch) =>
                setWorkspace((prev) => ({
                  ...prev,
                  scheduleBlocks: prev.scheduleBlocks.map((b) =>
                    b.id === blockId ? { ...b, ...patch } : b
                  ),
                }))
              }
              onDeleteBlock={(blockId) => {
                setWorkspace((prev) => ({
                  ...prev,
                  scheduleBlocks: prev.scheduleBlocks.filter((b) => b.id !== blockId),
                }));
                notify('Schedule block removed');
              }}
              onReplaceDayBlocks={(date, nextBlocks) =>
                setWorkspace((prev) => ({
                  ...prev,
                  scheduleBlocks: [
                    ...prev.scheduleBlocks.filter((b) => b.date !== date),
                    ...nextBlocks,
                  ],
                }))
              }
              onNotify={notify}
            />
          )}

          {activeView === 'admin-drafts' && (
            <AdminDraftsView
              blueprint={workspace.blueprint}
              sprints={workspace.sprints}
              tasks={workspace.tasks}
              scheduleBlocks={workspace.scheduleBlocks}
              activeDate={workspace.activeDate}
              drafts={workspace.adminDrafts}
              onAddDraft={(draft: AdminDraft) =>
                setWorkspace((prev) => ({
                  ...prev,
                  adminDrafts: [draft, ...prev.adminDrafts],
                }))
              }
              onUpdateDraft={(draftId, content) =>
                setWorkspace((prev) => ({
                  ...prev,
                  adminDrafts: prev.adminDrafts.map((d) =>
                    d.id === draftId ? { ...d, content } : d
                  ),
                }))
              }
              onDeleteDraft={(draftId) => {
                setWorkspace((prev) => ({
                  ...prev,
                  adminDrafts: prev.adminDrafts.filter((d) => d.id !== draftId),
                }));
                notify('Draft deleted');
              }}
              onNotify={notify}
            />
          )}

          {activeView === 'assistant' && (
            <AssistantView
              workspace={workspace}
              onAddMessages={(msgs) =>
                setWorkspace((prev) => ({
                  ...prev,
                  assistantMessages: [...prev.assistantMessages, ...msgs],
                }))
              }
              onAddGeneralTasks={handleAddTasks}
              onCompleteTasks={(ids) =>
                setWorkspace((prev) => ({
                  ...prev,
                  tasks: prev.tasks.map((t) =>
                    ids.includes(t.id) ? { ...t, status: 'done' } : t
                  ),
                }))
              }
              onAddScheduleBlocks={(blocks) =>
                setWorkspace((prev) => ({
                  ...prev,
                  scheduleBlocks: [...prev.scheduleBlocks, ...blocks],
                }))
              }
              onLaunchMvpGrillWithPrompt={(seed) => handleStartFreshMvpGrill(seed)}
              onNotify={notify}
            />
          )}
        </main>
      </div>

      {/* Subtle Toast Banner */}
      {toast && (
        <div
          role="status"
          className={`fixed bottom-5 right-5 z-50 rounded-md border px-4 py-2.5 text-xs font-medium shadow-lg ${
            toast.tone === 'error'
              ? 'border-[#DC2626]/50 bg-[#2A1215] text-[#FCA5A5]'
              : 'border-[#2E3748] bg-[#181E29] text-[#F1F5F9]'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
