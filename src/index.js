import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, Filter, FilterConditions, Sort } from '@forge/kvs';
import { randomUUID } from 'node:crypto';
import { mapJiraIssueToWorkItem } from '../packages/domain/dist/jira-adapter.js';
import {
  createDecisionReviewRecord,
  effectiveDecisionReviewStatus,
  isValidDecisionReviewRecord,
  validateDecisionReviewCommand,
} from '../packages/domain/dist/review-governance.js';
import { resolveDecisionLifecycle } from '../packages/domain/dist/decision-lifecycle.js';
import { extractClaims, detectFlags } from '../packages/domain/dist/supersession.js';
import { isDecisionCandidate } from '../packages/domain/dist/candidate-filter.js';
import {
  buildDecisionGraph,
  calculateBlastRadius,
} from '../packages/domain/dist/decision-graph.js';

const resolver = new Resolver();
// Resolve the public Jira tenant URL from Jira's Server Info API.
// Do not derive browser links from issue.self: Forge may return an API-gateway URL.
async function getJiraSiteBaseUrl() {
  const response = await api.asUser().requestJira(route`/rest/api/3/serverInfo`);
  if (!response.ok) {
    throw new Error(`Could not resolve the Jira site URL (HTTP ${response.status}).`);
  }

  const serverInfo = await response.json();
  const rawBaseUrl = String(serverInfo.baseUrl ?? '').trim();
  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error('Jira Server Info returned an invalid baseUrl.');
  }
  if (parsedBaseUrl.protocol !== 'https:') {
    throw new Error('Jira Server Info returned a non-HTTPS baseUrl.');
  }
  return parsedBaseUrl.origin;
}
const CURRENT_REVIEW_ENTITY = 'decision-review-current';
const REVIEW_EVENT_ENTITY = 'decision-review-event';
const MAX_REVIEW_HISTORY_PAGE_SIZE = 100;
const JIRA_FIELDS = [
  'summary',
  'description',
  'issuetype',
  'status',
  'priority',
  'assignee',
  'duedate',
  'labels',
  'issuelinks',
  'comment',
  'parent',
  'subtasks',
];
const JIRA_PAGE_SIZE = 100;
const MAX_NEIGHBOUR_WAVES = 2;
const MAX_TOTAL_ISSUES = 300;
const MAX_NEIGHBOURS_PER_WAVE = 100;
const MAX_SEARCH_TERMS = 15;

