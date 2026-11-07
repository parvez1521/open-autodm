'use client';

/**
 * Live status banner for the /data-deletion page.
 *
 * DEVIATION FROM THE RESTORED PAGE (deliberate, Phase C): the restored
 * page rendered a static banner claiming "Status: Completed" for ANY
 * ?id= / ?confirmation_code= parameter, without any lookup - an unverified
 * completion claim. This component instead fetches the REAL request state
 * from GET /api/meta/data-deletion/status and renders honestly:
 *
 *   completed   → the original "Completed" banner (only state allowed to
 *                 claim completion, and only on the API's word)
 *   not_found   → processed, but no data matched - nothing was deleted
 *                 because nothing existed; NOT shown as "Completed"
 *   received / processing → in progress; deletion is not finished yet
 *   failed      → processing failed; retry/contact guidance
 *   unknown code / lookup error → "could not verify this reference";
 *                 no status is claimed at all
 */

import { useEffect, useState } from 'react';
import { CheckCircle, Warning, Clock, Question, CircleNotch, XCircle } from '@/components/phosphor';

type BannerState =
  | { kind: 'loading' }
  | { kind: 'completed' }
  | { kind: 'not_found' }
  | { kind: 'in_progress'; status: string }
  | { kind: 'failed' }
  | { kind: 'unverified' };

export function DeletionStatusBanner({ confirmationCode }: { confirmationCode: string }) {
  const [state, setState] = useState<BannerState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const res = await fetch(
          `/api/meta/data-deletion/status?code=${encodeURIComponent(confirmationCode)}`
        );
        if (!res.ok) throw new Error(`Status lookup failed: ${res.status}`);
        const data = (await res.json()) as { status?: unknown };
        if (cancelled) return;
        switch (data.status) {
          case 'completed':
            setState({ kind: 'completed' });
            break;
          case 'not_found':
            setState({ kind: 'not_found' });
            break;
          case 'failed':
            setState({ kind: 'failed' });
            break;
          case 'received':
          case 'processing':
            setState({ kind: 'in_progress', status: data.status });
            break;
          default:
            setState({ kind: 'unverified' });
        }
      } catch {
        if (!cancelled) setState({ kind: 'unverified' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [confirmationCode]);

  const codeLine = (
    <p className="text-sm text-muted-foreground">
      Confirmation code:{' '}
      <code className="bg-background px-1.5 py-0.5 rounded font-mono text-foreground border border-border">
        {confirmationCode}
      </code>
    </p>
  );

  if (state.kind === 'loading') {
    return (
      <div className="p-4 rounded-xl bg-muted/40 border border-border text-foreground mb-6 space-y-2">
        <div className="flex items-center gap-2 font-semibold text-base">
          <CircleNotch className="w-5 h-5 shrink-0 animate-spin" />
          <span>Checking the status of this deletion request…</span>
        </div>
        {codeLine}
      </div>
    );
  }

  if (state.kind === 'completed') {
    return (
      <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-foreground mb-6 space-y-2">
        <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 font-semibold text-base">
          <CheckCircle className="w-5 h-5 shrink-0" />
          <span>Data Deletion Request Status: Completed</span>
        </div>
        {codeLine}
        <p className="text-sm text-muted-foreground">
          In accordance with our data retention policy, all connected account credentials, automations, and audience
          interaction records associated with this request have been permanently purged from our database.
        </p>
      </div>
    );
  }

  if (state.kind === 'not_found') {
    return (
      <div className="p-4 rounded-xl bg-muted/40 border border-border text-foreground mb-6 space-y-2">
        <div className="flex items-center gap-2 font-semibold text-base">
          <Question className="w-5 h-5 shrink-0" />
          <span>Data Deletion Request Status: Processed - no data found</span>
        </div>
        {codeLine}
        <p className="text-sm text-muted-foreground">
          This request has been processed, but no account or interaction records in our database matched it, so there
          was nothing to delete. If you believe data should exist, double-check the reference or use the email request
          process below.
        </p>
      </div>
    );
  }

  if (state.kind === 'in_progress') {
    return (
      <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-foreground mb-6 space-y-2">
        <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-semibold text-base">
          <Clock className="w-5 h-5 shrink-0" />
          <span>Data Deletion Request Status: In progress ({state.status})</span>
        </div>
        {codeLine}
        <p className="text-sm text-muted-foreground">
          Your deletion request has been received and is being processed. Deletion is <strong>not yet complete</strong> -
          please check this page again later with the same confirmation code.
        </p>
      </div>
    );
  }

  if (state.kind === 'failed') {
    return (
      <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-foreground mb-6 space-y-2">
        <div className="flex items-center gap-2 text-red-600 dark:text-red-400 font-semibold text-base">
          <XCircle className="w-5 h-5 shrink-0" />
          <span>Data Deletion Request Status: Failed</span>
        </div>
        {codeLine}
        <p className="text-sm text-muted-foreground">
          Processing of this request failed before deletion completed. Your data has <strong>not</strong> been confirmed
          deleted. Please submit the request again or use the email request process below.
        </p>
      </div>
    );
  }

  // unverified - unknown code, or the status lookup itself failed.
  return (
    <div className="p-4 rounded-xl bg-muted/40 border border-border text-foreground mb-6 space-y-2">
      <div className="flex items-center gap-2 font-semibold text-base">
        <Warning className="w-5 h-5 shrink-0" />
        <span>We could not verify this reference</span>
      </div>
      {codeLine}
      <p className="text-sm text-muted-foreground">
        No deletion request with this confirmation code could be found, so no status can be shown for it. Check that
        the code is complete and correct, or use the email request process below.
      </p>
    </div>
  );
}
