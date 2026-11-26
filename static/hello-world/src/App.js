import React, { useCallback, useEffect, useState } from 'react';
import { events, invoke, view } from '@forge/bridge';
import './App.css';
import CommandCenter from './CommandCenter';

function DecisionRegister() {
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const scan = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const data = await invoke('scanConfluenceDecisions');
      setResults(data);
    } catch (err) {
      setError(err?.message || 'Could not scan Confluence.');
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <main className="dt-shell dt-register">
      <header className="dt-header">
        <div className="dt-brand">
          <div className="dt-brand-mark">D</div>
          <div>
            <div className="dt-brand-name">DecisionTrace</div>
            <div className="dt-brand-subtitle">DECISION INTELLIGENCE</div>
          </div>
        </div>
        <span className="dt-connected">
          <span className="dt-dot" /> CONFLUENCE
        </span>
      </header>

      <section className="dt-intro">
        <div className="dt-eyebrow">DECISION REGISTER</div>
        <h1>Decisions should govern the work.</h1>
        <p>
          Discover decision pages, extract explicit claims and prepare
          them for human review before they are used to assess Jira work.
        </p>
      </section>

      <section className="dt-register-toolbar">
        <div>
          <div className="dt-eyebrow">SOURCE DISCOVERY</div>
          <h2>Confluence decision pages</h2>
        </div>
        <button
          className="dt-primary-button"
          onClick={scan}
          disabled={loading}
        >
          {loading ? 'Scanning...' : '↻ Scan Confluence'}
        </button>
      </section>

      <div className="dt-register-note">
        <strong>Human review required.</strong>
        <span>
          Extracted claims are candidates, not confirmed decisions.
          No Jira conflict verdict is generated from an unreviewed page.
        </span>
      </div>

      {error && (
        <div className="dt-register-error">
          <strong>Connection or search error</strong>
          <p>{error}</p>
          <button className="dt-button" onClick={scan}>
            Retry
          </button>
        </div>
      )}

      {!results && !loading && !error && (
        <div className="dt-register-empty">
          <div className="dt-empty-icon">◈</div>
          <h3>Your decision sources start here.</h3>
          <p>
            Scan Confluence to discover pages containing decision-related
            content and extract explicit Use and Exclude claims.
          </p>
        </div>
      )}

      {loading && (
        <div className="dt-loading">
          <div className="dt-spinner" />
          <p>Searching Confluence pages...</p>
        </div>
      )}

      {results && (
        <section className="dt-results">
          <div className="dt-results-heading">
            <div>
              <div className="dt-eyebrow">SCAN RESULTS</div>
              <h2>{results.count} decision candidates</h2>
<p className="dt-results-subtitle">
  Filtered from {results.scannedCount} recently modified pages.
  Templates and pages without decision signals are excluded.
</p>
            </div>
            <span className="dt-pending">CANDIDATES</span>
          </div>

          {results.pages.length === 0 && (
            <div className="dt-register-empty">
              <h3>No matching pages found.</h3>
              <p>
                Create a Confluence page containing a decision, or check
                whether your account has access to existing pages.
              </p>
            </div>
          )}

          {results.pages.map((page) => (
            <article className="dt-page-card" key={page.id}>
              <div className="dt-page-heading">
                <div>
                  <span className="dt-page-space">{page.spaceKey}</span>
                  <h3>
                    {page.url ? (
                      <a href={page.url} target="_blank" rel="noreferrer">
                        {page.title} ↗
                      </a>
                    ) : page.title}
                  </h3>
                </div>
                <span className="dt-page-review">Needs review · {page.declaredStatus}</span>
              </div>

              <p className="dt-page-preview">
                {page.preview || 'No readable page body was returned.'}
              </p>

              <div className="dt-claims-heading">
                EXTRACTED CLAIMS ({page.claims.length})
              </div>

              {page.claims.length === 0 ? (
                <p className="dt-no-claims">
                  No explicit Use or Exclude statement was extracted.
                  This page needs manual inspection.
                </p>
              ) : (
                page.claims.map((claim) => (
                  <div className="dt-claim" key={claim.id}>
                    <span className={
                      claim.kind === 'exclude'
                        ? 'dt-claim-type dt-exclude'
                        : 'dt-claim-type'
                    }>
                      {claim.kind.toUpperCase()}
                    </span>
                    <div>
                      <strong>{claim.value}</strong>
                      <p>Source: {claim.quotedText}</p>
                    </div>
                  </div>
                ))
              )}
            </article>
          ))}

          <p className="dt-results-footnote">
            Showing up to {results.limit} recently modified matching pages.
            Results respect the current user's Confluence access.
          </p>
        </section>
      )}

      <footer className="dt-footer">
        <span>DECISIONTRACE</span>
        <span>Evidence first. Human approval always.</span>
      </footer>
    </main>
  );
}

