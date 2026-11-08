/**
 * KeywordTicker — design pass round 4 (2026-11-08), owner-requested.
 *
 * The owner asked for continuous animation on the homepage so it
 * feels alive. This is a slow marquee of the product's real loop:
 * the keywords a visitor can comment, what each one sends, and the
 * shipped safety facts that bound every send. Nothing here is a
 * claim the product does not already make elsewhere on the page
 * (the demo scenarios, the safety strip, the FAQ).
 *
 * Pure CSS motion (globals.css `.ticker-track`): the track holds two
 * copies of the list and translates -50%, so it loops seamlessly
 * with no JS and no timers. The second copy is aria-hidden. Under
 * prefers-reduced-motion the animation is off (CSS) and the strip
 * reads as a static spec line.
 */

const ITEMS: { lead: string; rest: string }[] = [
    { lead: "PRICE", rest: "comment → pricing DM sent" },
    { lead: "LINK", rest: "comment → guide DM sent" },
    { lead: "DEMO", rest: "comment → booking DM sent" },
    { lead: "Match", rest: "keyword checked, public reply posted" },
    { lead: "Story reply", rest: "answered in the same thread" },
    { lead: "24-hour window", rest: "checked before every send" },
    { lead: "180 / hour", rest: "hard cap on DMs, never exceeded" },
    { lead: "Every webhook", rest: "HMAC-SHA-256 verified" },
];

function TickerRow({ hidden }: { hidden?: boolean }) {
    return (
        <div className="flex shrink-0 items-center" aria-hidden={hidden || undefined}>
            {ITEMS.map((item) => (
                <span
                    key={item.lead}
                    className="flex items-center gap-2.5 whitespace-nowrap px-6 py-3 font-mono text-[12px]"
                >
                    <span className="h-1.5 w-1.5 shrink-0 bg-primary" />
                    <span className="font-semibold text-foreground">{item.lead}</span>
                    <span className="text-muted-foreground">{item.rest}</span>
                </span>
            ))}
        </div>
    );
}

export function KeywordTicker() {
    return (
        <div className="overflow-hidden border-t border-border bg-card" data-testid="keyword-ticker">
            <div className="ticker-track flex w-max">
                <TickerRow />
                <TickerRow hidden />
            </div>
        </div>
    );
}
