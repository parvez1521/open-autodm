import {
  ArrowDown,
  ArrowRight,
  ChatCircle,
  Check,
  Lightning,
} from "@/components/phosphor";

/**
 * IntroWorkflow — the brand intro's content. Third shape, per
 * owner feedback 2026-11-10 ~02:44 IST: the compact centered
 * card from ~02:19 IST read as "bohot basic" — "sirf beech me
 * chota sa box hai" — so the workflow now plays as a HORIZONTAL
 * STRIP: three separate panels spanning the sheet, animating
 * one by one LEFT → RIGHT, each section the product's own loop —
 *   Panel 1 · the trigger: a Reel comment lands, keyword chip
 *             highlighted;
 *   Panel 2 · open-autoDM itself: the automation answers with
 *             the public reply;
 *   Panel 3 · the DM: the direct-message card with the link
 *             card, the "Send me the link" reveal button and
 *             the delivered tick.
 * Dashed connectors between the panels light up as the flow
 * advances, so the left→right progression is unmistakable. On
 * small screens the panels stack top→bottom in the same order,
 * connectors pointing down; the strip never overflows.
 *
 * Pure CSS: the .intro-flow-* keyframes in globals.css are keyed
 * to the sheet's own .ce-go gate (fonts painted), so a slow load
 * can never use the sequence up unseen, and the last panel lands
 * at ~1.95s inside the sheet's ~2.1s moment. No JS, no images.
 * Reduced-motion and coarse-pointer visitors never see the sheet
 * at all (intro.ts skips it and globals.css hard-hides it), so
 * the beats need no motion guard of their own. Markup mirrors
 * the landing demo's comment-to-DM simulation (DemoShowcase) so
 * the intro reads as the same product moment, stretched wide.
 */
export function IntroWorkflow() {
  return (
    <div
      data-flow
      className="flex w-full max-w-[64rem] flex-col items-stretch px-2 sm:px-4 md:flex-row"
    >
      {/* Panel 1 — the trigger: the comment lands. */}
      <section className="intro-flow-panel intro-flow-panel-1 flex-1 rounded-2xl border border-border bg-card p-4 text-left">
        <p className="micro-label">1 · Comment</p>
        <div className="mt-3 flex items-start gap-2.5 text-[13px]">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground font-heading text-[12px] font-semibold text-background">
            C
          </span>
          <div>
            <p className="font-medium leading-tight">@creator</p>
            <p className="text-[11px] text-muted-foreground">
              Reel · 3 free AI websites for students
            </p>
          </div>
        </div>
        <div className="mt-4 flex items-start gap-2.5 text-[13px]">
          <ChatCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p className="leading-relaxed">
            <span className="font-medium">@visitor</span> Send the{" "}
            <span className="intro-flow-chip rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-primary">
              LINK
            </span>{" "}
            please
          </p>
        </div>
      </section>

      {/* Connector 1 → 2 — lights up as the flow advances. */}
      <div
        aria-hidden
        className="intro-flow-link intro-flow-link-1 flex shrink-0 flex-col items-center py-1 md:w-14 md:flex-row md:py-0 lg:w-20"
      >
        <span className="intro-flow-track relative block h-8 w-px md:h-px md:w-auto md:flex-1">
          <span className="intro-flow-fill intro-flow-fill-v md:hidden" />
          <span className="intro-flow-fill intro-flow-fill-h hidden md:block" />
        </span>
        <ArrowDown className="intro-flow-head -mt-1 h-4 w-4 shrink-0 md:hidden" />
        <ArrowRight className="intro-flow-head -ml-1 hidden h-4 w-4 shrink-0 md:block" />
      </div>

      {/* Panel 2 — open-autoDM answers: the public reply. */}
      <section className="intro-flow-panel intro-flow-panel-2 flex-1 rounded-2xl border border-border bg-card p-4 text-left">
        <p className="micro-label flex items-center gap-1.5">
          <Lightning className="h-3.5 w-3.5 text-primary" />
          2 · AutoDM
        </p>
        <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
          Keyword matched — the automation replies in public and opens
          the DM. No manual work.
        </p>
        <div className="mt-4 border-l-2 border-primary/40 pl-3 text-[13px]">
          <p className="leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">@creator</span>{" "}
            Sent you the link in DM — check your inbox
          </p>
        </div>
      </section>

      {/* Connector 2 → 3 — lights up as the flow advances. */}
      <div
        aria-hidden
        className="intro-flow-link intro-flow-link-2 flex shrink-0 flex-col items-center py-1 md:w-14 md:flex-row md:py-0 lg:w-20"
      >
        <span className="intro-flow-track relative block h-8 w-px md:h-px md:w-auto md:flex-1">
          <span className="intro-flow-fill intro-flow-fill-v md:hidden" />
          <span className="intro-flow-fill intro-flow-fill-h hidden md:block" />
        </span>
        <ArrowDown className="intro-flow-head -mt-1 h-4 w-4 shrink-0 md:hidden" />
        <ArrowRight className="intro-flow-head -ml-1 hidden h-4 w-4 shrink-0 md:block" />
      </div>

      {/* Panel 3 — the DM lands with the link. */}
      <section className="intro-flow-panel intro-flow-panel-3 flex-1 rounded-2xl border border-border bg-card p-4 text-left">
        <p className="micro-label">3 · Direct message</p>
        <div className="mt-3 rounded-xl rounded-tl-sm border border-border bg-background px-3 py-2.5">
          <p className="text-[13px] font-medium leading-snug">
            Launch your app for free — the guide
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Step-by-step, no paid tools
          </p>
          <span className="mt-2 inline-flex h-7 items-center rounded-full bg-foreground px-3 text-[11px] font-semibold text-background">
            Send me the link
          </span>
        </div>
        <p className="mt-2.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Check className="h-3.5 w-3.5 text-emerald-accent" />
          Delivered automatically
        </p>
      </section>
    </div>
  );
}
