/**
 * Customer-journey fixes (2026-11-09) — item E behavioural test plus
 * source pins for the UI-layer items (the suite is node-only, no DOM;
 * component fixes are pinned at source level, the repo's established
 * pattern for UI work — see audit-fixes.test.ts).
 *
 *  E  /api/script-writer now runs behind the shared per-user rate
 *     limiter: the 11th rapid request from one user is refused 429
 *     while a different user is unaffected.
 *  F  Automation editor: no-account blocker banner + disabled Save,
 *     full-width mutation error bar (never a silent failure).
 *  G  /analytics settles: error state with Retry + honest empty
 *     state; the spinner is gated on isLoading only. (Later
 *     2026-11-09: the read now rides the workspace request scope
 *     and the page distinguishes no-workspace / resolving / error —
 *     see the dated pins in describe G.)
 *  H  Dashboard reads the same /api/billing/status resolution as
 *     /billing (useBillingStatus) and ALWAYS renders the plan card.
 *  I  BillingPanel: inline phone error at the field; dismissible
 *     Cashfree-open escape hatch clears the busy state.
 *  J  Admin subpages gate with notFound() (404), never a 200
 *     "Access denied" body.
 *  L  Privacy policy states the SaaS reality (public signup,
 *     Cashfree) and no longer claims registration is disabled.
 *  M  No user-visible "prototype" wording remains on live surfaces;
 *     the landing AI line is provider-neutral.
 *  P  Motion fail-visible values: entrances start near-visible with
 *     short durations and no negative viewport margins.
 *  Q  WorkspaceProvider re-arms provisioning per empty episode.
 *  K  (source pin) the instagram callback never builds a debug=
 *     redirect parameter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const { mockGetAuthenticatedUser } = vi.hoisted(() => ({
  mockGetAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: (req: Request) => mockGetAuthenticatedUser(req),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST as scriptWriterPOST } from '@/app/api/script-writer/route';

function readSrc(rel: string): string {
  return readFileSync(path.join(process.cwd(), 'src', rel), 'utf8');
}

// ══ E — script-writer limiter ═══════════════════════════════════════════
describe('E — POST /api/script-writer is rate limited per user', () => {
  const VALID = {
    topic: 'how to grow on instagram',
    niche: 'Fitness',
    language: 'english',
    durationSeconds: 30,
    tone: 'bold',
    hookStyle: 'question',
    ctaKeyword: 'grow',
  };
  const req = () =>
    new Request('http://localhost/api/script-writer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID),
    });

  beforeEach(() => {
    mockGetAuthenticatedUser.mockReset();
    // No provider keys in the test env: requests that pass the
    // limiter reach the provider layer and degrade (never 429);
    // only the limiter itself answers 429.
    delete process.env['GROQ_API_KEY'];
    delete process.env['GROQ_API_KEY_2'];
    delete process.env['CLOUDFLARE_ACCOUNT_ID'];
    delete process.env['CLOUDFLARE_API_TOKEN'];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('the 11th rapid request from one user is 429 rate_limited; another user is unaffected', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ id: 'sw-user-1', email: 'a@example.test' });
    let lastStatus = 0;
    for (let i = 0; i < 10; i++) {
      const res = await scriptWriterPOST(req());
      expect(res.status).not.toBe(429);
    }
    const refused = await scriptWriterPOST(req());
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: string }).error).toBe('rate_limited');
    lastStatus = refused.status;
    expect(lastStatus).toBe(429);

    mockGetAuthenticatedUser.mockResolvedValue({ id: 'sw-user-2', email: 'b@example.test' });
    const other = await scriptWriterPOST(req());
    expect(other.status).not.toBe(429);
  });
});

// ══ Source pins ═════════════════════════════════════════════════════════
describe('F — automation editor never fails silently', () => {
  const src = readSrc('components/automations/new-flow/NewAutomationModal.tsx');
  it('renders a persistent no-account blocker and disables Save/Activate behind it', () => {
    expect(src).toContain('noAccountBlocker');
    expect(src).toContain('role="alert"');
    expect(src).toContain('bg-amber-500/10');
    expect(src).toContain('disabled={isPending || noAccountBlocker}');
    expect(src).toContain('/settings');
  });
  it('mutation errors render as a full-width alert bar, not a truncated header span', () => {
    expect(src).toContain('activateError');
    expect(src).not.toContain('max-w-[240px]');
  });
});

describe('G — /analytics always settles', () => {
  const src = readSrc('app/(main)/analytics/page.tsx');
  it('has an error state with retry and an honest empty state', () => {
    expect(src).toContain('isError');
    expect(src).toContain('refetch');
    expect(src).toContain('No activity in this range yet');
    // The lone-spinner-forever shape is gone: loading is its own branch.
    // (2026-11-09, workspace-scope fix: the branch gained the
    // provider-resolving condition — the pin follows the new shape.)
    // (2026-11-09, round-2 fix: the branch keys off isPending, not
    // isLoading — a scope-disabled query reports isLoading=false
    // with no data and no error, which the error branch could read
    // as a failure during first load. The pin follows the new
    // shape; see tests/customer-fixes-round2-2026-11-09.test.ts.)
    expect(src).toContain('isPending || (workspaceRuntimeEnabled && workspaceLoading) ? (');
  });

  // 2026-11-09 — the live bug behind this fix: with a workspace
  // selected, /analytics settled on "A workspace context is
  // required: no workspace was specified" because useAnalytics was
  // the last read still issuing a plain unscoped apiClient call —
  // the route (workspace mode) fails closed without the selector.
  it('the analytics read rides the shared workspace request scope, like its siblings', () => {
    const hook = readSrc('hooks/useAnalytics.ts');
    expect(hook).toContain('workspaceRequestScopeFromSelection');
    expect(hook).toContain('sendWorkspaceRequest<AnalyticsPayload>');
    expect(hook).toContain("enabled: requestScope.kind !== 'unavailable'");
    // The cache key names the workspace in workspace mode, so a
    // workspace switch can never render the previous one's numbers.
    expect(hook).toContain('requestScope.workspaceId');
    // The old unscoped transport is gone from the hook entirely
    // (no api/client import, no direct apiClient call).
    expect(hook).not.toContain("from '@/lib/api/client'");
    expect(hook).not.toContain('apiClient<AnalyticsPayload>');
  });

  it('the page keeps the three states distinct: no-workspace ≠ loading ≠ fetch error', () => {
    // No-workspace-at-all (provider loaded, list empty) has its own
    // panel and is checked BEFORE the loading/error branches.
    expect(src).toContain('noWorkspace');
    expect(src).toContain('No workspace yet');
    expect(src).toContain('/settings/workspace');
    expect(src.indexOf('noWorkspace ? (')).toBeLessThan(src.indexOf('isError || !data ? ('));
    // The genuine-failure error state survives untouched.
    expect(src).toContain('Analytics could not be loaded');
  });
});

describe('H — dashboard plan card reads billing status', () => {
  // 2026-11-10: dashboard UI moved to components/dashboard/DashboardClient.tsx (route page = server wrapper).
  const page = readSrc('components/dashboard/DashboardClient.tsx');
  const hook = readSrc('hooks/useBillingStatus.ts');
  it('the hook hits the same /api/billing/status endpoint as /billing', () => {
    expect(hook).toContain('/api/billing/status');
    expect(page).toContain('useBillingStatus');
  });
  it('the plan card always renders (testid present, Free included in the copy paths)', () => {
    expect(page).toContain('dashboard-plan-card');
    expect(page).toContain('Manage billing');
  });
});

describe('I — BillingPanel checkout UX', () => {
  const src = readSrc('components/billing/BillingPanel.tsx');
  it('phone validation is inline at the field', () => {
    expect(src).toContain('billing-phone-error');
    expect(src).toContain('setPhoneError');
  });
  it('the Cashfree-open state is dismissible and clears the busy plan', () => {
    expect(src).toContain('billing-cashfree-open');
    expect(src).toContain('setBusyPlan(null)');
  });
});

describe('J — admin subpages 404 on gate failure', () => {
  for (const page of ['subscriptions', 'payment-events', 'overrides']) {
    it(`/admin/${page} uses notFound()`, () => {
      const src = readSrc(`app/(admin)/admin/${page}/page.tsx`);
      expect(src).toContain('notFound()');
      expect(src).toContain('gate.allowed');
      expect(src).not.toContain('<AdminAccessDenied');
    });
  }
});

describe('K — callback source carries no debug= redirect (pin)', () => {
  it('route source builds no debug= redirect parameter', () => {
    const src = readSrc('app/api/instagram/callback/route.ts');
    expect(src).not.toContain('debug=${');
    expect(src).not.toContain('`&debug');
    expect(src).not.toContain("'&debug");
  });
});

describe('L — privacy policy matches the SaaS reality', () => {
  const src = readSrc('app/privacy-policy/page.tsx');
  it('no longer claims registration is disabled / owner-provisioned', () => {
    expect(src).not.toContain('Public self-registration is');
    expect(src).not.toContain('provisioned exclusively by the instance owner');
  });
  it('states public signup and names Cashfree as the payment processor', () => {
    expect(src).toContain('Anyone may register publicly');
    expect(src).toContain('Cashfree Payments');
    expect(src).toContain('Subscription &amp; Payment Data');
  });
});

describe('M — no user-visible prototype wording on live surfaces', () => {
  it('the SaaS layout carries no PROTOTYPE badge', () => {
    const src = readSrc('app/(saas)/layout.tsx');
    expect(src).not.toContain('SaaS PROTOTYPE');
    expect(src).not.toContain('PROTOTYPE');
  });
  it('pricing + onboarding headings are plain', () => {
    expect(readSrc('components/pricing/PricingClient.tsx')).not.toContain('Pricing (prototype)');
    expect(readSrc('app/(saas)/onboarding/page.tsx')).not.toContain('Get set up (prototype)');
  });
  it('the landing AI line is provider-neutral (no model-name claim)', () => {
    const src = readSrc('app/page.tsx');
    expect(src).not.toContain('Llama 3.3 70B on Cloudflare Workers');
    expect(src).toContain('free AI (Groq + Cloudflare Workers AI)');
  });
});

describe('P — motion entrances fail visible', () => {
  it('shared presets start near-visible with short durations', () => {
    const presets = readSrc('lib/motion/presets.ts');
    // Rise retimed 10px -> 12px on 2026-11-09 (owner directive
    // "Open Caption style adopt": entrances match the reference
    // fade-in-up, 0.45s cubic-bezier(0.16,1,0.3,1), 12px rise).
    expect(presets).toContain('hidden: { opacity: 0.3, y: 12 }');
    expect(presets).toContain('staggerChildren: 0.04');
    expect(presets).not.toContain('hidden: { opacity: 0, y: 24 }');
  });
  it('Reveal fires on first viewport contact from a near-visible start', () => {
    const reveal = readSrc('components/home/Reveal.tsx');
    expect(reveal).toContain('initial={{ opacity: 0.3, y }}');
    expect(reveal).toContain('margin: "0px"');
    expect(reveal).not.toContain('-8% 0px');
  });
  it('the ScrollMorph CSS start state is near-visible', () => {
    const css = readSrc('app/globals.css');
    expect(css).toContain('opacity: 0.3;');
    expect(css).toContain('translateY(12px) scale(0.94) rotate(-1.5deg)');
    expect(css).not.toContain('translateY(30px) scale(0.78) rotate(-5deg)');
  });
  it('the landing hero entrance cannot trap content', () => {
    // Superseded 2026-11-09 (owner directive: Open Caption style +
    // animation concepts adopt). The hero entrance is no longer
    // motion variants — it is the reference's pure-CSS [data-hero]
    // system, whose fail-visible guarantees are structural: the
    // animations are CSS (they run with or without hydration),
    // reduced-motion disables them outright, and coarse pointers
    // paint the sub/CTA copy immediately. The pins below stand in
    // for the old near-visible-variant pin.
    const page = readSrc('app/page.tsx');
    const css = readSrc('app/globals.css');
    expect(page).toContain('data-hero="word"');
    expect(page).toContain('data-hero="sub"');
    expect(css).toContain('@keyframes hero-up');
    expect(css).toContain('@media (pointer: coarse) { [data-hero="sub"], [data-hero="cta"] { animation: none; } }');
    expect(css).toContain('[data-hero] { animation: none !important; }');
  });
});

describe('Q — provisioning re-arms per empty episode', () => {
  it('WorkspaceProvider resets the attempt ref when a non-empty list is observed', () => {
    const src = readSrc('components/workspace/WorkspaceProvider.tsx');
    expect(src).toContain('provisionAttemptedRef.current = false');
    expect(src).toContain('EMPTY EPISODE');
  });
});

describe('N + O — forgot-password route and member rows', () => {
  it('the /forgot-password page renders the shared panel', () => {
    const page = readSrc('app/forgot-password/page.tsx');
    expect(page).toContain('ForgotPasswordPanel');
    const panel = readSrc('components/auth/ForgotPasswordPanel.tsx');
    expect(panel).toContain('ForgotPasswordForm');
  });
  it('member rows format the joined date and hide the raw user id', () => {
    const src = readSrc('components/workspace/WorkspaceMembers.tsx');
    expect(src).toContain('formatJoinedDate');
    expect(src).not.toContain('Member ID');
  });
});
