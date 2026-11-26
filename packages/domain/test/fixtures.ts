import type { Decision, WorkItem } from '../src/types.js';

export type FlagRule = 'explicit-supersession' | 'claim-contradiction' | 'informal-reversal';

export interface Fixture {
  name: string;
  decisions: Decision[];
  workItems: WorkItem[];
  expect: {
    positive: boolean;
    rule?: FlagRule;
    verdict?: 'conflict' | 'review';
    minFlags?: number;
  };
}

const dec = (p: Partial<Decision> & Pick<Decision, 'id' | 'title' | 'text'>): Decision => ({
  sourceType: 'confluence-page',
  sourceUrl: 'https://example.atlassian.net/wiki/x',
  status: 'active',
  claims: [],
  createdAt: '2026-11-01T00:00:00Z',
  ...p,
});

const wi = (p: Partial<WorkItem> & Pick<WorkItem, 'key' | 'summary'>): WorkItem => ({
  id: p.key,
  type: 'task',
  description: '',
  comments: [],
  status: 'todo',
  priority: 'medium',
  linkedDecisionIds: [],
  linkedWorkItemKeys: [],
  ...p,
});

export const FIXTURES: Fixture[] = [
  { name: 'supersede: linked work item flags', decisions: [dec({ id: 'd1', title: 'Use Vendor A', text: 'Use Vendor A.', status: 'superseded', supersededBy: 'd2' })], workItems: [wi({ key: 'PROJ-1', summary: 'Integrate Vendor A', linkedDecisionIds: ['d1'] })], expect: { positive: true, rule: 'explicit-supersession', verdict: 'conflict' } },
  { name: 'supersede: with claims on decision', decisions: [dec({ id: 'd1', title: 'Vendor A', text: 'Use Vendor A for auth.', status: 'superseded', supersededBy: 'd2' })], workItems: [wi({ key: 'PROJ-2', summary: 'Vendor A integration', linkedDecisionIds: ['d1'] })], expect: { positive: true, rule: 'explicit-supersession' } },
  { name: 'supersede: multiple linked work items', decisions: [dec({ id: 'd1', title: 'Vendor A', text: 'Use Vendor A.', status: 'superseded', supersededBy: 'd2' })], workItems: [wi({ key: 'PROJ-3', summary: 'Task one', linkedDecisionIds: ['d1'] }), wi({ key: 'PROJ-4', summary: 'Task two', linkedDecisionIds: ['d1'] })], expect: { positive: true, rule: 'explicit-supersession', minFlags: 2 } },
  { name: 'supersede: chain D1->D2->D3 linked to D1', decisions: [dec({ id: 'd1', title: 'Vendor A', text: 'Use Vendor A.', status: 'superseded', supersededBy: 'd2' }), dec({ id: 'd2', title: 'Vendor B', text: 'Use Vendor B.', status: 'superseded', supersededBy: 'd3' }), dec({ id: 'd3', title: 'Vendor C', text: 'Use Vendor C.', status: 'active' })], workItems: [wi({ key: 'PROJ-5', summary: 'Still on Vendor A', linkedDecisionIds: ['d1'] })], expect: { positive: true, rule: 'explicit-supersession' } },

  { name: 'exclude: summary mentions excluded value', decisions: [dec({ id: 'd1', title: 'Exclude Vendor A', text: 'Exclude Vendor A from all auth flows.' })], workItems: [wi({ key: 'PROJ-6', summary: 'Integrate Vendor A' })], expect: { positive: true, rule: 'claim-contradiction', verdict: 'conflict' } },
  { name: 'exclude: description mentions excluded value', decisions: [dec({ id: 'd1', title: 'Exclude Vendor A', text: 'Exclude Vendor A.' })], workItems: [wi({ key: 'PROJ-7', summary: 'Auth work', description: 'Hook Vendor A into login.' })], expect: { positive: true, rule: 'claim-contradiction', verdict: 'conflict' } },
  { name: 'exclude: comment mentions excluded value', decisions: [dec({ id: 'd1', title: 'Exclude Vendor A', text: 'Exclude Vendor A.' })], workItems: [wi({ key: 'PROJ-8', summary: 'Auth work', comments: ['pinging Vendor A for docs'] })], expect: { positive: true, rule: 'claim-contradiction', verdict: 'conflict' } },
  { name: 'exclude: case insensitive match', decisions: [dec({ id: 'd1', title: 'Exclude Vendor A', text: 'Exclude Vendor A.' })], workItems: [wi({ key: 'PROJ-9', summary: 'vendor a integration' })], expect: { positive: true, rule: 'claim-contradiction' } },
  { name: 'exclude: "Migrate from Vendor A"', decisions: [dec({ id: 'd1', title: 'Exclude Vendor A', text: 'Exclude Vendor A.' })], workItems: [wi({ key: 'PROJ-10', summary: 'Migrate from Vendor A' })], expect: { positive: true, rule: 'claim-contradiction' } },
  { name: 'exclude: mention in epic description', decisions: [dec({ id: 'd1', title: 'Exclude Vendor A', text: 'Exclude Vendor A.' })], workItems: [wi({ key: 'EPIC-1', type: 'epic', summary: 'Auth overhaul', description: 'Rip out Vendor A.' })], expect: { positive: true, rule: 'claim-contradiction', verdict: 'conflict' } },
  { name: 'exclude: question form', decisions: [dec({ id: 'd1', title: 'Exclude Vendor A', text: 'Exclude Vendor A.' })], workItems: [wi({ key: 'PROJ-11', summary: 'Auth', comments: ['are we still on Vendor A?'] })], expect: { positive: true, rule: 'claim-contradiction' } },

  { name: 'informal: "we are going with Vendor B now"', decisions: [dec({ id: 'd1', title: 'Vendor A', text: 'Use Vendor A.' })], workItems: [wi({ key: 'PROJ-12', summary: 'Auth work', comments: ['we are going with Vendor B now'] })], expect: { positive: true, rule: 'informal-reversal', verdict: 'review' } },
  { name: 'informal: "we have decided to switch to Vendor B"', decisions: [dec({ id: 'd1', title: 'Vendor A', text: 'Use Vendor A.' })], workItems: [wi({ key: 'PROJ-13', summary: 'Auth work', comments: ['we have decided to switch to Vendor B'] })], expect: { positive: true, rule: 'informal-reversal', verdict: 'review' } },
  { name: 'informal: "actually, let us go with Vendor B"', decisions: [dec({ id: 'd1', title: 'Vendor A', text: 'Use Vendor A.' })], workItems: [wi({ key: 'PROJ-14', summary: 'Auth work', comments: ['actually, let us go with Vendor B'] })], expect: { positive: true, rule: 'informal-reversal', verdict: 'review' } },
  { name: 'informal: "we are moving to Vendor B"', decisions: [dec({ id: 'd1', title: 'Vendor A', text: 'Use Vendor A.' })], workItems: [wi({ key: 'PROJ-15', summary: 'Auth work', comments: ['we are moving to Vendor B'] })], expect: { positive: true, rule: 'informal-reversal', verdict: 'review' } },
  { name: 'informal: "we are switching to Vendor B"', decisions: [dec({ id: 'd1', title: 'Vendor A', text: 'Use Vendor A.' })], workItems: [wi({ key: 'PROJ-16', summary: 'Auth work', comments: ['we are switching to Vendor B'] })], expect: { positive: true, rule: 'informal-reversal', verdict: 'review' } },

  { name: 'combined: supersession + exclude', decisions: [dec({ id: 'd1', title: 'Vendor A', text: 'Use Vendor A.', status: 'superseded', supersededBy: 'd2' }), dec({ id: 'd2', title: 'Exclude Vendor A', text: 'Exclude Vendor A.', status: 'active' })], workItems: [wi({ key: 'PROJ-17', summary: 'Integrate Vendor A', linkedDecisionIds: ['d1'] })], expect: { positive: true, minFlags: 1 } },
  { name: 'combined: informal + exclude', decisions: [dec({ id: 'd1', title: 'Exclude Vendor A', text: 'Exclude Vendor A.' })], workItems: [wi({ key: 'PROJ-18', summary: 'Auth work', comments: ['we are going with Vendor A now'] })], expect: { positive: true, minFlags: 1 } },

  { name: 'negative: active + linked, no contradiction', decisions: [dec({ id: 'd1', title: 'Use Vendor B', text: 'Use Vendor B.' })], workItems: [wi({ key: 'PROJ-19', summary: 'Vendor B integration', linkedDecisionIds: ['d1'] })], expect: { positive: false } },
  { name: 'negative: use claim matches work item', decisions: [dec({ id: 'd1', title: 'Vendor B', text: 'Use Vendor B.' })], workItems: [wi({ key: 'PROJ-20', summary: 'Vendor B integration' })], expect: { positive: false } },
  { name: 'negative: exclude claim, no mention', decisions: [dec({ id: 'd1', title: 'Exclude Vendor A', text: 'Exclude Vendor A.' })], workItems: [wi({ key: 'PROJ-21', summary: 'Unrelated work' })], expect: { positive: false } },
  { name: 'negative: proposal "should consider"', decisions: [dec({ id: 'd1', title: 'Vendor A', text: 'Use Vendor A.' })], workItems: [wi({ key: 'PROJ-22', summary: 'Auth work', comments: ['we should consider Vendor B'] })], expect: { positive: false } },
  { name: 'negative: proposal "what if"', decisions: [dec({ id: 'd1', title: 'Vendor A', text: 'Use Vendor A.' })], workItems: [wi({ key: 'PROJ-23', summary: 'Auth work', comments: ['what if we switch to Vendor B'] })], expect: { positive: false } },
  { name: 'negative: empty work item', decisions: [dec({ id: 'd1', title: 'Vendor A', text: 'Use Vendor A.' })], workItems: [wi({ key: 'PROJ-24', summary: '' })], expect: { positive: false } },
  { name: 'negative: decision with no claims', decisions: [dec({ id: 'd1', title: 'General decision', text: 'We will review this next quarter.' })], workItems: [wi({ key: 'PROJ-25', summary: 'Work', linkedDecisionIds: ['d1'] })], expect: { positive: false } },
  { name: 'negative: "Vendor AB" is not "Vendor A"', decisions: [dec({ id: 'd1', title: 'Exclude Vendor A', text: 'Exclude Vendor A.' })], workItems: [wi({ key: 'PROJ-26', summary: 'Integrate Vendor AB' })], expect: { positive: false } },
  { name: 'negative: linked to active decision', decisions: [dec({ id: 'd1', title: 'Use Vendor A', text: 'Use Vendor A.' })], workItems: [wi({ key: 'PROJ-27', summary: 'Vendor A integration', linkedDecisionIds: ['d1'] })], expect: { positive: false } },
  { name: 'negative: two active decisions, linked to both', decisions: [dec({ id: 'd1', title: 'Use Vendor A', text: 'Use Vendor A.' }), dec({ id: 'd2', title: 'Also Vendor A', text: 'Adopt Vendor A.' })], workItems: [wi({ key: 'PROJ-28', summary: 'Vendor A integration', linkedDecisionIds: ['d1', 'd2'] })], expect: { positive: false } },
  { name: 'negative: unrelated comment', decisions: [dec({ id: 'd1', title: 'Vendor A', text: 'Use Vendor A.' })], workItems: [wi({ key: 'PROJ-29', summary: 'Auth work', comments: ['need coffee, this is slow'] })], expect: { positive: false } },
  { name: 'negative: lowercase "the vendor"', decisions: [dec({ id: 'd1', title: 'Exclude Vendor A', text: 'Exclude Vendor A.' })], workItems: [wi({ key: 'PROJ-30', summary: 'talk to the vendor about pricing' })], expect: { positive: false } },
  { name: 'removal: removing excluded option is review, not conflict', decisions: [dec({ id: 'd1', title: 'Exclude Vendor A', text: 'Exclude Vendor A.' })], workItems: [wi({ key: 'PROJ-31', summary: 'Remove Vendor A token fallback' })], expect: { positive: true, rule: 'claim-contradiction', verdict: 'review' } },
  { name: 'migration: migrating from excluded option is review, not conflict', decisions: [dec({ id: 'd1', title: 'Exclude Vendor A', text: 'Exclude Vendor A.' })], workItems: [wi({ key: 'PROJ-32', summary: 'Migrate from Vendor A' })], expect: { positive: true, rule: 'claim-contradiction', verdict: 'review' } },];
