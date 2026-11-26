import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequestConfluence, mockDefinitions, mockStorage, mockState } = vi.hoisted(() => ({
  mockRequestConfluence: vi.fn(),
  mockDefinitions: {},
  mockStorage: {
    'decision-review-current': new Map(),
    'decision-review-event': new Map(),
  },
  mockState: {
    pageVersion: 7,
    pageStatus: 'current',
    pageStatusCode: 200,
    pageTitle: 'Decision: Authentication Provider',
    pageBody: '<p>Use Vendor A as the authentication provider.</p>',
    operations: [{ operation: 'update', targetType: 'page' }],
    operationsStatus: 200,
    failTransaction: false,
    throwAfterCommit: false,
    transactionBarrier: null,
  },
}));

vi.mock('@forge/resolver', () => ({
  default: class MockResolver {
    define(name, callback) { mockDefinitions[name] = callback; }
    getDefinitions() { return mockDefinitions; }
  },
}));

vi.mock('@forge/api', () => ({
  default: { asUser: () => ({ requestConfluence: mockRequestConfluence }) },
  route: (parts, ...values) => parts.reduce(
    (result, part, index) => result + part + (values[index] ?? ''), '',
  ),
}));

vi.mock('@forge/kvs', () => {
  class Filter {
    constructor() { this.conditions = []; }
    and(attribute, condition) { this.conditions.push({ attribute, ...condition }); return this; }
  }
  const FilterConditions = {
    equalTo: (value) => ({ type: 'equalTo', value }),
    notExists: () => ({ type: 'notExists' }),
  };
  const kvs = {
    entity(entityName) {
      const store = mockStorage[entityName];
      return {
        get: async (key) => store.get(String(key)),
        query() {
          let partition = [];
          let limit = 10;
          let cursor = '';
          const query = {
            index(_name, options) { partition = options.partition; return query; },
            sort() { return query; },
            limit(value) { limit = value; return query; },
            cursor(value) { cursor = value; return query; },
            async getMany() {
              const rows = [...store.entries()]
                .map(([key, value]) => ({ key, value }))
                .filter((item) => item.value.decisionId === partition[0])
                .sort((a, b) => b.value.revision - a.value.revision);
              const offset = cursor ? Number(cursor) : 0;
              const results = rows.slice(offset, offset + limit);
              const nextOffset = offset + results.length;
              return { results, ...(nextOffset < rows.length ? { nextCursor: String(nextOffset) } : {}) };
            },
          };
          return query;
        },
      };
    },
    transact() {
      const operations = [];
      const builder = {
        set(key, value, options) { operations.push({ key: String(key), value, options }); return builder; },
        async execute() {
          if (mockState.transactionBarrier) await mockState.transactionBarrier();
          if (mockState.failTransaction) throw new Error('simulated storage outage');
          // Check all preconditions before either entity is modified.
          for (const operation of operations) {
            const store = mockStorage[operation.options.entityName];
            const previous = store.get(operation.key);
            for (const condition of operation.options.conditions.conditions) {
              if (condition.type === 'notExists' && previous?.[condition.attribute] !== undefined) {
                throw new Error('conditional transaction failed');
              }
              if (condition.type === 'equalTo' && previous?.[condition.attribute] !== condition.value) {
                throw new Error('conditional transaction failed');
              }
            }
          }
          for (const operation of operations) {
            mockStorage[operation.options.entityName].set(operation.key, operation.value);
          }
          if (mockState.throwAfterCommit) {
            mockState.throwAfterCommit = false;
            throw new Error('simulated lost transaction response');
          }
        },
      };
      return builder;
    },
  };
  return { kvs, Filter, FilterConditions, Sort: { ASC: 'ASC', DESC: 'DESC' } };
});

import { handler } from '../../../src/index.js';

const response = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

function configurePage() {
  mockRequestConfluence.mockImplementation(async (url) => {
    if (url.includes('/operations')) {
      return response({ operations: mockState.operations }, mockState.operationsStatus);
    }
    if (url.includes('/wiki/api/v2/pages/')) {
      const pageId = url.match(/\/pages\/(\d+)/)?.[1] ?? '5144577';
      return response({
        id: pageId,
        status: mockState.pageStatus,
        title: mockState.pageTitle,
        body: { storage: { value: mockState.pageBody } },
        version: mockState.pageVersion === null ? {} : { number: mockState.pageVersion },
      }, mockState.pageStatusCode);
    }
    throw new Error(`Unexpected Confluence request: ${url}`);
  });
}