function storageToText(html = '') {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|tr|div|ul|ol)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function searchConfluenceDecisions() {
  const cql = 'type=page AND text ~ "decision" ORDER BY lastmodified DESC';
  const response = await api.asUser().requestConfluence(
    route`/wiki/rest/api/content/search?cql=${cql}&limit=50&expand=body.storage,version,space`
  );

  if (response.status === 401 || response.status === 403) {
    throw new Error('Confluence access denied. Check the current user\'s page permissions and the app scopes.');
  }
  if (response.status === 404) {
    throw new Error('Confluence is unavailable to this installation. Confirm that Confluence is installed on this site.');
  }
  if (!response.ok) {
    throw new Error(`Confluence search failed with HTTP ${response.status}.`);
  }

  const data = await response.json();
  const pages = Array.isArray(data.results) ? data.results : [];
  const baseUrl = data._links?.base ?? '';

  const candidates = pages.flatMap((page) => {
    const title = page.title ?? 'Untitled decision page';
    const body = storageToText(page.body?.storage?.value ?? '');
    const text = `${title}\n${body}`.trim();
    const decision = {
      id: `confluence-${page.id}`,
      sourceType: 'confluence-page',
      sourceUrl: page._links?.webui ? `${baseUrl}${page._links.webui}` : '',
      title,
      text,
      status: 'proposed',
      claims: [],
      createdAt: page.version?.when ?? '',
    };

    const claims = extractClaims(decision);
    if (!isDecisionCandidate(title, text, claims)) return [];

    const statusMatch = text.match(
      /(?:^|\n)\s*status\s*[:\-]\s*(active|approved|proposed|superseded|retired|revoked|reversed)\b/im
    );

    return [{
      id: String(page.id),
      title,
      url: decision.sourceUrl,
      spaceKey: page.space?.key ?? 'Unknown space',
      updatedAt: page.version?.when ?? null,
      sourceVersion: Number.isSafeInteger(page.version?.number) ? page.version.number : null,
      preview: body.slice(0, 600),
      declaredStatus: statusMatch ? statusMatch[1].toLowerCase() : 'unspecified',
      supersedes: [...text.matchAll(/(?:^|\n)\s*supersedes(?:\s+decision)?\s*[:#-]\s*(?:page\s*)?(\d+)\b/gim)].map((match) => String(match[1])),
      supersededById: text.match(/(?:^|\n)\s*superseded\s+by\s*[:#-]\s*(?:page\s*)?(\d+)\b/im)?.[1] ?? null,
      claims: claims.map((claim) => ({
        id: claim.id,
        kind: claim.kind,
        value: claim.value,
        quotedText: claim.quotedText,
        confidence: claim.confidence,
      })),
      reviewStatus: 'needs-review',
      reviewedAt: null,
    }];
  });

  return {
    source: 'Confluence',
    query: cql,
    limit: 50,
    scannedCount: pages.length,
    count: candidates.length,
    pages: candidates,
  };
}

function escapeJqlPhrase(value) {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]/g, ' ')
    .trim();
  return `text ~ "\\"${escaped}\\""`;
}

function getSearchTerms(pages) {
  const terms = pages.flatMap((page) => (page.claims ?? []).map((claim) => claim.value));
  return [...new Set(terms.map((term) => String(term ?? '').trim()))]
    .filter((term) => term.length >= 2 && term.length <= 80)
    .slice(0, MAX_SEARCH_TERMS);
}

async function requestJiraJql(jql, nextPageToken = undefined) {
  const body = {
    jql,
    fields: JIRA_FIELDS,
    maxResults: JIRA_PAGE_SIZE,
    ...(nextPageToken ? { nextPageToken } : {}),
  };

  const response = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error('Jira search was denied. The current user needs Browse Projects access to the relevant Jira issues.');
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Jira enhanced search failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
  }

  return response.json();
}

function collectNeighbourKeys(issues) {
  const keys = new Set();
  for (const issue of issues) {
    const fields = issue.fields ?? {};
    for (const link of fields.issuelinks ?? []) {
      const inward = link.inwardIssue?.key;
      const outward = link.outwardIssue?.key;
      if (inward) keys.add(String(inward).toUpperCase());
      if (outward) keys.add(String(outward).toUpperCase());
    }
    if (fields.parent?.key) keys.add(String(fields.parent.key).toUpperCase());
    for (const subtask of fields.subtasks ?? []) {
      if (subtask?.key) keys.add(String(subtask.key).toUpperCase());
    }
  }
  return [...keys].filter((key) => /^[A-Z][A-Z0-9_]*-\d+$/.test(key));
}

async function fetchJiraIssuesForDecisions(pages) {
  const searchTerms = getSearchTerms(pages);
  if (searchTerms.length === 0) {
    return {
      issues: [],
      matchedIssueCount: 0,
      relatedIssueCount: 0,
      searchTerms: [],
      truncated: false,
      searchMode: 'No extracted claims; Jira search skipped',
    };
  }

  const jql = `(${searchTerms.map(escapeJqlPhrase).join(' OR ')}) ORDER BY updated DESC`;
  const issueByKey = new Map();
  const seenPageTokens = new Set();
  let nextPageToken;
  let truncated = false;

  // Follow enhanced-search continuation tokens up to the global safety cap.
  // The UI is told when the cap is reached so it never presents partial coverage as complete.
  do {
    const page = await requestJiraJql(jql, nextPageToken);
    for (const issue of page.issues ?? []) {
      if (issue?.key) issueByKey.set(String(issue.key).toUpperCase(), issue);
    }

    const next = page.nextPageToken;
    if (!next || page.isLast === true) {
      if (!next && page.isLast === false) truncated = true;
      nextPageToken = undefined;
      break;
    }
    if (seenPageTokens.has(next)) {
      truncated = true;
      nextPageToken = undefined;
      break;
    }
    seenPageTokens.add(next);
    if (issueByKey.size >= MAX_TOTAL_ISSUES) {
      truncated = true;
      nextPageToken = undefined;
      break;
    }
    nextPageToken = next;
  } while (nextPageToken);

  if (nextPageToken) truncated = true;
  let searchMode = 'Claim-targeted Jira enhanced JQL search + linked-issue expansion';

  // Jira enhanced JQL search can temporarily lag immediately after an issue edit.
  // If exact claim search returns nothing, inspect a bounded 30-day recent-activity
  // window and let the graph engine perform the same local evidence matching.
  if (issueByKey.size === 0) {
    const fallbackJql = 'updated >= -30d ORDER BY updated DESC';
    const fallbackTokens = new Set();
    let fallbackToken;

    do {
      const recentPage = await requestJiraJql(fallbackJql, fallbackToken);
      for (const issue of recentPage.issues ?? []) {
        if (issue?.key) issueByKey.set(String(issue.key).toUpperCase(), issue);
      }

      const next = recentPage.nextPageToken;
      if (!next || recentPage.isLast === true) {
        if (!next && recentPage.isLast === false) truncated = true;
        fallbackToken = undefined;
        break;
      }
      if (fallbackTokens.has(next)) {
        truncated = true;
        fallbackToken = undefined;
        break;
      }
      fallbackTokens.add(next);
      if (issueByKey.size >= MAX_TOTAL_ISSUES) {
        truncated = true;
        fallbackToken = undefined;
        break;
      }
      fallbackToken = next;
    } while (fallbackToken);

    searchMode = 'Recent Jira activity fallback (last 30 days) + local evidence matching + linked-issue expansion';
  }

  const matchedIssueCount = issueByKey.size;

  // Expand linked issues and parent/sub-task neighbours so the graph can show paths
  // instead of treating only phrase-matching issues as the entire impact radius.
  for (let wave = 0; wave < MAX_NEIGHBOUR_WAVES; wave += 1) {
    if (issueByKey.size >= MAX_TOTAL_ISSUES) {
      truncated = true;
      break;
    }

    const pending = collectNeighbourKeys([...issueByKey.values()])
      .filter((key) => !issueByKey.has(key));
    if (pending.length === 0) break;

    const remaining = MAX_TOTAL_ISSUES - issueByKey.size;
    const batch = pending.slice(0, Math.min(MAX_NEIGHBOURS_PER_WAVE, remaining));
    if (pending.length > batch.length) truncated = true;
    if (batch.length === 0) break;

    const relatedJql = `key in (${batch.join(', ')}) ORDER BY updated DESC`;
    const related = await requestJiraJql(relatedJql);
    for (const issue of related.issues ?? []) {
      if (issue?.key) issueByKey.set(String(issue.key).toUpperCase(), issue);
    }
    if (related.isLast === false || related.nextPageToken) truncated = true;
  }

  const issues = [...issueByKey.values()];
  return {
    issues,
    matchedIssueCount,
    relatedIssueCount: Math.max(0, issues.length - matchedIssueCount),
    searchTerms,
    truncated,
    searchMode,
  };
}

async function readCurrentDecisionReview(decisionId) {
  return kvs.entity(CURRENT_REVIEW_ENTITY).get(String(decisionId));
}

/**
 * Attach only the current effective review state to discovered pages. Review
 * details and rationale are exposed only by the access-controlled history API.
 */
async function attachReviewStatuses(pages) {
  return Promise.all(pages.map(async (page) => {
    const decisionId = String(page.id);
    const record = await readCurrentDecisionReview(decisionId);
    const validRecord = isValidDecisionReviewRecord(record, decisionId);

    return {
      ...page,
      reviewStatus: effectiveDecisionReviewStatus(
        record,
        page.sourceVersion,
        decisionId
      ),
      reviewedAt: validRecord ? record.reviewedAt : null,
      reviewSourceVersion: validRecord ? record.sourceVersion : null,
      staleApproval: Boolean(
        validRecord &&
        record.status === 'approved' &&
        Number.isSafeInteger(page.sourceVersion) &&
        record.sourceVersion !== page.sourceVersion
      ),
    };
  }));
}

function requireAuthenticatedAccountId(req) {
  const accountId = typeof req?.context?.accountId === 'string'
    ? req.context.accountId.trim()
    : '';
  const accountType = req?.context?.accountType;

  // Forge represents anonymous users with the shared account ID `unidentified`.
  // That value must never be persisted as an individual reviewer identity.
  if (!accountId || accountId === 'unidentified' || accountType === 'anonymous') {
    throw new Error('An authenticated Atlassian user is required for this operation.');
  }
  return accountId;
}

/**
 * Fetch a page as the interacting user. Editing permission is checked through
 * Confluence's permitted-operations endpoint before any review is accepted.
 */
async function getConfluencePageForCurrentUser(decisionId, { requireEdit = false } = {}) {
  const pageResponse = await api.asUser().requestConfluence(
    route`/wiki/api/v2/pages/${decisionId}?body-format=storage&include-version=true`
  );

  if (pageResponse.status === 401 || pageResponse.status === 403) {
    throw new Error('The current user cannot view this Confluence decision page.');
  }
  if (pageResponse.status === 404) {
    throw new Error('The Confluence decision page does not exist or is not visible to the current user.');
  }
  if (!pageResponse.ok) {
    throw new Error(`Could not verify the Confluence decision page (HTTP ${pageResponse.status}).`);
  }

  const page = await pageResponse.json();
  if (String(page?.id ?? '') !== decisionId) {
    throw new Error('Confluence returned a different page than the requested decision.');
  }
  if (String(page?.status ?? '').toLowerCase() !== 'current') {
    throw new Error('Only a current Confluence page can be reviewed.');
  }

  // The resolver is the trust boundary: do not rely on the Command Center
  // filtering alone. Re-run the same candidate rules used by discovery.
  const title = typeof page?.title === 'string' ? page.title.trim() : '';
  const body = storageToText(page?.body?.storage?.value ?? '');
  const text = `${title}\n${body}`.trim();
  const candidateDecision = {
    id: `confluence-${decisionId}`,
    sourceType: 'confluence-page',
    sourceUrl: '',
    title,
    text,
    status: 'proposed',
    claims: [],
    createdAt: '',
  };
  const claims = extractClaims(candidateDecision);
  if (!title || !isDecisionCandidate(title, text, claims)) {
    throw new Error('Only Confluence pages that qualify as DecisionTrace decision candidates can be reviewed.');
  }

  const sourceVersion = page?.version?.number;
  if (
    typeof sourceVersion !== 'number' ||
    !Number.isSafeInteger(sourceVersion) ||
    sourceVersion < 1
  ) {
    throw new Error('Confluence did not return a verifiable current page version.');
  }

  if (requireEdit) {
    const operationsResponse = await api.asUser().requestConfluence(
      route`/wiki/api/v2/pages/${decisionId}/operations`
    );

    if (operationsResponse.status === 401 || operationsResponse.status === 403) {
            throw new Error(
        `Page edit permission could not be verified because Confluence returned HTTP ${operationsResponse.status}.`
      );
    }
    if (!operationsResponse.ok) {
      throw new Error(`Confluence page-edit permission could not be verified (HTTP ${operationsResponse.status}).`);
    }

    const permissionData = await operationsResponse.json();
    const operations = Array.isArray(permissionData?.operations)
      ? permissionData.operations
      : Array.isArray(permissionData?.operations?.results)
        ? permissionData.operations.results
        : null;

    if (!operations) {
      throw new Error('Confluence did not return a verifiable page permission list.');
    }

    const canUpdatePage = operations.some((item) =>
      String(item?.operation ?? '').toLowerCase() === 'update' &&
      String(item?.targetType ?? '').toLowerCase() === 'page'
    );

    if (!canUpdatePage) {
      throw new Error('You need Confluence edit permission on this decision page to submit a review.');
    }
  }

  return { page, sourceVersion };
}

async function attachReviewStatusesToDiscovery(discovery) {
  return {
    ...discovery,
    pages: await attachReviewStatuses(discovery.pages),
  };
}

function applySupersessionRelationships(pages) {
  const byId = new Map(pages.map((page) => [String(page.id), page]));

  for (const page of pages) {
    // Direction A: a newer page explicitly says it supersedes an older page ID.
    for (const oldId of (page.supersedes ?? []).map(String)) {
      const oldPage = byId.get(oldId);
      if (!oldPage || oldPage.id === page.id) continue;
      oldPage.derivedStatus = 'superseded';
      oldPage.supersededBy = page.id;
      oldPage.supersededByTitle = page.title;
    }

    // Direction B: an older page explicitly names the page that superseded it.
    if (page.supersededById) {
      const replacement = byId.get(String(page.supersededById));
      if (replacement && replacement.id !== page.id) {
        page.derivedStatus = 'superseded';
        page.supersededBy = replacement.id;
        page.supersededByTitle = replacement.title;
        replacement.supersedes = [...new Set([...(replacement.supersedes ?? []), page.id])];
      }
    }
  }

  return pages;
}

function toGraphDecision(page) {
  const lifecycle = resolveDecisionLifecycle({
    declaredStatus: page.declaredStatus,
    derivedStatus: page.derivedStatus,
    reviewStatus: page.reviewStatus,
  });

  return {
    id: String(page.id),
    title: page.title,
    status: lifecycle.status,
    approvalState: lifecycle.approvalState,
    sourceUrl: page.url,
    supersedes: (page.supersedes ?? []).map(String),
    claims: (page.claims ?? []).map((claim) => ({
      kind: String(claim.kind).toUpperCase() === 'EXCLUDE' ? 'EXCLUDE' : 'USE',
      text: claim.value,
    })),
  };
}

function toGraphWorkItem(issue, siteBase) {
  const fields = issue.fields ?? {};
  const workItem = mapJiraIssueToWorkItem(issue);

  return {
    key: workItem.key,
    summary: workItem.summary,
    description: workItem.description,
    status: fields.status?.name ?? workItem.status,
    issueType: fields.issuetype?.name ?? workItem.type,
    url: siteBase ? `${siteBase}/browse/${workItem.key}` : '',
    labels: Array.isArray(fields.labels) ? fields.labels : [],
    comments: workItem.comments,
    linkedIssueKeys: workItem.linkedWorkItemKeys,
    parentKey: fields.parent?.key ?? null,
    decisionIds: workItem.linkedDecisionIds ?? [],
  };
}

function toFlagDecision(page) {
  const lifecycle = resolveDecisionLifecycle({
    declaredStatus: page.declaredStatus,
    derivedStatus: page.derivedStatus,
    reviewStatus: page.reviewStatus,
  });
  // Only a current human approval may activate claims in the flag engine.
  const status = lifecycle.status === 'superseded'
    ? 'superseded'
    : lifecycle.authoritative
      ? 'active'
      : 'proposed';

  return {
    id: String(page.id),
    sourceType: 'confluence-page',
    sourceUrl: page.url,
    title: page.title,
    text: page.preview ?? '',
    status,
    supersededBy: page.supersededByTitle ?? page.supersededBy ?? undefined,
    claims: (page.claims ?? []).map((claim) => ({
      id: claim.id,
      decisionId: String(page.id),
      kind: String(claim.kind).toLowerCase() === 'exclude' ? 'exclude' : 'use',
      value: claim.value,
      quotedText: claim.quotedText,
      confidence: claim.confidence,
    })),
    createdAt: page.updatedAt ?? '',
  };
}

resolver.define('scanConfluenceDecisions', async () => {
  const discovery = await searchConfluenceDecisions();
  return attachReviewStatusesToDiscovery(discovery);
});

resolver.define('getDecisionGraph', async () => {
  const discovery = await searchConfluenceDecisions();
  const reviewedDiscovery = await attachReviewStatusesToDiscovery(discovery);
  const pages = applySupersessionRelationships(reviewedDiscovery.pages);

  const jiraSiteBaseUrl = await getJiraSiteBaseUrl();
  const jiraResult = await fetchJiraIssuesForDecisions(pages);
  const decisions = pages.map(toGraphDecision);
  const workItems = jiraResult.issues.map((issue) => toGraphWorkItem(issue, jiraSiteBaseUrl));
  const graph = buildDecisionGraph(decisions, workItems);
  const impacts = decisions.map((decision) => calculateBlastRadius(graph, decision.id));

  const flagDecisions = pages.map(toFlagDecision);
  const flagWorkItems = jiraResult.issues.map(mapJiraIssueToWorkItem);
  const flags = detectFlags({ decisions: flagDecisions, workItems: flagWorkItems });
  const directMatchedIssueCount = new Set(
    graph.decisionWorkLinks.map((link) => link.workItemKey)
  ).size;

  return {
    ...discovery,
    pages,
    jira: {
      issueCount: workItems.length,
      matchedIssueCount: directMatchedIssueCount,
      relatedIssueCount: Math.max(0, workItems.length - directMatchedIssueCount),
      searchTermsCount: jiraResult.searchTerms.length,
      searchTruncated: jiraResult.truncated,
      searchMode: jiraResult.searchMode,
    },
    graph,
    impacts,
    flags,
    generatedAt: new Date().toISOString(),
  };
});

resolver.define('diagnoseJiraIssue', async (req) => {
  const issueKey = String(req.payload?.issueKey ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) {
    throw new Error('Enter a valid Jira issue key, for example FS-1.');
  }

  const discovery = await searchConfluenceDecisions();
  const claims = discovery.pages.flatMap((page) =>
    (page.claims ?? []).map((claim) => ({
      decisionId: String(page.id),
      decisionTitle: page.title,
      kind: claim.kind,
      value: claim.value,
      quotedText: claim.quotedText,
    }))
  );

  const response = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueKey}?fields=summary,description,labels,comment,issuelinks,parent,status,issuetype`
  );

  let jqlKeySearchFound = null;
  let jqlKeySearchError = null;
  let jqlFoundIssue = null;
  try {
    const jqlResult = await requestJiraJql(`key = ${issueKey}`);
    jqlFoundIssue = (jqlResult.issues ?? []).find(
      (candidate) => String(candidate.key).toUpperCase() === issueKey
    ) ?? null;
    jqlKeySearchFound = Boolean(jqlFoundIssue);
  } catch (error) {
    jqlKeySearchError = error?.message ?? 'Exact-key Jira search failed.';
  }

  let issue = null;
  let retrievalMode = 'direct-issue-api';
  if (response.ok) {
    issue = await response.json();
  } else if (jqlFoundIssue) {
    // A searchable issue is usable evidence even if the direct issue endpoint failed.
    issue = jqlFoundIssue;
    retrievalMode = 'enhanced-jql-fallback';
  } else {
    let recentIssueSample = [];
    let recentIssueSearchError = null;
    try {
      const recentResult = await requestJiraJql('updated >= -30d ORDER BY updated DESC');
      recentIssueSample = (recentResult.issues ?? []).slice(0, 12).map((candidate) => ({
        key: String(candidate.key ?? ''),
        summary: String(candidate.fields?.summary ?? 'No summary available'),
      })).filter((candidate) => candidate.key);
    } catch (error) {
      recentIssueSearchError = error?.message ?? 'Recent Jira issue search failed.';
    }

    const message = response.status === 404
      ? (jqlKeySearchFound === false
          ? `Neither direct retrieval nor exact-key search could find ${issueKey}. The recent visible Jira issues are listed below to help identify whether the test issue has a different key.`
          : `Direct retrieval returned HTTP ${response.status}, and the exact-key search could not confirm ${issueKey}. Check the search result and recent visible issues below.`)
      : `Jira returned HTTP ${response.status} for direct retrieval, and exact-key search did not return ${issueKey}.`;

    return {
      found: false,
      issueKey,
      httpStatus: response.status,
      message,
      decisionClaims: claims,
      jqlKeySearchFound,
      jqlKeySearchError,
      recentIssueSample,
      recentIssueSearchError,
      generatedAt: new Date().toISOString(),
    };
  }
  const fields = issue.fields ?? {};
  const mapped = mapJiraIssueToWorkItem(issue);
  const labels = Array.isArray(fields.labels) ? fields.labels : [];
  const comments = Array.isArray(mapped.comments) ? mapped.comments : [];
  const haystacks = [
    { field: 'summary', text: mapped.summary ?? '' },
    { field: 'description', text: mapped.description ?? '' },
    ...labels.map((text) => ({ field: 'label', text: String(text) })),
    ...comments.map((text) => ({ field: 'comment', text: String(text) })),
  ];

  const normalize = (value) => String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');

  const containsPhrase = (haystack, phrase) => {
    const h = normalize(haystack);
    const p = normalize(phrase);
    return Boolean(h && p && (` ${h} `).includes(` ${p} `));
  };

  const matches = claims.map((claim) => {
    const matchedIn = haystacks
      .filter((entry) => containsPhrase(entry.text, claim.value))
      .map((entry) => ({
        field: entry.field,
        excerpt: String(entry.text).replace(/\s+/g, ' ').slice(0, 240),
      }));
    return { ...claim, matchedIn, matched: matchedIn.length > 0 };
  });

  // Exact-key query already completed above.

  const siteBase = await getJiraSiteBaseUrl();
  const matchedClaims = matches.filter((claim) => claim.matched);

  return {
    found: true,
    issueKey,
    httpStatus: response.status,
    retrievalMode,
    jqlKeySearchFound,
    jqlKeySearchError,
    issue: {
      key: mapped.key,
      summary: mapped.summary,
      status: fields.status?.name ?? mapped.status,
      issueType: fields.issuetype?.name ?? mapped.type,
      url: siteBase ? `${siteBase}/browse/${mapped.key}` : '',
      descriptionLength: String(mapped.description ?? '').length,
      descriptionExcerpt: String(mapped.description ?? '').replace(/\s+/g, ' ').slice(0, 600),
      labels,
      commentCount: comments.length,
      linkedIssueKeys: mapped.linkedWorkItemKeys ?? [],
      parentKey: fields.parent?.key ?? null,
    },
    decisionClaimCount: claims.length,
    matchedClaimCount: matchedClaims.length,
    matches,
    generatedAt: new Date().toISOString(),
  };
});
resolver.define('setDecisionReview', async (req) => {
  // Never trust reviewer identity or page version supplied by the client.
  const reviewerAccountId = requireAuthenticatedAccountId(req);
  const payload = req?.payload && typeof req.payload === 'object' && !Array.isArray(req.payload)
    ? req.payload
    : {};
  const decisionId = typeof payload.decisionId === 'string'
    ? payload.decisionId.trim()
    : '';

  if (!/^\d{1,30}$/.test(decisionId)) {
    throw new Error('A valid Confluence page ID is required.');
  }

  const { sourceVersion } = await getConfluencePageForCurrentUser(decisionId, {
    requireEdit: true,
  });

  const command = validateDecisionReviewCommand({
    decisionId,
    status: payload.status,
    reviewerAccountId,
    sourceVersion,
    reason: typeof payload.reason === 'string' ? payload.reason : '',
  });

  const currentEntity = kvs.entity(CURRENT_REVIEW_ENTITY);
  const currentRecord = await currentEntity.get(decisionId);
  if (
    currentRecord !== undefined &&
    currentRecord !== null &&
    !isValidDecisionReviewRecord(currentRecord, decisionId)
  ) {
    throw new Error('The current review record is malformed. No new review was saved.');
  }

  const expectedRevision = currentRecord?.revision ?? 0;
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision >= 2_147_483_647
  ) {
    throw new Error('The review revision is invalid or has reached its storage limit.');
  }

  const record = createDecisionReviewRecord(command, {
    eventId: randomUUID(),
    reviewedAt: new Date().toISOString(),
    revision: expectedRevision + 1,
  });

  const currentConditions = currentRecord
    ? new Filter().and('revision', FilterConditions.equalTo(expectedRevision))
    : new Filter().and('revision', FilterConditions.notExists());
  const eventKey = `${decisionId}:${record.eventId}`;

  const successResult = {
    ok: true,
    decisionId,
    status: record.status,
    sourceVersion: record.sourceVersion,
    reviewedAt: record.reviewedAt,
    revision: record.revision,
    eventId: record.eventId,
  };

  try {
    // The current state update and immutable event append are committed or
    // rolled back together. A competing revision makes the whole write fail.
    await kvs.transact()
      .set(decisionId, record, {
        entityName: CURRENT_REVIEW_ENTITY,
        conditions: currentConditions,
      })
      .set(eventKey, record, {
        entityName: REVIEW_EVENT_ENTITY,
        conditions: new Filter().and('eventId', FilterConditions.notExists()),
      })
      .execute();
  } catch {
    // The event is immutable. Check it directly first because another reviewer
    // may have advanced the current record after this transaction committed.
    const eventRead = await Promise.allSettled([
      kvs.entity(REVIEW_EVENT_ENTITY).get(eventKey),
      currentEntity.get(decisionId),
    ]);
    const persistedEvent = eventRead[0].status === 'fulfilled' ? eventRead[0].value : null;
    const latestRecord = eventRead[1].status === 'fulfilled' ? eventRead[1].value : null;

    if (persistedEvent?.eventId === record.eventId || latestRecord?.eventId === record.eventId) {
      return successResult;
    }
    if (eventRead.every((result) => result.status === 'rejected')) {
      throw new Error('Review storage could not confirm the transaction. No review success is reported.');
    }
    if (eventRead[1].status === 'fulfilled' && (latestRecord?.revision ?? 0) !== expectedRevision) {
      throw new Error('Another reviewer saved a newer review. Reload the decision and submit again.');
    }
    if (eventRead.some((result) => result.status === 'rejected')) {
      throw new Error('Review storage could not fully confirm the transaction. No review success is reported.');
    }
    throw new Error('The review could not be saved. No review success is reported.');
  }

  return successResult;
});

resolver.define('getDecisionReviewHistory', async (req) => {
  requireAuthenticatedAccountId(req);
  const payload = req?.payload && typeof req.payload === 'object' && !Array.isArray(req.payload)
    ? req.payload
    : {};
  const decisionId = typeof payload.decisionId === 'string'
    ? payload.decisionId.trim()
    : '';

  if (!/^\d{1,30}$/.test(decisionId)) {
    throw new Error('A valid Confluence page ID is required.');
  }

  // The source page is fetched as the current user before returning its history.
  const { sourceVersion } = await getConfluencePageForCurrentUser(decisionId);

  const requestedLimit = payload.limit === undefined ? 20 : Number(payload.limit);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw new Error('History page size must be a positive integer.');
  }
  const limit = Math.min(requestedLimit, MAX_REVIEW_HISTORY_PAGE_SIZE);
  const cursor = payload.cursor === undefined || payload.cursor === null
    ? ''
    : typeof payload.cursor === 'string'
      ? payload.cursor
      : '';
  if (payload.cursor !== undefined && payload.cursor !== null && (!cursor || cursor.length > 4096)) {
    throw new Error('The review-history cursor is invalid.');
  }

  let query = kvs.entity(REVIEW_EVENT_ENTITY)
    .query()
    .index('by-decision-revision', { partition: [decisionId] })
    .sort(Sort.DESC)
    .limit(limit);

  if (cursor) query = query.cursor(cursor);

  const page = await query.getMany();
  const events = (page.results ?? [])
    .map((entry) => entry?.value)
    .filter((record) => isValidDecisionReviewRecord(record, decisionId))
    .map((record) => ({
      decisionId: record.decisionId,
      status: record.status,
      reviewerAccountId: record.reviewerAccountId,
      sourceVersion: record.sourceVersion,
      reason: record.reason,
      eventId: record.eventId,
      reviewedAt: record.reviewedAt,
      revision: record.revision,
    }));

  return {
    ok: true,
    decisionId,
    currentSourceVersion: sourceVersion,
    events,
    nextCursor: page.nextCursor ?? null,
    hasMore: Boolean(page.nextCursor),
  };
});

resolver.define('getIssueSnapshot', async (req) => {
  const issueKey = req.context?.extension?.issue?.key;
  if (typeof issueKey !== 'string' || !/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) {
    throw new Error('Could not determine the current Jira issue.');
  }

  const response = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueKey}?fields=summary,description,issuetype,status,priority,labels,assignee,duedate,issuelinks,comment`
  );
  if (!response.ok) {
    throw new Error(`Jira issue lookup failed (${response.status}). Check your permissions.`);
  }

  const data = await response.json();
  const fields = data.fields ?? {};
  const workItem = mapJiraIssueToWorkItem(data);

  return {
    issue: {
      key: workItem.key,
      summary: workItem.summary,
      description: workItem.description,
      type: fields.issuetype?.name ?? 'Issue',
      status: fields.status?.name ?? 'Unknown',
      priority: fields.priority?.name ?? 'Unassigned',
      assignee: workItem.assignee ?? 'Unassigned',
      dueDate: workItem.dueDate ?? null,
      labels: Array.isArray(fields.labels) ? fields.labels : [],
      commentCount: Array.isArray(fields.comment)
        ? fields.comment.length
        : fields.comment?.total ?? workItem.comments.length,
      linkedIssues: workItem.linkedWorkItemKeys,
    },
    workItem,
    decisionCoverage: {
      jiraConnected: true,
      confluenceConnected: false,
      status: 'awaiting_decision_source',
    },
  };
});

