import { describe, expect, it } from 'vitest';
import {
  createDecisionReviewRecord,
  effectiveDecisionReviewStatus,
  validateDecisionReviewCommand,
} from '../src/review-governance.js';

const validCommand = {
  decisionId: '5144577',
  status: 'approved',
  reviewerAccountId: 'atlassian-account-123',
  sourceVersion: 7,
  reason: 'Architecture review completed and the selected provider is accepted.',
};

describe('decision review governance contract', () => {
  it('normalizes reviewer input and preserves the source version', () => {
    const result = validateDecisionReviewCommand({
      ...validCommand,
      decisionId: ' 5144577 ',
      reviewerAccountId: ' atlassian-account-123 ',
      reason: ` ${validCommand.reason} `,
    });

    expect(result).toEqual(validCommand);
  });

  it('accepts an explicit rejection with a rationale', () => {
    const result = validateDecisionReviewCommand({
      ...validCommand,
      status: 'rejected',
      reason: 'The decision lacks a security review and cannot be approved.',
    });

    expect(result.status).toBe('rejected');
  });

  it('allows a review reset without requiring an approval rationale', () => {
    const result = validateDecisionReviewCommand({
      ...validCommand,
      status: 'needs-review',
      reason: '',
    });

    expect(result.status).toBe('needs-review');
  });

  it('rejects malformed Confluence page IDs', () => {
    expect(() => validateDecisionReviewCommand({
      ...validCommand,
      decisionId: '../5144577',
    })).toThrow(/Confluence page ID/);
  });

  it('rejects unsupported review states', () => {
    expect(() => validateDecisionReviewCommand({
      ...validCommand,
      status: 'published',
    })).toThrow(/Review status/);
  });

  it('requires a reviewer identity supplied by trusted resolver context', () => {
    expect(() => validateDecisionReviewCommand({
      ...validCommand,
      reviewerAccountId: '',
    })).toThrow(/reviewer identity/);
  });

  it('requires a valid positive Confluence source version', () => {
    for (const sourceVersion of [0, -1, 1.5, Number.NaN, '7']) {
      expect(() => validateDecisionReviewCommand({
        ...validCommand,
        sourceVersion,
      })).toThrow(/page version/);
    }
  });

  it('requires a meaningful rationale for approval and rejection', () => {
    for (const status of ['approved', 'rejected']) {
      expect(() => validateDecisionReviewCommand({
        ...validCommand,
        status,
        reason: 'Looks fine',
      })).toThrow(/rationale/);
    }
  });

  it('enforces the rationale minimum at the exact 20-character boundary', () => {
    const exactMinimum = 'x'.repeat(20);
    const belowMinimum = 'x'.repeat(19);

    expect(validateDecisionReviewCommand({
      ...validCommand,
      reason: exactMinimum,
    }).reason).toBe(exactMinimum);

    expect(() => validateDecisionReviewCommand({
      ...validCommand,
      reason: belowMinimum,
    })).toThrow(/rationale/);
  });

  it('rejects an excessively long rationale', () => {
    expect(() => validateDecisionReviewCommand({
      ...validCommand,
      reason: 'x'.repeat(1001),
    })).toThrow(/must not exceed/);
  });

  it('creates a version-bound auditable review record', () => {
    const record = createDecisionReviewRecord(validCommand, {
      eventId: 'evt-unique-001',
      reviewedAt: '2026-11-26T12:00:00.000Z',
      revision: 1,
    });

    expect(record).toMatchObject({
      schemaVersion: 2,
      decisionId: '5144577',
      status: 'approved',
      reviewerAccountId: 'atlassian-account-123',
      sourceVersion: 7,
      eventId: 'evt-unique-001',
      revision: 1,
    });
  });

  it('rejects invalid event metadata', () => {
    expect(() => createDecisionReviewRecord(validCommand, {
      eventId: '',
      reviewedAt: '2026-11-26T12:00:00.000Z',
      revision: 1,
    })).toThrow(/event ID/);

    expect(() => createDecisionReviewRecord(validCommand, {
      eventId: 'evt-1',
      reviewedAt: 'not-a-date',
      revision: 1,
    })).toThrow(/timestamp/);
  });

  it('treats approval as authoritative for the exact reviewed page version', () => {
    const record = createDecisionReviewRecord(validCommand, {
      eventId: 'evt-unique-002',
      reviewedAt: '2026-11-26T12:00:00.000Z',
      revision: 1,
    });

    expect(effectiveDecisionReviewStatus(record, 7)).toBe('approved');
    expect(effectiveDecisionReviewStatus(record, 8)).toBe('needs-review');
  });

  it('fails closed for legacy, missing or malformed review records', () => {
    expect(effectiveDecisionReviewStatus(undefined, 7)).toBe('needs-review');
    expect(effectiveDecisionReviewStatus({ status: 'approved' } as never, 7)).toBe('needs-review');
    expect(effectiveDecisionReviewStatus({
      ...createDecisionReviewRecord(validCommand, {
        eventId: 'evt-unique-003',
        reviewedAt: '2026-11-26T12:00:00.000Z',
        revision: 1,
      }),
      sourceVersion: 0,
    }, 7)).toBe('needs-review');
  });
});