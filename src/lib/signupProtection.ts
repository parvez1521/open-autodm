/**
 * Signup protection — the in-code layer of the invite-only posture
 * (Phase 10.4 Workstream A, finding S-02).
 *
 * PRODUCT POSTURE: this app has NO self-registration. There is no
 * registration UI, no registration route, and no code path in this
 * codebase calls any Supabase Auth method that creates or provisions an
 * account — that invariant is pinned by tests/signup-protection.test.ts,
 * which source-scans the whole tree. Users are provisioned ONLY by the
 * instance owner in the Supabase dashboard (Authentication → Users →
 * Add user), and the owner must ALSO turn OFF "Allow new users to sign
 * up" in the dashboard (docs/SELF_HOSTING.md). That toggle lives in
 * Supabase project configuration: it cannot be read or set from this
 * codebase (no Management API credential exists in the app), so it
 * remains an owner action — see the verification procedure in
 * phase10.4-scratch-A-signup.md.
 *
 * WHY THERE IS NO "PROVISIONED USER" CHECK: the data model cannot
 * distinguish a dashboard-created user from a self-registered one. The
 * public.profiles row is auto-created by a database trigger for EVERY
 * auth.users insert (migration 20260729000001), however the user was
 * created, and neither app_settings.owner_user_id nor the OWNER_*
 * environment variables describe a membership list — they name the
 * single instance owner. Gating every route on "is the owner" would
 * break the documented multi-operator use (the owner inviting a second
 * operator via the dashboard), and any other distinguisher would need
 * new schema. This module therefore implements the strongest honest
 * app-layer controls that need no schema:
 *
 *   1. ANONYMOUS IDENTITIES ARE ALWAYS DENIED. The app never provisions
 *      anonymous Supabase users; if anonymous sign-in were ever enabled
 *      at the project level, those identities still cannot operate this
 *      instance. Checked unconditionally — no configuration can switch
 *      this off.
 *
 *   2. OPTIONAL OWNER ALLOWLIST. When the owner sets either variable,
 *      only the listed identities may operate the instance:
 *        INSTANCE_ALLOWED_EMAILS      comma/whitespace separated emails
 *                                     (matched case-insensitively)
 *        INSTANCE_ALLOWED_USER_IDS    comma/whitespace separated
 *                                     Supabase auth user UUIDs
 *      When both are set, matching EITHER list admits the identity.
 *      The owner should list every provisioned operator, including
 *      themselves. This is the in-code membership guard for owners who
 *      want defence in depth behind the dashboard toggle.
 *
 * FAIL-CLOSED CONTRACT (mirrors src/lib/owner.ts):
 *   - Env is read directly from process.env on every call, so the gate
 *     works even while other configuration is broken.
 *   - A variable that is set but contains ANY malformed entry (a
 *     non-email in the email list, a non-UUID in the id list) makes the
 *     whole configuration INVALID and denies EVERYONE — a typo can lock
 *     the instance, it can never silently widen it.
 *   - A blank variable counts as unconfigured (same semantics as
 *     OWNER_*), never as "allow everyone".
 *   - No variable, default, or code path in this module can CREATE a
 *     user; the module only ever narrows which already-verified
 *     identities are accepted. Account creation, when the owner
 *     deliberately enables it (below), lives OUTSIDE this module.
 *
 * OWNER-DIRECTED CHANGE — flag-gated public signup (preview launch
 * preparation, 2026-11-07): the default posture above is unchanged,
 * but the owner can now set PUBLIC_SIGNUP_ENABLED=true (see
 * src/lib/billing/flags.ts), in which case /get-started renders the
 * one component allowed to call supabase.auth.signUp
 * (src/components/auth/SignupForm.tsx — the S-02 source scan exempts
 * exactly that file for exactly that method, and pins that it stays
 * the only one). This module's gate is NOT weakened by the flag:
 * anonymous identities are still always denied, and a configured
 * allowlist still narrows who may operate the instance — including
 * people who self-registered while the flag was on. The posture
 * report below simply tells the truth about which mode the owner
 * has selected.
 *
 * Consumers: src/lib/auth.ts (every API route), src/middleware.ts
 * (protected pages), src/app/auth/callback/route.ts (session minting).
 */

export interface IdentityLike {
  id: string;
  email?: string | null | undefined;
  isAnonymous?: boolean | null | undefined;
}

export type AccessDenialReason = 'anonymous-identity' | 'allowlist-invalid-config' | 'not-on-allowlist';

