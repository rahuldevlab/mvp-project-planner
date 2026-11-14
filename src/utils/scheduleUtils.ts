import type { ScheduleBlock, ScheduleConflict, WorkspaceState } from '../types/workspace';

export function formatMinutesToTime(minutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(minutes)));
  const hrs = Math.floor(clamped / 60);
  const mins = clamped % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

export function parseTimeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(':').map((n) => parseInt(n, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return 9 * 60;
  return Math.max(0, Math.min(24 * 60, h * 60 + m));
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hrs = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hrs}h` : `${hrs}h ${rem}m`;
}

export function detectScheduleConflicts(
  blocks: ScheduleBlock[],
  activeDate: string
): ScheduleConflict[] {
  const dayBlocks = blocks
    .filter((b) => b.date === activeDate)
    .slice()
    .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);

  const conflicts: ScheduleConflict[] = [];

  for (let i = 0; i < dayBlocks.length; i++) {
    for (let j = i + 1; j < dayBlocks.length; j++) {
      const a = dayBlocks[i];
      const b = dayBlocks[j];
      const overlapStart = Math.max(a.startMinute, b.startMinute);
      const overlapEnd = Math.min(a.endMinute, b.endMinute);

      if (overlapEnd > overlapStart) {
        const overlapMinutes = overlapEnd - overlapStart;
        const severity = a.locked && b.locked ? 'critical' : 'warning';
        conflicts.push({
          id: `conflict_${a.id}_${b.id}`,
          blockAId: a.id,
          blockBId: b.id,
          overlapStartMinute: overlapStart,
          overlapEndMinute: overlapEnd,
          overlapMinutes,
          severity,
          summary: `"${a.title}" overlaps "${b.title}" (${formatMinutesToTime(overlapStart)}–${formatMinutesToTime(overlapEnd)}, ${overlapMinutes}m)`,
        });
      }
    }
  }

  return conflicts;
}

export function calculateDailyLoad(
  blocks: ScheduleBlock[],
  activeDate: string,
  workdayStartMinute: number,
  workdayEndMinute: number
): { scheduledMinutes: number; capacityMinutes: number; meetingMinutes: number; focusMinutes: number } {
  const dayBlocks = blocks.filter((b) => b.date === activeDate);
  let scheduledMinutes = 0;
  let meetingMinutes = 0;
  let focusMinutes = 0;

  for (const block of dayBlocks) {
    const dur = Math.max(0, block.endMinute - block.startMinute);
    scheduledMinutes += dur;
    if (block.type === 'meeting') meetingMinutes += dur;
    if (block.type === 'deep_work') focusMinutes += dur;
  }

  return {
    scheduledMinutes,
    capacityMinutes: Math.max(60, workdayEndMinute - workdayStartMinute),
    meetingMinutes,
    focusMinutes,
  };
}

export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

export function validateImportedWorkspace(raw: unknown): raw is WorkspaceState {
  if (!raw || typeof raw !== 'object') return false;
  const candidate = raw as Partial<WorkspaceState>;
  return (
    typeof candidate.workspaceName === 'string' &&
    typeof candidate.activeDate === 'string' &&
    typeof candidate.blueprint === 'object' &&
    candidate.blueprint !== null &&
    Array.isArray(candidate.sprints) &&
    Array.isArray(candidate.tasks) &&
    Array.isArray(candidate.scheduleBlocks)
  );
}
