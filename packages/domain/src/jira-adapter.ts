import type { WorkItem } from './types.js';

interface JiraIssueLike {
  id?: string | number;
  key: string;
  fields?: {
    summary?: string;
    description?: unknown;
    issuetype?: { name?: string };
    status?: {
      name?: string;
      statusCategory?: { key?: string };
    };
    priority?: { name?: string };
    assignee?: { displayName?: string };
    duedate?: string;
    comment?: {
      comments?: Array<{ body?: unknown }>;
    } | Array<{ body?: unknown }>;
    issuelinks?: Array<{
      inwardIssue?: { key?: string };
      outwardIssue?: { key?: string };
    }>;
  };
}

function adfToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';

  const node = value as {
    type?: string;
    text?: string;
    content?: unknown[];
  };

  if (node.type === 'text') return node.text ?? '';

  const children = (node.content ?? [])
    .map(adfToText)
    .filter(Boolean);

  if (node.type === 'doc') return children.join('\n');
  if (node.type === 'paragraph') return children.join('');

  return children.join(' ');
}

function mapIssueType(name = ''): WorkItem['type'] {
  const value = name.toLowerCase();

  if (value.includes('epic')) return 'epic';
  if (value.includes('bug')) return 'bug';
  if (value.includes('story')) return 'story';

  return 'task';
}

function mapStatus(
  name = '',
  category = ''
): WorkItem['status'] {
  const value = name.toLowerCase();
  const categoryValue = category.toLowerCase();

  if (
    categoryValue === 'done' ||
    /done|closed|resolved|complete/.test(value)
  ) return 'done';

  if (/review|testing|quality assurance|\bqa\b/.test(value)) {
    return 'in-review';
  }

  if (
    categoryValue === 'indeterminate' ||
    /progress|active|development/.test(value)
  ) return 'in-progress';

  return 'todo';
}

function mapPriority(name = ''): WorkItem['priority'] {
  const value = name.toLowerCase();

  if (/highest|blocker|critical/.test(value)) return 'highest';
  if (/high|major/.test(value)) return 'high';
  if (/lowest|trivial/.test(value)) return 'lowest';
  if (/low|minor/.test(value)) return 'low';

  return 'medium';
}

export function mapJiraIssueToWorkItem(
  issue: JiraIssueLike
): WorkItem {
  const fields = issue.fields ?? {};

  const commentEntries = Array.isArray(fields.comment)
    ? fields.comment
    : (fields.comment as { comments?: Array<{ body?: unknown }> } | undefined)?.comments ?? [];

  const comments = commentEntries
    .map((comment) => adfToText(comment.body))
    .filter(Boolean);

  const linkedWorkItemKeys = Array.from(
    new Set(
      (fields.issuelinks ?? [])
        .flatMap((link) => [
          link.inwardIssue?.key,
          link.outwardIssue?.key,
        ])
        .filter((key): key is string => Boolean(key))
    )
  );

  return {
    id: String(issue.id ?? issue.key),
    key: issue.key,
    type: mapIssueType(fields.issuetype?.name),
    summary: fields.summary ?? '',
    description: adfToText(fields.description),
    comments,
    status: mapStatus(
      fields.status?.name,
      fields.status?.statusCategory?.key
    ),
    priority: mapPriority(fields.priority?.name),
    assignee: fields.assignee?.displayName,
    dueDate: fields.duedate,
    linkedDecisionIds: [],
    linkedWorkItemKeys,
  };
}