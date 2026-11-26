import { describe, expect, it } from "vitest";
import {
  buildDecisionGraph,
  calculateBlastRadius,
  type DecisionGraphDecision,
  type DecisionGraphWorkItem,
} from "../src/decision-graph";

const authenticationDecision: DecisionGraphDecision = {
  id: "decision-auth-provider",
  title: "Authentication Provider",
  status: "Active",
  approvalState: "approved",
  claims: [
    { kind: "USE", text: "Vendor B" },
    { kind: "EXCLUDE", text: "Vendor A" },
  ],
};

describe("DecisionTrace decision graph", () => {
  it("links Jira work that uses the selected option", () => {
    const graph = buildDecisionGraph(
      [authenticationDecision],
      [{ key: "AUTH-1", summary: "Migrate login service to Vendor B" }]
    );

    expect(graph.decisionWorkLinks).toHaveLength(1);
    expect(graph.decisionWorkLinks[0].relationship).toBe(
      "mentions-selected-option"
    );
    expect(graph.decisionWorkLinks[0].matchedClaims).toEqual([
      { kind: "USE", text: "Vendor B" },
    ]);
    expect(graph.decisionWorkLinks[0].evidence[0].sourceField).toBe("summary");
  });

  it("keeps excluded-option mentions in the human-review severity band", () => {
    const graph = buildDecisionGraph(
      [authenticationDecision],
      [{ key: "AUTH-2", summary: "Remove Vendor A token fallback" }]
    );

    const impact = calculateBlastRadius(graph, authenticationDecision.id);

    expect(graph.decisionWorkLinks[0].relationship).toBe(
      "mentions-excluded-option"
    );
    expect(impact.affectedItems[0].riskFlags).toContain(
      "excluded-option-mentioned"
    );
    expect(impact.affectedItems[0].severity).toBe("medium");
  });

  it("does not confuse Vendor A with Vendor AB", () => {
    const graph = buildDecisionGraph(
      [authenticationDecision],
      [{ key: "AUTH-3", summary: "Review Vendor AB integration" }]
    );

    expect(graph.decisionWorkLinks).toHaveLength(0);
  });

  it("uses explicit decision references even without claim text", () => {
    const graph = buildDecisionGraph(
      [authenticationDecision],
      [{
        key: "AUTH-4",
        summary: "Refactor login configuration",
        decisionIds: ["decision-auth-provider"],
      }]
    );

    expect(graph.decisionWorkLinks).toHaveLength(1);
    expect(graph.decisionWorkLinks[0].evidenceStrength).toBe("explicit");
    expect(graph.decisionWorkLinks[0].relationship).toBe("explicit-reference");
  });

  it("traverses linked Jira work and reports direct and indirect impact", () => {
    const workItems: DecisionGraphWorkItem[] = [
      { key: "AUTH-10", summary: "Move login to Vendor B", linkedIssueKeys: ["AUTH-11"] },
      { key: "AUTH-11", summary: "Remove Vendor A fallback", linkedIssueKeys: ["AUTH-12"] },
      { key: "AUTH-12", summary: "Update authentication runbook" },
      { key: "AUTH-99", summary: "Unrelated database maintenance" },
    ];

    const graph = buildDecisionGraph([authenticationDecision], workItems);
    const impact = calculateBlastRadius(graph, authenticationDecision.id);

    expect(impact.directCount).toBe(2);
    expect(impact.indirectCount).toBe(1);
    expect(impact.totalCount).toBe(3);

    const indirect = impact.affectedItems.find((item) => item.key === "AUTH-12");
    expect(indirect?.relationship).toBe("indirect");
    expect(indirect?.path).toEqual(["AUTH-11", "AUTH-12"]);
    expect(impact.affectedItems.some((item) => item.key === "AUTH-99")).toBe(false);
  });

  it("supports parent relationships and case-insensitive Jira keys", () => {
    const graph = buildDecisionGraph(
      [authenticationDecision],
      [
        { key: "AUTH-20", summary: "Use Vendor B in API", parentKey: "auth-21" },
        { key: "AUTH-21", summary: "Authentication epic" },
      ]
    );

    const impact = calculateBlastRadius(graph, authenticationDecision.id);
    expect(impact.totalCount).toBe(2);
    expect(impact.affectedItems.find((item) => item.key === "AUTH-21")?.depth).toBe(1);
  });

  it("does not traverse missing Jira issues or self-links", () => {
    const graph = buildDecisionGraph(
      [authenticationDecision],
      [{
        key: "AUTH-30",
        summary: "Use Vendor B",
        linkedIssueKeys: ["AUTH-30", "MISSING-1"],
      }]
    );

    expect(graph.workItemLinks).toHaveLength(0);
    expect(calculateBlastRadius(graph, authenticationDecision.id).totalCount).toBe(1);
  });

  it("raises severity when the governing decision is superseded", () => {
    const superseded: DecisionGraphDecision = {
      ...authenticationDecision,
      status: "Superseded",
    };

    const graph = buildDecisionGraph(
      [superseded],
      [{ key: "AUTH-40", summary: "Remove Vendor A from login" }]
    );

    const impact = calculateBlastRadius(graph, superseded.id);
    expect(impact.affectedItems[0].riskFlags).toContain("decision-is-superseded");
    expect(impact.affectedItems[0].severity).toBe("high");
  });

  it("marks unapproved decisions for human review", () => {
    const unverified: DecisionGraphDecision = {
      ...authenticationDecision,
      approvalState: "unverified",
    };

    const graph = buildDecisionGraph(
      [unverified],
      [{ key: "AUTH-50", summary: "Move login to Vendor B" }]
    );

    const impact = calculateBlastRadius(graph, unverified.id);
    expect(impact.affectedItems[0].riskFlags).toContain("decision-not-approved");
    expect(impact.affectedItems[0].severity).toBe("medium");
  });

  it("creates supersession relationships between known decisions", () => {
    const oldDecision: DecisionGraphDecision = {
      id: "decision-old",
      title: "Old authentication provider",
      claims: [{ kind: "USE", text: "Vendor A" }],
    };
    const newDecision: DecisionGraphDecision = {
      ...authenticationDecision,
      supersedes: ["decision-old", "missing-decision"],
    };

    const graph = buildDecisionGraph([oldDecision, newDecision], []);

    expect(graph.supersessionLinks).toEqual([{
      id: "decision-auth-provider::supersedes::decision-old",
      fromDecisionId: "decision-auth-provider",
      toDecisionId: "decision-old",
      relationship: "supersedes",
    }]);
  });

  it("handles cycles without counting a Jira issue more than once", () => {
    const graph = buildDecisionGraph(
      [authenticationDecision],
      [
        { key: "AUTH-60", summary: "Use Vendor B", linkedIssueKeys: ["AUTH-61"] },
        { key: "AUTH-61", summary: "Authentication integration", linkedIssueKeys: ["AUTH-60"] },
      ]
    );

    const impact = calculateBlastRadius(graph, authenticationDecision.id);
    expect(impact.totalCount).toBe(2);
    expect(new Set(impact.affectedItems.map((item) => item.key)).size).toBe(2);
  });

  it("captures comment mentions as evidence without claiming implementation", () => {
    const graph = buildDecisionGraph(
      [authenticationDecision],
      [{ key: "AUTH-70", summary: "Review login flow", comments: ["Switch to Vendor B"] }]
    );

    expect(graph.decisionWorkLinks).toHaveLength(1);
    expect(graph.decisionWorkLinks[0].relationship).toBe("mentions-selected-option");
    expect(graph.decisionWorkLinks[0].evidence[0].sourceField).toBe("comment");
  });});
