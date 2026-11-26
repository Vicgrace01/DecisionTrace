import { describe, test, expect } from 'vitest';
import { detectFlags, extractClaims } from '../src/supersession.js';
import type { Decision } from '../src/types.js';
import { FIXTURES } from './fixtures.js';

function prepare(decisions: Decision[]): Decision[] {
  return decisions.map((d) => (d.claims.length === 0 ? { ...d, claims: extractClaims(d) } : d));
}

describe('claim extraction quality', () => {
  test('rejects ambiguous uppercase modal text', () => {
    const decision: Decision = {
      id: 'noise-1',
      sourceType: 'confluence-page',
      sourceUrl: 'x',
      title: 'Standard Node.js Tech Stack',
      text: 'The team may adopt Blue SHOULD use the supported stack.',
      status: 'active',
      claims: [],
      createdAt: '2026-11-24T00:00:00Z'
    };

    expect(extractClaims(decision)).toHaveLength(0);
  });
});
describe('supersession detection on labeled set', () => {
  for (const fixture of FIXTURES) {
    test(fixture.name, () => {
      const flags = detectFlags({ decisions: prepare(fixture.decisions), workItems: fixture.workItems });
      if (fixture.expect.positive) {
        expect(flags.length).toBeGreaterThanOrEqual(fixture.expect.minFlags ?? 1);
        if (fixture.expect.rule) expect(flags.some((f) => f.ruleId === fixture.expect.rule)).toBe(true);
        if (fixture.expect.verdict) expect(flags.some((f) => f.verdict === fixture.expect.verdict)).toBe(true);
      } else {
        expect(flags).toHaveLength(0);
      }
    });
  }

  test('precision on labeled set >= 80%', () => {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const fixture of FIXTURES) {
      const flags = detectFlags({ decisions: prepare(fixture.decisions), workItems: fixture.workItems });
      const expectedPositive = fixture.expect.positive;
      const gotPositive = flags.length > 0;
      if (expectedPositive && gotPositive) tp++;
      else if (expectedPositive && !gotPositive) fn++;
      else if (!expectedPositive && gotPositive) fp++;
      else tn++;
    }
    const precision = tp / (tp + fp || 1);
    const recall = tp / (tp + fn || 1);
    console.log(`\n>> PRECISION: ${(precision * 100).toFixed(1)}% | RECALL: ${(recall * 100).toFixed(1)}% | TP: ${tp} | FP: ${fp} | FN: ${fn} | TN: ${tn} | total: ${FIXTURES.length}`);
    expect(precision).toBeGreaterThanOrEqual(0.8);
  });
});
