/**
 * Programme 17 / Workstream B — service-role audit pins.
 *
 * Two kinds of pins, both derived from the audit in
 * saas/phase17-work/B-service-role.md (grep truth, not the Phase 16
 * matrix):
 *
 *  1. SOURCE-SCAN CLASSIFICATION. Every file under src/ that imports
 *     `createServiceClient` must appear in CLASSIFIED below, with the
 *     guard tokens its audited ownership/auth check consists of. A new
 *     unclassified importer, or removal of a guard token, fails here —
 *     the service role bypasses RLS, so an unclassified importer is an
 *     unreviewed tenant boundary. Files whose guard is NOT per-user /
 *     per-workspace scoping sit in REVIEWED_EXCEPTIONS with the reason
 *     (platform singleton, Meta-signature credential, cron secret,
 *     internal helper behind already-validated callers).
 *
 *     NOTE (Finding B-F1 in the audit doc): ZERO product files import
 *     `src/lib/tenancy/scopedDb.ts` — the Phase D guards are the
 *     heterogeneous checks pinned here (legacy user_id scoping, payload
 *     workspace validation, Phase E pair checks), NOT scopedDb. The
 *     `no scopedDb imports` pin below records that fact so the coverage
 *     claim can never silently drift from the source in either
 *     direction; it is a documentation-integrity pin, not a claim that
 *     the current state is the finished multi-tenant design.
 *
 *  2. BEHAVIOURAL REGRESSION for the one defect fixed by this
 *     workstream: processWebhook's DM session-tap branch loaded
 *     `automation_sessions` by bare id (service role, no ownership
 *     check) and paired the foreign session's automation_id with the
 *     receiving account. A foreign-session tap must now enqueue
 *     nothing and leave the session row byte-identical; an own-session
 *     tap still routes exactly one follow-up job.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MetaWebhookBody } from '@/lib/types';

// ── Source-scan helpers ────────────────────────────────────────────────────

const SRC_ROOT = path.resolve(process.cwd(), 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return path.relative(SRC_ROOT, file).split(path.sep).join('/');
}

function sourceOf(relPath: string): string {
  return readFileSync(path.join(SRC_ROOT, relPath), 'utf8');
}

const IMPORTER_RE = /from\s+['"]@\/lib\/supabase\/service['"]/;

/** Files importing createServiceClient, relative to src/. */
function serviceImporters(): string[] {
  return walk(SRC_ROOT)
    .filter((f) => IMPORTER_RE.test(readFileSync(f, 'utf8')))
    .map(rel)
    .sort();
}

// ── Classification ─────────────────────────────────────────────────────────

type GuardKind =
  | 'user-session+owner-check'
  | 'cron-secret'
  | 'webhook-hmac'
  | 'oauth-state'
  | 'meta-signature'
  | 'code-as-credential'
  | 'platform-singleton'
  | 'entitlement-gate'
  | 'internal-helper';

interface Classified {
  kind: GuardKind;
  /** Substrings that must be present — the audited guard, in source. */
  tokens: string[];
  /** Required for every non user-session kind: why this is acceptable. */
  exceptionReason?: string;
}

