import type { Claim } from './types.js';

/**
 * A search hit is only surfaced as a decision candidate when it:
 * 1. Contains an explicit extractable claim.
 * 2. Has a decision-related title, decision language, or
 *    an explicit governance status on a standard/policy page.
 *
 * Templates are excluded from the candidate register.
 */
export function isDecisionCandidate(
  title: string,
  text: string,
  claims: Claim[]
): boolean {
  if (claims.length === 0) return false;

  if (/\btemplate\b/i.test(title)) return false;

  const decisionTitle =
    /\bdecision\b|\bADR\b/i.test(title);

  const decisionLanguage =
    /\b(?:final decision|decision owner|decision date|decision status|we have decided|we decided|the decision is|decision was made|approved approach)\b/i.test(text);

  const governedStandard =
    /\b(?:standard|policy|architecture)\b/i.test(title) &&
    /\b(?:approved|active|effective)\b/i.test(text);

  return decisionTitle || decisionLanguage || governedStandard;
}