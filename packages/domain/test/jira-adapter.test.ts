import { describe, expect, test } from 'vitest';
import { mapJiraIssueToWorkItem } from '../src/jira-adapter.js';

describe('Jira issue adapter', () => {
  test('maps issue fields, comments and relationships', () => {
    const issue = {
      id: '10001',
      key: 'PROJ-2',
      fields: {
        summary: 'Integrate Vendor A',
        description: {
          type: 'doc',
          content: [{
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Connect Vendor A' }
            ]
          }]
        },
        issuetype: { name: 'Bug' },
        status: {
          name: 'In Progress',
          statusCategory: { key: 'indeterminate' }
        },
        priority: { name: 'High' },
        assignee: { displayName: 'Project Owner' },
        duedate: '2026-12-01',
        comment: {
          comments: [{
            body: {
              type: 'doc',
              content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: 'Still working on this.' }]
              }]
            }
          }]
        },
        issuelinks: [
          { outwardIssue: { key: 'PROJ-3' } },
          { inwardIssue: { key: 'PROJ-1' } },
          { outwardIssue: { key: 'PROJ-3' } }
        ]
      }
    };

    const result = mapJiraIssueToWorkItem(issue);

    expect(result.key).toBe('PROJ-2');
    expect(result.type).toBe('bug');
    expect(result.status).toBe('in-progress');
    expect(result.priority).toBe('high');
    expect(result.description).toBe('Connect Vendor A');
    expect(result.comments).toEqual(['Still working on this.']);
    expect(result.linkedWorkItemKeys).toEqual(['PROJ-3', 'PROJ-1']);
    expect(result.linkedDecisionIds).toEqual([]);
  });

  test('handles missing optional Jira fields', () => {
    const result = mapJiraIssueToWorkItem({
      id: '10002',
      key: 'PROJ-3',
      fields: {
        summary: 'General task'
      }
    });

    expect(result.key).toBe('PROJ-3');
    expect(result.status).toBe('todo');
    expect(result.priority).toBe('medium');
    expect(result.comments).toEqual([]);
    expect(result.linkedWorkItemKeys).toEqual([]);
  });

  test('maps comment arrays returned by enhanced JQL search', () => {
    const result = mapJiraIssueToWorkItem({
      id: '10003',
      key: 'PROJ-4',
      fields: {
        summary: 'Authentication work',
        comment: [{ body: 'We are switching to Vendor B now.' }],
      },
    });

    expect(result.comments).toEqual(['We are switching to Vendor B now.']);
  });});