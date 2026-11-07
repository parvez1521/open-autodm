"use client";

/**
 * Creator Studio sub-navigation (Programmes S1 + S2 + S3).
 *
 * Every entry is a live route since S3 completed the section: the
 * tools, and the four library surfaces as tabs of /studio/library.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Compass,
  Crosshair,
  Lightbulb,
  PenLine,
  AudioLines,
  FileText,
  Image as ImageIcon,
  Presentation,
  SearchCheck,
  LibraryBig,
  FolderOpen,
  Images,
  Clapperboard,
  Music4,
  Laugh,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface NavEntry {
  name: string;
  href?: string;
  icon: React.ComponentType<{ className?: string }>;
  soon?: string; // programme label, e.g. "S2"
}

const TOOLS: NavEntry[] = [
  { name: "Workflow", href: "/studio", icon: Compass },
  { name: "Niche Finder", href: "/studio/niche", icon: Crosshair },
  { name: "Next Video Ideas", href: "/studio/ideas", icon: Lightbulb },
  { name: "Script Builder", href: "/studio/script", icon: PenLine },
  { name: "Voiceover Studio", href: "/studio/voiceover", icon: AudioLines },
  { name: "Transcript Tools", href: "/studio/transcript", icon: FileText },
  { name: "Thumbnail Editor", href: "/studio/thumbnail", icon: ImageIcon },
  { name: "Presentations", href: "/studio/presentations", icon: Presentation },
  { name: "SEO Workspace", href: "/studio/seo", icon: SearchCheck },
  { name: "Prompt Library", href: "/studio/prompts", icon: LibraryBig },
  { name: "Projects", href: "/studio/projects", icon: FolderOpen },
];

const LIBRARIES: NavEntry[] = [
  { name: "Stock Images", href: "/studio/library?tab=images", icon: Images },
  { name: "Stock Videos", href: "/studio/library?tab=videos", icon: Clapperboard },
  { name: "Stock Audio", href: "/studio/library?tab=audio", icon: Music4 },
  { name: "Meme Library", href: "/studio/library?tab=memes", icon: Laugh },
];

function Entry({ entry, pathname }: { entry: NavEntry; pathname: string }) {
  // Library entries carry a ?tab= query; active state compares paths only.
  const entryPath = entry.href?.split("?")[0];
  const isActive =
    entryPath !== undefined &&
    (entryPath === "/studio" ? pathname === "/studio" : pathname.startsWith(entryPath));
  if (!entry.href) {
    return (
      <span
        className="inline-flex items-center gap-2 rounded-full border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground/70"
        title={`Coming in ${entry.soon}`}
        aria-disabled="true"
      >
        <entry.icon className="w-3.5 h-3.5" />
        {entry.name}
        <span className="rounded-full bg-muted px-1.5 py-px text-[10px] font-medium">
          {entry.soon}
        </span>
      </span>
    );
  }
  return (
    <Link
      href={entry.href}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors",
        isActive
          ? "border-primary/50 bg-primary/10 text-foreground font-medium"
          : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/60"
      )}
    >
      <entry.icon className="w-3.5 h-3.5" />
      {entry.name}
    </Link>
  );
}

export function StudioNav() {
  const pathname = usePathname();
  return (
    <div className="mb-6 space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {TOOLS.map((e) => (
          <Entry key={e.name} entry={e} pathname={pathname} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70 pr-1">
          Libraries
        </span>
        {LIBRARIES.map((e) => (
          <Entry key={e.name} entry={e} pathname={pathname} />
        ))}
      </div>
    </div>
  );
}
