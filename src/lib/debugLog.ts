/**
 * Debug event logger - powers the live debug panel on the Automations page.
 *
 * Fire-and-forget writes to the debug_events table. Never blocks or breaks
 * the automation flow; failures are swallowed after a console note.
 *
 * OWNERSHIP (security audit finding #6): when the caller context knows the
 * owning operator, it passes `userId` inside metadata; the value is ALSO
 * persisted into the debug_events.user_id column (migration
 * 20260730000003) so /api/debug/events can scope reads and deletes per
 * user. Call sites with no user context (e.g. pre-auth webhook checks)
 * omit it and the row is stored with user_id NULL - visible to no ordinary
 * user through the API. Call sites acting on a connected Instagram account
 * derive the owner from that account row (see processWebhook/processJob).
 *
 * SCRUBBING (Phase 10.4 §9, S-11): the free-text `message` and every string
 * value inside `metadata` pass through the logger's value-pattern scrubber
 * before insert, so a secret-shaped value interpolated by any call site
 * (e.g. an upstream error body echoed into a message) is stored only as
 * [redacted]. The owner `userId` is extracted from the RAW metadata first;
 * dashed UUIDs are not a scrub pattern, so scoping is unaffected.
 *
 * WORKSPACE (Phase D1 / Programme 16): `workspaceId` in metadata is
 * extracted exactly like `userId` — from the RAW metadata, before
 * scrubbing — and persisted into the debug_events.workspace_id column
 * (migration …000032) so tenant paths are auditable per workspace.
 * Callers without a workspace context omit it and the row stores NULL,
 * exactly as before.
 */

import { createServiceClient } from '@/lib/supabase/service';
import { scrubLogValue, scrubSecretShapedValues } from '@/lib/logger';

export type DebugLevel = 'info' | 'warn' | 'error';
export type DebugStatus = 'ok' | 'error' | 'skipped' | 'processing';

export function debugLog(
  service: 'webhook' | 'worker' | 'instagram' | 'oauth' | 'cron',
  level: DebugLevel,
  eventType: string,
  status: DebugStatus,
  message: string,
  metadata: Record<string, unknown> = {}
): void {
  const rawUserId = metadata['userId'];
  const userId = typeof rawUserId === 'string' && rawUserId.length > 0 ? rawUserId : null;
  const rawWorkspaceId = metadata['workspaceId'];
  const workspaceId =
    typeof rawWorkspaceId === 'string' && rawWorkspaceId.length > 0 ? rawWorkspaceId : null;

  const scrubbedMessage = scrubSecretShapedValues(message);
  const scrubbedMetadata = scrubLogValue(metadata) as Record<string, unknown>;

  void (async (): Promise<void> => {
    try {
      const db = createServiceClient();
      await db.from('debug_events').insert({
        service,
        level,
        event_type: eventType,
        status,
        message: scrubbedMessage,
        metadata: scrubbedMetadata,
        user_id: userId,
        // Only present when a workspace is known, so existing callers'
        // inserts stay byte-for-byte identical (and keep working on
        // deployments where …000032 has not been applied yet).
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
      });
    } catch (err) {
      console.error(
        '[debugLog] failed:',
        scrubSecretShapedValues(err instanceof Error ? err.message : String(err))
      );
    }
  })();
}
