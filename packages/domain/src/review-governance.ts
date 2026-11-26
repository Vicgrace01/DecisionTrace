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
const MAX_REVISION = 2_147_483_647;
const RESET_REASON = 'Review reset to needs-review.';

/**
 * Validates review command fields. The resolver must supply reviewer identity
 * from trusted Forge invocation context and sourceVersion from Confluence.
 */
export function validateDecisionReviewCommand(
  input: unknown
): DecisionReviewCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('A decision review command is required.');
  }

  const value = input as Record<string, unknown>;
  const decisionId = typeof value.decisionId === 'string' ? value.decisionId.trim() : '';
  const status = typeof value.status === 'string'
    ? value.status.trim() as DecisionReviewStatus
    : undefined;
  const reviewerAccountId = typeof value.reviewerAccountId === 'string'
    ? value.reviewerAccountId.trim()
    : '';
  const sourceVersion = value.sourceVersion;
  const suppliedReason = typeof value.reason === 'string' ? value.reason.trim() : '';
  // Custom Entity Store string attributes must be non-empty. A reset remains
  // an explicit audit event without requiring the reviewer to write prose.
  const reason = status === 'needs-review' && !suppliedReason
    ? RESET_REASON
    : suppliedReason;

  if (!DECISION_ID_PATTERN.test(decisionId)) {
    throw new Error('A valid Confluence page ID is required.');
  }
  if (!status || !REVIEW_STATUSES.has(status)) {
    throw new Error('Review status must be approved, rejected or needs-review.');
  }
  if (!reviewerAccountId || reviewerAccountId.length > MAX_REVIEWER_ID_LENGTH) {
    throw new Error('The authenticated reviewer identity is required.');
  }
  if (
    typeof sourceVersion !== 'number' ||
    !Number.isSafeInteger(sourceVersion) ||
    sourceVersion < 1 ||
    sourceVersion > MAX_REVISION
  ) {
    throw new Error('A valid current Confluence page version is required.');
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new Error('Review rationale must not exceed ' + MAX_REASON_LENGTH + ' characters.');
  }
  if (
    (status === 'approved' || status === 'rejected') &&
    reason.length < MIN_REASON_LENGTH
  ) {
    throw new Error(
      'A rationale of at least ' + MIN_REASON_LENGTH +
      ' characters is required to approve or reject a decision.'
    );
  }

  return { decisionId, status, reviewerAccountId, sourceVersion, reason };
}

/**
 * A persisted record is valid only when every command and audit field is
 * present. Legacy and partially-written values fail closed.
 */
export function isValidDecisionReviewRecord(
  recordInput: unknown,
  expectedDecisionId?: string
): recordInput is DecisionReviewRecord {
  if (!recordInput || typeof recordInput !== 'object' || Array.isArray(recordInput)) {
    return false;
  }

  const record = recordInput as Record<string, unknown>;
  if (record.schemaVersion !== 2) return false;
  // Validation of incoming commands may synthesize a default reset reason;
  // persisted records must already contain their own non-empty audit reason.
  if (typeof record.reason !== 'string' || !record.reason.trim()) return false;

  try {
    const command = validateDecisionReviewCommand(record);
    const eventId = typeof record.eventId === 'string' ? record.eventId.trim() : '';
    const reviewedAt = typeof record.reviewedAt === 'string' ? record.reviewedAt.trim() : '';
    const revision = record.revision;

    if (expectedDecisionId && command.decisionId !== expectedDecisionId) return false;
    if (!eventId || eventId.length > 128) return false;
    if (!reviewedAt || !Number.isFinite(Date.parse(reviewedAt))) return false;
    if (
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      revision > MAX_REVISION
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
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
  const eventId = typeof metadata?.eventId === 'string' ? metadata.eventId.trim() : '';
  const reviewedAt = typeof metadata?.reviewedAt === 'string' ? metadata.reviewedAt.trim() : '';
  const revision = metadata?.revision;

  if (!eventId || eventId.length > 128) {
    throw new Error('A unique review event ID is required.');
  }
  if (!reviewedAt || !Number.isFinite(Date.parse(reviewedAt))) {
    throw new Error('A valid review timestamp is required.');
  }
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    revision > MAX_REVISION
  ) {
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
 * A review applies only to the exact current Confluence page version.
 * Missing, legacy, malformed or stale records are treated as needs-review.
 */
export function effectiveDecisionReviewStatus(
  record: Partial<DecisionReviewRecord> | null | undefined,
  currentSourceVersion: number | null | undefined,
  expectedDecisionId?: string
): DecisionReviewStatus {
  if (!isValidDecisionReviewRecord(record, expectedDecisionId)) {
    return 'needs-review';
  }
  if (
    typeof currentSourceVersion !== 'number' ||
    !Number.isSafeInteger(currentSourceVersion) ||
    currentSourceVersion < 1 ||
    record.sourceVersion !== currentSourceVersion
  ) {
    return 'needs-review';
  }
  return record.status;
}
