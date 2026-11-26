import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke, router } from '@forge/bridge';
import './CommandCenter.css';
import JudgeMode from './JudgeMode';

const MENU = [
  { id: 'overview', icon: '◫', label: 'Overview' },
  { id: 'sources', icon: '◈', label: 'Decision sources' },
  { id: 'impact', icon: '⌘', label: 'Impact graph' },
  { id: 'reviews', icon: '◎', label: 'Review queue' },
  { id: 'judge', icon: '✦', label: 'Judge mode' }
];

const RELATION_LABELS = {
  'mentions-selected-option': 'SELECTED OPTION MENTION',
  'mentions-excluded-option': 'EXCLUDED OPTION MENTION',
  'mixed-or-ambiguous': 'MIXED / AMBIGUOUS MENTION',
  'explicit-reference': 'EXPLICIT DECISION REFERENCE',
};

function StatCard({ label, value, note, icon, accent }) {
  return (
    <article className="cc-stat">
      <div className="cc-stat-top">
        <span className="cc-stat-label">{label}</span>
        <span className={`cc-stat-icon ${accent}`}>{icon}</span>
      </div>
      <strong className="cc-stat-value">{value}</strong>
      <span className="cc-stat-note">{note}</span>
    </article>
  );
}

function ReviewPill({ status }) {
  const label = status === 'approved'
    ? 'APPROVED BY REVIEWER'
    : status === 'rejected'
      ? 'REJECTED CANDIDATE'
      : 'NEEDS HUMAN REVIEW';
  return <span className={`cc-review-state ${status || 'needs-review'}`}>{label}</span>;
}

