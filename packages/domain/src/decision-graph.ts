export type DecisionClaimKind = "USE" | "EXCLUDE";

export type DecisionApprovalState =
  | "approved"
  | "unverified"
  | "needs-review"
  | "rejected";

export interface DecisionGraphClaim {
  kind: DecisionClaimKind;
  text: string;
}

export interface DecisionGraphDecision {
  id: string;
  title: string;
  status?: string;
  approvalState?: DecisionApprovalState;
  sourceUrl?: string;
  claims: readonly DecisionGraphClaim[];
  supersedes?: readonly string[];
}

export interface DecisionGraphWorkItem {
  key: string;
  summary: string;
  description?: string | null;
  status?: string;
  issueType?: string;
  url?: string;
  labels?: readonly string[];
  comments?: readonly string[];
  linkedIssueKeys?: readonly string[];
  parentKey?: string | null;
  decisionIds?: readonly string[];
}

export interface DecisionEvidence {
  claimKind: DecisionClaimKind;
  claimText: string;
  sourceField: "summary" | "description" | "comment" | "label" | "explicit-reference";
  excerpt: string;
}

export type DecisionWorkRelationship =
  | "mentions-selected-option"
  | "mentions-excluded-option"
  | "mixed-or-ambiguous"
  | "explicit-reference";

export interface DecisionWorkLink {
  id: string;
  decisionId: string;
  workItemKey: string;
  relationship: DecisionWorkRelationship;
  evidenceStrength: "explicit" | "claim-match";
  matchedClaims: DecisionGraphClaim[];
  evidence: DecisionEvidence[];
}

export interface WorkItemLink {
  id: string;
  fromKey: string;
  toKey: string;
  relationship: "issue-link" | "parent";
}

export interface DecisionSupersessionLink {
  id: string;
  fromDecisionId: string;
  toDecisionId: string;
  relationship: "supersedes";
}

export interface DecisionGraph {
  decisions: DecisionGraphDecision[];
  workItems: DecisionGraphWorkItem[];
  decisionWorkLinks: DecisionWorkLink[];
  workItemLinks: WorkItemLink[];
  supersessionLinks: DecisionSupersessionLink[];
  stats: {
    decisionCount: number;
    workItemCount: number;
    directRelationshipCount: number;
    issueLinkCount: number;
    supersessionCount: number;
  };
}

export type ImpactSeverity = "critical" | "high" | "medium" | "low";

export interface AffectedWorkItem {
  key: string;
  summary: string;
  status?: string;
  url?: string;
  depth: number;
  path: string[];
  relationship: "direct" | "indirect";
  matchedClaims: DecisionGraphClaim[];
  riskFlags: string[];
  severity: ImpactSeverity;
}

export interface DecisionGraphBlastRadiusResult {
  decisionId: string;
  decisionTitle: string;
  directCount: number;
  indirectCount: number;
  totalCount: number;
  affectedItems: AffectedWorkItem[];
}

