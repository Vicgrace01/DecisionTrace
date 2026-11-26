import type { Decision, WorkItem, BlastRadiusEntry, BlastRadiusResult } from './types.js';

export interface BlastRadiusInput {
  decision: Decision;
  workItems: WorkItem[];
}

export function computeBlastRadius(input: BlastRadiusInput): BlastRadiusResult {
  const byKey = new Map<string, WorkItem>();
  for (const wi of input.workItems) byKey.set(wi.key, wi);

  const visited = new Set<string>();
  const entries: BlastRadiusEntry[] = [];

  const roots = input.workItems.filter((wi) => wi.linkedDecisionIds.includes(input.decision.id));
  const queue: Array<{ item: WorkItem; depth: number; path: string[] }> =
    roots.map((r) => ({ item: r, depth: 0, path: [r.key] }));

  while (queue.length > 0) {
    const { item, depth, path } = queue.shift()!;
    if (visited.has(item.key)) continue;
    visited.add(item.key);
    entries.push({
      workItemKey: item.key,
      summary: item.summary,
      status: item.status,
      priority: item.priority,
      storyPoints: item.storyPoints ?? 0,
      estimatedHours: item.estimatedHours ?? 0,
      assignee: item.assignee,
      dueDate: item.dueDate,
      depth,
      path,
    });
    for (const childKey of item.linkedWorkItemKeys) {
      const child = byKey.get(childKey);
      if (child && !visited.has(child.key)) {
        queue.push({ item: child, depth: depth + 1, path: [...path, child.key] });
      }
    }
  }

  const rank: Record<string, number> = { highest: 5, high: 4, medium: 3, low: 2, lowest: 1 };
  entries.sort((a, b) => (rank[b.priority] ?? 0) - (rank[a.priority] ?? 0) || a.depth - b.depth);

  return {
    decisionId: input.decision.id,
    totalItems: entries.length,
    totalStoryPoints: entries.reduce((sum, e) => sum + e.storyPoints, 0),
    totalEstimatedHours: entries.reduce((sum, e) => sum + e.estimatedHours, 0),
    entries,
  };
}
