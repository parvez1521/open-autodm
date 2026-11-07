/**
 * Phase 14 — server-side platform-admin gate STUB for the (admin) UI
 * prototype. The real check (a later phase) verifies the signed-in
 * user's row in `platform_admins` (…000025, service-role read) inside a
 * server component / route handler — never from client state, never
 * from workspace membership, never from user-editable metadata.
 *
 * This stub fails closed: it allows access only when the prototype env
 * explicitly names a platform-admin actor. By default (and in tests)
 * nobody passes, and the admin pages render an access-denied state with
 * no customer data at all.
 */
import type { ActorContext } from './types';

export interface PlatformAdminGate {
  allowed: boolean;
  actor: ActorContext | null;
  reason: string;
}

export function evaluatePlatformAdminGate(env: Record<string, string | undefined> = {}): PlatformAdminGate {
  const actorId = env.ADMIN_PROTOTYPE_ACTOR_ID;
  if (env.ADMIN_PROTOTYPE_PLATFORM_ADMIN === 'true' && actorId) {
    return {
      allowed: true,
      actor: { userId: actorId, platformRole: 'platform-admin', workspaceRoles: {} },
      reason: 'prototype stub: env-named platform-admin actor',
    };
  }
  return {
    allowed: false,
    actor: null,
    reason: 'no platform-admin session (stub check — platform_admins verification is a later phase)',
  };
}
