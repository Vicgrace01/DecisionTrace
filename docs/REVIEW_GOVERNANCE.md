# Decision review governance

## Trust boundary

Review submission requires an authenticated Forge resolver invocation. The reviewer account ID comes from `req.context.accountId`; any client-supplied reviewer identity or source-version value is ignored.

The resolver fetches the Confluence page through REST API v2 as the interacting user and records the current version returned by Confluence. Before accepting a review it calls the page permitted-operations endpoint and requires an `update` operation targeting a `page`. If identity, page visibility, version or edit permission cannot be established, the operation fails closed.

DecisionTrace does not write to the source Confluence page.

## Storage model

Two Forge Custom Entity Store entities are declared in `manifest.yml`:

- `decision-review-current`: one current version-bound review record per Confluence page ID.
- `decision-review-event`: append-only review events indexed by decision ID and revision.

Each record stores schema version, decision ID, status, authenticated reviewer account ID, source version, rationale, event ID, timestamp and revision. Approval and rejection require a rationale of at least 20 characters. A reset to `needs-review` is stored as an event with the default rationale `Review reset to needs-review.` rather than deleting prior audit history.

The previous `decisiontrace:decision-reviews:v1` monolithic object is no longer read. Legacy entries lack trustworthy reviewer and source-version metadata and therefore cannot become approvals.

## Concurrency

The current-record write and event append use one Custom Entity Store transaction. The current-record set is conditional on the previously read revision (or on the revision attribute not existing for the first review). The event append is conditional on its event ID not existing. Forge documents that conditional transaction operations commit together only if every condition succeeds. A conflicting reviewer must reload and retry; the losing transaction writes neither the current record nor its event.

This is optimistic concurrency control per decision, not a global lock. The transaction uses two operations, below Forge's 25-operation limit.

## History pagination

Review history is queried by the `by-decision-revision` index, partitioned by decision ID and sorted by descending revision. Responses are capped at 100 events. Forge query cursors are ephemeral pagination cursors and should not be persisted as durable identifiers.

Custom Entity Store indexed queries are eventually consistent. `entity().get` is strictly consistent, so effective current review status uses the direct read path while history pagination may briefly lag a just-committed event.

## Lifecycle precedence

The shared domain lifecycle helper applies consistent rules to graph construction, flagging and Rovo:

1. Superseded, retired, revoked or reversed decisions are never authoritative.
2. A rejected review cannot be overridden by a source page declaring itself Active.
3. An approval is authoritative only when the page is currently active/approved and the review matches the exact current source version.
4. Missing, legacy, malformed or stale review records are treated as `needs-review`.
5. A prior approval tied to an older source version is explicitly reported as stale and requires review again.

## Deployment and migration

The granular `read:page:confluence` scope and Custom Entity Store entities/index require a Forge deployment and app upgrade before the new resolver paths are available in an installed environment. Forge index creation runs asynchronously after deployment; history queries should not be relied on until the index is ready. No deployment, installation upgrade or data migration is performed by this sprint.

## Existing UI integration caveat

The current Command Center calls `setDecisionReview` with only `decisionId` and `status`. This backend now requires a meaningful `reason` for `approved` and `rejected` reviews. The current approve/reject buttons will therefore receive a validation error until a follow-up UI change collects and submits a rationale. The `needs-review`/Reopen action remains callable without a user-entered rationale; the backend records the explicit reset reason. UI changes are intentionally outside this backend sprint and must be completed before enabling the stricter review flow for end users.
