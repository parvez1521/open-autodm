import Link from "next/link";
import { Lock } from "@/components/phosphor";

/**
 * Shared permission-denied state (production-pages audit,
 * 2026-11-23).
 *
 * Use wherever the app renders a denial to a signed-in user who
 * lacks permission — it explains the lack of permission without
 * revealing anything about the protected resource, and offers a
 * safe way out. It does NOT replace the admin/setup gates: those
 * deliberately render a 404 on a failed gate (see
 * src/app/(admin)/admin/subscriptions/page.tsx and
 * src/app/(main)/setup/page.tsx) so a rendered "Access denied"
 * page does not reveal the restricted area exists.
 *
 * `compact` renders the inline form for use inside a card (for
 * example the BillingPanel viewer-role denial): icon + text only,
 * no action buttons, no large vertical padding.
 */
export function ForbiddenState({
  title = "You don't have access to this",
  description = "Your account doesn't have permission to do this. If you think this is a mistake, contact the workspace owner or the operator.",
  compact = false,
}: {
  title?: string;
  description?: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div role="alert" className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-4">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
          <Lock className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold text-foreground">{title}</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center px-6 py-16 text-foreground">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Lock className="h-5 w-5" aria-hidden="true" />
      </span>
      <p className="micro-label mt-6">Permission denied</p>
      <h1 className="mt-3 text-center font-heading text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-3 max-w-md text-center text-[15px] leading-relaxed text-muted-foreground">
        {description}
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/dashboard"
          className="inline-flex h-10 items-center rounded-lg bg-foreground px-4 text-[13.5px] font-semibold text-background transition-opacity hover:opacity-90"
        >
          Go to your console
        </Link>
        <Link
          href="/support"
          className="inline-flex h-10 items-center rounded-lg border border-border px-4 text-[13.5px] font-medium transition-colors hover:bg-muted"
        >
          Contact support
        </Link>
      </div>
    </div>
  );
}