const CLASSIFIED: Record<string, Classified> = {
  // — User routes: session auth + legacy user_id ownership on every query —
  'app/api/activity/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ["eq('user_id', user.id)", 'ownedAccountIds.includes(requestedAccountId)'],
  },
  'app/api/ai/generate/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ['isInstanceOwner(user)', "eq('user_id', userId)"],
  },
  'app/api/analytics/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ["eq('user_id', user.id)", 'ownedIds.includes(requestedAccountId)'],
  },
  'app/api/automations/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ["eq('user_id', user.id)"],
  },
  'app/api/automations/[id]/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ["eq('user_id', user.id)"],
  },
  'app/api/contacts/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ["eq('user_id', user.id)", 'accountIds.includes(requestedAccountId)'],
  },
  'app/api/debug/events/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ["eq('user_id', user.id)"],
  },
  'app/api/instagram/accounts/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ["eq('user_id', user.id)"],
  },
  'app/api/instagram/disconnect/[accountId]/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ["eq('user_id', user.id)"],
  },
  'app/api/instagram/posts/[accountId]/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ["eq('user_id', user.id)", '${user.id}:${accountId}'],
  },
  'app/api/instagram/refresh/[accountId]/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ["eq('user_id', user.id)"],
  },
  'app/api/instagram/resubscribe/[accountId]/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ["eq('user_id', user.id)"],
  },
  'app/api/instagram/subscription-status/[accountId]/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ["eq('user_id', user.id)"],
  },
  'app/api/traffic-guard/pause/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ['account.user_id !== user.id', "eq('instagram_account_id', accountId)"],
  },
  'app/api/traffic-guard/resume/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ['account.user_id !== user.id', "eq('instagram_account_id', accountId)"],
  },
  'app/api/traffic-guard/status/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ['account.user_id !== user.id'],
  },
  'app/api/instagram/connect/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ['getAuthenticatedUser', 'resolveWorkspaceContext', "requireWorkspaceRole(ctx, ['owner', 'admin'])"],
  },
  // — Programme 18 Phase D/G additions (reconciled in Phase J): the
  // briefed traffic-guard dismiss route and the workspaces route tree —
  // session auth + fresh membership resolution (+ capability / RPC) —
  'app/api/traffic-guard/dismiss/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ['getAuthenticatedUser', 'resolveRouteWorkspaceContext', "requireCapability(resolved.ctx, 'write')"],
  },
  // Programme 19 (F-J1) reconciliation: the membership RPCs derive
  // their actor from auth.uid(), which is NULL under the service role,
  // so they now run through the user-JWT factory
  // (src/lib/supabase/userClient.ts). workspaces/accept/route.ts no
  // longer imports the service client at all and was therefore
  // removed from this classification (its RPC is pinned by
  // tests/p19-workspaces-rpc-auth.test.ts).
  // Programme 30 (AA-6) reconciliation (2026-11-07): the remaining
  // read-only service-client uses in the workspaces tree — the
  // workspaces GET list + name enrichment, the members GET context
  // resolution + member-list read, and the members/[userId]
  // context resolution — now ALSO run through the user-JWT factory
  // (RLS …000024 memberships_select_member / workspaces_select_member
  // permit exactly those reads for a member). All three files
  // (app/api/workspaces/route.ts,
  // app/api/workspaces/[workspaceId]/members/route.ts,
  // app/api/workspaces/[workspaceId]/members/[userId]/route.ts) no
  // longer import the service client at all and are removed from
  // this classification, exactly as the accept route was in P19;
  // their behaviour is pinned by tests/p18-workspaces-routes.test.ts,
  // tests/p19-workspaces-rpc-auth.test.ts (updated) and
  // tests/p30-aa6-user-scoped-reads.test.ts. The invitations route
  // below still uses the service client under its P18 context checks
  // and stays classified.
  'app/api/workspaces/[workspaceId]/invitations/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ['getAuthenticatedUser', 'resolveRouteWorkspaceContext(db, user.id, workspaceId)', "requireCapability(resolved.ctx, 'manageMembers')"],
  },
  // Customer-fix exception (2026-11-09): the accept route carries ONE
  // service client again — read-only, for the ENTITLEMENTS_ENFORCED
  // teamSeats gate that runs BEFORE the accept RPC. The gate's
  // invitation-by-token-hash lookup cannot run on the caller's user
  // client (the invitee is not yet a member; RLS
  // invitations_select_owner_admin limits invitation reads to the
  // workspace's owner/admins), and neither can the target workspace's
  // member count / subscription. The queries execute only inside the
  // gate's context thunk, so with the flag off the client is
  // constructed but never queried and the route behaves exactly as
  // P19 left it; the membership-writing RPC itself still runs through
  // the user-JWT factory (pinned in p19-workspaces-rpc-auth.test.ts).
  'app/api/workspaces/accept/route.ts': {
    kind: 'entitlement-gate',
    tokens: ['getAuthenticatedUser', 'evaluateEntitlementGate', 'hashInvitationToken(token)', 'createUserRpcClient(request, user.id)'],
    exceptionReason:
      'Flag-gated (ENTITLEMENTS_ENFORCED), read-only teamSeats check before the accept RPC: invitation-by-hash, member count and subscription of the target workspace are unreadable to the not-yet-member invitee under RLS, so the pre-check requires the service role. No service-role writes; the accept RPC runs on the user-JWT client.',
  },

  // — Reviewed exceptions: guard is not per-user scoping, by design —
  'app/api/cron/process-jobs/route.ts': {
    kind: 'cron-secret',
    tokens: ['safeCompare(provided, cronSecret)'],
    exceptionReason:
      'Platform maintenance job (queue drain, token refresh for ALL accounts, cleanup RPC). Header-only CRON_SECRET, fail-closed when unconfigured. No user tenant context exists by design.',
  },
  'app/api/webhook/route.ts': {
    kind: 'webhook-hmac',
    tokens: ['hmacSha256Hex', 'signatureValid'],
    exceptionReason:
      'Meta webhook ingress: HMAC-SHA256 over the raw body is verified before any DB work; tenant context is derived afterwards from the verified entry IGSID -> instagram_accounts row (see processWebhook).',
  },
  'app/api/instagram/callback/route.ts': {
    kind: 'oauth-state',
    tokens: ['verifyOAuthState', 'resolveWorkspaceContext', '!== userId'],
    exceptionReason:
      'OAuth callback: identity comes exclusively from the signed state JWT; pre-write ownership check rejects accounts owned by another user, and workspace states re-verify owner/admin membership and reject foreign-workspace bindings.',
  },
  'app/api/meta/data-deletion/route.ts': {
    kind: 'meta-signature',
    tokens: ['verifyMetaCallback'],
    exceptionReason:
      'Meta compliance callback: HMAC signed_request verified before any processing; all deletes in lib/meta/accountData.ts are keyed by the verified app-scoped ID (double-scoped for the account row). data_deletion_requests is platform-level per the Phase 16 matrix exclusion.',
  },
  'app/api/meta/deauthorize/route.ts': {
    kind: 'meta-signature',
    tokens: ['verifyMetaCallback'],
    exceptionReason: 'Same contract as the data-deletion callback (see above).',
  },
  'app/api/meta/data-deletion/status/route.ts': {
    kind: 'code-as-credential',
    tokens: ['findDeletionRequestByCode'],
    exceptionReason:
      "Meta's design: the random 16-char confirmation code is the only credential; lookup returns status fields only, for exactly that one request.",
  },
  'app/data-deletion/status/page.tsx': {
    kind: 'code-as-credential',
    tokens: ['findDeletionRequestByCode'],
    exceptionReason: 'Server-rendered twin of the status API above; same code-as-credential contract.',
  },
  'app/api/setup/route.ts': {
    kind: 'platform-singleton',
    tokens: ['getAuthenticatedUser', 'isInstanceOwner(user)'],
    exceptionReason:
      'Setup wizard for the deployment singleton (app_settings id=1): any authenticated user may complete FIRST setup; once completed, POST is owner-only and fail-closed when no owner is configured; the webhook verify token is redacted for non-owners.',
  },
  // Launch preparation (2026-11-07): the public waitlist is
  // platform-level by design — the addresses are not tenant data and
  // belong to no workspace. The waitlist_entries table grants NOTHING
  // to anon/authenticated and has no policies (migration …000034), so
  // this route is the only write path; its guards are strict email
  // validation/normalization and a per-IP rate limit, both pinned by
  // tests/waitlist.test.ts.
  'app/api/waitlist/route.ts': {
    kind: 'platform-singleton',
    tokens: ['normalizeWaitlistEmail', 'isRateLimited', 'from("waitlist_entries")'],
    exceptionReason:
      'Public landing-page waitlist insert (launch preparation, 2026-11-07): unauthenticated by design, but the table is platform-level (no tenant data), RLS grants anon/authenticated nothing, and this service-role route is the single write path behind email validation and a per-IP rate limit.',
  },
  'lib/settings.ts': {
    kind: 'platform-singleton',
    tokens: ["from('platform_config')", "from('app_settings')"],
    exceptionReason:
      'Platform Meta credentials (one Meta app per deployment) — explicitly excluded from workspace_id in the Phase 16 matrix. Read prefers platform_config, write stays on app_settings (gated cutover, documented in the audit; owned by the settings workstream).',
  },
  'lib/automation/queue.ts': {
    kind: 'internal-helper',
    tokens: ['claim_due_jobs', 'payload.workspaceId'],
    exceptionReason:
      'Internal queue primitives: job ids come from the claim_due_jobs RPC or from rows the engine just claimed; enqueue stamps workspace_id from the (already validated) payload. No external caller can supply an id.',
  },
  'lib/automation/contacts.ts': {
    kind: 'internal-helper',
    tokens: ['record_contact_interaction', 'p_account_id: params.instagramAccountId'],
    exceptionReason:
      'Fire-and-forget audience bookkeeping called only from engine paths whose instagramAccountId was resolved server-side from a verified webhook entry or a pair-validated job payload; the RPC keys strictly by that account id.',
  },
  'lib/automation/inboundRateLimit.ts': {
    kind: 'internal-helper',
    tokens: ['check_and_record_inbound_event', 'p_ig_account_id: input.igAccountId'],
    exceptionReason:
      'Admission limiter keyed ONLY on the HMAC-verified payload entry IGSID; stores counts/metadata in inbound_webhook_events, never tenant content. Fail-open on store error is a documented, deliberate design (verified ingestion continues; dedupe + outbound limiter still bound harm).',
  },
  'lib/trafficGuard/tracker.ts': {
    kind: 'internal-helper',
    tokens: ["eq('user_id', userId)", 'get_traffic_guard_status'],
    exceptionReason:
      'Engine/cron internals keyed by account id resolved from verified webhooks or cron iteration; the one user-facing mutation (markNotificationRead) filters by user_id, and its route plus the pause/resume/status routes verify account ownership before calling in.',
  },
  'lib/debugLog.ts': {
    kind: 'internal-helper',
    tokens: ['user_id: userId', 'workspace_id: workspaceId'],
    exceptionReason:
      'Write-only event sink: stamps user_id (and workspace_id when known) from caller context; rows with NULL user_id are hidden from every ordinary user by the debug route. Read/delete scoping lives in app/api/debug/events/route.ts.',
  },

  // — Background processors: workspace validation + pair checks (Phase D1/E) —
  'lib/automation/processWebhook.ts': {
    kind: 'internal-helper',
    tokens: [
      "eq('instagram_user_id', entry.id)",
      'session.instagram_account_id',
      'isRecipientSuppressed',
    ],
    exceptionReason:
      'Runs only on HMAC-verified payloads (route verifies first). Account is resolved from the verified entry IGSID; automations are fetched account-scoped; the session-tap branch verifies session.instagram_account_id against the receiving account (P17/B fix, behaviourally pinned below). Payloads are stamped with the account workspace binding.',
  },
  'lib/automation/processJob.ts': {
    kind: 'internal-helper',
    tokens: [
      'tenant_context_mismatch',
      'automation.instagram_account_id !== payload.instagramAccountId',
      'session.instagram_account_id !== payload.instagramAccountId',
    ],
    exceptionReason:
      'Queue-claimed jobs only: payload workspace is validated against the account binding (fail-closed skip), automation<->account and session<->payload pair checks run before any send (Phase E). NOTE: branch-ordering defects inside this file are pinned by tests/p17-processjob-reverify.test.ts (Workstream A) — see audit Findings B-F4/B-F5.',
  },
  'lib/automation/followUps.ts': {
    kind: 'internal-helper',
    tokens: ['resolveWorkspaceForAccount', "eq('status', 'scheduled')"],
    exceptionReason:
      'Follow-up rows are keyed by (automation_id, recipient_id, qualified_event_id); scheduling callers derive account+automation from verified/account-scoped flows, the cron sweep re-derives the workspace from the account binding, and the send path re-validates in processJob.',
  },

  // — SaaS billing routes (subscription wiring, 2026-11-08) —
  // Session auth first, then the workspace is resolved per request
  // through lib/billing/access.ts (routeContext membership check —
  // the selector is never proof) and mutations additionally require
  // the owner-only manageBilling capability. All billing reads/writes
  // are scoped by the resolved ctx.workspaceId.
  'app/api/billing/checkout/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ['getAuthenticatedUser(request)', 'resolveBillingWorkspace', 'billingManagerFailure(resolved.ctx)'],
  },
  'app/api/billing/trial/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ['getAuthenticatedUser(request)', 'resolveBillingWorkspace', 'billingManagerFailure(resolved.ctx)'],
  },
  'app/api/billing/status/route.ts': {
    kind: 'user-session+owner-check',
    tokens: ['getAuthenticatedUser(request)', 'resolveBillingWorkspace', 'hasCapability(ctx, "manageBilling")'],
  },
  'app/api/billing/webhook/route.ts': {
    kind: 'webhook-hmac',
    // ONE public webhook URL serves both providers (dispatch by
    // signature header). Razorpay (fallback, verifier below) — and,
    // per the owner's 2026-11-08 ~20:34 IST decision making Cashfree
    // the PRIMARY gateway, the Cashfree verifier call alongside it.
    // Cashfree signs `timestamp + rawBody` (plain concatenation) with
    // the CLIENT SECRET; both verifications are fail-closed over the
    // exact raw body and run before parsing.
    tokens: [
      'verifyRazorpayWebhookSignature(rawBody, signature, config.webhookSecret)',
      'verifyCashfreeWebhookSignature(rawBody, signature, clientSecret, timestamp)',
      'getBillingOrderByProviderOrderId',
      'processBillingWebhook',
    ],
    exceptionReason:
      'Public payment-provider webhook (Cashfree primary per owner decision 2026-11-08 ~20:34 IST; Razorpay fallback): the HMAC-SHA256 signature over the exact raw body is the credential (fail closed, verified before parsing). The workspace is resolved ONLY from the billing_orders row recorded at checkout (provider-scoped lookup) — never from payload claims — and the Phase 12 core re-verifies the order server-side with the provider before any entitlement write.',
  },

  // — Owner admin panel (2026-11-09) —
  // Platform-level by design: the panel reads EVERY workspace's
  // billing state, so no per-user/per-workspace scoping can apply.
  // Its guard is the server-side ADMIN_EMAILS allowlist checked
  // against the verified session email BEFORE the service client is
  // constructed; anyone else gets notFound() (404 — the panel's
  // existence is not revealed). Gate + data pinned by
  // tests/admin-panel.test.ts.
  'app/(admin)/admin/page.tsx': {
    kind: 'platform-singleton',
    tokens: ['isAdminEmail', 'notFound()', 'createServiceClient()'],
    exceptionReason:
      'Owner-only subscriber panel (2026-11-09): platform-level billing reads across all workspaces sit behind the server-side ADMIN_EMAILS allowlist (fail-closed when unset) evaluated against the verified session email, with a 404 for everyone else; the service client is built only after the gate passes.',
  },
};

