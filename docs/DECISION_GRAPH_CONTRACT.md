# DecisionTrace Decision Graph

## Purpose
Build an evidence-backed relationship graph connecting Confluence
decision candidates to Jira work items.

## Decision input
- id
- title
- status
- approvalState
- sourceUrl
- claims: USE and EXCLUDE
- supersedes

## Jira work item input
- key
- summary
- description
- status
- issueType
- url
- labels
- linkedIssueKeys
- parentKey
- decisionIds

## Graph capabilities
- Whole-phrase claim matching.
- Explicit decision references.
- Jira issue-link and parent relationships.
- Decision supersession relationships.
- Direct and indirect blast-radius calculation.
- Shortest paths to affected work items.
- Evidence excerpts and risk classifications.

## Safety boundary
A claim match is a candidate relationship, not proof of compliance.
Unverified decisions remain unverified. Human approval is separate
from graph construction. No Jira issues are automatically modified.
