import { describe, expect, it } from 'vitest';
import { resolveDecisionLifecycle } from '../src/decision-lifecycle.js';

describe('shared decision lifecycle precedence', () => {
  it('treats an active source with a current human approval as authoritative', () => {
    expect(resolveDecisionLifecycle({ declaredStatus: 'active', reviewStatus: 'approved' }))
      .toMatchObject({ status: 'active', approvalState: 'approved', authoritative: true });
  });

  it('never promotes a rejected decision because its page says Active', () => {
    expect(resolveDecisionLifecycle({ declaredStatus: 'Active', reviewStatus: 'rejected' }))
      .toMatchObject({ status: 'rejected', approvalState: 'rejected', authoritative: false, rejected: true });
  });

  it('gives superseded or retired source status precedence over approval', () => {
    for (const declaredStatus of ['superseded', 'retired', 'revoked', 'reversed']) {
      expect(resolveDecisionLifecycle({ declaredStatus, reviewStatus: 'approved' }))
        .toMatchObject({ status: 'superseded', authoritative: false, superseded: true });
    }
  });

  it('does not treat an unreviewed Active page as authoritative', () => {
    expect(resolveDecisionLifecycle({ declaredStatus: 'active', reviewStatus: 'needs-review' }))
      .toMatchObject({ status: 'proposed', approvalState: 'unverified', authoritative: false });
  });

  it('treats an approval on a still-proposed page as unverified, not authoritative', () => {
    expect(resolveDecisionLifecycle({ declaredStatus: 'proposed', reviewStatus: 'approved' }))
      .toMatchObject({ status: 'proposed', approvalState: 'unverified', authoritative: false });
  });

  it('uses derived supersession over an Active declaration', () => {
    expect(resolveDecisionLifecycle({ declaredStatus: 'active', derivedStatus: 'superseded', reviewStatus: 'approved' }))
      .toMatchObject({ status: 'superseded', authoritative: false, superseded: true });
  });
});