function request({
  decisionId = '5144577',
  status = 'approved',
  reason = 'Architecture review completed and the selected provider is accepted.',
  reviewerAccountId = 'forged-client-reviewer',
  sourceVersion = 999,
  accountId = 'trusted-atlassian-account',
  accountType,
  limit,
  cursor,
} = {}) {
  return {
    payload: { decisionId, status, reason, reviewerAccountId, sourceVersion, limit, cursor },
    context: accountId
      ? { accountId, ...(accountType ? { accountType } : {}) }
      : accountType
        ? { accountType }
        : {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStorage['decision-review-current'].clear();
  mockStorage['decision-review-event'].clear();
  mockState.pageVersion = 7;
  mockState.pageStatus = 'current';
  mockState.pageStatusCode = 200;
  mockState.pageTitle = 'Decision: Authentication Provider';
  mockState.pageBody = '<p>Use Vendor A as the authentication provider.</p>';
  mockState.operations = [{ operation: 'update', targetType: 'page' }];
  mockState.operationsStatus = 200;
  mockState.failTransaction = false;
  mockState.throwAfterCommit = false;
  mockState.transactionBarrier = null;
  configurePage();
});

describe('actual Forge decision-review resolvers', () => {
  it('rejects missing authenticated identity even if payload supplies a reviewer', async () => {
    await expect(handler.setDecisionReview(request({ accountId: '' })))
      .rejects.toThrow(/authenticated Atlassian user/);
    expect(mockRequestConfluence).not.toHaveBeenCalled();
    expect(mockStorage['decision-review-current'].size).toBe(0);
  });

  it('rejects anonymous resolver contexts and the shared unidentified account ID', async () => {
    await expect(handler.setDecisionReview(request({
      accountId: 'anonymous-account',
      accountType: 'anonymous',
    }))).rejects.toThrow(/authenticated Atlassian user/);

    await expect(handler.setDecisionReview(request({
      accountId: 'unidentified',
    }))).rejects.toThrow(/authenticated Atlassian user/);

    expect(mockStorage['decision-review-current'].size).toBe(0);
  });

  it('uses trusted resolver identity and backend-fetched page version', async () => {
    const result = await handler.setDecisionReview(request());
    const current = mockStorage['decision-review-current'].get('5144577');
    const events = [...mockStorage['decision-review-event'].values()];
    expect(result).toMatchObject({ ok: true, decisionId: '5144577', status: 'approved', sourceVersion: 7, revision: 1 });
    expect(current.reviewerAccountId).toBe('trusted-atlassian-account');
    expect(current.reviewerAccountId).not.toBe('forged-client-reviewer');
    expect(current.sourceVersion).toBe(7);
    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe(current.eventId);
    expect(mockRequestConfluence).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the user does not have page update permission', async () => {
    mockState.operations = [{ operation: 'read', targetType: 'page' }];
    await expect(handler.setDecisionReview(request())).rejects.toThrow(/edit permission/);
    expect(mockStorage['decision-review-current'].size).toBe(0);
    expect(mockStorage['decision-review-event'].size).toBe(0);
  });

  it('fails closed when Confluence cannot verify permitted operations', async () => {
    mockState.operationsStatus = 403;
    await expect(handler.setDecisionReview(request())).rejects.toThrow(/permission could not be verified/);
    expect(mockStorage['decision-review-current'].size).toBe(0);
  });

  it('rejects missing pages and invalid page versions', async () => {
    mockState.pageStatusCode = 404;
    await expect(handler.setDecisionReview(request())).rejects.toThrow(/does not exist/);
    mockState.pageStatusCode = 200;
    mockState.pageVersion = null;
    await expect(handler.setDecisionReview(request())).rejects.toThrow(/page version/);
    expect(mockStorage['decision-review-event'].size).toBe(0);
  });

  it('rejects archived or non-current source pages', async () => {
    mockState.pageStatus = 'archived';
    await expect(handler.setDecisionReview(request())).rejects.toThrow(/current Confluence page/);
    expect(mockStorage['decision-review-event'].size).toBe(0);
  });

  it('rejects an editable Confluence page that is not a DecisionTrace decision candidate', async () => {
    mockState.pageTitle = 'Team Lunch Schedule';
    mockState.pageBody = '<p>Lunch is at noon on Friday.</p>';

    await expect(handler.setDecisionReview(request()))
      .rejects.toThrow(/decision candidates/);

    expect(mockStorage['decision-review-current'].size).toBe(0);
    expect(mockStorage['decision-review-event'].size).toBe(0);
  });

  it('requires meaningful rationales for approvals and rejections', async () => {
    await expect(handler.setDecisionReview(request({ status: 'rejected', reason: 'Not ready' })))
      .rejects.toThrow(/rationale/);
    expect(mockStorage['decision-review-event'].size).toBe(0);
  });

  it('preserves earlier events when a reviewer resets a decision to needs-review', async () => {
    await handler.setDecisionReview(request({ status: 'approved' }));
    await handler.setDecisionReview(request({ status: 'needs-review', reason: '' }));
    const current = mockStorage['decision-review-current'].get('5144577');
    expect(current.status).toBe('needs-review');
    expect(current.reason).toBe('Review reset to needs-review.');
    expect(current.revision).toBe(2);
    expect(mockStorage['decision-review-event'].size).toBe(2);
  });

  it('allows only one concurrent writer for the same expected revision', async () => {
    await handler.setDecisionReview(request({ status: 'approved' }));
    let arrived = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    mockState.transactionBarrier = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await gate;
    };
    const outcomes = await Promise.allSettled([
      handler.setDecisionReview(request({ status: 'rejected', reason: 'Security review found a blocker that must be resolved.' })),
      handler.setDecisionReview(request({ status: 'needs-review', reason: '' })),
    ]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect(mockStorage['decision-review-current'].get('5144577').revision).toBe(2);
    expect(mockStorage['decision-review-event'].size).toBe(2);
  });

  it('confirms success when the transaction committed but its response was lost', async () => {
    mockState.throwAfterCommit = true;
    const result = await handler.setDecisionReview(request());

    expect(result.ok).toBe(true);
    expect(mockStorage['decision-review-current'].get('5144577').eventId).toBe(result.eventId);
    expect(mockStorage['decision-review-event'].size).toBe(1);
  });

  it('does not report success when the storage transaction fails', async () => {
    mockState.failTransaction = true;
    await expect(handler.setDecisionReview(request())).rejects.toThrow(/No review success is reported/);
    expect(mockStorage['decision-review-current'].size).toBe(0);
    expect(mockStorage['decision-review-event'].size).toBe(0);
  });

  it('returns history in descending revision order with cursor pagination', async () => {
    await handler.setDecisionReview(request({ status: 'approved' }));
    await handler.setDecisionReview(request({ status: 'needs-review', reason: '' }));
    await handler.setDecisionReview(request({ status: 'rejected', reason: 'The risk review identified unresolved security requirements.' }));
    const firstPage = await handler.getDecisionReviewHistory(request({ limit: 2 }));
    expect(firstPage.events.map((event) => event.revision)).toEqual([3, 2]);
    expect(firstPage.events[0].reviewerAccountId).toBe('trusted-atlassian-account');
    expect(firstPage.hasMore).toBe(true);
    const secondPage = await handler.getDecisionReviewHistory(request({ limit: 2, cursor: firstPage.nextCursor }));
    expect(secondPage.events.map((event) => event.revision)).toEqual([1]);
    expect(secondPage.hasMore).toBe(false);
  });

  it('does not expose history when the current user cannot view the source page', async () => {
    await handler.setDecisionReview(request());
    mockState.pageStatusCode = 403;
    await expect(handler.getDecisionReviewHistory(request())).rejects.toThrow(/cannot view/);
  });

  it('isolates history by decision ID', async () => {
    await handler.setDecisionReview(request({ decisionId: '5144577' }));
    await handler.setDecisionReview(request({ decisionId: '5144578' }));
    const history = await handler.getDecisionReviewHistory(request({ decisionId: '5144577' }));
    expect(history.events).toHaveLength(1);
    expect(history.events[0].decisionId).toBe('5144577');
  });
});
