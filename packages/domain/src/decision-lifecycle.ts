export type EffectiveDecisionStatus =
  | 'active'
  | 'superseded'
  | 'rejected'
  | 'proposed';

export type EffectiveApprovalState = 'approved' | 'rejected' | 'unverified';

export interface DecisionLifecycleInput {
  declaredStatus?: string | null;
  derivedStatus?: string | null;
  reviewStatus?: string | null;
}

export interface DecisionLifecycle {
  status: EffectiveDecisionStatus;
  approvalState: EffectiveApprovalState;
  authoritative: boolean;
  superseded: boolean;
  rejected: boolean;
}

function normalizeStatus(value?: string | null): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/\s+/g, '-')
    : '';
}

/**
 * Shared precedence for graph, flag engine and Rovo. Supersession outranks
 * approval; rejection outranks a page's Active declaration; approval is
 * authoritative only for an active source decision and a current review.
 */
export function resolveDecisionLifecycle(
  input: DecisionLifecycleInput
): DecisionLifecycle {
  const sourceStatus = normalizeStatus(input.derivedStatus)
    || normalizeStatus(input.declaredStatus);
  const reviewStatus = normalizeStatus(input.reviewStatus);
  const superseded = ['superseded', 'retired', 'revoked', 'reversed'].includes(sourceStatus);
  const rejected = reviewStatus === 'rejected';

  const authoritative = reviewStatus === 'approved'
    && !superseded
    && ['active', 'approved'].includes(sourceStatus);

  const approvalState: EffectiveApprovalState = rejected
    ? 'rejected'
    : authoritative
      ? 'approved'
      : 'unverified';

  const status: EffectiveDecisionStatus = superseded
    ? 'superseded'
    : rejected
      ? 'rejected'
      : authoritative
        ? 'active'
        : 'proposed';

  return { status, approvalState, authoritative, superseded, rejected };
}