function App() {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [contextReady, setContextReady] = useState(false);
  const [isRegister, setIsRegister] = useState(false);
  const [isCommandCenter, setIsCommandCenter] = useState(false);

  const loadIssue = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const result = await invoke('getIssueSnapshot');

      if (!result?.issue) {
        throw new Error('Jira did not return an issue snapshot.');
      }

      setSnapshot(result);
    } catch (err) {
      setError(err?.message || 'Unable to load this Jira issue.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let subscription = null;

    view.getContext().then((context) => {
      if (!active) return;

      const extensionType = context?.extension?.type ?? '';

      const macro =
        extensionType === 'macro' ||
        extensionType.endsWith(':macro');

      const commandCenter =
        extensionType === 'confluence:globalPage';

      setIsRegister(macro);
      setIsCommandCenter(commandCenter);
      setContextReady(true);

      if (!macro && !commandCenter) {
        loadIssue();

        events.on('JIRA_ISSUE_CHANGED', loadIssue)
          .then((sub) => {
            if (active) subscription = sub;
            else sub.unsubscribe();
          })
          .catch(() => {});
      }
    }).catch(() => {
      if (active) {
        setIsRegister(false);
        setContextReady(true);
        loadIssue();
      }
    });

    return () => {
      active = false;
      if (subscription) subscription.unsubscribe();
    };
  }, [loadIssue]);

  if (!contextReady) {
    return (
      <main className="dt-shell">
        <div className="dt-loading">
          <div className="dt-spinner" />
          <p>Initialising DecisionTrace...</p>
        </div>
      </main>
    );
  }

  if (isRegister) return <DecisionRegister />;
  if (isCommandCenter) return <CommandCenter />;

  if (loading && !snapshot) {
    return (
      <main className="dt-shell">
        <div className="dt-loading">
          <div className="dt-spinner" />
          <p>Connecting to Jira...</p>
        </div>
      </main>
    );
  }

  if (error && !snapshot) {
    return (
      <main className="dt-shell">
        <div className="dt-error">
          <span className="dt-error-icon">!</span>
          <h2>We couldn't load this issue</h2>
          <p>{error}</p>
          <button onClick={loadIssue} className="dt-button">
            Try again
          </button>
        </div>
      </main>
    );
  }

  const issue = snapshot?.issue;
  const coverage = snapshot?.decisionCoverage;

  if (!issue) return null;

  return (
    <main className="dt-shell">
      <header className="dt-header">
        <div className="dt-brand">
          <div className="dt-brand-mark">D</div>
          <div>
            <div className="dt-brand-name">DecisionTrace</div>
            <div className="dt-brand-subtitle">DECISION INTELLIGENCE</div>
          </div>
        </div>

        <div className="dt-header-actions">
          <span className="dt-connected">
            <span className="dt-dot" /> JIRA CONNECTED
          </span>
          <button
            className="dt-refresh"
            onClick={loadIssue}
            disabled={loading}
          >
            {loading ? 'Refreshing...' : '↻ Refresh'}
          </button>
        </div>
      </header>

      <section className="dt-intro">
        <div className="dt-eyebrow">ISSUE INTELLIGENCE</div>
        <h1>Know what this work is actually following.</h1>
        <p>
          DecisionTrace connects decisions to the work they govern,
          then identifies work that may no longer reflect those decisions.
        </p>
      </section>

      <section className="dt-issue-card">
        <div className="dt-issue-top">
          <div>
            <div className="dt-issue-key">{issue.key}</div>
            <h2>{issue.summary || 'Untitled issue'}</h2>
          </div>
          <span className="dt-status">{issue.status}</span>
        </div>

        <div className="dt-divider" />

        <div className="dt-facts">
          <div className="dt-fact">
            <span>ISSUE TYPE</span>
            <strong>{issue.type}</strong>
          </div>
          <div className="dt-fact">
            <span>PRIORITY</span>
            <strong>{issue.priority}</strong>
          </div>
          <div className="dt-fact">
            <span>ASSIGNEE</span>
            <strong>{issue.assignee}</strong>
          </div>
          <div className="dt-fact">
            <span>DUE DATE</span>
            <strong>{issue.dueDate || 'Not set'}</strong>
          </div>
        </div>

        {issue.labels?.length > 0 && (
          <div className="dt-labels">
            {issue.labels.map((label) => (
              <span className="dt-label" key={label}>{label}</span>
            ))}
          </div>
        )}
      </section>

      <section className="dt-coverage">
        <div className="dt-section-heading">
          <div>
            <div className="dt-eyebrow">DECISION COVERAGE</div>
            <h2>Decision alignment</h2>
          </div>
          <span className="dt-pending">NOT YET ACTIVE</span>
        </div>

        <div className="dt-pending-card">
          <div className="dt-pending-symbol">↗</div>
          <div className="dt-pending-content">
            <h3>Jira is connected. Decision sources are next.</h3>
            <p>
              Jira issue context is available. Confluence decisions
              must be discovered and reviewed before conflict detection
              can produce a verdict.
            </p>
          </div>
        </div>
      </section>

      <section className="dt-context-grid">
        <div className="dt-context-card">
          <span className="dt-card-icon">↳</span>
          <div>
            <span className="dt-card-label">LINKED WORK</span>
            <strong>{issue.linkedIssues?.length ?? 0}</strong>
            <p>Related Jira issues</p>
          </div>
        </div>

        <div className="dt-context-card">
          <span className="dt-card-icon">≡</span>
          <div>
            <span className="dt-card-label">DISCUSSION</span>
            <strong>{issue.commentCount ?? 0}</strong>
            <p>Available issue comments</p>
          </div>
        </div>

        <div className="dt-context-card">
          <span className="dt-card-icon">◈</span>
          <div>
            <span className="dt-card-label">SOURCE STATUS</span>
            <strong>{coverage?.jiraConnected ? 'Connected' : 'Offline'}</strong>
            <p>Jira issue context</p>
          </div>
        </div>
      </section>

      <section className="dt-next">
        <div className="dt-eyebrow">THE NEXT LAYER</div>
        <h2>From recorded decisions to verified consequences.</h2>
        <div className="dt-next-steps">
          <div>
            <span>01</span>
            <strong>Collect decisions</strong>
            <p>Connect Confluence decision pages.</p>
          </div>
          <div>
            <span>02</span>
            <strong>Detect conflicts</strong>
            <p>Compare decision claims against live Jira work.</p>
          </div>
          <div>
            <span>03</span>
            <strong>Review with evidence</strong>
            <p>Let a person confirm or dismiss proposed flags.</p>
          </div>
        </div>
      </section>

      <footer className="dt-footer">
        <span>DECISIONTRACE</span>
        <span>Evidence first. Human approval always.</span>
      </footer>

      {error && <div className="dt-inline-error">{error}</div>}
    </main>
  );
}

export default App;