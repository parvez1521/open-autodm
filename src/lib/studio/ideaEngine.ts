/**
 * Creator Studio — Next Video Ideas engine (Programme S1).
 *
 * Offline generator: original format/question/angle templates composed
 * with the creator's topic. Selection is deterministic (hash-rotated) so
 * the same input returns the same list, results never repeat within a
 * list, and every mode is covered by its own bank. The Groq-backed route
 * can enhance this list when configured; this engine is the always-on
 * base and the fallback.
 */

import type { IdeaItem, IdeaMode, StudioCategory } from "./types";
import { stableHash } from "./nicheEngine";

interface IdeaTemplate {
  title: string;
  format: string;
  whyItWorks: string;
}

/** {topic} = the creator's topic, {category} = the Studio category. */
const PROVEN_FORMATS: IdeaTemplate[] = [
  { title: "{topic}: 7 mistakes almost every beginner makes", format: "Mistake list", whyItWorks: "Mistake lists promise avoided pain, which holds attention to the end." },
  { title: "I tried {topic} for 30 days — here is what actually happened", format: "30-day test", whyItWorks: "A time-bound personal test creates a built-in story arc and a result viewers wait for." },
  { title: "{topic} tier list: beginner to pro, ranked honestly", format: "Tier list", whyItWorks: "Rankings invite disagreement, and disagreement drives comments." },
  { title: "The complete beginner roadmap for {topic} (start to finish)", format: "Roadmap", whyItWorks: "Roadmaps are saved and shared because they remove decision fatigue." },
  { title: "{topic} on a budget vs premium — is the upgrade worth it?", format: "Comparison", whyItWorks: "A clear either/or question earns clicks from buyers and learners alike." },
  { title: "5 {topic} tools I wish I had found earlier", format: "Tool roundup", whyItWorks: "Tool roundups package several small payoffs into one video." },
  { title: "Stop doing {topic} like this — do this instead", format: "Myth-bust", whyItWorks: "Correcting a common habit pattern interrupts scrolling and builds authority." },
  { title: "{topic} explained in 10 minutes (no jargon)", format: "Explainer", whyItWorks: "A plain-language promise widens the audience beyond existing fans." },
  { title: "I rated 10 popular {topic} opinions — most are wrong", format: "Reaction / rating", whyItWorks: "Rating familiar opinions gives viewers a position to agree or fight with." },
  { title: "One week of {topic}: my daily routine, results and costs", format: "Routine diary", whyItWorks: "Specifics (days, numbers, costs) make the video feel honest and rewatchable." },
  { title: "The {topic} checklist I follow before every project", format: "Checklist", whyItWorks: "Checklists are high-save content; saves signal quality to the algorithm." },
  { title: "{topic} for {category} beginners: your first 7 days, planned", format: "Starter plan", whyItWorks: "A dated plan converts vague interest into a follow-along series." },
];

const AUDIENCE_QUESTIONS: IdeaTemplate[] = [
  { title: "Why does {topic} work for some people and fail for others?", format: "Question-led", whyItWorks: "It names the frustration viewers already feel but cannot explain." },
  { title: "What nobody tells you before starting {topic}", format: "Untold truths", whyItWorks: "Promises insider honesty — the gap between expectation and reality." },
  { title: "Is {topic} still worth it this year? An honest answer", format: "Honest take", whyItWorks: "Timeliness plus honesty is a strong click combination for returning viewers." },
  { title: "How long does {topic} actually take to show results?", format: "Timeline answer", whyItWorks: "Sets realistic expectations — the question every beginner searches first." },
  { title: "What should you do when {topic} stops working?", format: "Troubleshooting", whyItWorks: "Troubleshooting videos capture high-intent search traffic for months." },
  { title: "Can you do {topic} with zero budget? I worked it out", format: "Zero-budget test", whyItWorks: "Removes the most common excuse and objection in one promise." },
  { title: "The questions I get asked most about {topic} — answered", format: "Q&A", whyItWorks: "Real audience questions double as proof of demand for each segment." },
  { title: "What is the difference between cheap and good {topic}?", format: "Difference explainer", whyItWorks: "Sharpens buying decisions, which keeps viewers until the verdict." },
  { title: "Why do experts disagree about {topic}?", format: "Debate explainer", whyItWorks: "Presenting both sides fairly builds trust and comment volume." },
  { title: "If I started {topic} from zero today, what would I do first?", format: "Restart plan", whyItWorks: "The restart framing makes experienced advice feel directly usable." },
];

