import { describe, test, expect } from 'vitest';
import { computeBlastRadius } from '../src/blast-radius.js';
import type { Decision, WorkItem } from '../src/types.js';

const baseDecision = (id: string): Decision => ({
  id, sourceType: 'confluence-page', sourceUrl: 'x', title: id, text: 'Use Vendor A.',
  status: 'active', claims: [], createdAt: '2026-11-01T00:00:00Z',
});

describe('blast radius', () => {
  test('traces epic to child tasks', () => {
    const workItems: WorkItem[] = [
      { id: 'e1', key: 'EPIC-1', type: 'epic', summary: 'Vendor A epic', description: '', comments: [], status: 'in-progress', priority: 'high', linkedDecisionIds: ['d1'], linkedWorkItemKeys: ['TASK-1', 'TASK-2'], storyPoints: 5, estimatedHours: 10 },
      { id: 't1', key: 'TASK-1', type: 'task', summary: 'Task one', description: '', comments: [], status: 'todo', priority: 'medium', linkedDecisionIds: [], linkedWorkItemKeys: [], storyPoints: 2, estimatedHours: 4 },
      { id: 't2', key: 'TASK-2', type: 'task', summary: 'Task two', description: '', comments: [], status: 'todo', priority: 'low', linkedDecisionIds: [], linkedWorkItemKeys: [], storyPoints: 1, estimatedHours: 2 },
    ];
    const result = computeBlastRadius({ decision: baseDecision('d1'), workItems });
    expect(result.totalItems).toBe(3);
    expect(result.totalStoryPoints).toBe(8);
    expect(result.entries[0].workItemKey).toBe('EPIC-1');
    expect(result.entries.map((e) => e.workItemKey).sort()).toEqual(['EPIC-1', 'TASK-1', 'TASK-2']);
  });

  test('no linked work items yields empty result', () => {
    const result = computeBlastRadius({ decision: baseDecision('d1'), workItems: [] });
    expect(result.totalItems).toBe(0);
    expect(result.entries).toHaveLength(0);
  });
});
