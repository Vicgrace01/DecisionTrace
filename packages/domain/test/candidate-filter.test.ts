import { describe, expect, test } from 'vitest';
import { isDecisionCandidate } from '../src/candidate-filter.js';
import type { Claim } from '../src/types.js';

const claims: Claim[] = [{
  id: 'd1-claim-0',
  decisionId: 'd1',
  kind: 'use',
  value: 'Vendor B',
  quotedText: 'use Vendor B',
  confidence: 0.9
}];

describe('decision candidate filtering', () => {
  test('accepts a titled decision page with explicit claims', () => {
    expect(isDecisionCandidate(
      'Decision: Authentication Provider',
      'Final Decision: use Vendor B',
      claims
    )).toBe(true);
  });

  test('accepts a page with explicit decision language', () => {
    expect(isDecisionCandidate(
      'Authentication Provider',
      'We have decided to use Vendor B',
      claims
    )).toBe(true);
  });

  test('rejects templates', () => {
    expect(isDecisionCandidate(
      'Template - Decision documentation',
      'Final Decision: use Vendor B',
      claims
    )).toBe(false);
  });

  test('rejects pages with claims but no decision signal', () => {
    expect(isDecisionCandidate(
      'COVID 19 Update',
      'Please use Vendor B for support',
      claims
    )).toBe(false);
  });

  test('rejects pages with no explicit claims', () => {
    expect(isDecisionCandidate(
      'Decision: Authentication Provider',
      'The team will review options',
      []
    )).toBe(false);
  });

  test('recognises explicitly governed standards', () => {
    expect(isDecisionCandidate(
      'Standard Node.js Tech Stack',
      'Status: approved. Adopt Vendor B.',
      claims
    )).toBe(true);
  });
});