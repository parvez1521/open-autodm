import { ChatCircle, Check } from "@/components/phosphor";

/**
 * IntroWorkflow — the brand intro's content since 2026-11-10
 * (owner directive ~02:19 IST). The three-bar "music lines" wave
 * that used to sit under the wordmark was rejected ("intro
 * animation sirf music lines aa rahi hai, wo nahi chahiye tha")
 * in favour of a small workflow animation like the one built for
 * Open Caption: the product's own loop, in three beats —
 *   1. a follower comment lands, its keyword chip highlighted;
 *   2. the automatic public reply appears;
 *   3. a DM card slides in carrying the link card, the
 *      "Send me the link" reveal button and a delivered tick.
 *
 * Pure CSS: the .intro-flow-* keyframes in globals.css are keyed
 * to the sheet's own .ce-go gate (fonts painted), so a slow load
 * can never use the sequence up unseen, and the beats land in
 * ~1.7s inside the sheet's ~2s moment. No JS, no images.
 * Reduced-motion visitors never see the sheet at all (intro.ts
 * skips it and globals.css hard-hides it), so the beats need no
 * motion guard of their own. Markup mirrors the landing demo's
 * comment-to-DM simulation (DemoShowcase) so the intro reads as
 * the same product moment, compressed.
 */
export function IntroWorkflow() {
  return (
    <div
      data-flow
      className="w-[19rem] max-w-[86vw] rounded-2xl border border-border bg-card p-4 text-left"
    >
      {/* Beat 1 — the comment lands, keyword chip highlighted. */}
      <div className="intro-flow-beat intro-flow-beat-1 flex items-start gap-2.5 text-[13px]">
        <ChatCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p className="leading-relaxed">
          <span className="font-medium">@visitor</span> Send the{" "}
          <span className="intro-flow-chip rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-primary">
            LINK
          </span>{" "}
          please
        </p>
      </div>

      {/* Beat 2 — the automatic public reply. */}
      <div className="intro-flow-beat intro-flow-beat-2 ml-6 mt-3 border-l-2 border-primary/40 pl-3 text-[13px]">
        <p className="leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">@creator</span> Sent
          you the link in DM — check your inbox
        </p>
      </div>

      {/* Beat 3 — the DM card with the link + delivered tick. */}
      <div className="intro-flow-beat intro-flow-beat-3 mt-4 border-t border-border pt-3">
        <p className="micro-label">Direct message</p>
        <div className="mt-2 rounded-xl rounded-tl-sm border border-border bg-background px-3 py-2.5">
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
      </div>
      <p className="intro-flow-beat intro-flow-beat-4 mt-2.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Check className="h-3.5 w-3.5 text-emerald-accent" />
        Delivered automatically
      </p>
    </div>
  );
}
