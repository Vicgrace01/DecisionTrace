export type DecisionSourceType = 'confluence-page' | 'jira-comment';
export type DecisionStatus = 'active' | 'superseded' | 'proposed';

export interface Claim {
  id: string;
  decisionId: string;
  kind: 'use' | 'exclude' | 'require' | 'prefer';
  value: string;
  quotedText: string;
  confidence: number;
}

export interface Decision {
  id: string;
  sourceType: DecisionSourceType;
  sourceUrl: string;
  title: string;
  text: string;
  status: DecisionStatus;
  claims: Claim[];
  supersededBy?: string;
  createdAt: string;
}

export type WorkItemType = 'epic' | 'task' | 'bug' | 'story';
export type WorkItemStatus = 'todo' | 'in-progress' | 'in-review' | 'done';

export interface WorkItem {
  id: string;
  key: string;
  type: WorkItemType;
  summary: string;
  description: string;
  comments: string[];
  status: WorkItemStatus;
  priority: 'lowest' | 'low' | 'medium' | 'high' | 'highest';
  storyPoints?: number;
  estimatedHours?: number;
  assignee?: string;
  dueDate?: string;
  linkedDecisionIds: string[];
  linkedWorkItemKeys: string[];
}

export type FlagRuleId = 'explicit-supersession' | 'claim-contradiction' | 'informal-reversal';
export type FlagVerdict = 'conflict' | 'review';

export interface Flag {
  id: string;
  workItemKey: string;
  decisionId: string;
  claimId?: string;
  ruleId: FlagRuleId;
  verdict: FlagVerdict;
  confidence: number;
  evidenceQuote: string;
  rationale: string;
}

export interface BlastRadiusEntry {
  workItemKey: string;
  summary: string;
  status: WorkItemStatus;
  priority: string;
  storyPoints: number;
  estimatedHours: number;
  assignee?: string;
  dueDate?: string;
  depth: number;
  path: string[];
}

export interface BlastRadiusResult {
  decisionId: string;
  totalItems: number;
  totalStoryPoints: number;
  totalEstimatedHours: number;
  entries: BlastRadiusEntry[];
}
