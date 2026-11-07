import Link from "next/link";
import {
  Crosshair,
  Lightbulb,
  PencilLine,
  Waveform,
  FileText,
  Image as ImageIcon,
  Presentation,
  FileMagnifyingGlass,
  Books,
  Images,
  FolderOpen,
  ArrowRight,
} from "@/components/phosphor";
import { cn } from "@/lib/utils";

/**
 * Creator Studio — landing page (Programmes S1 + S2 + S3; landing
 * layout from the Studio restructure).
 *
 * An intro band, the six-step workflow as a numbered journey, and a
 * full directory of the Studio's tools grouped by category — every
 * tool lives on its own dedicated page.
 */

const STEPS = [
  {
    n: 1,
    name: "Find a niche",
    blurb: "Score a topic before you commit to it, demand, competition, ease and earning potential.",
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
    icon: PencilLine,
    status: "live" as const,
  },
  {
    n: 4,
    name: "Add a voiceover",
    blurb: "Turn the script into narration in the browser, no uploads, no paid voices.",
    href: "/studio/voiceover",
    icon: Waveform,
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
    icon: FileMagnifyingGlass,
    status: "live" as const,
  },
];

const DIRECTORY = [
  {
    label: "Create",
    tools: [
      {
        name: "Niche Finder",
        blurb: "Score a topic before you commit to it, demand, competition, ease and earning potential.",
        href: "/studio/niche",
        icon: Crosshair,
      },
      {
        name: "Next Video Ideas",
        blurb: "Generate video ideas in proven formats, audience questions and trending angles.",
        href: "/studio/ideas",
        icon: Lightbulb,
      },
      {
        name: "Script Builder",
        blurb: "Build a structured script with a hook, sections and a closing call to action.",
        href: "/studio/script",
        icon: PencilLine,
      },
      {
        name: "Voiceover Studio",
        blurb: "Turn the script into narration in the browser, no uploads, no paid voices.",
        href: "/studio/voiceover",
        icon: Waveform,
      },
      {
        name: "Transcript Tools",
        blurb: "Clean, format and reuse transcripts, paste or upload, no fetching.",
        href: "/studio/transcript",
        icon: FileText,
      },
      {
        name: "Thumbnail Editor",
        blurb: "Compose a 1280×720 thumbnail on a canvas editor with templates and your own images.",
        href: "/studio/thumbnail",
        icon: ImageIcon,
      },
      {
        name: "Presentations",
        blurb: "Turn a topic into a slide deck, present in the browser or export it.",
        href: "/studio/presentations",
        icon: Presentation,
      },
    ],
  },
  {
    label: "Grow",
    tools: [
      {
        name: "SEO Workspace",
        blurb: "Titles, a structured description and a right-sized tag list, ready to paste.",
        href: "/studio/seo",
        icon: FileMagnifyingGlass,
      },
      {
        name: "Prompt Library",
        blurb: "Ready-to-use prompts for hooks, scripts, thumbnails, SEO and brand outreach.",
        href: "/studio/prompts",
        icon: Books,
      },
    ],
  },
  {
    label: "Library",
    tools: [
      {
        name: "Stock Libraries",
        blurb: "Free stock images, videos and audio with their credits attached, plus your own meme collection.",
        href: "/studio/library",
        icon: Images,
      },
      {
        name: "Projects",
        blurb: "Everything you save from the Studio tools, kept on this device.",
        href: "/studio/projects",
        icon: FolderOpen,
      },
    ],
  },
];

export default function StudioHomePage() {
  let toolIndex = 0;
  return (
    <div className="space-y-12">
      <section>
        <h2 className="text-lg font-semibold tracking-tight">
          One video, planned and packaged end to end
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          The Creator Studio is a set of dedicated tools that take a video from a
          rough topic to a publish-ready package: score the niche, pick the idea,
          write the script, add a voiceover, design the thumbnail and finish with
          SEO, each tool on its own page, with stock libraries and your saved
          projects alongside. Follow the six-step workflow below, or jump straight
          to the tool you need from the directory.
        </p>
      </section>

      <section>
        <h2 className="text-sm font-medium text-muted-foreground mb-3">
          The workflow, one video, start to finish
        </h2>
        <ol className="border-t border-border">
          {STEPS.map((step) => {
            const live = step.status === "live";
            const row = (
              <div
                className={cn(
                  "flex items-center gap-4 border-b border-border py-5 sm:gap-5",
                  !live && "opacity-60"
                )}
              >
                <span
                  aria-hidden="true"
                  className="w-8 shrink-0 font-mono text-sm tabular-nums text-muted-foreground"
                >
                  {String(step.n).padStart(2, "0")}
                </span>
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                  <step.icon className="w-5 h-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-base font-semibold">{step.name}</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
                    {step.blurb}
                  </p>
                </div>
                {live ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
                    Open <ArrowRight className="w-3.5 h-3.5" />
                  </span>
                ) : (
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    Coming in {step.status}
                  </span>
                )}
              </div>
            );
            return (
              <li key={step.n}>
                {live ? (
                  <Link href={step.href!} className="block">
                    {row}
                  </Link>
                ) : (
                  row
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <section>
        <h2 className="text-sm font-medium text-muted-foreground mb-3">All tools</h2>
        <div className="space-y-8">
          {DIRECTORY.map((group) => (
            <div key={group.label}>
              <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70 mb-1">
                {group.label}
              </h3>
              <div className="border-t border-border">
                {group.tools.map((tool) => {
                  toolIndex += 1;
                  const index = toolIndex;
                  return (
                    <Link
                      key={tool.name}
                      href={tool.href}
                      className="flex items-center gap-4 border-b border-border py-4 transition-colors hover:bg-muted/40 sm:gap-5"
                    >
                      <span
                        aria-hidden="true"
                        className="w-8 shrink-0 font-mono text-sm tabular-nums text-muted-foreground"
                      >
                        {String(index).padStart(2, "0")}
                      </span>
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                        <tool.icon className="w-4.5 h-4.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{tool.name}</span>
                        <span className="mt-0.5 block text-[13px] leading-relaxed text-muted-foreground">
                          {tool.blurb}
                        </span>
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
                        Open <ArrowRight className="w-3.5 h-3.5" />
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-border pt-6">
        <h2 className="text-sm font-medium">How the Studio stays free</h2>
        <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-muted-foreground">
          Every tool runs on a built-in engine that works offline and costs nothing. Where an
          instance has a free AI tier configured, tools can optionally enhance their output
          with it. Results are always labelled{" "}
          <span className="text-foreground font-medium">Built-in engine</span> or{" "}
          <span className="text-foreground font-medium">Free AI</span> so you know what
          produced them. Free AI quotas are shared and finite; when they run out, the
          built-in engines keep working.
        </p>
      </section>
    </div>
  );
}
