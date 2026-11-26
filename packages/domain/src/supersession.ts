import type { Decision, WorkItem, Flag, Claim } from './types.js';

const REVERSAL_PATTERNS: RegExp[] = [
  /\bwe(?:'re| are)?\s+(?:now\s+)?(?:going|moving|switching)\s+(?:with|to)\s+([A-Z][\w.-]*(?:\s+[A-Z][\w.-]*)*)/i,
  /\bwe(?:'ve| have)?\s+decided\s+(?:to\s+)?(?:go\s+with|use|switch\s+to)\s+([A-Z][\w.-]*(?:\s+[A-Z][\w.-]*)*)/i,
  /\bactually,?\s+(?:let'?s|let\s+us|we'?ll|we\s+will)\s+(?:go\s+with|use|switch\s+to)\s+([A-Z][\w.-]*(?:\s+[A-Z][\w.-]*)*)/i,
];

const PROPOSAL_PATTERNS: RegExp[] = [
  /\bwe\s+(?:should|could|might|may)\s+(?:consider\s+)?(?:go(?:ing)?\s+with|us(?:ing)?|switch(?:ing)?\s+to)\s+([A-Z][\w.-]*(?:\s+[A-Z][\w.-]*)*)/i,
  /\bwhat\s+(?:if|about)\s+we\s+(?:go\s+with|use|switch\s+to)\s+([A-Z][\w.-]*(?:\s+[A-Z][\w.-]*)*)/i,
];

const CLAIM_USE =
  /\b(?:[Uu]se|[Uu]sing|[Aa]dopt|[Aa]dopting|[Gg]oing\s+[Ww]ith)\b\s+([A-Z][\w-]*(?:\.[A-Z][\w-]*)*(?:\s+[A-Z][\w-]*(?:\.[A-Z][\w-]*)*)*)/g;

const CLAIM_EXCLUDE =
  /\b(?:[Ee]xclude|[Ee]xcluding|[Aa]void|[Aa]voiding|[Dd]rop|[Dd]ropping|[Rr]eject|[Rr]ejecting)\b\s+([A-Z][\w-]*(?:\.[A-Z][\w-]*)*(?:\s+[A-Z][\w-]*(?:\.[A-Z][\w-]*)*)*)/g;

const NEGATION_CONTEXT =
  /\b(?:not|no\s+longer|don'?t|doesn'?t|won'?t|stop|avoid|exclude|drop|reject|remove|removing|removed|migrate\s+from|migrating\s+from|disable|disabling|deprecate|deprecated)\b/i;

function extractMatches(
  decision: Decision,
  pattern: RegExp,
  kind: Claim['kind'],
  startIndex: number
): Claim[] {
  const claims: Claim[] = [];
  const regex = new RegExp(pattern.source, pattern.flags);

  for (const match of decision.text.matchAll(regex)) {
    const rawValue = match[1].trim();

    // A modal word immediately attached to an uppercase candidate
    // makes the extracted target ambiguous. Do not invent a claim.
    if (
      /\s+(?:SHOULD|MUST|SHALL|WILL|MAY|CAN|COULD|WOULD)\s*$/.test(rawValue)
    ) {
      continue;
    }

    const value = rawValue.replace(/[.,;:]+$/, '').trim();

    if (!value || value.length > 100) continue;

    claims.push({
      id: `${decision.id}-claim-${startIndex + claims.length}`,
      decisionId: decision.id,
      kind,
      value,
      quotedText: match[0],
      confidence: 0.9
    });
  }

  return claims;
}

export function extractClaims(decision: Decision): Claim[] {
  const uses = extractMatches(decision, CLAIM_USE, 'use', 0);
  const excludes = extractMatches(
    decision,
    CLAIM_EXCLUDE,
    'exclude',
    uses.length
  );

  return [...uses, ...excludes];
}

interface ReversalHit {
  value: string;
  quote: string;
  isProposal: boolean;
}

function detectReversal(text: string): ReversalHit | null {
  for (const pattern of REVERSAL_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return { value: match[1], quote: match[0], isProposal: false };
    }
  }

  for (const pattern of PROPOSAL_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return { value: match[1], quote: match[0], isProposal: true };
    }
  }

  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineContaining(haystack: string, needle: string): string {
  return haystack.split('\n').find(
    (line) => line.toLowerCase().includes(needle.toLowerCase())
  ) ?? needle;
}

function hashShort(value: string): string {
  let hash = 0;

  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }

  return Math.abs(hash).toString(36).slice(0, 6);
}

export interface DetectInput {
  decisions: Decision[];
  workItems: WorkItem[];
}

export function detectFlags(input: DetectInput): Flag[] {
  const flags: Flag[] = [];
  const supersededById = new Map<string, Decision>();
  const activeDecisions: Decision[] = [];

  for (const decision of input.decisions) {
    if (decision.status === 'superseded') {
      supersededById.set(decision.id, decision);
    }

    if (decision.status === 'active') {
      activeDecisions.push(decision);
    }
  }

  for (const workItem of input.workItems) {
    for (const linkedId of workItem.linkedDecisionIds) {
      const superseded = supersededById.get(linkedId);

      if (superseded?.supersededBy) {
        flags.push({
          id: `flag-${workItem.key}-${superseded.id}-explicit`,
          workItemKey: workItem.key,
          decisionId: superseded.id,
          ruleId: 'explicit-supersession',
          verdict: 'conflict',
          confidence: 0.95,
          evidenceQuote:
            `Work item ${workItem.key} is linked to superseded decision "${superseded.title}"`,
          rationale:
            `Decision was superseded by "${superseded.supersededBy}". Work item still references it.`
        });
      }
    }

    const haystack = [
      workItem.summary,
      workItem.description,
      ...workItem.comments
    ].join('\n');

    for (const decision of activeDecisions) {
      for (const claim of decision.claims) {
        if (claim.kind !== 'exclude') continue;

        const expression = new RegExp(
          `\\b${escapeRegex(claim.value)}\\b`,
          'i'
        );

        if (!expression.test(haystack)) continue;

        const line = lineContaining(haystack, claim.value);
        const negated = NEGATION_CONTEXT.test(line);

        flags.push({
          id: `flag-${workItem.key}-${claim.id}-contradiction`,
          workItemKey: workItem.key,
          decisionId: decision.id,
          claimId: claim.id,
          ruleId: 'claim-contradiction',
          verdict: negated ? 'review' : 'conflict',
          confidence: negated ? 0.5 : 0.85,
          evidenceQuote: line,
          rationale: negated
            ? `Mention of "${claim.value}" appears in a negated context. Needs human review.`
            : `Active decision excludes "${claim.value}", but work item still mentions it.`
        });
      }
    }

    for (const comment of workItem.comments) {
      const hit = detectReversal(comment);

      if (!hit || hit.isProposal) continue;

      flags.push({
        id: `flag-${workItem.key}-${hashShort(comment)}-informal`,
        workItemKey: workItem.key,
        decisionId: 'informal',
        ruleId: 'informal-reversal',
        verdict: 'review',
        confidence: 0.6,
        evidenceQuote: hit.quote,
        rationale:
          `Comment suggests reversal to "${hit.value}". Low confidence; requires review.`
      });
    }
  }

  return flags;
}