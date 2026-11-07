/**
 * Creator Studio — Niche Finder engine (Programme S1).
 *
 * A transparent, deterministic heuristic over the curated dataset in
 * niches.ts. It is NOT live market data: the same input always produces
 * the same report, every adjustment is listed in `signals`, and the UI
 * labels the result a built-in heuristic estimate.
 */

import { NICHE_DATASET, type NicheEntry } from "./niches";
import type { NicheReport, NicheSubScores, StudioCategory } from "./types";
import { STUDIO_CATEGORIES } from "./types";

/** Stable FNV-1a hash — deterministic across runs and platforms. */
export function stableHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function clamp(n: number, min = 5, max = 98): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Keyword/phrase signals that nudge the base estimate, with reasons. */
const SIGNALS: {
  match: string[];
  note: string;
  adjust: Partial<NicheSubScores>;
}[] = [
  {
    match: ["ai", "artificial intelligence", "automation"],
    note: "AI angle: demand is elevated right now, and so is incoming competition.",
    adjust: { demand: 6, competition: 5 },
  },
  {
    match: ["faceless", "no face", "without showing face"],
    note: "Faceless format: a lower production barrier raises ease of starting.",
    adjust: { easeOfStarting: 8 },
  },
  {
    match: ["hindi", "hinglish", "tamil", "telugu", "bengali", "marathi", "regional"],
    note: "Regional-language angle: demand is strong and the field is less crowded than English.",
    adjust: { demand: 5, competition: -6 },
  },
  {
    match: ["shorts", "reels", "short form"],
    note: "Short-form angle: discovery is easier, direct per-view earnings are lower.",
    adjust: { demand: 4, easeOfStarting: 5, earningPotential: -6 },
  },
  {
    match: ["beginner", "beginners", "from scratch", "zero to hero"],
    note: "Beginner-focused angle: a clear entry point raises ease of starting.",
    adjust: { easeOfStarting: 4 },
  },
];

function matchEntry(topic: string, category: StudioCategory): { entry: NicheEntry; matchedBy: "keyword" | "category" } {
  const tokens = tokenize(topic);
  const lower = ` ${topic.toLowerCase()} `;
  let best: NicheEntry | null = null;
  let bestScore = 0;
  for (const entry of NICHE_DATASET) {
    let score = 0;
    for (const kw of entry.keywords) {
      if (kw.includes(" ")) {
        if (lower.includes(` ${kw} `) || lower.includes(kw)) score += 3;
      } else if (tokens.includes(kw)) {
        score += 2;
      }
    }
    if (entry.category === category) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  if (best && bestScore >= 2) return { entry: best, matchedBy: "keyword" };

  // Fallback: the median entry of the chosen category.
  const inCategory = NICHE_DATASET.filter((e) => e.category === category);
  const pool = inCategory.length > 0 ? inCategory : NICHE_DATASET;
  const median = [...pool].sort((a, b) => a.demand - b.demand)[Math.floor(pool.length / 2)]!;
  return { entry: median, matchedBy: "category" };
}

function categoryMedian(category: StudioCategory): NicheSubScores & { cpm: string; audience: string } {
  const pool = NICHE_DATASET.filter((e) => e.category === category);
  const list = pool.length > 0 ? pool : NICHE_DATASET;
  const avg = (pick: (e: NicheEntry) => number) =>
    list.reduce((sum, e) => sum + pick(e), 0) / list.length;
  return {
    demand: avg((e) => e.demand),
    competition: avg((e) => e.competition),
    easeOfStarting: avg((e) => e.easeOfStarting),
    earningPotential: avg((e) => e.earningPotential),
    cpm: list[0]!.cpmBandInr,
    audience: list[0]!.audienceBand,
  };
}

export function verdictFor(overall: number): string {
  if (overall >= 70) return "Strong opportunity — worth committing to a series.";
  if (overall >= 55) return "Worth testing — publish a small series and measure before going all-in.";
  if (overall >= 40) return "Tough but workable — you will need a sharper angle than the average channel here.";
  return "High risk as stated — narrow the topic further or pick a clearer sub-niche.";
}

export function analyseNiche(input: { topic: string; category?: string }): NicheReport {
  const topic = input.topic.trim().slice(0, 120);
  const category: StudioCategory =
    input.category && (STUDIO_CATEGORIES as readonly string[]).includes(input.category)
      ? (input.category as StudioCategory)
      : "Other";

  const { entry, matchedBy } = matchEntry(topic, category);
  const median = categoryMedian(category);

  // Anchor: dataset entry blended with the category median (70/30 keyword
  // match, 40/60 when only the category matched).
  const w = matchedBy === "keyword" ? 0.7 : 0.4;
  const base: NicheSubScores = {
    demand: entry.demand * w + median.demand * (1 - w),
    competition: entry.competition * w + median.competition * (1 - w),
    easeOfStarting: entry.easeOfStarting * w + median.easeOfStarting * (1 - w),
    earningPotential: entry.earningPotential * w + median.earningPotential * (1 - w),
  };

  const signals: string[] = [
    matchedBy === "keyword"
      ? `Anchored to the built-in “${entry.name}” profile.`
      : `No close built-in match for this topic — estimated from the ${category} category profile.`,
  ];

  const lower = topic.toLowerCase();
  for (const signal of SIGNALS) {
    if (signal.match.some((m) => lower.includes(m))) {
      signals.push(signal.note);
      for (const [key, delta] of Object.entries(signal.adjust)) {
        base[key as keyof NicheSubScores] += delta ?? 0;
      }
    }
  }

  // Small deterministic per-topic variation (±4) so neighbouring topics do
  // not all return identical numbers. Hash-derived — never random.
  const h = stableHash(`${category}::${lower}`);
  const jitter = (salt: number) => ((h >> salt) % 9) - 4;
  const subScores: NicheSubScores = {
    demand: clamp(base.demand + jitter(0)),
    competition: clamp(base.competition + jitter(3)),
    easeOfStarting: clamp(base.easeOfStarting + jitter(6)),
    earningPotential: clamp(base.earningPotential + jitter(9)),
  };

  const overall = clamp(
    subScores.demand * 0.3 +
      (100 - subScores.competition) * 0.25 +
      subScores.easeOfStarting * 0.2 +
      subScores.earningPotential * 0.25,
    5,
    97
  );

  return {
    topic,
    category,
    matchedNiche: entry.name,
    overall,
    subScores,
    audienceBand: entry.audienceBand,
    cpmBandInr: entry.cpmBandInr,
    verdict: verdictFor(overall),
    signals,
    heuristic: true,
  };
}
