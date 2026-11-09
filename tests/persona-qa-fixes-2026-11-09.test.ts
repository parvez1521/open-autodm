/**
 * Persona-QA fixes (2026-11-09) — source pins for the 10 defects
 * the 10-persona QA run confirmed (report:
 * ~/workspace/opendm-persona-qa-2026-11-09/REPORT.md). Source-level
 * pins, the repo's established pattern for UI fixes.
 *
 *  1  Invite/role-change errors surface the server's plan-limit
 *     message (PLAN_LIMIT_REACHED) instead of a blanket
 *     "Permission denied" mapping for every 403.
 *  2  Billing recent orders are workspace-scoped end to end:
 *     the status route re-filters to the resolved workspace and
 *     the panel refuses to render a payload naming another
 *     workspace than the one requested.
 *  3  The Cashfree "payment window open" dismiss bar floats fixed
 *     at the viewport bottom with the maximum z-index, above the
 *     payment SDK's modal layer.
 *  4  Members (/settings/workspace) is a first-class entry in the
 *     console sidebar.
 *  5  Billing is a first-class entry in the console sidebar (it
 *     had NO console nav entry at all — the "intermittently
 *     missing" link existed only in the marketing shell).
 *  6  The internal catalogue-attribution line no longer renders
 *     on the public pricing page; the conditional checkout-honesty
 *     sentence (renders only while checkout is closed) remains.
 *  7  (a) The dashboard plan card shows the period end / trial
 *     end / lapse date. (b) The billing panel offers the free
 *     trial only to genuinely free, never-subscribed workspaces.
 *  8  The billing panel's Enterprise card shows "Custom" for
 *     account/seat/volume limits (matching /pricing), not the
 *     catalogue's numeric ceilings.
 *  9  WorkspaceMembers resets its form/feedback state when the
 *     active workspace changes (no cross-workspace leak).
 * 10  Invite link has a Copy button; pending invitations ride
 *     the members read and render in the members UI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function readSrc(rel: string): string {
  return readFileSync(path.join(process.cwd(), 'src', rel), 'utf8');
}

const members = readSrc('components/workspace/WorkspaceMembers.tsx');
const billingPanel = readSrc('components/billing/BillingPanel.tsx');
const sidebar = readSrc('components/dashboard/Sidebar.tsx');
const pricing = readSrc('components/pricing/PricingClient.tsx');

describe('PQ-1 — plan-limit refusals surface the server message', () => {
  it('routes invite + role-change errors through the code-aware helper', () => {
    expect(members).toContain('PLAN_LIMIT_REACHED');
    expect(members).toContain('actionErrorMessage');
    // The permission strings survive — but only as the fallback
    // for genuine permission failures (p18 pins assert their
    // presence; PQ-1 pins their demotion from blanket mapping).
    expect(members).toContain('Permission denied: only workspace owners and admins can invite members.');
    expect(members).toContain('Permission denied: only workspace owners and admins can change roles.');
    expect(members).not.toContain('err.status === 403) {\n                setError("Permission denied');
  });

  it('ApiError carries the machine-readable failure code', () => {
    const client = readSrc('lib/api/client.ts');
    expect(client).toContain('code?: string');
  });
});

describe('PQ-2 — recent orders cannot cross workspaces', () => {
  it('the status route re-filters orders to the resolved workspace', () => {
    const route = readSrc('app/api/billing/status/route.ts');
    expect(route).toContain('o.workspaceId === ctx.workspaceId');
  });

  it('the panel refuses a payload naming a different workspace', () => {
    expect(billingPanel).toContain('data.workspaceId !== wsId');
    expect(billingPanel).toContain('Could not load billing for the selected workspace');
  });
});

describe('PQ-3 — the payment-window dismiss bar floats above the modal', () => {
  it('renders fixed with the maximum z-index', () => {
    const bar = billingPanel.slice(billingPanel.indexOf('billing-cashfree-open') - 600, billingPanel.indexOf('billing-cashfree-open'));
    expect(bar).toContain('fixed');
    expect(bar).toContain('z-[2147483647]');
    expect(bar).toContain('bottom-4');
  });
});

describe('PQ-4/5 — Members and Billing are console sidebar entries', () => {
  it('NAV carries both destinations', () => {
    expect(sidebar).toContain('{ name: "Members", href: "/settings/workspace", icon: Users, external: false }');
    expect(sidebar).toContain('{ name: "Billing", href: "/billing", icon: Receipt, external: false }');
  });

  it('the Settings prefix does not double-light on the members page', () => {
    expect(sidebar).toContain('pathname.startsWith("/settings/workspace")');
  });

  it('Receipt is exported through the phosphor client wrapper', () => {
    expect(readSrc('components/phosphor.tsx')).toContain('Receipt,');
  });
});

describe('PQ-6 — the internal catalogue line is off the public pricing page', () => {
  it('no catalogue attribution renders', () => {
    expect(pricing).not.toContain('Catalogue status');
    expect(pricing).not.toContain('these prices were set by the');
    expect(pricing).not.toContain('The hosted service itself is in preparation');
    expect(pricing).not.toContain('CATALOGUE_STATUS');
  });

  it('the conditional checkout-honesty sentence remains', () => {
    expect(pricing).toContain('Checkout is being switched on');
    expect(pricing).toContain('checkoutLive');
  });
});

describe('PQ-7 — plan dates on the dashboard; trial offered only to the never-subscribed', () => {
  it('the dashboard plan card renders period/trial/lapse dates', () => {
    // 2026-11-10: dashboard UI moved to components/dashboard/DashboardClient.tsx (route page = server wrapper).
    const dash = readSrc('components/dashboard/DashboardClient.tsx');
    expect(dash).toContain('Current period ends ${formatPlanDate(');
    expect(dash).toContain('day(s) left, ends ${formatPlanDate(billingStatus.trial.endsAt)}');
    expect(dash).toContain('Subscription ended on ${formatPlanDate(');
  });

  it('the billing hook type carries the trial end date', () => {
    expect(readSrc('hooks/useBillingStatus.ts')).toContain('endsAt: string | null');
  });

  it('the trial CTA keys off trialOffered, not merely not-active', () => {
    expect(billingPanel).toContain('const trialOffered = !paidActive && !trialing && !hasPaidSubscriptionHistory && !status.trial.lapsed;');
    expect(billingPanel).toContain('{trialOffered && (');
    expect(billingPanel).not.toContain('{!paidActive && (\n                        <button\n                          type="button"\n                          disabled={!status.canManageBilling || busyPlan !== null}\n                          onClick={() => void startTrial(plan)}');
  });
});

describe('PQ-8 — Enterprise limits read "Custom" in billing', () => {
  it('the plan-card limits line branches on customPricing', () => {
    expect(billingPanel).toContain('Custom accounts, seats and volumes');
    expect(billingPanel).toContain('plan.customPricing ? (');
  });
});

describe('PQ-9 — workspace settings form state resets on workspace switch', () => {
  it('an effect keyed on the selected workspace clears form + feedback state', () => {
    expect(members).toContain('}, [selectedWorkspaceId]);');
    const reset = members.slice(members.indexOf('Persona-QA fix 9'), members.indexOf('if (!workspaceRuntimeEnabled) return null;'));
    expect(reset).toContain('setInviteResult(null)');
    expect(reset).toContain('setNewWorkspaceName("")');
    expect(reset).toContain('setError(null)');
    expect(reset).toContain('setNotice(null)');
  });
});

describe('PQ-10 — copyable invite link and visible pending invitations', () => {
  it('the invite result carries a Copy button with a Copied state', () => {
    expect(members).toContain('handleCopyInviteLink');
    expect(members).toContain('navigator.clipboard.writeText(inviteResult.acceptLink)');
    expect(members).toContain('aria-label="Copy invite link"');
    expect(members).toContain('workspace-pending-invites');
  });

  it('the members read returns pending invitations', () => {
    const route = readSrc('app/api/workspaces/[workspaceId]/members/route.ts');
    expect(route).toContain('pendingInvitations');
    expect(route).toContain("from('workspace_invitations')");
    expect(route).toContain(".is('accepted_at', null)");
  });

  it('a successful invite refreshes the lists so the pending invite appears', () => {
    const invite = members.slice(members.indexOf('const handleInvite'), members.indexOf('const handleCopyInviteLink'));
    expect(invite).toContain('await loadMembers()');
  });
});
