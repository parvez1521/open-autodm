/**
 * Public deletion-status lookup for the Meta data deletion flow.
 *
 * GET /api/meta/data-deletion/status?code=<confirmation_code>
 *
 * The confirmation code is the only credential (Meta's design: it shows
 * the code + status URL to the user). Returns the request's REAL state -
 * this endpoint can never report completion unless the deletion workflow
 * actually finished: status values are received / processing / completed /
 * not_found / failed. Unknown code → 404.
 */

import { createServiceClient } from '@/lib/supabase/service';
import { findDeletionRequestByCode } from '@/lib/meta/accountData';
import { createLogger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('meta-data-deletion-status');

export async function GET(request: Request): Promise<Response> {
  const code = new URL(request.url).searchParams.get('code');
  if (!code) {
    return Response.json({ error: 'Missing code parameter' }, { status: 400 });
  }

  try {
    const db = createServiceClient();
    const row = await findDeletionRequestByCode(db, code);
    if (!row) {
      return Response.json({ error: 'Unknown confirmation code' }, { status: 404 });
    }
    return Response.json(
      {
        confirmation_code: row.confirmation_code,
        status: row.status,
        updated_at: row.updated_at,
        completed_at: row.completed_at,
      },
      { status: 200 }
    );
  } catch (err) {
    logger.error({ err }, 'Deletion status lookup failed');
    return Response.json({ error: 'Status lookup failed' }, { status: 500 });
  }
}
