import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequestJira, mockRequestConfluence, mockKvsGet } = vi.hoisted(() => ({
  mockRequestJira: vi.fn(),
  mockRequestConfluence: vi.fn(),
  mockKvsGet: vi.fn(),
}));

vi.mock('@forge/resolver', () => ({
  default: class MockResolver {
    define() {}
    getDefinitions() { return {}; }
  },
}));

vi.mock('@forge/api', () => ({
  default: {
    asUser: () => ({
      requestJira: mockRequestJira,
      requestConfluence: mockRequestConfluence,
    }),
  },
  route: (parts, ...values) => parts.reduce(
    (result, part, index) => result + part + (values[index] ?? ''),
    '',
  ),
}));

vi.mock('@forge/kvs', () => ({
  kvs: { get: mockKvsGet },
}));

import { checkDecisionValidity } from '../../../src/index.js';

const response = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

const makeIssue = ({
  key = 'AUTH-101',
  summary = 'Migrate login gateway to Vendor B',
  description = 'Authentication integration task',
  comments = [],
} = {}) => ({
  key,
  fields: {
    summary,
    description,
    labels: [],
    issuelinks: [],
    subtasks: [],
    status: { name: 'To Do' },
    issuetype: { name: 'Task' },
    comment: {
      comments: comments.map((body, index) => ({ id: String(index + 1), body })),
    },
  },
});

const makeDecisionPage = ({
  id = '5144577',
  status = 'Active',
  selectedOption = 'Vendor B',
  excludedOption = null,
  supersedesId = null,
} = {}) => {
  const statements = [
    `<p>Status: ${status}</p>`,
    `<p>We have decided to use ${selectedOption} for all new authentication integrations.</p>`,
  ];
  if (excludedOption) {
    statements.push(`<p>Exclude ${excludedOption} from all future authentication flows.</p>`);
  }
  if (supersedesId) {
    statements.push(`<p>Supersedes decision: ${supersedesId}</p>`);
  }

  return {
    id,
    title: 'Decision: Authentication Provider',
    body: { storage: { value: statements.join('') } },
    version: { when: '2026-11-25T10:00:00.000Z' },
    space: { key: 'AUTH' },
    _links: { webui: `/spaces/AUTH/pages/${id}` },
  };
};

const configureScenario = ({
  issue = makeIssue(),
  pages = [makeDecisionPage()],
  reviews = { '5144577': { status: 'approved', updatedAt: '2026-11-25T11:00:00.000Z' } },
} = {}) => {
  mockRequestJira.mockResolvedValue(response(issue));
  mockRequestConfluence.mockResolvedValue(response({
    results: pages,
    _links: { base: 'https://example.atlassian.net/wiki' },
  }));
  mockKvsGet.mockResolvedValue(reviews);
};

beforeEach(() => {
  vi.clearAllMocks();
  configureScenario();
});

describe('DecisionTrace actual Rovo action handler', () => {
  it('returns ISSUE_KEY_REQUIRED without calling Jira when no key is supplied', async () => {
    const result = await checkDecisionValidity({});

    expect(result.outcome).toBe('ISSUE_KEY_REQUIRED');
    expect(mockRequestJira).not.toHaveBeenCalled();
    expect(mockRequestConfluence).not.toHaveBeenCalled();
  });

  it('extracts the Jira issue key from the Rovo Jira context URL', async () => {
    const result = await checkDecisionValidity({
      context: { jira: { url: 'https://example.atlassian.net/browse/AUTH-101' } },
    });

    expect(result.issue.key).toBe('AUTH-101');
    expect(result.outcome).toBe('ALIGNED_WITH_APPROVED_DECISION_SIGNAL');
  });

  it('recognises a summary match against an active, reviewer-approved decision', async () => {
    const result = await checkDecisionValidity({ issueKey: 'AUTH-101' });

    expect(result.outcome).toBe('ALIGNED_WITH_APPROVED_DECISION_SIGNAL');
    expect(result.summary.approvedActiveMatches).toBe(1);
    expect(result.decisionMatches[0].relationship).toBe('mentions-selected-option');
    expect(result.decisionMatches[0].evidence.some((item) => item.sourceField === 'summary')).toBe(true);
  });

  it('uses Jira comment evidence when the issue summary does not contain the selected option', async () => {
    configureScenario({
      issue: makeIssue({
        summary: 'Authentication migration task',
        description: 'Review the login provider migration',
        comments: ['We are switching to Vendor B for the authentication gateway.'],
      }),
    });

    const result = await checkDecisionValidity({ issueKey: 'AUTH-101' });

    expect(result.outcome).toBe('ALIGNED_WITH_APPROVED_DECISION_SIGNAL');
    expect(result.issue.commentCount).toBe(1);
    expect(result.decisionMatches).toHaveLength(1);
    expect(result.decisionMatches[0].evidence.some((item) => item.sourceField === 'comment')).toBe(true);
  });

  it('flags work matching a reviewer-approved superseded decision as potentially stale', async () => {
    configureScenario({
      issue: makeIssue({ summary: 'Continue Vendor A authentication gateway' }),
      pages: [
        makeDecisionPage({ id: '5144577', selectedOption: 'Vendor A' }),
        makeDecisionPage({ id: '5144578', selectedOption: 'Vendor B', supersedesId: '5144577' }),
      ],
      reviews: {
        '5144577': { status: 'approved', updatedAt: '2026-11-25T11:00:00.000Z' },
        '5144578': { status: 'approved', updatedAt: '2026-11-26T08:00:00.000Z' },
      },
    });

    const result = await checkDecisionValidity({ issueKey: 'AUTH-101' });

    expect(result.outcome).toBe('POTENTIALLY_STALE_DECISION');
    expect(result.summary.approvedSupersededMatches).toBe(1);
  });

  it('routes an excluded-option mention to human review rather than declaring a violation', async () => {
    configureScenario({
      issue: makeIssue({ summary: 'Continue Vendor A authentication integration' }),
      pages: [makeDecisionPage({ excludedOption: 'Vendor A' })],
    });

    const result = await checkDecisionValidity({ issueKey: 'AUTH-101' });

    expect(result.outcome).toBe('HUMAN_REVIEW_REQUIRED');
    expect(result.safety.humanReviewRequiredForEnforcement).toBe(true);
    expect(result.decisionMatches[0].relationship).toBe('mentions-excluded-option');
  });

  it('does not treat an unapproved decision candidate as authoritative', async () => {
    configureScenario({ reviews: {} });

    const result = await checkDecisionValidity({ issueKey: 'AUTH-101' });

    expect(result.outcome).toBe('UNVERIFIED_DECISION_CANDIDATE_MATCH');
    expect(result.summary.approvedActiveMatches).toBe(0);
    expect(result.decisionMatches[0].authoritative).toBe(false);
  });

  it('returns ISSUE_NOT_FOUND_OR_NOT_VISIBLE for a Jira 404', async () => {
    mockRequestJira.mockResolvedValue(response({}, 404));

    const result = await checkDecisionValidity({ issueKey: 'AUTH-404' });

    expect(result.outcome).toBe('ISSUE_NOT_FOUND_OR_NOT_VISIBLE');
    expect(mockRequestConfluence).not.toHaveBeenCalled();
  });

  it('returns JIRA_ACCESS_DENIED for a Jira 403', async () => {
    mockRequestJira.mockResolvedValue(response({}, 403));

    const result = await checkDecisionValidity({ issueKey: 'AUTH-403' });

    expect(result.outcome).toBe('JIRA_ACCESS_DENIED');
    expect(mockRequestConfluence).not.toHaveBeenCalled();
  });
});