function normalizePhrase(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeKey(value: string): string {
  return value.trim().toUpperCase();
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const normalizedHaystack = normalizePhrase(haystack);
  const normalizedPhrase = normalizePhrase(phrase);

  if (!normalizedHaystack || !normalizedPhrase) return false;

  return (` ${normalizedHaystack} `).includes(` ${normalizedPhrase} `);
}

function excerpt(value: string, maxLength = 220): string {
  const clean = value.trim().replace(/\s+/g, " ");
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1)}…`;
}

function findClaimEvidence(
  item: DecisionGraphWorkItem,
  claim: DecisionGraphClaim
): DecisionEvidence | undefined {
  if (containsPhrase(item.summary, claim.text)) {
    return {
      claimKind: claim.kind,
      claimText: claim.text,
      sourceField: "summary",
      excerpt: excerpt(item.summary),
    };
  }

  if (item.description && containsPhrase(item.description, claim.text)) {
    return {
      claimKind: claim.kind,
      claimText: claim.text,
      sourceField: "description",
      excerpt: excerpt(item.description),
    };
  }

  for (const comment of item.comments ?? []) {
    if (containsPhrase(comment, claim.text)) {
      return {
        claimKind: claim.kind,
        claimText: claim.text,
        sourceField: "comment",
        excerpt: excerpt(comment),
      };
    }
  }
  for (const label of item.labels ?? []) {
    if (containsPhrase(label, claim.text)) {
      return {
        claimKind: claim.kind,
        claimText: claim.text,
        sourceField: "label",
        excerpt: excerpt(label),
      };
    }
  }

  return undefined;
}

function isSuperseded(status?: string): boolean {
  const normalized = normalizePhrase(status ?? "");
  return ["superseded", "reversed", "retired", "revoked"].includes(normalized);
}

function uniqueBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildDecisionGraph(
  decisionsInput: readonly DecisionGraphDecision[],
  workItemsInput: readonly DecisionGraphWorkItem[]
): DecisionGraph {
  const decisions = uniqueBy(
    decisionsInput.filter((item) => item.id.trim() && item.title.trim()),
    (item) => item.id
  );

  const workItems = uniqueBy(
    workItemsInput.filter((item) => item.key.trim()),
    (item) => normalizeKey(item.key)
  ).map((item) => ({ ...item, key: normalizeKey(item.key) }));

  const knownWorkKeys = new Set(workItems.map((item) => item.key));
  const decisionWorkLinks: DecisionWorkLink[] = [];
  const workItemLinks: WorkItemLink[] = [];
  const supersessionLinks: DecisionSupersessionLink[] = [];

  for (const decision of decisions) {
    for (const item of workItems) {
      const matchedClaims: DecisionGraphClaim[] = [];
      const evidence: DecisionEvidence[] = [];

      for (const claim of decision.claims ?? []) {
        const match = findClaimEvidence(item, claim);
        if (match) {
          matchedClaims.push(claim);
          evidence.push(match);
        }
      }

      const explicitReference = (item.decisionIds ?? []).includes(decision.id);

      if (explicitReference) {
        evidence.push({
          claimKind: "USE",
          claimText: decision.title,
          sourceField: "explicit-reference",
          excerpt: `Jira work item explicitly references decision ${decision.id}`,
        });
      }

      if (!explicitReference && matchedClaims.length === 0) continue;

      const useMatches = matchedClaims.filter((claim) => claim.kind === "USE");
      const excludeMatches = matchedClaims.filter((claim) => claim.kind === "EXCLUDE");

      let relationship: DecisionWorkRelationship;

      if (useMatches.length > 0 && excludeMatches.length > 0) {
        relationship = "mixed-or-ambiguous";
      } else if (excludeMatches.length > 0) {
        relationship = "mentions-excluded-option";
      } else if (useMatches.length > 0) {
        relationship = "mentions-selected-option";
      } else {
        relationship = "explicit-reference";
      }

      decisionWorkLinks.push({
        id: `${decision.id}::${item.key}`,
        decisionId: decision.id,
        workItemKey: item.key,
        relationship,
        evidenceStrength: explicitReference ? "explicit" : "claim-match",
        matchedClaims,
        evidence,
      });
    }

    for (const oldDecisionId of decision.supersedes ?? []) {
      if (!decisions.some((candidate) => candidate.id === oldDecisionId)) continue;

      supersessionLinks.push({
        id: `${decision.id}::supersedes::${oldDecisionId}`,
        fromDecisionId: decision.id,
        toDecisionId: oldDecisionId,
        relationship: "supersedes",
      });
    }
  }

  for (const item of workItems) {
    for (const linkedKey of item.linkedIssueKeys ?? []) {
      const target = normalizeKey(linkedKey);
      if (!knownWorkKeys.has(target) || target === item.key) continue;

      workItemLinks.push({
        id: `${item.key}::linked::${target}`,
        fromKey: item.key,
        toKey: target,
        relationship: "issue-link",
      });
    }

    if (item.parentKey) {
      const parent = normalizeKey(item.parentKey);
      if (knownWorkKeys.has(parent) && parent !== item.key) {
        workItemLinks.push({
          id: `${item.key}::parent::${parent}`,
          fromKey: item.key,
          toKey: parent,
          relationship: "parent",
        });
      }
    }
  }

  const uniqueWorkItemLinks = uniqueBy(workItemLinks, (link) => link.id);

  return {
    decisions,
    workItems,
    decisionWorkLinks,
    workItemLinks: uniqueWorkItemLinks,
    supersessionLinks,
    stats: {
      decisionCount: decisions.length,
      workItemCount: workItems.length,
      directRelationshipCount: decisionWorkLinks.length,
      issueLinkCount: uniqueWorkItemLinks.length,
      supersessionCount: supersessionLinks.length,
    },
  };
}

function severityFor(riskFlags: readonly string[]): ImpactSeverity {
  const superseded = riskFlags.includes("decision-is-superseded");
  const excludedMention = riskFlags.includes("excluded-option-mentioned");
  const unapproved = riskFlags.includes("decision-not-approved");

  // A text mention alone is not proof of a violation or implementation.
  // Keep it in the human-review band; reserve high for superseded decisions.
  if (superseded) return "high";
  if (excludedMention || unapproved) return "medium";
  return "low";
}

export function calculateBlastRadius(
  graph: DecisionGraph,
  decisionId: string
): DecisionGraphBlastRadiusResult {
  const decision = graph.decisions.find((item) => item.id === decisionId);

  if (!decision) {
    return {
      decisionId,
      decisionTitle: "Unknown decision",
      directCount: 0,
      indirectCount: 0,
      totalCount: 0,
      affectedItems: [],
    };
  }

  const itemByKey = new Map(graph.workItems.map((item) => [item.key, item]));
  const directLinks = graph.decisionWorkLinks.filter(
    (link) => link.decisionId === decisionId
  );

  const directClaimsByKey = new Map<string, DecisionGraphClaim[]>();
  for (const link of directLinks) {
    directClaimsByKey.set(link.workItemKey, link.matchedClaims);
  }

  // Treat issue links and parent relationships as traversable in both directions.
  const adjacency = new Map<string, Set<string>>();

  for (const item of graph.workItems) adjacency.set(item.key, new Set());

  for (const link of graph.workItemLinks) {
    adjacency.get(link.fromKey)?.add(link.toKey);
    adjacency.get(link.toKey)?.add(link.fromKey);
  }

  const depthByKey = new Map<string, number>();
  const pathByKey = new Map<string, string[]>();
  const queue: string[] = [];

  for (const link of directLinks) {
    const key = link.workItemKey;
    if (!itemByKey.has(key) || depthByKey.has(key)) continue;

    depthByKey.set(key, 0);
    pathByKey.set(key, [key]);
    queue.push(key);
  }

  let cursor = 0;

  while (cursor < queue.length) {
    const current = queue[cursor++];
    const currentDepth = depthByKey.get(current) ?? 0;
    const currentPath = pathByKey.get(current) ?? [current];
    const neighbors = [...(adjacency.get(current) ?? [])].sort();

    for (const neighbor of neighbors) {
      if (depthByKey.has(neighbor)) continue;

      depthByKey.set(neighbor, currentDepth + 1);
      pathByKey.set(neighbor, [...currentPath, neighbor]);
      queue.push(neighbor);
    }
  }

  const approvalState = decision.approvalState ?? "unverified";
  const superseded = isSuperseded(decision.status);

  const affectedItems: AffectedWorkItem[] = [];

  for (const [key, depth] of depthByKey.entries()) {
    const item = itemByKey.get(key);
    if (!item) continue;

    const matchedClaims = directClaimsByKey.get(key) ?? [];
    const riskFlags: string[] = [];

    if (superseded) riskFlags.push("decision-is-superseded");
    if (approvalState !== "approved") riskFlags.push("decision-not-approved");

    if (matchedClaims.some((claim) => claim.kind === "EXCLUDE")) {
      riskFlags.push("excluded-option-mentioned");
    }

    affectedItems.push({
      key,
      summary: item.summary,
      status: item.status,
      url: item.url,
      depth,
      path: pathByKey.get(key) ?? [key],
      relationship: depth === 0 ? "direct" : "indirect",
      matchedClaims,
      riskFlags,
      severity: severityFor(riskFlags),
    });
  }

  affectedItems.sort(
    (a, b) => a.depth - b.depth || a.key.localeCompare(b.key)
  );

  const directCount = affectedItems.filter(
    (item) => item.relationship === "direct"
  ).length;
  const indirectCount = affectedItems.length - directCount;

  return {
    decisionId,
    decisionTitle: decision.title,
    directCount,
    indirectCount,
    totalCount: affectedItems.length,
    affectedItems,
  };
}