function ImpactList({ impact, onOpenIssue }) {
  if (!impact || impact.totalCount === 0) {
    return (
      <div className="cc-empty-state">
        <strong>No Jira relationships detected for this decision.</strong>
        <p>That means no visible issue matched its extracted claim phrases or linked-issue expansion. It does not prove that no related work exists.</p>
      </div>
    );
  }

  return (
    <div className="cc-impact-list">
      {impact.affectedItems.map((item) => (
        <article className={`cc-impact-row depth-${Math.min(item.depth, 3)}`} key={item.key}>
          <div className="cc-impact-depth">{item.depth === 0 ? 'DIRECT' : `HOP ${item.depth}`}</div>
          <div className="cc-impact-main">
            <div className="cc-impact-title-line">
              <strong>{item.key}</strong>
              <span className={`cc-severity ${item.severity}`}>{item.severity.toUpperCase()}</span>
            </div>
            <p>{item.summary}</p>
            <small>{item.path.join('  →  ')}</small>
            {item.matchedClaims?.length > 0 && (
              <div className="cc-impact-claims">
                {item.matchedClaims.map((claim, index) => (
                  <span key={`${claim.kind}-${claim.text}-${index}`} className={`cc-table-claim ${claim.kind.toLowerCase()}`}>
                    {claim.kind} {claim.text}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="cc-impact-side">
            <span>{item.status || 'Status unavailable'}</span>
            {item.url && <button onClick={() => onOpenIssue(item.url)}>Open ↗</button>}
          </div>
        </article>
      ))}
    </div>
  );
}

function RelationshipList({ links, workItems, onOpenIssue }) {
  const byKey = new Map((workItems ?? []).map((item) => [item.key, item]));
  if (!links || links.length === 0) {
    return (
      <div className="cc-empty-inline">
        No Jira work items currently match this candidate's extracted claims. Try refreshing after creating or updating relevant Jira work.
      </div>
    );
  }

  return (
    <div className="cc-relationship-list">
      {links.map((link) => {
        const item = byKey.get(link.workItemKey);
        return (
          <article className="cc-relationship-row" key={link.id}>
            <div className="cc-relationship-type">{RELATION_LABELS[link.relationship] || link.relationship}</div>
            <div className="cc-relationship-main">
              <strong>{link.workItemKey}{item ? ` · ${item.summary}` : ''}</strong>
              <small>{link.evidenceStrength === 'explicit' ? 'Explicit reference' : 'Phrase match — inspect context'}</small>
              {link.evidence?.map((evidence, index) => (
                <blockquote key={`${link.id}-${index}`}>
                  <span>{evidence.claimKind} · {evidence.sourceField}</span>
                  “{evidence.excerpt}”
                </blockquote>
              ))}
            </div>
            {item?.url && <button className="cc-inline-link" onClick={() => onOpenIssue(item.url)}>Open issue ↗</button>}
          </article>
        );
      })}
      <p className="cc-caveat">A phrase match establishes a possible relationship, not proof that the issue implements or violates the decision.</p>
    </div>
  );
}

function CommandCenter() {
  const [activeSection, setActiveSection] = useState('overview');
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [reviewingId, setReviewingId] = useState('');
  const [reviewReasons, setReviewReasons] = useState({});
  const [reviewHistory, setReviewHistory] = useState({});
  const [historyOpenId, setHistoryOpenId] = useState('');
  const [historyLoadingId, setHistoryLoadingId] = useState('');
  const [historyErrors, setHistoryErrors] = useState({});  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [diagnosticIssueKey, setDiagnosticIssueKey] = useState('LEO-23');
  const [diagnosticLoading, setDiagnosticLoading] = useState(false);
  const [diagnosticResult, setDiagnosticResult] = useState(null);
  const [diagnosticError, setDiagnosticError] = useState('');

  const loadGraph = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError('');
    try {
      const result = await invoke('getDecisionGraph');
      if (!result || !Array.isArray(result.pages) || !result.graph) {
        throw new Error('DecisionTrace returned an incomplete graph response.');
      }
      setData(result);
      setSelectedId((current) => result.pages.some((page) => page.id === current)
        ? current
        : result.pages[0]?.id ?? '');
      if (!quiet) {
        setNotice(`Updated ${result.pages.length} decision candidates. Analysed ${result.jira?.issueCount ?? 0} Jira issues and found ${result.jira?.matchedIssueCount ?? 0} direct evidence matches. ${result.jira?.searchMode ?? ""}`);
      }
    } catch (err) {
      setError(err?.message || 'Unable to build the live decision graph.');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadGraph(false);
  }, [loadGraph]);

  const candidates = data?.pages ?? [];
  const selected = candidates.find((page) => page.id === selectedId) ?? candidates[0] ?? null;
  const graph = data?.graph;
  const workItems = graph?.workItems ?? [];
  const selectedLinks = graph?.decisionWorkLinks?.filter((link) => link.decisionId === selected?.id) ?? [];
  const selectedImpact = data?.impacts?.find((impact) => impact.decisionId === selected?.id) ?? null;
  const selectedFlags = data?.flags?.filter((flag) => flag.decisionId === selected?.id) ?? [];
  const claimCount = candidates.reduce((sum, page) => sum + (page.claims?.length ?? 0), 0);
  const reviewCount = candidates.filter((page) => page.reviewStatus === 'needs-review').length;

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return candidates;
    return candidates.filter((page) => [
      page.title,
      page.spaceKey,
      page.preview,
      ...(page.claims ?? []).map((claim) => claim.value),
    ].join(' ').toLowerCase().includes(term));
  }, [candidates, query]);

  const openUrl = async (url) => {
    if (!url) return;
    try { await router.open(url); }
    catch { setError('The requested Atlassian page could not be opened.'); }
  };

  const updateReview = async (decisionId, status) => {
    const reason = status === 'needs-review'
      ? ''
      : String(reviewReasons[decisionId] ?? '').trim();

    if (status !== 'needs-review' && (reason.length < 20 || reason.length > 1000)) {
      setError('Enter a review rationale of at least 20 characters and no more than 1,000 characters.');
      return;
    }

    setReviewingId(decisionId);
    setError('');
    setNotice('');
    try {
      await invoke('setDecisionReview', {
        decisionId,
        status,
        ...(status === 'needs-review' ? {} : { reason }),
      });
      setReviewReasons((current) => {
        const next = { ...current };
        delete next[decisionId];
        return next;
      });
      setReviewHistory((current) => {
        const next = { ...current };
        delete next[decisionId];
        return next;
      });
      setHistoryErrors((current) => ({ ...current, [decisionId]: '' }));
      setNotice(status === 'approved'
        ? 'Decision approved for use in DecisionTrace analysis. The Confluence source was not changed.'
        : status === 'rejected'
          ? 'Candidate rejected in DecisionTrace. The Confluence source was not changed.'
          : 'Candidate returned to the review queue.');
      await loadGraph(true);
    } catch (err) {
      setError(err?.message || 'Could not save the review decision.');
    } finally {
      setReviewingId('');
    }
  };

  const runIssueDiagnostic = async () => {
    setDiagnosticLoading(true);
    setDiagnosticError('');
    setDiagnosticResult(null);
    try {
      const result = await invoke('diagnoseJiraIssue', { issueKey: diagnosticIssueKey });
      setDiagnosticResult(result);
    } catch (err) {
      setDiagnosticError(err?.message || 'Direct Jira diagnostic failed.');
    } finally {
      setDiagnosticLoading(false);
    }
  };
  useEffect(() => {
    let active = true;
    setDiagnosticLoading(true);
    setDiagnosticError('');
    invoke('diagnoseJiraIssue', { issueKey: 'LEO-23' })
      .then((result) => {
        if (active) setDiagnosticResult(result);
      })
      .catch((err) => {
        if (active) setDiagnosticError(err?.message || 'Automatic Jira diagnostic failed.');
      })
      .finally(() => {
        if (active) setDiagnosticLoading(false);
      });
    return () => { active = false; };
  }, []);
  const loadReviewHistory = async (decisionId, cursor = null) => {
    setHistoryLoadingId(decisionId);
    setHistoryErrors((current) => ({ ...current, [decisionId]: '' }));
    try {
      const result = await invoke('getDecisionReviewHistory', {
        decisionId,
        limit: 20,
        ...(cursor ? { cursor } : {}),
      });
      setReviewHistory((current) => {
        const existing = cursor ? (current[decisionId]?.events ?? []) : [];
        const byEventId = new Map(existing.map((event) => [event.eventId, event]));
        for (const event of result.events ?? []) byEventId.set(event.eventId, event);
        return {
          ...current,
          [decisionId]: {
            events: [...byEventId.values()],
            nextCursor: result.nextCursor ?? null,
            hasMore: Boolean(result.hasMore),
            currentSourceVersion: result.currentSourceVersion,
          },
        };
      });
    } catch (err) {
      setHistoryErrors((current) => ({
        ...current,
        [decisionId]: err?.message || 'Could not load review history.',
      }));
    } finally {
      setHistoryLoadingId('');
    }
  };

  const toggleReviewHistory = (decisionId) => {
    if (historyOpenId === decisionId) {
      setHistoryOpenId('');
      return;
    }
    setHistoryOpenId(decisionId);
    if (!reviewHistory[decisionId]) loadReviewHistory(decisionId);
  };

  const renderReviewActions = (page) => {
    const reason = reviewReasons[page.id] ?? '';
    const reasonLength = reason.trim().length;
    const reasonValid = reasonLength >= 20 && reasonLength <= 1000;
    const isReviewing = reviewingId === page.id;
    const reasonInputId = `cc-review-reason-${page.id}`;
    const history = reviewHistory[page.id];
    const historyOpen = historyOpenId === page.id;
    const historyLoading = historyLoadingId === page.id;

    return (
      <div className="cc-review-action-panel">
        <label className="cc-review-reason-label" htmlFor={reasonInputId}>
          <span>REVIEW RATIONALE</span>
          <small>Required for approval or rejection</small>
        </label>
        <textarea
          id={reasonInputId}
          className="cc-review-reason"
          value={reason}
          rows={3}
          maxLength={1000}
          disabled={isReviewing}
          placeholder="Explain the evidence and why this decision should be approved or rejected..."
          aria-describedby={`${reasonInputId}-help`}
          onChange={(event) => setReviewReasons((current) => ({
            ...current,
            [page.id]: event.target.value,
          }))}
        />
        <div className="cc-review-reason-meta" id={`${reasonInputId}-help`}>
          <span>At least 20 characters. Maximum 1,000.</span>
          <span className={reasonValid ? 'valid' : ''}>{reasonLength}/1000</span>
        </div>
        <div className="cc-review-actions">
          <button className="cc-review-button approve" disabled={isReviewing || !reasonValid} onClick={() => updateReview(page.id, 'approved')}>
            {isReviewing ? 'Saving...' : 'Approve decision'}
          </button>
          <button className="cc-review-button reject" disabled={isReviewing || !reasonValid} onClick={() => updateReview(page.id, 'rejected')}>
            Reject candidate
          </button>
          {page.reviewStatus !== 'needs-review' && (
            <button className="cc-review-button reopen" disabled={isReviewing} onClick={() => updateReview(page.id, 'needs-review')}>
              Reopen
            </button>
          )}
          <button
            className="cc-review-button history-toggle"
            disabled={historyLoading}
            aria-expanded={historyOpen}
            onClick={() => toggleReviewHistory(page.id)}
          >
            {historyLoading ? 'Loading history...' : historyOpen ? 'Hide audit history' : 'View audit history'}
          </button>
        </div>
        {historyOpen && (
          <section className="cc-review-history" aria-label={`Review history for ${page.title}`}>
            <div className="cc-review-history-head">
              <strong>IMMUTABLE REVIEW HISTORY</strong>
              {history?.currentSourceVersion && <span>Current page version {history.currentSourceVersion}</span>}
            </div>
            {historyErrors[page.id] && <div className="cc-review-history-error">{historyErrors[page.id]}</div>}
            {historyLoading && !history && <p className="cc-review-history-empty">Loading review events...</p>}
            {history && history.events.length === 0 && !historyLoading && (
              <p className="cc-review-history-empty">No review events have been recorded for this decision.</p>
            )}
            {history?.events?.length > 0 && (
              <ol className="cc-review-history-list">
                {history.events.map((event) => (
                  <li className="cc-review-history-event" key={event.eventId}>
                    <div className="cc-review-history-event-top">
                      <span className={`cc-history-status ${event.status}`}>{event.status.replace('-', ' ')}</span>
                      <strong>Revision {event.revision}</strong>
                      <time dateTime={event.reviewedAt}>{new Date(event.reviewedAt).toLocaleString()}</time>
                    </div>
                    <div className="cc-review-history-meta">
                      <span>Source version {event.sourceVersion}{event.sourceVersion === history.currentSourceVersion ? ' · current' : ' · older source version'}</span>
                      <span>Reviewer {String(event.reviewerAccountId ?? '').slice(0, 10)}…</span>
                    </div>
                    <p>{event.reason}</p>
                  </li>
                ))}
              </ol>
            )}
            {history?.hasMore && (
              <button
                className="cc-review-history-more"
                disabled={historyLoading}
                onClick={() => loadReviewHistory(page.id, history.nextCursor)}
              >
                {historyLoading ? 'Loading...' : 'Load older events'}
              </button>
            )}
          </section>
        )}
      </div>
    );
  };

  const heading = activeSection === 'sources'
    ? 'Decision sources'
    : activeSection === 'impact'
      ? 'Impact graph'
      : activeSection === 'reviews'
        ? 'Human review queue'
        : 'Workspace overview';

  return (
    <div className="cc-app">
      <aside className="cc-sidebar">
        <div className="cc-logo">
          <div className="cc-logo-mark">D</div>
          <div>
            <div className="cc-logo-name">DecisionTrace</div>
            <div className="cc-logo-caption">DECISION INTELLIGENCE</div>
          </div>
        </div>

        <div className="cc-workspace">
          <span className="cc-small-label">WORKSPACE</span>
          <div className="cc-workspace-value">
            <span className="cc-workspace-avatar">V</span>
            <span><strong>Development</strong><small>One Atlas</small></span>
            <span className="cc-chevron">⌄</span>
          </div>
        </div>

        <div className="cc-nav-label">WORKSPACE</div>
        <nav className="cc-nav">
          {MENU.map((item) => (
            <button key={item.id} className={`cc-nav-item ${activeSection === item.id ? 'active' : ''}`} onClick={() => setActiveSection(item.id)}>
              <span className="cc-nav-icon">{item.icon}</span>
              <span>{item.label}</span>
              {item.id === 'reviews' && reviewCount > 0 && <span className="cc-nav-count">{reviewCount}</span>}
              {activeSection === item.id && <span className="cc-nav-indicator" />}
            </button>
          ))}
        </nav>

        <div className="cc-sidebar-bottom">
          <div className="cc-source-health">
            <div className="cc-health-heading"><span>CONNECTED SOURCES</span><span className="cc-health-dot" /></div>
            <div className="cc-source-line"><span className="cc-source-symbol jira">J</span><span>Jira</span><strong>Live query</strong></div>
            <div className="cc-source-line"><span className="cc-source-symbol conf">C</span><span>Confluence</span><strong>Live scan</strong></div>
          </div>
          <div className="cc-user"><div className="cc-user-avatar">VN</div><div><strong>Workspace reviewer</strong><small>Current Atlassian user</small></div></div>
        </div>
      </aside>

      <main className="cc-main">
        <header className="cc-topbar">
          <div className="cc-breadcrumb">WORKSPACE <span>/</span> DECISION INTELLIGENCE</div>
          <div className="cc-top-actions"><span className="cc-environment"><span className="cc-health-dot" /> DEVELOPMENT</span><div className="cc-top-avatar">DT</div></div>
        </header>

        <div className="cc-content">
          <section className="cc-hero">
            <div className="cc-hero-copy">
              <div className="cc-hero-eyebrow"><span className="cc-live-dot" /> DECISION OPERATIONS / COMMAND CENTER</div>
              <h1>Decisions change.<br /><span>Work should know.</span></h1>
              <p>Trace decision evidence into Jira work, inspect connected dependencies and route uncertain changes to a human reviewer.</p>
              <div className="cc-hero-actions">
                <button className="cc-scan-button" onClick={() => loadGraph(false)} disabled={loading}>
                  <span>{loading ? '◌' : '↻'}</span>{loading ? 'Building live graph...' : 'Refresh decision graph'}
                </button>
                <span className="cc-hero-hint">{data?.jira?.searchMode || "Confluence scan + Jira enhanced search"}</span>
              </div>
            </div>
            <div className="cc-hero-art" aria-hidden="true">
              <div className="cc-orbit orbit-one" /><div className="cc-orbit orbit-two" /><div className="cc-orbit orbit-three" />
              <div className="cc-art-core"><span>D</span></div>
              <div className="cc-art-node node-one">DECISION</div><div className="cc-art-node node-two">WORK</div><div className="cc-art-node node-three">EVIDENCE</div>
            </div>
          </section>

          <div className="cc-section-heading">
            <div><span className="cc-section-kicker">WORKSPACE INTELLIGENCE</span><h2>{heading}</h2><p>Live, permission-scoped Atlassian data. Candidate relationships remain subject to human interpretation.</p></div>
            <div className="cc-last-scan"><span className={data ? 'cc-scan-status active' : 'cc-scan-status'} />{data ? `Updated ${new Date(data.generatedAt).toLocaleTimeString()}` : 'Loading workspace'}</div>
          </div>

          {notice && <div className="cc-notice"><span>✓</span>{notice}</div>}
          {error && <div className="cc-error"><strong>Integration needs attention</strong><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}

          {activeSection === 'overview' && (
            <>
              <section className="cc-stats">
                <StatCard label="PAGES SCANNED" value={data ? data.scannedCount : '—'} note="Confluence search results" icon="▤" accent="blue" />
                <StatCard label="DECISION CANDIDATES" value={data ? data.count : '—'} note={`${reviewCount} awaiting human review`} icon="◈" accent="purple" />
                <StatCard label="JIRA ISSUES ANALYSED" value={data ? data.jira.issueCount : '—'} note={data?.jira?.searchTruncated ? 'Search capped; partial coverage' : 'Claim-targeted + linked issues'} icon="J" accent="teal" />
                <StatCard label="POTENTIAL RELATIONSHIPS" value={data ? graph?.stats?.directRelationshipCount ?? 0 : '—'} note="Phrase mentions or explicit references" icon="⌘" accent="amber" />
              </section>

              <section className="cc-workbench">
                <article className="cc-panel cc-graph-panel">
                  <div className="cc-panel-heading"><div><span className="cc-section-kicker">RELATIONSHIP EXPLORER</span><h3>Decision dependency map</h3></div><span className="cc-panel-tag">LIVE ATLASSIAN DATA</span></div>
                  {selected ? (
                    <>
                      <div className="cc-graph">
                        <div className="cc-graph-source"><div className="cc-graph-source-icon">C</div><div><small>CONFLUENCE SOURCE · {selected.spaceKey}</small><strong>{selected.title}</strong><span>Page {selected.id}</span></div></div>
                        <div className="cc-graph-connector"><span /><small>SOURCE CLAIMS</small></div>
                        <div className="cc-graph-claims">
                          {(selected.claims ?? []).map((claim) => <div className="cc-graph-claim" key={claim.id}><span className={`cc-claim-dot ${claim.kind}`} /><div><small>{claim.kind.toUpperCase()}</small><strong>{claim.value}</strong></div><span className="cc-claim-arrow">↗</span></div>)}
                          {selected.claims?.length === 0 && <div className="cc-empty-inline">No explicit claims were extracted.</div>}
                        </div>
                        <div className="cc-graph-connector"><span /><small>DECISION REVIEW STATE</small></div>
                        <div className="cc-graph-decision"><div className="cc-decision-symbol">D</div><div><small>DECISION CANDIDATE</small><strong>{selected.title}</strong><span>{selected.declaredStatus || 'Status unspecified'}</span></div><ReviewPill status={selected.reviewStatus} /></div>
                        <div className="cc-graph-connector"><span /><small>{selectedLinks.length} POTENTIAL JIRA RELATIONSHIPS</small></div>
                      </div>
                      <RelationshipList links={selectedLinks} workItems={workItems} onOpenIssue={openUrl} />
                    </>
                  ) : <div className="cc-graph-empty"><div className="cc-empty-symbol">◈</div><h3>No decision candidates loaded.</h3><p>Refresh the graph to scan Confluence and search Jira using extracted claims.</p></div>}
                </article>

                <article className="cc-panel cc-evidence-panel">
                  <div className="cc-panel-heading"><div><span className="cc-section-kicker">PROVENANCE</span><h3>Evidence inspector</h3></div><span className="cc-evidence-icon">⌕</span></div>
                  {selected ? <>
                    <div className="cc-source-detail"><span className="cc-detail-label">SOURCE DOCUMENT</span><strong>{selected.title}</strong><span>{selected.spaceKey} · {selected.id}</span></div>
                    <div className="cc-source-preview"><span className="cc-detail-label">SOURCE EXCERPT</span><p>{selected.preview || 'No page preview is available.'}</p></div>
                    <div className="cc-detail-status"><div><span className="cc-detail-label">DECLARED STATUS</span><strong>{selected.declaredStatus || 'Unspecified'}</strong></div><ReviewPill status={selected.reviewStatus} /></div>
                    <div className="cc-evidence-actions"><button onClick={() => openUrl(selected.url)} disabled={!selected.url}>Open original source ↗</button></div>
                    <p className="cc-evidence-disclaimer">Extracted text is evidence, not an approved decision. Approval is stored by DecisionTrace and does not edit the Confluence page.</p>
                    {renderReviewActions(selected)}
                  </> : <div className="cc-empty-inline">Select a candidate to inspect its source.</div>}
                </article>
              </section>

              <section className="cc-panel cc-register-panel">
                <div className="cc-register-heading"><div><span className="cc-section-kicker">BLAST RADIUS</span><h3>{selected ? `Related work for ${selected.title}` : 'Related work'}</h3><p>Direct phrase matches and indirect Jira relationships. Connected work is not automatically deemed non-compliant.</p></div><span className="cc-count">{selectedImpact?.totalCount ?? 0} related issues</span></div>
                <ImpactList impact={selectedImpact} onOpenIssue={openUrl} />
              </section>

              {selected?.reviewStatus === 'approved' && selectedFlags.length > 0 && (
                <section className="cc-panel cc-register-panel">
                  <div className="cc-register-heading"><div><span className="cc-section-kicker">DETERMINISTIC CHECKS</span><h3>Potential work conflicts</h3><p>Rule-based findings generated only after this candidate has been approved in DecisionTrace. Each finding still requires human confirmation.</p></div><span className="cc-count">{selectedFlags.length} findings</span></div>
                  <div className="cc-flag-list">
                    {selectedFlags.map((flag) => (
                      <article className="cc-flag-row" key={flag.id}>
                        <div><strong>{flag.workItemKey}</strong><span className={`cc-severity ${flag.verdict === 'conflict' ? 'high' : 'medium'}`}>{flag.verdict === 'conflict' ? 'POTENTIAL CONFLICT' : 'REVIEW'}</span></div>
                        <p>{flag.rationale}</p>
                        <blockquote>“{flag.evidenceQuote}”</blockquote>
                      </article>
                    ))}
                  </div>
                </section>
              )}
              {selected && selected.reviewStatus !== 'approved' && (
                <div className="cc-review-gate">Approve this candidate after checking its source before DecisionTrace promotes rule-based findings for it.</div>
              )}
            </>
          )}

          {activeSection === 'sources' && (
            <section className="cc-panel cc-register-panel">
              <div className="cc-register-heading"><div><span className="cc-section-kicker">SOURCE DISCOVERY</span><h3>Decision candidate register</h3><p>Extracted candidates from Confluence, with status kept separate from reviewer approval.</p></div><span className="cc-count">{candidates.length} candidates</span></div>
              <div className="cc-table-tools"><div className="cc-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles, spaces and claims..." /></div><button className="cc-secondary-button" onClick={() => loadGraph(false)} disabled={loading}>↻ Refresh sources</button></div>
              {filtered.length === 0 ? <div className="cc-table-empty"><strong>No matching decision candidates</strong><p>Refresh the graph or adjust the search term.</p></div> : <div className="cc-candidate-list">
                {filtered.map((page) => <div className={`cc-candidate-row ${selected?.id === page.id ? 'selected' : ''}`} key={page.id}>
                  <button className="cc-candidate-main" onClick={() => { setSelectedId(page.id); setActiveSection('overview'); }}><span className="cc-candidate-file">D</span><span className="cc-candidate-text"><strong>{page.title}</strong><small>{page.spaceKey} · {page.claims.length} claims · Page {page.id}</small></span></button>
                  <div className="cc-candidate-claims">{page.claims.slice(0, 2).map((claim) => <span key={claim.id} className={`cc-table-claim ${claim.kind}`}>{claim.kind.toUpperCase()} {claim.value}</span>)}</div>
                  <ReviewPill status={page.reviewStatus} />
                  <button className="cc-open-candidate" onClick={() => openUrl(page.url)} disabled={!page.url}>↗</button>
                </div>)}
              </div>}
            </section>
          )}

          {activeSection === 'impact' && (
            <section className="cc-panel cc-register-panel">
              <div className="cc-register-heading"><div><span className="cc-section-kicker">DEPENDENCY TRAVERSAL</span><h3>Impact graph</h3><p>Directly matched work and connected Jira issues, ordered by shortest relationship path.</p></div><span className="cc-count">{selectedImpact?.totalCount ?? 0} related nodes</span></div>
              <div className="cc-table-tools"><label className="cc-detail-label" htmlFor="cc-decision-select">SELECT DECISION</label><select id="cc-decision-select" className="cc-decision-select" value={selected?.id ?? ''} onChange={(event) => setSelectedId(event.target.value)}><option value="">Select a decision</option>{candidates.map((page) => <option value={page.id} key={page.id}>{page.title}</option>)}</select></div>
              {selected && <div className="cc-impact-summary"><div><strong>{selectedImpact?.directCount ?? 0}</strong><span>Direct matches</span></div><div><strong>{selectedImpact?.indirectCount ?? 0}</strong><span>Indirectly connected</span></div><div><strong>{selectedImpact?.totalCount ?? 0}</strong><span>Total related work</span></div></div>}
              <ImpactList impact={selectedImpact} onOpenIssue={openUrl} />
            </section>
          )}

          {activeSection === 'reviews' && (
            <section className="cc-panel cc-register-panel">
              <div className="cc-register-heading"><div><span className="cc-section-kicker">HUMAN GOVERNANCE</span><h3>Review queue</h3><p>Approve or reject a candidate in DecisionTrace. This does not alter its Confluence source or Jira issues.</p></div><span className="cc-count">{reviewCount} pending</span></div>
              {candidates.length === 0 ? <div className="cc-table-empty"><strong>No candidates to review</strong><p>Refresh the graph to discover Confluence decision candidates.</p></div> : <div className="cc-review-list">
                {candidates.map((page) => <article className="cc-review-card" key={page.id}>
                  <div className="cc-review-card-head"><div><span className="cc-section-kicker">{page.spaceKey} · PAGE {page.id}</span><h3>{page.title}</h3></div><ReviewPill status={page.reviewStatus} /></div>
                  <p>{page.preview || 'No readable excerpt was returned.'}</p>
                  <div className="cc-review-claims">{page.claims.map((claim) => <span key={claim.id} className={`cc-table-claim ${claim.kind}`}>{claim.kind.toUpperCase()} {claim.value}</span>)}</div>
                  <div className="cc-review-card-actions">{renderReviewActions(page)}{page.url && <button className="cc-inline-link" onClick={() => openUrl(page.url)}>Inspect source ↗</button>}</div>
                </article>)}
              </div>}
            </section>
          )}

          <section className="cc-panel cc-register-panel cc-diagnostic-panel">
            <div className="cc-register-heading">
              <div>
                <span className="cc-section-kicker">JIRA CONNECTIVITY DIAGNOSTIC</span>
                <h3>Verify a specific Jira issue</h3>
                <p>Fetch one issue directly, inspect its saved fields, and compare its text against the current Confluence claims. This separates issue access, search indexing and evidence matching.</p>
              </div>
              <span className="cc-count">Targeted check</span>
            </div>
            <div className="cc-diagnostic-toolbar">
              <label htmlFor="cc-diagnostic-issue-key">JIRA ISSUE KEY</label>
              <input
                id="cc-diagnostic-issue-key"
                value={diagnosticIssueKey}
                onChange={(event) => setDiagnosticIssueKey(event.target.value.toUpperCase())}
                placeholder="LEO-23"
              />
              <button className="cc-secondary-button" onClick={runIssueDiagnostic} disabled={diagnosticLoading || !diagnosticIssueKey.trim()}>
                {diagnosticLoading ? 'Checking Jira...' : 'Diagnose issue'}
              </button>
            </div>
            {diagnosticError && <div className="cc-error"><strong>Diagnostic failed</strong><span>{diagnosticError}</span></div>}
            {diagnosticResult && (
              <div className="cc-diagnostic-result">
                {!diagnosticResult.found ? (
                  <div className="cc-empty-state">
                    <strong>{diagnosticResult.issueKey} could not be confirmed by the automatic checks.</strong>
                    <div className="cc-diagnostic-grid">
                      <div><small>DIRECT ISSUE API</small><strong>HTTP {diagnosticResult.httpStatus}</strong></div>
                      <div><small>EXACT-KEY JIRA SEARCH</small><strong>{diagnosticResult.jqlKeySearchFound === null ? 'CHECK FAILED' : diagnosticResult.jqlKeySearchFound ? 'FOUND' : 'NO MATCH'}</strong></div>
                    </div>
                    <p>{diagnosticResult.message}</p>
                    {diagnosticResult.jqlKeySearchError && <p className="cc-diagnostic-note">Exact-key search: {diagnosticResult.jqlKeySearchError}</p>}
                    {diagnosticResult.recentIssueSearchError && <p className="cc-diagnostic-note">Recent issue search: {diagnosticResult.recentIssueSearchError}</p>}
                    {diagnosticResult.recentIssueSample?.length > 0 && (
                      <div className="cc-diagnostic-recent">
                        <strong>Recent Jira issues visible to this account</strong>
                        {diagnosticResult.recentIssueSample.map((item) => (
                          <div key={item.key}><b>{item.key}</b><span>{item.summary}</span></div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="cc-diagnostic-grid">
                      <div><small>ISSUE RETRIEVAL</small><strong>{diagnosticResult.retrievalMode === 'enhanced-jql-fallback' ? 'FOUND VIA EXACT-KEY SEARCH' : `DIRECT API · HTTP ${diagnosticResult.httpStatus}`}</strong></div>
                      <div><small>ENHANCED JQL KEY SEARCH</small><strong>{diagnosticResult.jqlKeySearchFound === null ? 'CHECK FAILED' : diagnosticResult.jqlKeySearchFound ? 'INDEXED' : 'NOT FOUND'}</strong></div>
                      <div><small>DESCRIPTION LENGTH</small><strong>{diagnosticResult.issue.descriptionLength} characters</strong></div>
                      <div><small>CLAIM PHRASES MATCHED</small><strong>{diagnosticResult.matchedClaimCount} / {diagnosticResult.decisionClaimCount}</strong></div>
                    </div>
                    {diagnosticResult.jqlKeySearchError && <p className="cc-diagnostic-note">Enhanced JQL diagnostic: {diagnosticResult.jqlKeySearchError}</p>}
                    <div className="cc-diagnostic-issue">
                      <strong>{diagnosticResult.issue.key} · {diagnosticResult.issue.summary}</strong>
                      <span>{diagnosticResult.issue.issueType} · {diagnosticResult.issue.status} · {diagnosticResult.issue.commentCount} comments</span>
                      <p>{diagnosticResult.issue.descriptionExcerpt || 'Jira returned an empty description.'}</p>
                      {diagnosticResult.issue.labels.length > 0 && <small>Labels: {diagnosticResult.issue.labels.join(', ')}</small>}
                      {diagnosticResult.issue.linkedIssueKeys.length > 0 && <small>Linked: {diagnosticResult.issue.linkedIssueKeys.join(', ')}</small>}
                      {diagnosticResult.issue.parentKey && <small>Parent: {diagnosticResult.issue.parentKey}</small>}
                      {diagnosticResult.issue.url && <button className="cc-inline-link" onClick={() => openUrl(diagnosticResult.issue.url)}>Open Jira issue ↗</button>}
                    </div>
                    <div className="cc-diagnostic-claims">
                      {diagnosticResult.matches.map((claim, index) => (
                        <article key={`${claim.decisionId}-${claim.kind}-${claim.value}-${index}`}>
                          <div><span className={`cc-table-claim ${String(claim.kind).toLowerCase()}`}>{claim.kind.toUpperCase()} {claim.value}</span><strong>{claim.matched ? 'MATCHED' : 'NO MATCH'}</strong></div>
                          {claim.matchedIn.map((hit, hitIndex) => <blockquote key={`${hit.field}-${hitIndex}`}><small>{hit.field.toUpperCase()}</small>{hit.excerpt}</blockquote>)}
                        </article>
                      ))}
                      {diagnosticResult.matches.length === 0 && <p>No claims were returned by the current Confluence scan.</p>}
                    </div>
                    <p className="cc-diagnostic-note">Direct issue retrieval and enhanced JQL indexing are tested separately. This diagnostic does not change the Jira issue.</p>
                  </>
                )}
              </div>
            )}
          </section>
                    {activeSection === 'judge' && <JudgeMode />}

<section className="cc-bottom-banner"><div className="cc-bottom-symbol">✳</div><div><strong>Evidence before enforcement.</strong><p>{data?.jira?.searchTruncated ? 'Jira search reached its current result cap. Review the coverage note before relying on the graph.' : 'Phrase matches are candidates for inspection. Human review remains the authority for accepting or rejecting a decision.'}</p></div><span className="cc-bottom-stage">HUMAN IN THE LOOP</span></section>
          <footer className="cc-footer"><span>DECISIONTRACE © 2026</span><span>Decision intelligence · Evidence-led operations</span></footer>
        </div>
      </main>
    </div>
  );
}

export default CommandCenter;