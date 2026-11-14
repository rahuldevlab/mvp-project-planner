import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialWorkspace } from '../src/data/initialWorkspace';
import type { ScheduleBlock } from '../src/types/workspace';
import {
  calculateDailyLoad,
  detectScheduleConflicts,
  formatDuration,
  formatMinutesToTime,
  parseTimeToMinutes,
  validateImportedWorkspace,
} from '../src/utils/scheduleUtils';

test('detectScheduleConflicts flags intentional overlaps in initial workspace and distinguishes locked severity', () => {
  const ws = createInitialWorkspace();
  const conflicts = detectScheduleConflicts(ws.scheduleBlocks, ws.activeDate);

  assert.equal(conflicts.length, 2);
  assert.equal(conflicts[0].severity, 'warning');
  assert.equal(conflicts[0].overlapMinutes, 15);
  assert.equal(conflicts[1].severity, 'warning');
  assert.equal(conflicts[1].overlapMinutes, 30);
});

test('detectScheduleConflicts treats adjacent touching blocks as conflict-free and marks double-locked overlaps critical', () => {
  const blocks: ScheduleBlock[] = [
    {
      id: 'a',
      date: '2026-11-14',
      startMinute: 9 * 60,
      endMinute: 10 * 60,
      title: 'Standup',
      type: 'meeting',
      locked: true,
    },
    {
      id: 'b',
      date: '2026-11-14',
      startMinute: 10 * 60,
      endMinute: 11 * 60,
      title: 'Deep Work',
      type: 'deep_work',
      locked: false,
    },
    {
      id: 'c',
      date: '2026-11-15',
      startMinute: 9 * 60,
      endMinute: 10 * 60,
      title: 'Next Day Meeting',
      type: 'meeting',
      locked: true,
    },
  ];

  assert.equal(detectScheduleConflicts(blocks, '2026-11-14').length, 0);

  const criticalBlocks: ScheduleBlock[] = [
    blocks[0],
    {
      ...blocks[1],
      startMinute: 9 * 60 + 30,
      locked: true,
    },
  ];
  const criticalConflicts = detectScheduleConflicts(criticalBlocks, '2026-11-14');
  assert.equal(criticalConflicts.length, 1);
  assert.equal(criticalConflicts[0].severity, 'critical');
  assert.equal(criticalConflicts[0].overlapMinutes, 30);
});

test('calculateDailyLoad aggregates focus, meeting, and total scheduled minutes accurately', () => {
  const blocks: ScheduleBlock[] = [
    { id: '1', date: '2026-11-14', startMinute: 540, endMinute: 600, title: 'Meeting', type: 'meeting', locked: true },
    { id: '2', date: '2026-11-14', startMinute: 600, endMinute: 690, title: 'Build', type: 'deep_work', locked: false },
    { id: '3', date: '2026-11-14', startMinute: 720, endMinute: 750, title: 'Admin', type: 'admin', locked: false },
  ];

  const load = calculateDailyLoad(blocks, '2026-11-14', 8 * 60, 19 * 60);
  assert.equal(load.meetingMinutes, 60);
  assert.equal(load.focusMinutes, 90);
  assert.equal(load.scheduledMinutes, 180);
  assert.equal(load.capacityMinutes, 11 * 60);
});

test('time formatting and parsing round-trips cleanly', () => {
  assert.equal(formatMinutesToTime(9 * 60 + 5), '09:05');
  assert.equal(parseTimeToMinutes('14:45'), 14 * 60 + 45);
  assert.equal(formatDuration(45), '45m');
  assert.equal(formatDuration(90), '1h 30m');
  assert.equal(formatDuration(120), '2h');
});

test('validateImportedWorkspace accepts valid snapshot and rejects malformed JSON', () => {
  const valid = createInitialWorkspace();
  assert.equal(validateImportedWorkspace(valid), true);
  assert.equal(validateImportedWorkspace(null), false);
  assert.equal(validateImportedWorkspace({ workspaceName: 'Missing arrays' }), false);
});