resolver.define('getJudgeScenario', async () => {
  // Synthetic, explicitly labelled scenario. It exercises the same deterministic
  // graph engine as live data and does not create or modify Atlassian records.
  const oldDecisionId = 'DEMO-DECISION-V1';
  const currentDecisionId = 'DEMO-DECISION-V2';

  const decisions = [
    {
      id: oldDecisionId,
      title: 'Authentication provider standard — version 1',
      status: 'superseded',
      approvalState: 'approved',
      claims: [{ kind: 'USE', text: 'Vendor A' }],
    },
    {
      id: currentDecisionId,
      title: 'Authentication provider standard — version 2',
      status: 'active',
      approvalState: 'approved',
      supersedes: [oldDecisionId],
      claims: [
        { kind: 'USE', text: 'Vendor B' },
        { kind: 'EXCLUDE', text: 'Vendor A' },
      ],
    },
  ];

  const workItems = [
    {
      key: 'SAMPLE-AUTH-101',
      summary: 'Implement Vendor A OAuth adapter',
      description: 'The login service still requests access tokens from Vendor A for new authentication sessions.',
      status: 'In Progress',
      issueType: 'Task',
      linkedIssueKeys: ['SAMPLE-AUTH-102'],
    },
    {
      key: 'SAMPLE-AUTH-102',
      summary: 'Retain Vendor A refresh-token fallback',
      description: 'Keep the Vendor A refresh-token path active until the authentication rollout is complete.',
      status: 'To Do',
      issueType: 'Task',
      linkedIssueKeys: ['SAMPLE-AUTH-103', 'SAMPLE-AUTH-105'],
    },
    {
      key: 'SAMPLE-AUTH-103',
      summary: 'Update authentication deployment runbook',
      description: 'Revise the operational runbook after the authentication provider work is resolved.',
      status: 'To Do',
      issueType: 'Task',
    },
    {
      key: 'SAMPLE-AUTH-104',
      summary: 'Integrate Vendor B authentication provider',
      description: 'Route new authentication flows through Vendor B.',
      status: 'In Progress',
      issueType: 'Task',
    },
    {
      key: 'SAMPLE-AUTH-105',
      summary: 'Remove Vendor A fallback during Vendor B migration',
      description: 'Remove the legacy Vendor A token fallback while migrating new authentication flows to Vendor B.',
      status: 'To Do',
      issueType: 'Task',
    },
  ];

  const graph = buildDecisionGraph(decisions, workItems);
  const impacts = decisions.map((decision) => calculateBlastRadius(graph, decision.id));

  return {
    mode: 'seeded-demo',
    scenarioTitle: 'Authentication provider reversal',
    disclaimer: 'Synthetic demonstration data. The graph engine is real; these sample decisions and work items are not Jira or Confluence records.',
    oldDecisionId,
    currentDecisionId,
    decisions,
    graph,
    impacts,
    generatedAt: new Date().toISOString(),
  };
});
export async function checkDecisionValidity(payload = {}, actionContext = {}) {
  const payloadContext = payload?.context ?? {};
  const jiraContext = payloadContext?.jira ?? actionContext?.jira ?? {};
  const contextUrl = String(jiraContext?.url ?? '');
  const contextKeyFromUrl = contextUrl.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/i)?.[1] ?? '';
  const candidateKeys = [
    payload?.issueKey,
    payload?.key,
    jiraContext?.issueKey,
    payloadContext?.issueKey,
    actionContext?.issueKey,
    contextKeyFromUrl,
  ];
  const issueKey = candidateKeys
    .map((value) => typeof value === 'string' ? value.trim().toUpperCase() : '')
    .find((value) => /^[A-Z][A-Z0-9_]*-\d+$/.test(value)) ?? '';

  if (!issueKey) {
    return {
      outcome: 'ISSUE_KEY_REQUIRED',
      message: 'No Jira issue key was available. Open a Jira issue or provide its key, for example AUTH-123.',
      readOnly: true,
    };
  }

  const issueResponse = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueKey}?fields=summary,description,labels,issuelinks,parent,subtasks,status,issuetype,comment`
  );

  if (issueResponse.status === 404) {
    return {
      outcome: 'ISSUE_NOT_FOUND_OR_NOT_VISIBLE',
      issueKey,
      message: `Jira could not retrieve ${issueKey}. The issue may not exist on this site or may not be visible to the current user.`,
      readOnly: true,
    };
  }
  if (issueResponse.status === 401 || issueResponse.status === 403) {
    return {
      outcome: 'JIRA_ACCESS_DENIED',
      issueKey,
      message: `The current user cannot read ${issueKey}. Check Jira Browse Projects permissions and the app's read scopes.`,
      readOnly: true,
    };
  }
  if (!issueResponse.ok) {
    throw new Error(`DecisionTrace could not read ${issueKey} (HTTP ${issueResponse.status}).`);
  }

  const issue = await issueResponse.json();
  const discovery = await searchConfluenceDecisions();
  const reviewedDiscovery = await attachReviewStatusesToDiscovery(discovery);
  const pages = applySupersessionRelationships(reviewedDiscovery.pages);

  const decisions = pages.map(toGraphDecision);
  const workItem = mapJiraIssueToWorkItem(issue);
  const fields = issue.fields ?? {};
  const graphWorkItem = {
    key: workItem.key,
    summary: workItem.summary,
    description: workItem.description,
    status: fields.status?.name ?? workItem.status,
    issueType: fields.issuetype?.name ?? workItem.type,
    labels: Array.isArray(fields.labels) ? fields.labels : [],
    comments: workItem.comments ?? [],
    linkedIssueKeys: workItem.linkedWorkItemKeys ?? [],
    parentKey: fields.parent?.key ?? null,
    decisionIds: workItem.linkedDecisionIds ?? [],
  };
  const graph = buildDecisionGraph(decisions, [graphWorkItem]);
  const pagesById = new Map(pages.map((page) => [String(page.id), page]));

  const evidenceMatches = graph.decisionWorkLinks
    .filter((link) => link.workItemKey === issueKey)
    .map((link) => {
      const page = pagesById.get(String(link.decisionId));
      const decision = graph.decisions.find((item) => item.id === String(link.decisionId));
      const sourceDecisionStatus = String(page?.derivedStatus ?? page?.declaredStatus ?? 'unspecified').toLowerCase();
      const reviewStatus = page?.reviewStatus ?? 'needs-review';
      const lifecycle = resolveDecisionLifecycle({
        declaredStatus: page?.declaredStatus,
        derivedStatus: page?.derivedStatus,
        reviewStatus,
      });
      const superseded = lifecycle.superseded;
      const humanApproved = reviewStatus === 'approved';
      const rejected = lifecycle.rejected;
      const authoritative = lifecycle.authoritative;
      return {
        decisionId: String(link.decisionId),
        decisionTitle: page?.title ?? decision?.title ?? 'Unknown decision',
        decisionStatus: lifecycle.status,
        sourceDecisionStatus,
        reviewerStatus: reviewStatus,
        staleApproval: Boolean(page?.staleApproval),
        priorReviewSourceVersion: page?.reviewSourceVersion ?? null,
        humanApproved,
        rejected,
        authoritative,
        superseded,
        supersededBy: page?.supersededByTitle ?? page?.supersededBy ?? null,
        relationship: link.relationship,
        matchedClaims: link.matchedClaims,
        evidence: link.evidence,
        sourceUrl: page?.url ?? null,
      };
    });

  const activeApproved = evidenceMatches.filter((item) => item.authoritative);
  const staleApproved = evidenceMatches.filter((item) => item.humanApproved && item.superseded);
  const staleApprovalMatches = evidenceMatches.filter((item) => item.staleApproval);
  const rejectedMatches = evidenceMatches.filter((item) => item.rejected && !item.superseded);
  const unverified = evidenceMatches.filter((item) =>
    !item.authoritative && !item.rejected && !item.superseded
  );
  const excludedMentions = evidenceMatches.filter((item) =>
    item.relationship === 'mentions-excluded-option' || item.relationship === 'mixed-or-ambiguous'
  );
  const currentExclusionNeedsReview = excludedMentions.some((item) => item.authoritative);

  let outcome = 'NO_DECISION_MATCH';
  if (currentExclusionNeedsReview) outcome = 'HUMAN_REVIEW_REQUIRED';
  else if (staleApproved.length > 0) outcome = 'POTENTIALLY_STALE_DECISION';
  else if (staleApprovalMatches.length > 0) outcome = 'STALE_APPROVAL_REQUIRES_REVIEW';
  else if (rejectedMatches.length > 0) outcome = 'REJECTED_DECISION_MATCH';
  else if (activeApproved.some((item) => item.relationship === 'mentions-selected-option')) outcome = 'ALIGNED_WITH_APPROVED_DECISION_SIGNAL';
  else if (unverified.length > 0) outcome = 'UNVERIFIED_DECISION_CANDIDATE_MATCH';

  const linkedKeys = workItem.linkedWorkItemKeys ?? [];
  const commentCount = Array.isArray(issue.fields?.comment?.comments)
    ? issue.fields.comment.comments.length
    : 0;

  return {
    outcome,
    issue: {
      key: issueKey,
      summary: workItem.summary,
      status: issue.fields?.status?.name ?? workItem.status ?? 'Unknown',
      issueType: issue.fields?.issuetype?.name ?? workItem.type ?? 'Issue',
      url: null,
      linkedIssueCount: linkedKeys.length,
      commentCount,
    },
    decisionMatches: evidenceMatches,
    summary: {
      approvedActiveMatches: activeApproved.length,
      approvedSupersededMatches: staleApproved.length,
      staleApprovalMatches: staleApprovalMatches.length,
      rejectedMatches: rejectedMatches.length,
      unverifiedCandidateMatches: unverified.length,
      excludedOptionOrAmbiguousMentions: excludedMentions.length,
    },
    interpretation: {
      POTENTIALLY_STALE_DECISION: 'The issue matches a reviewer-approved decision that has been superseded. Treat this as a stale-decision signal and inspect whether the work still implements the old choice.',
      HUMAN_REVIEW_REQUIRED: 'The issue mentions an excluded option or has mixed evidence. This is not proof of a violation; a human must inspect whether the work is remediation, migration or continued implementation.',
      ALIGNED_WITH_APPROVED_DECISION_SIGNAL: 'The issue contains evidence matching an active, reviewer-approved selected option. This is an alignment signal, not proof that implementation is complete or correct.',
      STALE_APPROVAL_REQUIRES_REVIEW: 'The decision page has changed since it was approved. The earlier approval is no longer authoritative; a human must review the current source version.',
      REJECTED_DECISION_MATCH: 'The issue matches a decision that a human reviewer explicitly rejected. Do not treat it as an approved or authoritative decision.',
      UNVERIFIED_DECISION_CANDIDATE_MATCH: 'The issue matches a decision candidate that has not been approved by a human reviewer for its current source version. Do not treat it as authoritative.',
      NO_DECISION_MATCH: 'No extracted decision claim matched this issue. This does not prove that the issue is unrelated.',
    },
    safety: {
      readOnly: true,
      jiraModified: false,
      confluenceModified: false,
      humanReviewRequiredForEnforcement: true,
    },
    sourceCoverage: {
      confluencePagesScanned: discovery.scannedCount,
      decisionCandidates: discovery.count,
    },
  };
}
export const handler = resolver.getDefinitions();