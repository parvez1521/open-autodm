/**
 * Creator Studio — SEO Workspace engine (Programme S1).
 *
 * Fully offline. Builds a discoverability pack for a video: title options
 * (with character counts measured against YouTube's 100-character title
 * ceiling), a structured description, and a tag list sized to YouTube's
 * ~500-character tag budget. All text is generated from original
 * templates and per-category tag banks — nothing is fetched.
 */

import type { SeoPack, SeoTitleOption, StudioCategory } from "./types";

/** Generic per-category tag banks (original, plain-language search terms). */
const CATEGORY_TAGS: Partial<Record<StudioCategory, string[]>> = {
  "Tech & AI Tools": ["ai tools", "best ai tools", "tech tutorials", "new apps", "productivity tools", "software review"],
  Education: ["study tips", "exam preparation", "learn online", "student guide", "education channel"],
  Fitness: ["home workout", "fitness tips", "weight loss journey", "workout routine", "healthy lifestyle"],
  "Finance & Business": ["personal finance", "investing for beginners", "money tips", "side hustle ideas", "business ideas"],
  Motivation: ["self improvement", "motivation", "success habits", "mindset", "daily routine"],
  "Comedy & Entertainment": ["comedy video", "funny video", "entertainment", "viral video", "sketch comedy"],
  Food: ["recipe video", "cooking at home", "easy recipes", "food lover", "kitchen tips"],
  Travel: ["travel vlog", "travel guide", "budget travel", "places to visit", "trip planning"],
  "Beauty & Fashion": ["beauty tips", "skincare routine", "makeup tutorial", "fashion haul", "glow up"],
  Gaming: ["gaming video", "gameplay", "gaming tips", "live gaming", "game review"],
  Music: ["music video", "cover song", "music tutorial", "new music", "live performance"],
  "DIY & Home": ["diy projects", "home decor ideas", "craft ideas", "home hacks", "handmade"],
  Other: ["how to", "beginner guide", "tips and tricks", "step by step"],
};

const TITLE_TEMPLATES: { make: (t: string) => string; note: string }[] = [
  { make: (t) => `${cap(t)} — Complete Beginner Guide`, note: "Evergreen guide framing; strong for search." },
  { make: (t) => `How to get started with ${decap(t)} (step by step)`, note: "How-to phrasing matches how viewers search." },
  { make: (t) => `${cap(t)}: 5 things I wish I knew earlier`, note: "Number + regret hook; good click-through potential." },
  { make: (t) => `I tried ${decap(t)} for 30 days — honest results`, note: "Personal-test framing; results promise keeps viewers watching." },
  { make: (t) => `${cap(t)} explained simply (no jargon)`, note: "Plain-language promise widens the audience." },
  { make: (t) => `Stop doing ${decap(t)} wrong — watch this first`, note: "Correction hook; use only if the video genuinely fixes a mistake." },
  { make: (t) => `${cap(t)} vs the old way: which is actually better?`, note: "Comparison question; invites comments." },
  { make: (t) => `${cap(t)} — full breakdown with examples`, note: "Depth promise; suits longer, save-worthy videos." },
];

function cap(s: string): string {
  const t = s.trim();
  return t.length > 0 ? t[0]!.toUpperCase() + t.slice(1) : t;
}

function decap(s: string): string {
  const t = s.trim();
  return t.length > 0 ? t[0]!.toLowerCase() + t.slice(1) : t;
}

export function titleNote(charCount: number): string {
  if (charCount > 100) return "Over YouTube's 100-character title limit — trim before publishing.";
  if (charCount > 70) return "Within the limit; the end may be cut off in some feeds — keep the hook early.";
  if (charCount < 30) return "Short title — fine for browse traffic, but add a keyword for search.";
  return "Comfortable length for search and browse.";
}

/** Split a topic into useful tag phrases: full topic, then word n-grams. */
export function topicTags(topic: string): string[] {
  const clean = topic.trim().toLowerCase().replace(/\s+/g, " ");
  if (!clean) return [];
  const words = clean.split(" ").filter(Boolean);
  const out: string[] = [clean];
  for (let n = Math.min(3, words.length - 1); n >= 2; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      out.push(words.slice(i, i + n).join(" "));
    }
  }
  if (words.length > 1) out.push(...words.filter((w) => w.length > 3));
  return out;
}

/** Assemble tags until the ~500-char total budget (incl. separators) is hit. */
export function assembleTags(candidates: string[], budget = 500): { tags: string[]; totalChars: number } {
  const seen = new Set<string>();
  const tags: string[] = [];
  let total = 0;
  for (const raw of candidates) {
    const tag = raw.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    const cost = tag.length + (tags.length > 0 ? 2 : 0); // ", " separator
    if (total + cost > budget) continue;
    seen.add(tag);
    tags.push(tag);
    total += cost;
  }
  return { tags, totalChars: total };
}

export function buildSeoPack(input: {
  topic: string;
  category: StudioCategory;
  keywords?: string;
}): SeoPack {
  const topic = input.topic.trim().slice(0, 120) || input.category;
  const extraKeywords = (input.keywords ?? "")
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

  const titles: SeoTitleOption[] = TITLE_TEMPLATES.map((tpl) => {
    const title = tpl.make(topic);
    return { title, charCount: title.length, note: `${tpl.note} ${titleNote(title.length)}` };
  });

  const bank = CATEGORY_TAGS[input.category] ?? CATEGORY_TAGS.Other!;
  const { tags, totalChars } = assembleTags([
    ...topicTags(topic),
    ...extraKeywords,
    ...bank,
    `${topic.toLowerCase()} tutorial`,
    `${topic.toLowerCase()} guide`,
    `${topic.toLowerCase()} tips`,
  ]);
  const hashtags = tags.slice(0, 3).map((t) => `#${t.replace(/\s+/g, "")}`);

  const description = [
    `${cap(topic)} — everything you need to know, explained step by step.`,
    "",
    "In this video:",
    "• The essentials, in plain language",
    "• The mistakes most beginners make (and how to avoid them)",
    "• A simple plan you can start today",
    "",
    "Timestamps:",
    "0:00 Intro",
    "0:45 The basics",
    "4:30 Step-by-step walkthrough",
    "9:15 Common mistakes",
    "12:00 Summary & next steps",
    "",
    "Links & resources:",
    "[Add your links here]",
    "",
    "If this helped, subscribe for a new video every week.",
    "",
    hashtags.join(" "),
  ].join("\n");

  return { topic, category: input.category, titles, description, tags, tagsCharCount: totalChars, hashtags };
}
