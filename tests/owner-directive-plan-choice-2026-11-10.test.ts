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
 * D2 pins: the dashboard route is a server wrapper that redirects
 * a user with no plan state and no recorded choice ONCE to
 * /pricing?welcome=1; the getting-started checklist starts with
 * "Choose your plan"; the welcome-mode pricing page records the
 * choice via POST /api/billing/plan-choice, which stamps
 * plan_choice_made_at in app_metadata. The routing decision itself
 * is unit-tested below (needsPlanChoice / hasPlanState matrix).
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
  it('the dashboard route wrapper redirects once to the picker', () => {
    const page = read('app/(main)/dashboard/page.tsx');
    expect(page).toContain('redirect("/pricing?welcome=1")');
    expect(page).toContain('needsPlanChoice');
    expect(page).toContain('planChoiceMadeAt');
    expect(page).toContain('<DashboardClient');
    expect(page).toContain('isAdmin={isAdmin}');
    expect(page).toContain('planChoiceDone={planChoiceDone}');
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
