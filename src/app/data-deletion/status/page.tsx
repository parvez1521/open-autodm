import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalLayout } from '@/components/legal/LegalLayout';
import { CheckCircle, Clock, FileX, Warning, Question } from '@/components/phosphor';
import { createServiceClient } from '@/lib/supabase/service';
import { findDeletionRequestByCode, type DeletionRequestRow } from '@/lib/meta/accountData';

export const metadata: Metadata = {
  title: 'Data Deletion Status | open-autoDM',
  description: 'Check the status of a data deletion request submitted through Meta.',
};

// Status must always reflect the live record - never prerender or cache.
export const dynamic = 'force-dynamic';

interface StatusPageProps {
  searchParams?: Promise<{ code?: string }>;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

type Lookup =
  | { kind: 'no-code' }
  | { kind: 'unknown' }
  | { kind: 'unavailable' }
  | { kind: 'found'; row: DeletionRequestRow };

async function lookup(code: string | undefined): Promise<Lookup> {
  if (!code) return { kind: 'no-code' };
  try {
    const db = createServiceClient();
    const row = await findDeletionRequestByCode(db, code);
    return row ? { kind: 'found', row } : { kind: 'unknown' };
  } catch {
    return { kind: 'unavailable' };
  }
}

export default async function DataDeletionStatusPage({ searchParams }: StatusPageProps) {
  const params = searchParams ? await searchParams : {};
  const code = typeof params.code === 'string' ? params.code : undefined;
  const result = await lookup(code);

  return (
    <LegalLayout
      title="Data Deletion Request Status"
      subtitle="The current, real status of a data deletion request submitted through Meta. This page only reports completion after the deletion has actually run."
      lastUpdated="November 5, 2026"
      activePath="/data-deletion"
    >
      {code && (
        <p className="text-sm text-muted-foreground">
          Confirmation code:{' '}
          <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-foreground border border-border">{code}</code>
        </p>
      )}

      {result.kind === 'no-code' && (
        <div className="p-4 rounded-xl bg-muted/40 border border-border space-y-2">
          <div className="flex items-center gap-2 font-semibold text-base text-foreground">
            <Question className="w-5 h-5 shrink-0" />
            <span>No confirmation code provided</span>
          </div>
          <p className="text-sm text-muted-foreground">
            When you request data deletion through Meta, Meta shows you a confirmation code and a link to this page
            containing it. Open that link (or add <code className="font-mono text-xs">?code=YOUR_CODE</code> to this
            page&apos;s address) to see your request&apos;s status. If you have not made a request through Meta, see
            the{' '}
            <Link href="/data-deletion" className="text-primary hover:underline">
              data deletion instructions
            </Link>{' '}
            instead.
          </p>
        </div>
      )}

      {result.kind === 'unknown' && (
        <div className="p-4 rounded-xl bg-muted/40 border border-border space-y-2">
          <div className="flex items-center gap-2 font-semibold text-base text-foreground">
            <FileX className="w-5 h-5 shrink-0" />
            <span>Request not found</span>
          </div>
          <p className="text-sm text-muted-foreground">
            We have no deletion request with this confirmation code. Check that the code matches exactly what Meta
            showed you, or follow the{' '}
            <Link href="/data-deletion" className="text-primary hover:underline">
              data deletion instructions
            </Link>{' '}
            to submit a request.
          </p>
        </div>
      )}

      {result.kind === 'unavailable' && (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/25 space-y-2">
          <div className="flex items-center gap-2 font-semibold text-base text-foreground">
            <Warning className="w-5 h-5 text-amber-500 shrink-0" />
            <span>Status temporarily unavailable</span>
          </div>
          <p className="text-sm text-muted-foreground">
            We could not look up this request right now. This does not change your request&apos;s state - please try
            again shortly.
          </p>
        </div>
      )}

      {result.kind === 'found' && result.row.status === 'completed' && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 space-y-2">
          <div className="flex items-center gap-2 text-emerald-600 font-semibold text-base">
            <CheckCircle className="w-5 h-5 shrink-0" />
            <span>Deletion completed</span>
          </div>
          <p className="text-sm text-muted-foreground">
            The data associated with this request has been deleted from open-autoDM.
            {formatDate(result.row.completed_at) && (
              <>
                {' '}
                Completed on <strong className="text-foreground">{formatDate(result.row.completed_at)}</strong>.
              </>
            )}
          </p>
        </div>
      )}

      {result.kind === 'found' && (result.row.status === 'received' || result.row.status === 'processing') && (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/25 space-y-2">
          <div className="flex items-center gap-2 font-semibold text-base text-foreground">
            <Clock className="w-5 h-5 text-amber-500 shrink-0" />
            <span>Deletion in progress</span>
          </div>
          <p className="text-sm text-muted-foreground">
            Your request has been received and is being processed. Deletion has <strong className="text-foreground">not</strong>{' '}
            finished yet - please check this page again shortly for the final status.
          </p>
        </div>
      )}

      {result.kind === 'found' && result.row.status === 'not_found' && (
        <div className="p-4 rounded-xl bg-muted/40 border border-border space-y-2">
          <div className="flex items-center gap-2 font-semibold text-base text-foreground">
            <FileX className="w-5 h-5 shrink-0" />
            <span>No data found</span>
          </div>
          <p className="text-sm text-muted-foreground">
            This request was fully processed and open-autoDM held no data for the requesting account, so there was
            nothing to delete.
          </p>
        </div>
      )}

      {result.kind === 'found' && result.row.status === 'failed' && (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/25 space-y-2">
          <div className="flex items-center gap-2 font-semibold text-base text-foreground">
            <Warning className="w-5 h-5 text-amber-500 shrink-0" />
            <span>Processing issue</span>
          </div>
          <p className="text-sm text-muted-foreground">
            Something went wrong while processing this request, so deletion is <strong className="text-foreground">not</strong>{' '}
            complete. Your request stays recorded - submitting the deletion request again through Meta will
            re-run it, or you can contact the operator using the
            details on the{' '}
            <Link href="/data-deletion" className="text-primary hover:underline">
              data deletion instructions
            </Link>{' '}
            page.
          </p>
        </div>
      )}
    </LegalLayout>
  );
}
