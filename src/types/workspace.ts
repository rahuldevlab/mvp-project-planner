export type WorkspaceView =
  | 'general-tasks'
  | 'mvp-griller'
  | 'sprint-plan'
  | 'schedule'
  | 'admin-drafts'
  | 'assistant';

export type TaskScope = 'general' | 'sprint';

export type TaskCategory =
  | 'engineering'
  | 'design'
  | 'devops'
  | 'admin'
  | 'operations'
  | 'personal';

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

export type TaskStatus = 'backlog' | 'in_progress' | 'in_review' | 'done';

export type TaskRecurrence = 'none' | 'daily' | 'weekly';

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export interface TaskItem {
  id: string;
  scope: TaskScope;
  sprintId?: string;
  title: string;
  description: string;
  category: TaskCategory;
  priority: TaskPriority;
  status: TaskStatus;
  points?: number;
  estimatedMinutes: number;
  dueDate?: string;
  recurrence?: TaskRecurrence;
  subtasks: Subtask[];
  dependencies?: string[];
  acceptanceCriteria?: string;
  createdAt: string;
}

export interface TechStackItem {
  id: string;
  layer: 'Frontend' | 'Backend' | 'Database' | 'Auth & Security' | 'Hosting & CI/CD' | 'AI / Integrations' | string;
  choice: string;
  rationale: string;
}

export type GrillingStage = 'idle' | 'discovery' | 'architecture' | 'sprint_design' | 'ready';

export interface BlueprintReadiness {
  problemDefined: boolean;
  personaClear: boolean;
  mvpLoopScoped: boolean;
  stackSelected: boolean;
  sprintsDrafted: boolean;
}

export interface ProjectBlueprint {
  title: string;
  pitch: string;
  problemStatement: string;
  targetPersona: string;
  coreMvpLoop: string;
  nonGoals: string[];
  deploymentTarget: string;
  grillingStage: GrillingStage;
  readiness: BlueprintReadiness;
  techStack: TechStackItem[];
}

export type SprintStatus = 'planned' | 'active' | 'completed';

export interface Sprint {
  id: string;
  name: string;
  goal: string;
  startDate: string;
  endDate: string;
  capacityPoints: number;
  status: SprintStatus;
}

export type ScheduleBlockType = 'deep_work' | 'meeting' | 'admin' | 'buffer';

export interface ScheduleBlock {
  id: string;
  date: string;
  startMinute: number;
  endMinute: number;
  title: string;
  type: ScheduleBlockType;
  linkedTaskId?: string;
  linkedTaskScope?: TaskScope;
  locked: boolean;
  notes?: string;
}

export interface ScheduleConflict {
  id: string;
  blockAId: string;
  blockBId: string;
  overlapStartMinute: number;
  overlapEndMinute: number;
  overlapMinutes: number;
  severity: 'warning' | 'critical';
  summary: string;
}

export interface ProposedSchedulePlan {
  blocks: ScheduleBlock[];
  resolutions: string[];
  unscheduledTaskIds: string[];
  summary: string;
}

export type AdminDraftKind =
  | 'standup'
  | 'stakeholder_update'
  | 'follow_up_email'
  | 'meeting_agenda';

export interface AdminDraft {
  id: string;
  kind: AdminDraftKind;
  title: string;
  content: string;
  createdAt: string;
  sourceSnapshotSummary: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  quickReplies?: string[];
  actionSummary?: string[];
  triggersMvpGrill?: boolean;
}

export interface WorkspaceState {
  schemaVersion: number;
  workspaceName: string;
  activeDate: string;
  workdayStartMinute: number;
  workdayEndMinute: number;
  blueprint: ProjectBlueprint;
  sprints: Sprint[];
  tasks: TaskItem[];
  scheduleBlocks: ScheduleBlock[];
  adminDrafts: AdminDraft[];
  grillerMessages: ChatMessage[];
  assistantMessages: ChatMessage[];
}
