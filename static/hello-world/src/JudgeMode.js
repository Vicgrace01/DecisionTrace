import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@forge/bridge';
import './JudgeMode.css';

function JudgeMode() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedDecisionId, setSelectedDecisionId] = useState('DEMO-DECISION-V1');

  useEffect(() => {
    let active = true;
    invoke('getJudgeScenario')
      .then((result) => {
        if (!active) return;
        if (!result?.graph || !Array.isArray(result.decisions) || !Array.isArray(result.impacts)) {
          throw new Error('The seeded scenario returned an incomplete graph.');
        }
        setData(result);
        setSelectedDecisionId(result.oldDecisionId);
      })
      .catch((err) => {
        if (active) setError(err?.message || 'Could not load the seeded Judge Mode scenario.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const oldDecision = data?.decisions.find((item) => item.id === data.oldDecisionId);
  const currentDecision = data?.decisions.find((item) => item.id === data.currentDecisionId);
  const selectedDecision = data?.decisions.find((item) => item.id === selectedDecisionId);
  const impact = data?.impacts.find((item) => item.decisionId === selectedDecisionId);
  const workByKey = useMemo(
    () => new Map((data?.graph?.workItems ?? []).map((item) => [item.key, item])),
    [data]
  );
  const directLinks = (data?.graph?.decisionWorkLinks ?? []).filter(
    (link) => link.decisionId === selectedDecisionId
  );
  const linkByKey = new Map(directLinks.map((link) => [link.workItemKey, link]));

  if (loading) return <section className="dt-judge-shell"><div className="dt-judge-loading">Building the seeded decision-reversal scenario…</div></section>;
  if (error) return <section className="dt-judge-shell"><div className="dt-judge-error"><strong>Judge Mode could not load</strong><p>{error}</p></div></section>;
  if (!data || !oldDecision || !currentDecision) return null;

  return (
    <section className="dt-judge-shell">
      <div className="dt-judge-kicker"><span className="dt-judge-kicker-dot" /> JUDGE MODE <span className="dt-judge-seed-label">SEEDED DEMO DATA</span></div>
      <div className="dt-judge-heading">
        <div>
          <h2>A decision changed. Is the work still following the old one?</h2>
          <p>One reversal, five connected work items, and an evidence trail showing what may need attention.</p>
        </div>
        <div className="dt-judge-engine-tag">DETERMINISTIC GRAPH ENGINE</div>
      </div>

      <div className="dt-judge-disclaimer">
        <strong>Demonstration scenario</strong>
        <span>{data.disclaimer} No Jira or Confluence records are created or modified.</span>
      </div>

      <div className="dt-judge-decision-flow">
        <article className="dt-judge-decision old">
          <div className="dt-judge-card-top"><span>DECISION · VERSION 1</span><b>SUPERSEDED</b></div>
          <h3>{oldDecision.title}</h3>
          <div className="dt-judge-claim"><span>USE</span><strong>Vendor A</strong></div>
          <p>Original approved direction.</p>
        </article>
        <div className="dt-judge-supersedes"><span>SUPERSEDED BY</span><b>→</b></div>
        <article className="dt-judge-decision current">
          <div className="dt-judge-card-top"><span>DECISION · VERSION 2</span><b>ACTIVE</b></div>
          <h3>{currentDecision.title}</h3>
          <div className="dt-judge-claim"><span>USE</span><strong>Vendor B</strong></div>
          <div className="dt-judge-claim exclude"><span>EXCLUDE</span><strong>Vendor A</strong></div>
          <p>New direction explicitly supersedes version 1.</p>
        </article>
      </div>

      <div className="dt-judge-metrics">
        <div><strong>{data.graph.stats.supersessionCount}</strong><span>Supersession link</span></div>
        <div><strong>{impact?.directCount ?? 0}</strong><span>Direct matches</span></div>
        <div><strong>{impact?.indirectCount ?? 0}</strong><span>Indirect dependencies</span></div>
        <div><strong>{impact?.totalCount ?? 0}</strong><span>Items in this view's radius</span></div>
      </div>

      <div className="dt-judge-work-panel">
        <div className="dt-judge-work-header">
          <div><span>BLAST RADIUS EXPLORER</span><h3>Which work is connected to each decision?</h3></div>
          <div className="dt-judge-switch">
            <button className={selectedDecisionId === oldDecision.id ? 'active' : ''} onClick={() => setSelectedDecisionId(oldDecision.id)}>Old decision</button>
            <button className={selectedDecisionId === currentDecision.id ? 'active' : ''} onClick={() => setSelectedDecisionId(currentDecision.id)}>Current decision</button>
          </div>
        </div>
        <div className="dt-judge-selected-label">Showing: <strong>{selectedDecision?.title}</strong></div>
        {impact?.affectedItems?.length ? (
          <div className="dt-judge-issues">
            {impact.affectedItems.map((item) => {
              const source = workByKey.get(item.key);
              const link = linkByKey.get(item.key);
              const mixed = link?.relationship === 'mixed-or-ambiguous';
              return (
                <article className="dt-judge-issue" key={item.key}>
                  <div className="dt-judge-issue-depth">{item.depth === 0 ? 'DIRECT' : `INDIRECT · HOP ${item.depth}`}</div>
                  <div className="dt-judge-issue-body">
                    <div className="dt-judge-issue-title"><strong>{item.key}</strong><span className={`dt-judge-risk ${item.severity}`}>{item.severity.toUpperCase()}</span></div>
                    <h4>{item.summary}</h4>
                    <p>{source?.description || 'No description available.'}</p>
                    {item.path?.length > 1 && <small className="dt-judge-path">Dependency path: {item.path.join(' → ')}</small>}
                    {item.matchedClaims?.length > 0 && (
                      <div className="dt-judge-matched-claims">{item.matchedClaims.map((claim) => <span key={`${claim.kind}-${claim.text}`} className={claim.kind.toLowerCase()}>{claim.kind} · {claim.text}</span>)}</div>
                    )}
                    {mixed && <div className="dt-judge-human-review">Mixed mention: inspect whether this is remediation or continued implementation. Not automatically classified as a violation.</div>}
                    {link?.evidence?.map((evidence, index) => <blockquote key={`${item.key}-${index}`}>Evidence from {evidence.sourceField}: “{evidence.excerpt}”</blockquote>)}
                  </div>
                  <div className="dt-judge-issue-status">{item.status || source?.status || 'Status unknown'}</div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="dt-judge-empty">No work matched this seeded decision in the scenario.</div>
        )}
      </div>

      <div className="dt-judge-proof-grid">
        <article><span>WHAT THE ENGINE PROVES</span><h3>It connects the reversal to work.</h3><p>The newer decision explicitly supersedes the older one. Phrase matches identify direct work; Jira-style links expand the blast radius to indirect dependencies.</p></article>
        <article><span>WHAT STILL NEEDS A PERSON</span><h3>A mention is not a verdict.</h3><p>“Remove Vendor A” may be a remediation task. DecisionTrace exposes its evidence and routes ambiguous context for human inspection instead of calling it a confirmed violation.</p></article>
      </div>
    </section>
  );
}

export default JudgeMode;