const REVIEWED_EXCEPTIONS = Object.entries(CLASSIFIED)
  .filter(([, v]) => v.kind !== 'user-session+owner-check')
  .map(([k]) => k);

describe('P17/B source scan: service-role importer classification', () => {
  it('every createServiceClient importer under src/ is classified (no unreviewed tenant boundary)', () => {
    const importers = serviceImporters();
    const unclassified = importers.filter((f) => !(f in CLASSIFIED));
    expect(unclassified).toEqual([]);
  });

  it('the classification has no stale entries (every classified file still imports the factory)', () => {
    const importers = new Set(serviceImporters());
    const stale = Object.keys(CLASSIFIED).filter((f) => !importers.has(f));
    expect(stale).toEqual([]);
  });

  it('counts reconcile with the audit: 43 importing files, 87 executable call sites (P19: accept route declassified, workspaces POST service call removed; P30/AA-6: workspaces GET + members GET + members/[userId] declassified, 4 read call sites removed; launch prep 2026-11-07: waitlist route classified as a platform-singleton exception, +1 file, +1 call site; subscription wiring 2026-11-08: four billing routes classified — checkout/trial/status user-session+owner-check, webhook webhook-hmac — +4 files, +4 call sites; owner admin panel 2026-11-09: /admin page classified as a platform-singleton exception — +1 file, +1 call site; customer fixes 2026-11-09: accept route re-classified as an entitlement-gate exception (flag-gated read-only teamSeats check) — +1 file, +1 call site)', () => {
    const importers = serviceImporters();
    expect(importers.length).toBe(43);
    let calls = 0;
    for (const f of importers) {
      for (const line of sourceOf(f).split('\n')) {
        if (line.includes('import ')) continue;
        if (line.trimStart().startsWith('//')) continue;
        calls += (line.match(/createServiceClient\(\)/g) ?? []).length;
      }
    }
    // Excludes the definition in lib/supabase/service.ts (not an importer)
    // and comment mentions. Any new call site must update the audit table.
    expect(calls).toBe(87);
  });

  it('every classified file still carries its audited guard tokens', () => {
    const failures: string[] = [];
    for (const [file, spec] of Object.entries(CLASSIFIED)) {
      const src = sourceOf(file);
      for (const token of spec.tokens) {
        if (!src.includes(token)) failures.push(`${file}: missing guard token ${JSON.stringify(token)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('every non-user-scoped file is an explicit reviewed exception with a recorded reason', () => {
    for (const file of REVIEWED_EXCEPTIONS) {
      const spec = CLASSIFIED[file]!;
      expect(spec.exceptionReason, `${file} needs a reviewed-exception reason`).toBeTruthy();
      expect(spec.exceptionReason!.length).toBeGreaterThan(40);
    }
    // 22 user-scoped files carry their guard inline; the rest are
    // exceptions. (P19 removed the accept route from the user-scoped
    // set: it carries no service client any more. P30/AA-6 removed
    // the three remaining workspaces-tree files the same way.
    // Subscription wiring 2026-11-08 added the three user-scoped
    // billing routes: checkout, trial, status.)
    expect(Object.keys(CLASSIFIED).length - REVIEWED_EXCEPTIONS.length).toBe(22);
  });

  it('FINDING B-F1 pin: no product file imports scopedDb helpers (guards are heterogeneous, not scopedDb)', () => {
    const offenders = walk(SRC_ROOT)
      .map(rel)
      .filter((f) => !f.startsWith('lib/tenancy/'))
      .filter((f) => /from\s+['"]@\/lib\/tenancy\/scopedDb['"]/.test(sourceOf(f)));
    expect(offenders).toEqual([]);
  });

  it('the service-role key is constructed in exactly one place (the factory)', () => {
    const constructors = walk(SRC_ROOT)
      .map(rel)
      .filter((f) => sourceOf(f).includes('SUPABASE_SERVICE_ROLE_KEY') && f !== 'lib/env.ts');
    expect(constructors).toEqual(['lib/supabase/service.ts']);
  });

  it('processWebhook session-tap branch keeps the P17/B ownership check (source pin)', () => {
    const src = sourceOf('lib/automation/processWebhook.ts');
    expect(src).toContain('instagram_account_id, completed, expires_at');
    expect(src).toContain("(session.instagram_account_id as string) !== instagramAccountId");
    expect(src).toContain("(tapAutomation.instagram_account_id as string) === instagramAccountId");
  });
});

// ── Behavioural regression: webhook session-tap ownership ─────────────────

const fake = new FakeSupabase();

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) }),
  getAppUrl: () => 'https://app.opendm.in',
}));

import { processWebhookPayload } from '@/lib/automation/processWebhook';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function accountRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'acct-1',
    user_id: 'user-owner',
    instagram_user_id: 'IG-OWNER',
    username: 'creator',
    is_active: true,
    traffic_guard_paused: false,
    workspace_id: null,
    ...overrides,
  };
}

function tapBody(): MetaWebhookBody {
  return {
    object: 'instagram',
    entry: [
      {
        id: 'IG-OWNER',
        time: Math.floor(Date.now() / 1000),
        messaging: [
          {
            sender: { id: 'FAN-1' },
            recipient: { id: 'IG-OWNER' },
            timestamp: Date.now(),
            message: {
              mid: 'mid-tap-1',
              text: 'Get the link',
              quick_reply: { payload: `SESSION_${SESSION_ID}_STEP_1` },
            },
          },
        ],
      },
    ],
  } as unknown as MetaWebhookBody;
}

async function flushFireAndForget(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

describe('P17/B regression: processWebhook session-tap tenant ownership', () => {
  beforeEach(() => {
    for (const table of [
      'instagram_accounts', 'automations', 'automation_sessions', 'job_queue',
      'debug_events', 'recipient_opt_outs', 'contacts', 'automation_follow_ups',
    ]) {
      fake.replaceRows(table, []);
    }
    fake.seed('instagram_accounts', [accountRow()]);
  });

  it('foreign session tap: enqueues nothing, session row byte-identical', async () => {
    const foreignSession: FakeRow = {
      id: SESSION_ID,
      automation_id: 'auto-B',
      instagram_account_id: 'acct-B',
      audience_ig_user_id: 'FAN-1',
      current_step: 1,
      completed: false,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    };
    fake.seed('automation_sessions', [foreignSession]);
    fake.seed('automations', [
      { id: 'auto-B', instagram_account_id: 'acct-B', is_active: true, follow_up_enabled: false, follow_up_delay_minutes: 60, follow_up_message: '' },
    ]);

    const enqueued = await processWebhookPayload(tapBody());
    await flushFireAndForget();

    expect(enqueued).toBe(0);
    expect(fake.rows('job_queue')).toEqual([]);
    expect(fake.rows('automation_sessions')[0]).toEqual(foreignSession);
  });

  it('own session tap: routes exactly one follow-up job for the owning automation', async () => {
    fake.seed('automation_sessions', [
      {
        id: SESSION_ID,
        automation_id: 'auto-1',
        instagram_account_id: 'acct-1',
        audience_ig_user_id: 'FAN-1',
        current_step: 1,
        completed: false,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ]);
    fake.seed('automations', [
      { id: 'auto-1', instagram_account_id: 'acct-1', is_active: true, follow_up_enabled: false, follow_up_delay_minutes: 60, follow_up_message: '' },
    ]);

    const enqueued = await processWebhookPayload(tapBody());
    await flushFireAndForget();

    expect(enqueued).toBe(1);
    const jobs = fake.rows('job_queue');
    expect(jobs.length).toBe(1);
    const payload = jobs[0]!['payload'] as { automationId: string; instagramAccountId: string };
    expect(payload.automationId).toBe('auto-1');
    expect(payload.instagramAccountId).toBe('acct-1');
  });
});
