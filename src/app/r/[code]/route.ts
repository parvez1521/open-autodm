/**
 * Link click redirect (2026-11-17) — GET /r/{code}.
 *
 * Every link an automation sends is rewritten to a short /r/[code] URL.
 * This route records the click (link_clicks row + atomic click_count
 * increment) and redirects to the real destination. Unknown codes 404.
 * No auth: the code is an unguessable random token, and the route never
 * exposes any account data — it only redirects.
 */

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { recordLinkClick } from '@/lib/automation/linkTracking';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await params;
  const destination = await recordLinkClick(createServiceClient(), code, null);
  if (!destination) {
    return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  }
  return NextResponse.redirect(destination, { status: 302 });
}
