"use client";

/**
 * Creator Studio sub-navigation (Programmes S1 + S2 + S3; sidebar
 * layout from the Studio restructure).
 *
 * A grouped vertical sidebar on large screens — Overview / Create /
 * Grow / Library — that collapses to a horizontally scrolling row of
 * the same groups on smaller screens. Every entry is a live route:
 * the tools, and the four library surfaces as tabs of /studio/library.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Compass,
  Crosshair,
  Lightbulb,
  PencilLine,
  Waveform,
  FileText,
  Image as ImageIcon,
  Presentation,
  FileMagnifyingGlass,
  Books,
  FolderOpen,
  Images,
  FilmSlate,
  MusicNote,
  Smiley,
} from "@/components/phosphor";
import { cn } from "@/lib/utils";

interface NavEntry {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface NavGroup {
  label: string;
  entries: NavEntry[];
}

const GROUPS: NavGroup[] = [
  {
    label: "Overview",
    entries: [{ name: "Workflow", href: "/studio", icon: Compass }],
  },
  {
    label: "Create",
    entries: [
      { name: "Niche Finder", href: "/studio/niche", icon: Crosshair },
      { name: "Next Video Ideas", href: "/studio/ideas", icon: Lightbulb },
      { name: "Script Builder", href: "/studio/script", icon: PencilLine },
      { name: "Voiceover Studio", href: "/studio/voiceover", icon: Waveform },
      { name: "Transcript Tools", href: "/studio/transcript", icon: FileText },
      { name: "Thumbnail Editor", href: "/studio/thumbnail", icon: ImageIcon },
      { name: "Presentations", href: "/studio/presentations", icon: Presentation },
    ],
  },
  {
    label: "Grow",
    entries: [
      { name: "SEO Workspace", href: "/studio/seo", icon: FileMagnifyingGlass },
      { name: "Prompt Library", href: "/studio/prompts", icon: Books },
    ],
  },
  {
    label: "Library",
    entries: [
      { name: "Stock Images", href: "/studio/library?tab=images", icon: Images },
      { name: "Stock Videos", href: "/studio/library?tab=videos", icon: FilmSlate },
      { name: "Stock Audio", href: "/studio/library?tab=audio", icon: MusicNote },
      { name: "Meme Library", href: "/studio/library?tab=memes", icon: Smiley },
      { name: "Projects", href: "/studio/projects", icon: FolderOpen },
    ],
  },
];

function Entry({ entry, pathname }: { entry: NavEntry; pathname: string }) {
  // Library entries carry a ?tab= query; active state compares paths only.
  const entryPath = entry.href.split("?")[0] ?? entry.href;
  const isActive =
    entryPath === "/studio" ? pathname === "/studio" : pathname.startsWith(entryPath);
  return (
    <Link
      href={entry.href}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors",
        isActive
          ? "bg-primary/10 font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      )}
    >
      <entry.icon className="w-4 h-4 shrink-0" />
      {entry.name}
    </Link>
  );
}

export function StudioNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Creator Studio"
      className="flex gap-6 overflow-x-auto pb-1 lg:flex-col lg:gap-5 lg:overflow-visible lg:pb-0"
    >
      {GROUPS.map((group) => (
        <div key={group.label} className="min-w-max lg:min-w-0">
          <p className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {group.label}
          </p>
          <div className="flex gap-1 lg:flex-col">
            {group.entries.map((e) => (
              <Entry key={e.name} entry={e} pathname={pathname} />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
