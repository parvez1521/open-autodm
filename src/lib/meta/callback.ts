/**
 * Shared front door for Meta's signed_request callbacks (deauthorize +
 * data deletion). Both callbacks arrive as an
 * application/x-www-form-urlencoded POST carrying a single `signed_request`
 * parameter, so verification is identical:
 *
 *   1. Read the form body (anything else → 400, nothing processed).
 *   2. Load the stored Meta settings; if the app is not configured there
 *      are no secrets to verify against → fail closed with 500.
 *   3. Verify the signed_request against the Instagram App Secret first,
 *      then the parent Facebook App Secret (see lib/meta/signedRequest.ts).
 *      Invalid signature → 401, nothing processed.
 *
 * The raw signed_request, signatures and secrets are never logged.
 */

import { getMetaSettings } from '@/lib/settings';
import { parseSignedRequest } from '@/lib/meta/signedRequest';

export type CallbackVerification =
  | { ok: true; userId: string }
  | { ok: false; status: 400 | 401 | 500; error: string };

export async function verifyMetaCallback(request: Request): Promise<CallbackVerification> {
  let signedRequest: FormDataEntryValue | null = null;
  try {
    const form = await request.formData();
    signedRequest = form.get('signed_request');
  } catch {
    return { ok: false, status: 400, error: 'Expected a form-encoded body' };
  }
  if (typeof signedRequest !== 'string' || signedRequest.length === 0) {
    return { ok: false, status: 400, error: 'Missing signed_request parameter' };
  }

  let settings: Awaited<ReturnType<typeof getMetaSettings>>;
  try {
    settings = await getMetaSettings();
  } catch {
    // The settings load itself failed (e.g. env validation threw while
    // building the service client). Fail closed with the same controlled
    // 500 shape as the not-configured case below: never let the exception
    // escape as an unhandled framework error, and never act on a request
    // whose signature could not be verified. (Phase 10.3 fix.)
    return { ok: false, status: 500, error: 'App is not configured' };
  }
  if (!settings) {
    // Fail closed: without the stored app secrets we cannot prove the
    // request came from Meta, so we must not act on it.
    return { ok: false, status: 500, error: 'App is not configured' };
  }

  const secrets = [settings.metaAppSecret, settings.metaFbAppSecret].filter(
    (s): s is string => typeof s === 'string' && s.length > 0
  );
  const parsed = parseSignedRequest(signedRequest, secrets);
  if (!parsed) {
    return { ok: false, status: 401, error: 'Invalid signed_request signature' };
  }

  return { ok: true, userId: parsed.userId };
}