const TRENDING_ANGLES: IdeaTemplate[] = [
  { title: "{topic} in the age of AI: what changed and what did not", format: "Trend angle", whyItWorks: "AI is the question hanging over every niche; addressing it head-on captures the moment." },
  { title: "I let an AI plan my {topic} for a week — surprising results", format: "AI experiment", whyItWorks: "An experiment with an unpredictable outcome is naturally bingeable." },
  { title: "{topic}: old way vs new way (the gap is bigger than you think)", format: "Old vs new", whyItWorks: "Contrast framing makes progress visible in the first three seconds." },
  { title: "The {topic} trend everyone is copying — and why most fail at it", format: "Trend autopsy", whyItWorks: "Explaining a visible trend's failures positions you as the honest voice." },
  { title: "Small channels are winning at {topic} with this one shift", format: "Underdog angle", whyItWorks: "Viewers identify with small creators far more than with big names." },
  { title: "{topic} predictions: what will matter most in the next 12 months", format: "Predictions", whyItWorks: "Predictions get bookmarked and revisited — and argued with, which helps reach." },
  { title: "I copied a top {category} creator's {topic} strategy for 14 days", format: "Strategy copy test", whyItWorks: "Borrowed credibility plus a personal test equals a strong hook." },
  { title: "The hidden cost of {topic} nobody posts about", format: "Hidden cost", whyItWorks: "Money and time costs are concrete, emotional and rarely discussed." },
  { title: "{topic} but make it local: what works specifically for Indian audiences", format: "Local angle", whyItWorks: "Local specificity is underserved by global channels and builds loyal community." },
  { title: "Rating viral {topic} advice: genius or nonsense?", format: "Viral audit", whyItWorks: "Auditing viral claims rides existing search demand while adding judgement." },
];

const BANKS: Record<IdeaMode, IdeaTemplate[]> = {
  proven: PROVEN_FORMATS,
  questions: AUDIENCE_QUESTIONS,
  angles: TRENDING_ANGLES,
};

export const IDEA_MODE_LABELS: Record<IdeaMode, string> = {
  proven: "Proven formats",
  questions: "Unanswered audience questions",
  angles: "Trending angles",
};

function fill(template: string, topic: string, category: StudioCategory): string {
  const t = topic.trim();
  const titled = t.length > 0 ? t : category;
  return template
    .replaceAll("{topic}", titled)
    .replaceAll("{category}", category);
}

/**
 * Deterministic selection: the bank is rotated by a hash of the inputs so
 * repeat calls agree, then taken in order — guaranteed duplicate-free.
 */
export function generateIdeas(input: {
  topic: string;
  category: StudioCategory;
  mode: IdeaMode;
  count?: number;
}): IdeaItem[] {
  const count = Math.min(Math.max(input.count ?? 6, 1), 12);
  const bank = BANKS[input.mode];
  const seed = stableHash(`${input.mode}::${input.category}::${input.topic.trim().toLowerCase()}`);
  const start = seed % bank.length;
  const out: IdeaItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < bank.length && out.length < count; i++) {
    const tpl = bank[(start + i) % bank.length]!;
    const title = fill(tpl.title, input.topic, input.category);
    if (seen.has(title)) continue;
    seen.add(title);
    out.push({ title, format: tpl.format, whyItWorks: tpl.whyItWorks, mode: input.mode, engine: "built-in" });
  }
  return out;
}
