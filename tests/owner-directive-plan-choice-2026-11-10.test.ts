/**
 * Owner directive (2026-11-10) — Setup Wizard is admin-only, and
 * signup leads to a one-time plan choice, not a Meta-app journey.
 *
 * D1 pins: the console sidebar renders the Setup Wizard item only
 * for admins (server-computed via the ADMIN_EMAILS gate in the
 * (main) layout); the /setup route 404s non-admins server-side
 * with the exact /admin mechanism (verified session + isAdminEmail
 * + notFound); other customer-facing /setup links (settings Meta
 * app section, dashboard System-card button) are admin-gated too.
 *
 * D2 pins: the getting-started checklist starts with "Choose your
 * plan"; the welcome-mode pricing page records the choice via
 * POST /api/billing/plan-choice, which stamps
 * plan_choice_made_at in app_metadata. The routing decision itself
 * is unit-tested below (needsPlanChoice / hasPlanState matrix).
 *
 * TASK F CORRECTION (2026-11-10, later the same day — owner:
 * "homepage hi gayab kar diya"): the dashboard-entry redirect
 * shipped under D2 also bounced the signed-in owner off the
 * homepage, and the middleware bounced signed-in users from /
 * to /dashboard. Both are gone. The picker is now reached ONLY
 * through the post-auth surfaces: /auth/callback (email links +
 * Google OAuth) and the login/signup forms asking GET
 * /api/billing/plan-choice — all resolving through
 * lib/billing/planChoiceServer. The dashboard renders for every
 * signed-in user and carries the choice as a checklist step +
 * dismissible banner. F-pins live in their own describes below.
 *
 * TASK F ADDENDUM (2026-11-10): the setup_required message from
 * GET /api/instagram/connect is role-aware — admins keep the
 * Setup Wizard pointer, customers get "Instagram cannot connect
 * yet — the platform setup is not complete." (the settings-page
 * copy), because the account switcher renders the API message
 * verbatim and the wizard is admin-only.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  hasPlanState,
  needsPlanChoice,
  planChoiceMadeAt,
  PLAN_CHOICE_MADE_AT_KEY,
} from '@/lib/billing/planChoice';

const SRC = path.resolve(process.cwd(), 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

// ── Routing decision matrix ─────────────────────────────────────

describe('plan choice — routing decision (2026-11-10)', () => {
  const freeDefault = { planId: 'free', status: 'free', trialEndsAt: null };

  it('no subscription row + no marker → route to the picker', () => {
    expect(needsPlanChoice(null, false)).toBe(true);
  });

  it('the bare free default row is NOT plan state → route', () => {
    expect(hasPlanState(freeDefault)).toBe(false);
    expect(needsPlanChoice(freeDefault, false)).toBe(true);
  });

  it('marker set → never route, whatever the subscription says', () => {
    expect(needsPlanChoice(null, true)).toBe(false);
    expect(needsPlanChoice(freeDefault, true)).toBe(false);
  });

  it('an active paid subscription is plan state → no route', () => {
    expect(needsPlanChoice({ planId: 'starter', status: 'active', trialEndsAt: null }, false)).toBe(false);
  });

  it('a live trial is plan state → no route', () => {
    expect(
      needsPlanChoice({ planId: 'creator-pro', status: 'trialing', trialEndsAt: '2026-11-25T00:00:00Z' }, false),
    ).toBe(false);
  });

  it('a past trial (trialEndsAt set) is plan state → no route', () => {
    expect(hasPlanState({ planId: 'starter', status: 'expired', trialEndsAt: '2026-11-01T00:00:00Z' })).toBe(true);
    expect(needsPlanChoice({ planId: 'free', status: 'free', trialEndsAt: '2026-11-01T00:00:00Z' }, false)).toBe(false);
  });

  it('the marker reads only a non-empty string under its key', () => {
    expect(planChoiceMadeAt({ [PLAN_CHOICE_MADE_AT_KEY]: '2026-11-10T00:00:00Z' })).toBe('2026-11-10T00:00:00Z');
    expect(planChoiceMadeAt({ [PLAN_CHOICE_MADE_AT_KEY]: '' })).toBeNull();
    expect(planChoiceMadeAt({})).toBeNull();
    expect(planChoiceMadeAt(null)).toBeNull();
    expect(planChoiceMadeAt('nope')).toBeNull();
  });
});

// ── D1 — Setup Wizard admin-only ────────────────────────────────

describe('setup wizard — admin-only (2026-11-10)', () => {
  it('the /setup route is a server gate: verified session + ADMIN_EMAILS + notFound', () => {
    const page = read('app/(main)/setup/page.tsx');
    expect(page).toContain('isAdminEmail');
    expect(page).toContain('notFound()');
    expect(page).toContain('getUser()');
    expect(page).toContain('<SetupWizard />');
    // the wizard UI itself moved out of the route file
    expect(page).not.toContain('Save credentials');
  });

  it('the wizard UI lives in components/setup/SetupWizard.tsx', () => {
    const wizard = read('components/setup/SetupWizard.tsx');
    expect(wizard).toContain('export default function SetupWizard()');
    expect(wizard).toContain('Setup Wizard');
  });

  it('the sidebar hides the Setup Wizard item unless isAdmin', () => {
    const sidebar = read('components/dashboard/Sidebar.tsx');
    expect(sidebar).toContain('item.href !== "/setup"');
    expect(sidebar).toContain('isAdmin = false');
  });

  it('the (main) layout computes adminship server-side via the /admin gate', () => {
    const layout = read('app/(main)/layout.tsx');
    expect(layout).toContain('isAdminEmail(userEmail, process.env)');
    expect(layout).toContain('isAdmin={isAdmin}');
  });

  it('the dashboard System-card Setup Wizard button is admin-gated', () => {
    const dash = read('components/dashboard/DashboardClient.tsx');
    expect(dash).toContain('isAdmin && !setupLoading && !setup?.configured');
  });

  it('the settings Meta app section renders for admins only', () => {
    const settings = read('app/(main)/settings/page.tsx');
    expect(settings).toContain('{setup?.isAdmin && (');
    // and the setup_required error no longer sends customers to the wizard
    expect(settings).toContain('Instagram cannot connect yet');
    expect(settings).toContain('setup?.isAdmin');
  });

  it('the setup status API reports the caller-admin boolean (never the allowlist)', () => {
    const route = read('app/api/setup/route.ts');
    expect(route).toContain('isAdmin: isAdminEmail(user.email, process.env)');
    expect(read('hooks/useSetup.ts')).toContain('isAdmin?: boolean');
  });
});

// ── D2 — plan-picker routing + checklist ────────────────────────

describe('plan picker — routing + checklist (2026-11-10)', () => {
  it('the dashboard route wrapper renders for everyone — NO redirect (Task F, 2026-11-10)', () => {
    const page = read('app/(main)/dashboard/page.tsx');
    // The D2 redirect is gone: the wrapper only computes flags.
    expect(page).not.toContain('redirect(');
    expect(page).not.toContain('needsPlanChoice');
    expect(page).not.toContain('next/navigation');
    expect(page).toContain('planChoiceMadeAt');
    expect(page).toContain('hasPlanState');
    expect(page).toContain('<DashboardClient');
    expect(page).toContain('isAdmin={isAdmin}');
    expect(page).toContain('planChoiceDone={planChoiceDone}');
  });

  it('the dashboard carries the choice as a dismissible banner, not a gate (Task F)', () => {
    const dash = read('components/dashboard/DashboardClient.tsx');
    expect(dash).toContain('data-testid="plan-choice-banner"');
    expect(dash).toContain('planBannerDismissed');
    expect(dash).toContain('setPlanBannerDismissed(true)');
    expect(dash).toContain('href="/pricing"');
  });

  it('the checklist starts with Choose your plan → /pricing', () => {
    const dash = read('components/dashboard/DashboardClient.tsx');
    expect(dash).toContain('{ label: "Choose your plan", done: planChoiceDone || billingPlanChosen, href: "/pricing" }');
    expect(dash).toContain('{ label: "Connect your Instagram account", done: !!connectedAccount, href: "/settings" }');
    expect(dash).toContain('{ label: "Create your first automation", done: (automations?.length ?? 0) > 0, href: "/automations" }');
    expect(dash).toContain('{ label: "Activate it", done: activeCount > 0, href: "/automations" }');
    // no checklist step sends a customer to the wizard anymore
    expect(dash).not.toContain('href: "/setup" },');
  });

  it('welcome-mode pricing renders the plan-choice banner + Free as a choice', () => {
    const pricing = read('components/pricing/PricingClient.tsx');
    expect(pricing).toContain('data-testid="plan-picker-banner"');
    expect(pricing).toContain('Choose your plan');
    expect(pricing).toContain('Continue with Free');
    expect(pricing).toContain('recordPlanChoiceAndGoToDashboard');
    expect(pricing).toContain('fetch("/api/billing/plan-choice", { method: "POST" })');
    // non-welcome signed-in Free stays the honest "Current plan" marker
    expect(pricing).toContain('Current plan');
  });

  it('the pricing server page passes welcome from ?welcome=1', () => {
    const page = read('app/(saas)/pricing/page.tsx');
    expect(page).toContain('params.welcome === "1"');
    expect(page).toContain('welcome={welcome}');
  });
});

// ── Plan-choice recording route ─────────────────────────────────

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));
// Task F (2026-11-10): the post-auth resolver's data sources and
// the connect route's settings source, mocked for the behavioural
// describes at the bottom of this file.
vi.mock('@/lib/billing/access', () => ({ resolveBillingWorkspace: vi.fn() }));
vi.mock('@/lib/billing/persistence', () => ({ getWorkspaceSubscription: vi.fn() }));
vi.mock('@/lib/settings', () => ({ getMetaSettings: vi.fn(async () => null) }));

import { POST } from '@/app/api/billing/plan-choice/route';
import { getAuthenticatedUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';

const mockAuth = vi.mocked(getAuthenticatedUser);
const mockService = vi.mocked(createServiceClient);

describe('POST /api/billing/plan-choice (2026-11-10)', () => {
  const updates: { id: string; attrs: unknown }[] = [];
  let existingMeta: Record<string, unknown> = {};

  beforeEach(() => {
    updates.length = 0;
    existingMeta = { other_key: 'keep-me' };
    mockAuth.mockResolvedValue({ id: 'user-1', email: 'new@example.com' });
    mockService.mockReturnValue({
      auth: {
        admin: {
          getUserById: vi.fn(async () => ({
            data: { user: { id: 'user-1', app_metadata: existingMeta } },
            error: null,
          })),
          updateUserById: vi.fn(async (id: string, attrs: unknown) => {
            updates.push({ id, attrs });
            return { data: {}, error: null };
          }),
        },
      },
    } as never);
  });

  it('401s without a session', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(new Request('https://opendm.in/api/billing/plan-choice', { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(updates).toHaveLength(0);
  });

  it('stamps plan_choice_made_at, merging existing app_metadata', async () => {
    const res = await POST(new Request('https://opendm.in/api/billing/plan-choice', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    const attrs = updates[0]!.attrs as { app_metadata: Record<string, unknown> };
    expect(attrs.app_metadata['other_key']).toBe('keep-me');
    expect(typeof attrs.app_metadata[PLAN_CHOICE_MADE_AT_KEY]).toBe('string');
  });

  it('is idempotent when the marker already exists', async () => {
    existingMeta = { [PLAN_CHOICE_MADE_AT_KEY]: '2026-11-10T00:00:00Z' };
    const res = await POST(new Request('https://opendm.in/api/billing/plan-choice', { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alreadyRecorded?: boolean };
    expect(body.alreadyRecorded).toBe(true);
    expect(updates).toHaveLength(0);
  });
});

// ── Task F — entry flow (2026-11-10) ────────────────────────────

describe('Task F — homepage never bounces (2026-11-10)', () => {
  it('middleware has NO signed-in redirect away from /', () => {
    const mw = read('middleware.ts');
    expect(mw).not.toContain("pathname === '/'");
    expect(mw).not.toContain('pathname === "/"');
    // the protected-route and /login rules are untouched
    expect(mw).toContain("pathname === '/login' && user");
    expect(mw).toContain('isProtectedRoute');
  });

  it('the landing page itself performs no auth redirect', () => {
    const page = read('app/page.tsx');
    expect(page).not.toContain('redirect(');
    // F4: signed-out primary CTAs land on the login page
    expect(page).toContain('href="/login"');
    expect(page).not.toContain('href="/get-started"');
  });
});

describe('Task F — post-auth routing surfaces (2026-11-10)', () => {
  it('the auth callback resolves its destination via planChoiceServer', () => {
    const cb = read('app/auth/callback/route.ts');
    expect(cb).toContain("from '@/lib/billing/planChoiceServer'");
    expect(cb).toContain('resolvePostAuthDestination');
    expect(cb).toContain('exchangedUser.app_metadata');
    // the identity gate still runs BEFORE any destination is used
    expect(cb.indexOf('isIdentityAllowed')).toBeLessThan(cb.indexOf('resolvePostAuthDestination'));
  });

  it('GET /api/billing/plan-choice answers the destination for the forms', () => {
    const route = read('app/api/billing/plan-choice/route.ts');
    expect(route).toContain('export async function GET');
    expect(route).toContain('resolvePostAuthDestination');
    expect(route).toContain('needsPlanChoice: destination === PLAN_PICKER_DESTINATION');
  });

  it('the login form navigates to the resolved destination, not a hard-coded /dashboard', () => {
    const form = read('components/auth/LoginForm.tsx');
    expect(form).toContain('fetchPostAuthDestination');
    expect(form).toContain('window.location.href = await fetchPostAuthDestination()');
    expect(form).not.toContain('window.location.href = "/dashboard"');
  });

  it('the signup form (immediate-session path) uses the same destination', () => {
    const form = read('components/auth/SignupForm.tsx');
    expect(form).toContain('fetchPostAuthDestination');
    expect(form).toContain('window.location.href = await fetchPostAuthDestination()');
  });
});

describe('Task F — Google sign-in (2026-11-10)', () => {
  it('the login form offers Continue with Google via Supabase OAuth → /auth/callback', () => {
    const form = read('components/auth/LoginForm.tsx');
    expect(form).toContain('Continue with Google');
    expect(form).toContain('signInWithOAuth');
    expect(form).toContain('provider: "google"');
    expect(form).toContain('/auth/callback');
    // the G mark is an inline SVG — no external image, no emoji
    expect(form).toContain('<svg viewBox="0 0 24 24"');
    expect(form).toContain('GoogleMark');
    // divider between the OAuth button and the email form
    expect(form).toContain('>or</span>');
  });
});

// ── Task F — the resolver itself (behavioural) ──────────────────

import {
  PLAN_PICKER_DESTINATION,
  POST_AUTH_DESTINATION,
  resolvePostAuthDestination,
} from '@/lib/billing/planChoiceServer';
import { resolveBillingWorkspace } from '@/lib/billing/access';
import { getWorkspaceSubscription } from '@/lib/billing/persistence';

const mockResolveWs = vi.mocked(resolveBillingWorkspace);
const mockGetSub = vi.mocked(getWorkspaceSubscription);

describe('resolvePostAuthDestination (Task F, 2026-11-10)', () => {
  beforeEach(() => {
    mockResolveWs.mockReset();
    mockGetSub.mockReset();
    mockService.mockReturnValue({
      auth: {
        admin: {
          getUserById: vi.fn(async () => ({
            data: { user: { id: 'user-1', app_metadata: {} } },
            error: null,
          })),
        },
      },
    } as never);
    mockResolveWs.mockResolvedValue({ ok: true, ctx: { workspaceId: 'ws-1' } } as never);
    mockGetSub.mockResolvedValue(null as never);
  });

  it('marker already recorded → dashboard, subscription never consulted', async () => {
    const dest = await resolvePostAuthDestination({
      id: 'user-1',
      appMetadata: { [PLAN_CHOICE_MADE_AT_KEY]: '2026-11-10T00:00:00Z' },
    });
    expect(dest).toBe(POST_AUTH_DESTINATION);
    expect(mockResolveWs).not.toHaveBeenCalled();
  });

  it('no marker + no subscription row → the plan picker', async () => {
    const dest = await resolvePostAuthDestination({ id: 'user-1', appMetadata: {} });
    expect(dest).toBe(PLAN_PICKER_DESTINATION);
  });

  it('no marker + only the bare free default row → the plan picker', async () => {
    mockGetSub.mockResolvedValue({ planId: 'free', status: 'free', trialEndsAt: null } as never);
    const dest = await resolvePostAuthDestination({ id: 'user-1', appMetadata: {} });
    expect(dest).toBe(PLAN_PICKER_DESTINATION);
  });

  it('no marker + a real subscription → dashboard', async () => {
    mockGetSub.mockResolvedValue({ planId: 'starter', status: 'active', trialEndsAt: null } as never);
    const dest = await resolvePostAuthDestination({ id: 'user-1', appMetadata: {} });
    expect(dest).toBe(POST_AUTH_DESTINATION);
  });

  it('no marker + a past trial → dashboard (a trial is a made choice)', async () => {
    mockGetSub.mockResolvedValue({ planId: 'free', status: 'free', trialEndsAt: '2026-11-01T00:00:00Z' } as never);
    const dest = await resolvePostAuthDestination({ id: 'user-1', appMetadata: {} });
    expect(dest).toBe(POST_AUTH_DESTINATION);
  });

  it('no resolvable workspace → fail open to dashboard', async () => {
    mockResolveWs.mockResolvedValue({ ok: false } as never);
    const dest = await resolvePostAuthDestination({ id: 'user-1', appMetadata: {} });
    expect(dest).toBe(POST_AUTH_DESTINATION);
  });

  it('a resolution error → fail open to dashboard', async () => {
    mockResolveWs.mockRejectedValue(new Error('db down'));
    const dest = await resolvePostAuthDestination({ id: 'user-1', appMetadata: {} });
    expect(dest).toBe(POST_AUTH_DESTINATION);
  });

  it('metadata omitted → the marker is read from the server-side record', async () => {
    mockService.mockReturnValue({
      auth: {
        admin: {
          getUserById: vi.fn(async () => ({
            data: {
              user: {
                id: 'user-1',
                app_metadata: { [PLAN_CHOICE_MADE_AT_KEY]: '2026-11-10T00:00:00Z' },
              },
            },
            error: null,
          })),
        },
      },
    } as never);
    const dest = await resolvePostAuthDestination({ id: 'user-1' });
    expect(dest).toBe(POST_AUTH_DESTINATION);
    expect(mockResolveWs).not.toHaveBeenCalled();
  });
});

// ── Task F addendum — setup_required copy is role-aware ─────────

import { GET as connectGET } from '@/app/api/instagram/connect/route';

describe('instagram/connect setup_required message (Task F addendum, 2026-11-10)', () => {
  const savedAdminEmails = process.env['ADMIN_EMAILS'];

  beforeEach(() => {
    process.env['ADMIN_EMAILS'] = 'boss@example.com';
  });

  it('admins keep the Setup Wizard pointer', async () => {
    mockAuth.mockResolvedValue({ id: 'admin-1', email: 'boss@example.com' });
    const res = await connectGET(new Request('https://opendm.in/api/instagram/connect'));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('setup_required');
    expect(body.message).toBe(
      'Complete the Setup Wizard (Meta App ID + Secret) before connecting Instagram.',
    );
    if (savedAdminEmails === undefined) delete process.env['ADMIN_EMAILS'];
    else process.env['ADMIN_EMAILS'] = savedAdminEmails;
  });

  it('customers get the platform-setup copy — never the wizard pointer', async () => {
    mockAuth.mockResolvedValue({ id: 'cust-1', email: 'customer@example.com' });
    const res = await connectGET(new Request('https://opendm.in/api/instagram/connect'));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('setup_required');
    expect(body.message).toBe('Instagram cannot connect yet — the platform setup is not complete.');
    expect(body.message).not.toContain('Setup Wizard');
    if (savedAdminEmails === undefined) delete process.env['ADMIN_EMAILS'];
    else process.env['ADMIN_EMAILS'] = savedAdminEmails;
  });

  it('the settings page keeps its verbatim customer copy for the callback banner', () => {
    const settings = read('app/(main)/settings/page.tsx');
    expect(settings).toContain('"Instagram cannot connect yet — the platform setup is not complete."');
  });
});
