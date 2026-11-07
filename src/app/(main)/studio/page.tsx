import Link from "next/link";
import {
  Crosshair,
  Lightbulb,
  PenLine,
  AudioLines,
  Image as ImageIcon,
  Presentation,
  SearchCheck,
  LibraryBig,
  Library,
  FolderOpen,
  ArrowRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Creator Studio — workflow home (Programmes S1 + S2 + S3).
 *
 * The six-step creator workflow — all six steps are live since S3.
 */

const STEPS = [
  {
    n: 1,
    name: "Find a niche",
    blurb: "Score a topic before you commit to it — demand, competition, ease and earning potential.",
    href: "/studio/niche",
    icon: Crosshair,
    status: "live" as const,
  },
  {
    n: 2,
    name: "Pick the next video",
    blurb: "Generate video ideas in proven formats, audience questions and trending angles.",
    href: "/studio/ideas",
    icon: Lightbulb,
    status: "live" as const,
  },
  {
    n: 3,
    name: "Write the script",
    blurb: "Build a structured script with a hook, sections and a closing call to action.",
    href: "/studio/script",
    icon: PenLine,
    status: "live" as const,
  },
  {
    n: 4,
    name: "Add a voiceover",
    blurb: "Turn the script into narration in the browser — no uploads, no paid voices.",
    href: "/studio/voiceover",
    icon: AudioLines,
    status: "live" as const,
  },
  {
    n: 5,
    name: "Design the thumbnail",
    blurb: "Compose a 1280×720 thumbnail on a canvas editor with templates and your own images.",
    href: "/studio/thumbnail",
    icon: ImageIcon,
    status: "live" as const,
  },
  {
    n: 6,
    name: "Publish with SEO",
    blurb: "Titles, a structured description and a right-sized tag list, ready to paste.",
    href: "/studio/seo",
    icon: SearchCheck,
    status: "live" as const,
  },
];

const SHORTCUTS = [
  {
    name: "Presentations",
    blurb: "Turn a topic into a slide deck — present in the browser or export it.",
    href: "/studio/presentations",
    icon: Presentation,
  },
  {
    name: "Stock Libraries",
    blurb: "Free stock images, videos and audio with their credits attached, plus your own meme collection.",
    href: "/studio/library",
    icon: Library,
  },
  {
    name: "Prompt Library",
    blurb: "Ready-to-use prompts for hooks, scripts, thumbnails, SEO and brand outreach.",
    href: "/studio/prompts",
    icon: LibraryBig,
  },
  {
    name: "Projects",
    blurb: "Everything you save from the Studio tools, kept on this device.",
    href: "/studio/projects",
    icon: FolderOpen,
  },
];

export default function StudioHomePage() {
  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-sm font-medium text-muted-foreground mb-3">
          The workflow — one video, start to finish
        </h2>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((step) => {
            const live = step.status === "live";
            const card = (
              <div
                className={cn(
                  "h-full rounded-xl border p-5 transition-colors",
                  live
                    ? "border-border bg-card hover:border-primary/40"
                    : "border-dashed border-border bg-card/50"
                )}
              >
                <div className="flex items-start justify-between">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-foreground">
                    <step.icon className="w-4.5 h-4.5" />
                  </span>
                  {live ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                      Open <ArrowRight className="w-3.5 h-3.5" />
                    </span>
                  ) : (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      Coming in {step.status}
                    </span>
                  )}
                </div>
                <p className="mt-3 text-sm font-medium">
                  <span className="text-muted-foreground mr-1.5">{step.n}.</span>
                  {step.name}
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{step.blurb}</p>
              </div>
            );
            return (
              <li key={step.n}>
                {live ? (
                  <Link href={step.href!} className="block h-full">
                    {card}
                  </Link>
                ) : (
                  card
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <section>
        <h2 className="text-sm font-medium text-muted-foreground mb-3">More in the Studio</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {SHORTCUTS.map((s) => (
            <Link key={s.name} href={s.href} className="block">
              <div className="rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/40">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-foreground">
                  <s.icon className="w-4.5 h-4.5" />
                </span>
                <p className="mt-3 text-sm font-medium">{s.name}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{s.blurb}</p>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-medium">How the Studio stays free</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          Every tool runs on a built-in engine that works offline and costs nothing. Where an
          instance has a free AI tier configured, tools can optionally enhance their output
          with it — results are always labelled{" "}
          <span className="text-foreground font-medium">Built-in engine</span> or{" "}
          <span className="text-foreground font-medium">Free AI</span> so you know what
          produced them. Free AI quotas are shared and finite; when they run out, the
          built-in engines keep working.
        </p>
      </section>
    </div>
  );
}