export type AccessDecision = { allowed: true } | { allowed: false; reason: AccessDenialReason };

export interface AllowlistState {
  /** At least one allowlist variable is set to a non-blank value. */
  configured: boolean;
  /** A configured variable contains a malformed entry → deny everyone. */
  invalid: boolean;
  emailCount: number;
  userIdCount: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function splitEntries(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

interface ParsedList {
  present: boolean;
  valid: boolean;
  entries: string[];
}

function parseList(raw: string | undefined, shape: RegExp, normalize: (entry: string) => string): ParsedList {
  const entries = splitEntries(raw);
  if (entries.length === 0) return { present: false, valid: true, entries: [] };
  const normalized = entries.map(normalize);
  return { present: true, valid: normalized.every((entry) => shape.test(entry)), entries: normalized };
}

function readAllowlist(): { emails: ParsedList; userIds: ParsedList } {
  return {
    emails: parseList(process.env['INSTANCE_ALLOWED_EMAILS'], EMAIL_RE, (entry) => entry.toLowerCase()),
    userIds: parseList(process.env['INSTANCE_ALLOWED_USER_IDS'], UUID_RE, (entry) => entry.toLowerCase()),
  };
}

/** Snapshot of the allowlist configuration (names/counts only, never values). */
export function getAllowlistState(): AllowlistState {
  const { emails, userIds } = readAllowlist();
  return {
    configured: emails.present || userIds.present,
    invalid: (emails.present && !emails.valid) || (userIds.present && !userIds.valid),
    emailCount: emails.entries.length,
    userIdCount: userIds.entries.length,
  };
}

/**
 * Decide whether an already-verified Supabase identity may operate this
 * instance. `allowed: true` here NEVER creates or provisions anything —
 * it only accepts an identity Supabase has already authenticated.
 */
export function evaluateInstanceAccess(user: IdentityLike): AccessDecision {
  // (1) Anonymous identities: never provisioned by this product, always out.
  if (user.isAnonymous === true) return { allowed: false, reason: 'anonymous-identity' };

  const { emails, userIds } = readAllowlist();
  const state = getAllowlistState();

  // Malformed configuration fails closed for everyone.
  if (state.invalid) return { allowed: false, reason: 'allowlist-invalid-config' };

  // (2) No allowlist configured: the dashboard toggle is the control for
  // who can obtain an identity at all; any verified identity is accepted.
  if (!state.configured) return { allowed: true };

  if (userIds.present && userIds.entries.includes(user.id.toLowerCase())) return { allowed: true };
  if (emails.present && user.email && emails.entries.includes(user.email.toLowerCase())) {
    return { allowed: true };
  }
  return { allowed: false, reason: 'not-on-allowlist' };
}

/** Boolean convenience wrapper used by the auth gate and middleware. */
export function isIdentityAllowed(user: IdentityLike): boolean {
  try {
    return evaluateInstanceAccess(user).allowed;
  } catch {
    // The gate itself must never fail open.
    return false;
  }
}

import { readSaasFlags } from '@/lib/billing/flags';

export interface SignupPosture {
  mode: 'invite-only' | 'public-signup';
  /** True only when the owner has enabled PUBLIC_SIGNUP_ENABLED. */
  appInitiatedSignup: boolean;
  userProvisioning: 'supabase-dashboard-by-owner' | 'self-service-signup';
  anonymousIdentities: 'denied';
  allowlist: AllowlistState;
  /**
   * The dashboard "Allow new users to sign up" toggle cannot be read from
   * app code or runtime — the owner must verify it in the dashboard.
   * (With public signup enabled in the app, the dashboard toggle must
   * also be ON or Supabase will refuse the registration itself.)
   */
  dashboardToggleDetectableFromApp: false;
  supabaseDashboardSignupToggle: 'owner-verification-required';
}

/** Posture report for the owner-gated status surface. Contains no secrets. */
export function getSignupPosture(): SignupPosture {
  const signupEnabled = readSaasFlags(process.env).publicSignupEnabled;
  return {
    mode: signupEnabled ? 'public-signup' : 'invite-only',
    appInitiatedSignup: signupEnabled,
    userProvisioning: signupEnabled ? 'self-service-signup' : 'supabase-dashboard-by-owner',
    anonymousIdentities: 'denied',
    allowlist: getAllowlistState(),
    dashboardToggleDetectableFromApp: false,
    supabaseDashboardSignupToggle: 'owner-verification-required',
  };
}
