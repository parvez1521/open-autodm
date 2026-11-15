/**
 * Instance-owner identity - who is allowed to administer this deployment.
 *
 * The codebase has no role model (every authenticated user is an operator),
 * so instance-level administration - currently: changing the Meta app
 * credentials through the Setup Wizard after setup has completed - is gated
 * on an owner identity configured in the deployment environment:
 *
 *   OWNER_USER_ID  Supabase auth user ID of the owner (preferred)
 *   OWNER_EMAIL    owner's account email (matched case-insensitively)
 *
 * Priority mirrors the opendm-release-prep branch: when OWNER_USER_ID is
 * set it alone decides; OWNER_EMAIL is consulted only when no ID is set.
 *
 * Env is read directly from process.env (not getEnv()) so the check works
 * even while other configuration is broken - the same approach as
 * release-prep's isEnvironmentOwner.
 *
 * FAIL-CLOSED CONTRACT: when neither variable is configured,
 * isInstanceOwner() returns false for EVERYONE. Callers guarding a completed
 * setup therefore deny all modification until the operator sets one of the
 * variables - an unconfigured owner must never silently mean "anyone".
 */

import type { AuthenticatedUser } from '@/lib/auth';

/**
 * Forever-free owner comp — owner decision 2026-11-15 ("mere account
 * me koi bhi paid na lena pade, sab free access rahe"): the owner's
 * own account is comped for life. It bypasses EVERY plan limit
 * (Instagram accounts, team seats, workspaces, monthly volumes) and
 * never needs a paid plan or a payment.
 *
 * The comp is keyed on the owner's account email below AND on the
 * env-configured instance owner (isInstanceOwner) — either one
 * suffices. The hardcoded email is deliberate: the comp must NOT
 * silently stop working because a deployment forgot to set
 * OWNER_EMAIL/OWNER_USER_ID. It applies to this one account only;
 * no other user or workspace is ever comped by this check.
 */
export const OWNER_FREE_EMAILS: readonly string[] = ['parvezsiddiqui018@gmail.com'];

/** True when `user` is the owner whose account is forever free. */
export function isOwnerFree(user: Pick<AuthenticatedUser, 'id' | 'email'>): boolean {
  if (isInstanceOwner(user)) return true;
  const email = user.email?.trim().toLowerCase();
  return !!email && OWNER_FREE_EMAILS.includes(email);
}

/** True when an owner identity is configured in the environment. */
export function isOwnerConfigured(): boolean {
  return Boolean(process.env['OWNER_USER_ID']?.trim() || process.env['OWNER_EMAIL']?.trim());
}

/** True when `user` is the configured instance owner. */
export function isInstanceOwner(user: Pick<AuthenticatedUser, 'id' | 'email'>): boolean {
  const envOwnerId = process.env['OWNER_USER_ID']?.trim();
  if (envOwnerId) return user.id === envOwnerId;

  const envOwnerEmail = process.env['OWNER_EMAIL']?.trim();
  if (envOwnerEmail && user.email) {
    return user.email.toLowerCase() === envOwnerEmail.toLowerCase();
  }

  return false;
}
