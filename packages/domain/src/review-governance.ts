export type DecisionReviewStatus = 'approved' | 'rejected' | 'needs-review';

export interface DecisionReviewCommand {
  decisionId: string;
  status: DecisionReviewStatus;
  reviewerAccountId: string;
  sourceVersion: number;
  reason: string;
}

export interface DecisionReviewRecord extends DecisionReviewCommand {
  schemaVersion: 2;
  eventId: string;
  reviewedAt: string;
  revision: number;
}

const DECISION_ID_PATTERN = /^\d{1,30}$/;
const REVIEW_STATUSES = new Set<DecisionReviewStatus>([
  'approved',
  'rejected',
  'needs-review',
]);
const MIN_REASON_LENGTH = 20;
const MAX_REASON_LENGTH = 1000;
const MAX_REVIEWER_ID_LENGTH = 255;

export function validateDecisionReviewCommand(
  input: unknown
): DecisionReviewCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('A decision review command is required.');
  }

  const value = input as Record<string, unknown>;
  const decisionId = String(value.decisionId ?? '').trim();
  const status = String(value.status ?? '').trim() as DecisionReviewStatus;
  const reviewerAccountId = String(value.reviewerAccountId ?? '').trim();
  const sourceVersion = value.sourceVersion;
  const reason = String(value.reason ?? '').trim();

  if (!DECISION_ID_PATTERN.test(decisionId)) {
    throw new Error('A valid Confluence page ID is required.');
  }

  if (!REVIEW_STATUSES.has(status)) {
    throw new Error('Review status must be approved, rejected or needs-review.');
  }

  if (!reviewerAccountId || reviewerAccountId.length > MAX_REVIEWER_ID_LENGTH) {
    throw new Error('The authenticated reviewer identity is required.');
  }

  if (
    typeof sourceVersion !== 'number' ||
    !Number.isSafeInteger(sourceVersion) ||
    sourceVersion < 1
  ) {
    throw new Error('A valid current Confluence page version is required.');
  }

  if (reason.length > MAX_REASON_LENGTH) {
    throw new Error(`Review rationale must not exceed ${MAX_REASON_LENGTH} characters.`);
  }

  if (
    (status === 'approved' || status === 'rejected') &&
    reason.length < MIN_REASON_LENGTH
  ) {
    throw new Error(`A rationale of at least ${MIN_REASON_LENGTH} characters is required to approve or reject a decision.`);
  }

  return {
    decisionId,
    status,
    reviewerAccountId,
    sourceVersion,
    reason,
  };
}

export function createDecisionReviewRecord(
  commandInput: unknown,
  metadata: {
    eventId: string;
    reviewedAt: string;
    revision: number;
  }
): DecisionReviewRecord {
  const command = validateDecisionReviewCommand(commandInput);
  const eventId = String(metadata.eventId ?? '').trim();
  const reviewedAt = String(metadata.reviewedAt ?? '').trim();
  const revision = metadata.revision;

  if (!eventId || eventId.length > 128) {
    throw new Error('A unique review event ID is required.');
  }

  if (!reviewedAt || !Number.isFinite(Date.parse(reviewedAt))) {
    throw new Error('A valid review timestamp is required.');
  }

  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('A valid review revision is required.');
  }

  return {
    schemaVersion: 2,
    ...command,
    eventId,
    reviewedAt,
    revision,
  };
}

/**
 * A review is authoritative only for the exact Confluence page version
 * the reviewer examined. Missing or legacy versions fail closed.
 */
export function effectiveDecisionReviewStatus(
  record: Partial<DecisionReviewRecord> | null | undefined,
  currentSourceVersion: number | null | undefined
): DecisionReviewStatus {
  if (!record || record.schemaVersion !== 2) return 'needs-review';

  if (
    typeof currentSourceVersion !== 'number' ||
    !Number.isSafeInteger(currentSourceVersion) ||
    currentSourceVersion < 1 ||
    record.sourceVersion !== currentSourceVersion
  ) {
    return 'needs-review';
  }

  if (!REVIEW_STATUSES.has(record.status as DecisionReviewStatus)) {
    return 'needs-review';
  }

  return record.status as DecisionReviewStatus;
}