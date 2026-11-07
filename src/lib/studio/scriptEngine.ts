/**
 * Creator Studio — Script Builder engine (Programme S2).
 *
 * Offline generator: original speakable script scaffolding composed with
 * the creator's topic, in one of three formats and four tones. Selection
 * from the template banks is deterministic (rotated by a stable hash of
 * topic + tone + format) so the same input always returns the same draft.
 *
 * Timing model: short formats are timed from the text itself at a
 * natural speaking pace (SPEAKING_WPM). Long-form output is an outline,
 * not a word-for-word script, so its sections carry planned time slots
 * instead of text-derived timings.
 *
 * Source material: when the creator supplies source text (notes, an
 * article, a cleaned transcript), the strongest sentences — scored by
 * topic relevance with a length-fit tiebreak — are woven verbatim into
 * the main-point sections, and the draft is flagged accordingly.
 */

import { stableHash } from "./nicheEngine";
import type {
  ScriptDraft,
  ScriptFormat,
  ScriptSection,
  ScriptTone,
} from "./types";

/** Natural speaking pace used to time short-format scripts. */
export const SPEAKING_WPM = 150;

export const SCRIPT_FORMAT_OPTIONS: { id: ScriptFormat; label: string; blurb: string }[] = [
  {
    id: "reel30",
    label: "Reel / Short · 30s",
    blurb: "A tight half-minute cut: hook, quick setup, two points, payoff, call to action.",
  },
  {
    id: "short60",
    label: "Short · 60s",
    blurb: "A fuller minute: the same arc with three points and room to breathe.",
  },
  {
    id: "longform",
    label: "Long-form outline",
    blurb: "A planned outline for a longer video: what to cover, show and say, section by section.",
  },
];

export const SCRIPT_TONE_OPTIONS: { id: ScriptTone; label: string }[] = [
  { id: "energetic", label: "Energetic" },
  { id: "educational", label: "Educational" },
  { id: "calm", label: "Calm" },
  { id: "bold", label: "Bold" },
];

// ── Word counting & timing ─────────────────────────────────────────

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function spokenSeconds(text: string): number {
  const words = countWords(text);
  if (words === 0) return 0;
  return Math.max(1, Math.round((words / SPEAKING_WPM) * 60));
}

export function formatDuration(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// ── Source-material extraction ─────────────────────────────────────

function normalizeSentence(raw: string): string {
  let t = raw.trim().replace(/\s+/g, " ");
  if (t.length > 300) t = t.slice(0, 300).trimEnd();
  if (t.length > 0) t = t.charAt(0).toUpperCase() + t.slice(1);
  if (!/[.!?]$/.test(t)) {
    if (t.length >= 300) t = t.slice(0, 299);
    t += ".";
  }
  return t;
}

/**
 * Picks the strongest sentences from supplied source material.
 *
 * The source is split into sentences on `.`, `!`, `?` and newlines.
 * Candidates of 6–40 words are scored: 3 points per distinct topic token
 * (lowercased words longer than 2 characters) present in the sentence,
 * plus a length-fit bonus that peaks near 18 words and acts as a
 * tiebreak. The top `maxPoints` by score are returned in their original
 * document order, trimmed, capped at 300 characters, sentence-cased and
 * closed with terminal punctuation. Fully deterministic.
 */
export function extractKeyPoints(sourceText: string, topic: string, maxPoints: number): string[] {
  if (!sourceText || !sourceText.trim() || maxPoints <= 0) return [];

  const topicTokens = new Set(
    (topic.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2)
  );

  interface Candidate {
    index: number;
    text: string;
    score: number;
  }
  const candidates: Candidate[] = [];
  const fragments = sourceText.split(/[.!?\n]+/);
  fragments.forEach((fragment, index) => {
    const text = fragment.trim();
    if (!text) return;
    const words = countWords(text);
    if (words < 6 || words > 40) return;
    const wordSet = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    let matched = 0;
    for (const token of topicTokens) {
      if (wordSet.has(token)) matched += 1;
    }
    const lengthBonus = 1 - Math.min(1, Math.abs(words - 18) / 18);
    candidates.push({ index, text, score: 3 * matched + lengthBonus });
  });

  const top = [...candidates]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxPoints);
  top.sort((a, b) => a.index - b.index);
  return top.map((c) => normalizeSentence(c.text));
}

// ── Template banks (all copy original to Studio) ───────────────────

interface ShortPoint {
  /** The line the creator actually says out loud. */
  speak: string;
  /** Short practical guidance shown after the "On screen:" prefix. */
  visual: string;
}

interface ToneBank {
  hooks: string[];
  setups: string[];
  points: ShortPoint[];
  payoffs: string[];
  ctas: string[];
}

const SHORT_BANKS: Record<ScriptTone, ToneBank> = {
  energetic: {
    hooks: [
      "Stop scrolling! {topic} is easier than it looks, and I will prove it fast.",
      "You are doing {topic} the hard way. Here is the faster way, starting now.",
      "Watch this if {topic} has ever felt confusing, slow, or just plain frustrating.",
    ],
    setups: [
      "Quick context first: most people overcomplicate {topic}, so we will keep this simple and practical.",
      "Here is the situation: you want results from {topic} without wasting time, money, or energy.",
      "No fluff and no theory overload. Just the parts of {topic} that actually move the needle.",
    ],
    points: [
      { speak: "Start smaller than you think. One finished step beats a perfect plan.", visual: "circle the first step." },
      { speak: "Copy what already works before you improvise. Proven beats original at the start.", visual: "show a working example." },
      { speak: "Fix one bottleneck at a time. Small fixes stack up surprisingly fast.", visual: "highlight the bottleneck." },
      { speak: "Track the result, not the effort. Numbers tell you what to do next.", visual: "show before and after." },
    ],
    payoffs: [
      "Do those steps and {topic} stops feeling overwhelming and starts feeling doable today.",
      "That is the whole play: simple steps, done in order, and {topic} finally clicks.",
      "Stick with this for a week and you will feel the difference with {topic}.",
    ],
    ctas: [
      "Follow for part two, and save this for later.",
      "Try step one today, then tell me how it went below.",
      "Save this video, share it with a friend, and follow for more.",
    ],
  },
  educational: {
    hooks: [
      "Let us break down {topic} properly, one clear idea at a time.",
      "Once you see how the pieces fit, {topic} starts to make sense.",
      "Here is {topic} explained simply, without the jargon that usually surrounds it.",
    ],
    setups: [
      "First, a little background, because {topic} is much easier once the basics are clear.",
      "Think of this as a short lesson: definitions first, then examples, then practice with {topic}.",
      "We will go step by step, and by the end {topic} should feel genuinely clear.",
    ],
    points: [
      { speak: "Start with the definition. Clear terms remove half the confusion.", visual: "define the key term." },
      { speak: "Look at one concrete example. Examples make abstract ideas usable.", visual: "walk through one example." },
      { speak: "Notice the pattern underneath. Most topics repeat the same few moves.", visual: "underline the repeating pattern." },
      { speak: "Finally, test your understanding. Explaining it back is where learning sticks.", visual: "pose a quick check question." },
    ],
    payoffs: [
      "Understand those pieces and {topic} becomes a skill you can keep building on.",
      "That is {topic} in plain language: clear ideas, practised in the right order.",
      "Learn it in this order and {topic} will feel far less intimidating.",
    ],
    ctas: [
      "Save this lesson for revision, and follow for the next one.",
      "Ask your questions below, and save this for later.",
      "Follow for the next lesson, where we go one level deeper.",
    ],
  },
  calm: {
    hooks: [
      "Let us take {topic} slowly, one calm and simple step at a time.",
      "No rush and no pressure. Here is a gentle way into {topic} that actually sticks.",
      "If {topic} has felt like too much lately, this softer approach may help.",
    ],
    setups: [
      "We will keep this unhurried: a few clear ideas about {topic}, explained at an easy pace.",
      "Find a comfortable moment, and let us look at {topic} without any noise or hurry.",
      "Think of this as a quiet walkthrough. Small steps, plain words, and {topic} made manageable.",
    ],
    points: [
      { speak: "Begin with the easiest part. A gentle start lightens everything after it.", visual: "show the first step." },
      { speak: "Move at a pace you can keep. Steady beats fast, every time.", visual: "show a steady rhythm." },
      { speak: "When it feels heavy, simplify. One small thing done well is enough.", visual: "cross out the extras." },
      { speak: "End each session kindly. Noticing small progress keeps the habit alive.", visual: "note one small win." },
    ],
    payoffs: [
      "Taken gently, {topic} becomes something you can return to without dread.",
      "That is enough for today. A calmer approach to {topic} still gets you there.",
      "Small, steady steps with {topic} add up to real change over time.",
    ],
    ctas: [
      "Save this for later, and follow at your own pace.",
      "Share this with someone who needs a gentler start today.",
      "Follow for the next gentle step, whenever you are ready for it.",
    ],
  },
  bold: {
    hooks: [
      "Unpopular opinion: most advice about {topic} is wrong, and I can show you why.",
      "Forget the safe advice. {topic} rewards people who are willing to be direct.",
      "I am going to say the quiet part out loud about {topic} today.",
    ],
    setups: [
      "Let us be honest about {topic}: the comfortable version rarely gets anyone anywhere.",
      "This is not the polite take on {topic}. It is the one that actually works.",
      "Here is the deal with {topic}: excuses feel good and deliver absolutely nothing.",
    ],
    points: [
      { speak: "Say the hard thing first. Clarity beats comfort in almost every situation.", visual: "big bold claim text." },
      { speak: "Cut what is not working, even if you like it. Sentiment is expensive.", visual: "strike the weak option." },
      { speak: "Make the decision and own it. Half-decisions drain more energy than wrong ones.", visual: "show the decision, underlined." },
      { speak: "Charge what it is worth. Underpricing teaches people to undervalue you.", visual: "show the price plainly." },
    ],
    payoffs: [
      "Be direct about {topic} and the right people will respect you for it.",
      "That is the honest version of {topic}. Take it or leave it, it works.",
      "Do it boldly or not at all: {topic} does not reward half measures.",
    ],
    ctas: [
      "Disagree? Good. Tell me why in the comments, and follow for more.",
      "Share this with someone playing it safe, and follow for more.",
      "Follow if you want the honest version, not the comfortable one.",
    ],
  },
};

/** Extra lines that stretch a reel30 arc into a fuller short60 arc. */
const HOOK_KICKERS: string[] = [
  "Give me one minute and watch.",
  "Stay to the end for the payoff.",
  "This works even on your busiest days.",
];

const SETUP_EXTENSIONS: string[] = [
  "By the end, you will know the exact order to follow.",
  "We will keep the why brief and focus on the how.",
  "Everything here is beginner friendly, and nothing needs special equipment or tools.",
];

const POINT_DETAILS: string[] = [
  "Try it once, notice, then adjust one thing.",
  "Write it down; memory drops details fast.",
  "Awkward at first is normal; it passes.",
  "Repeat it twice this week; it sticks.",
];

const PAYOFF_EXTENSIONS: string[] = [
  "That is genuinely all there is to it.",
  "Simple, repeatable, and it compounds over time.",
  "The difference shows up sooner than you expect.",
];

const CTA_EXTENSIONS: string[] = [
  "New videos like this every week.",
  "Part two is already on my list.",
  "Bring a friend who needs this too.",
];

/** Long-form outline banks: what to cover, show and say per section. */
interface LongformBank {
  hooks: string[];
  setups: string[];
  points: string[];
  payoffs: string[];
  ctas: string[];
}

const LONGFORM_BANKS: Record<ScriptTone, LongformBank> = {
  energetic: {
    hooks: [
      "Open with energy: name the viewer's problem with {topic} in one sharp line.\nPromise the payoff early: what they will be able to do by the end.\nOn screen: bold title card with the topic and one striking visual.",
      "Start mid-action: show the end result of {topic} before explaining anything.\nAsk the question your viewers are already asking themselves.\nOn screen: quick montage of the best moments, cut fast.",
      "Lead with a surprising fact or a common failure in {topic}.\nTell viewers exactly why the next few minutes are worth it.\nOn screen: the surprising fact in large type.",
    ],
    setups: [
      "Set the scene: who this video is for and what level it assumes.\nPreview the roadmap: the main points you will cover, in order.\nOn screen: simple chapter list.",
      "Give brief context on why {topic} matters right now.\nState what you will not cover, so expectations stay clear.\nOn screen: roadmap graphic with today's chapters.",
    ],
    points: [
      "Cover the first core idea behind {topic}, in plain language.\nShow a real example on screen and narrate what to notice.\nSay the takeaway in one sentence before moving on.",
      "Cover the most common mistake people make with {topic}.\nShow what the mistake looks like, then the corrected version.\nSay why the fix works, briefly and concretely.",
      "Cover a practical step viewers can copy today.\nShow the step being done, start to finish, without skipping.\nSay what result to expect and how soon.",
      "Cover the detail most tutorials skip about {topic}.\nShow a close-up or a slower replay of the key moment.\nSay how this detail changes the outcome.",
    ],
    payoffs: [
      "Recap the main points in one fast pass, in the order covered.\nShow the end result one more time as proof.\nSay the single idea to remember if everything else is forgotten.",
      "Bring it together: how the points combine into one simple routine for {topic}.\nShow the routine as a clean checklist.\nSay what consistent practice looks like after a month.",
    ],
    ctas: [
      "Ask viewers to subscribe for the follow-up video on {topic}.\nPoint to the related video or playlist on the end screen.\nSay exactly what to comment: their biggest takeaway.",
      "Invite viewers to try the routine and report back in the comments.\nPin a comment with the checklist so it is easy to find.\nOn screen: end card with the next video.",
    ],
  },
  educational: {
    hooks: [
      "Open with the key question this video answers about {topic}.\nDefine the goal: what viewers will understand by the end.\nOn screen: the central question in clear type.",
      "Start with a short, relatable example that raises the puzzle of {topic}.\nPromise a jargon-free explanation, step by step.\nOn screen: the example, paused at the puzzling moment.",
      "State the misconception most learners bring to {topic}.\nPromise to replace it with a clearer mental model.\nOn screen: the misconception, crossed out.",
    ],
    setups: [
      "Lay the foundations: the two or three terms viewers need first.\nShow how those terms relate with a simple diagram.\nSay how the rest of the video builds on them.",
      "Give the roadmap: concepts in the order they will be taught.\nNote any materials or prior knowledge that helps.\nOn screen: chapter list with timings.",
    ],
    points: [
      "Teach the concept, starting from its definition.\nWork one example slowly, narrating each step.\nSay the rule of thumb that captures the idea.",
      "Compare two approaches to {topic} side by side.\nShow where each one works and where it breaks down.\nSay how to choose between them.",
      "Walk through a worked example from start to finish.\nPause at the step learners usually get wrong.\nSay how to check the answer independently.",
      "Connect this idea back to the foundations from the setup.\nShow the same idea in a second, different example.\nSay what changes and what stays the same.",
    ],
    payoffs: [
      "Summarise the lesson as a short list of principles.\nShow the principles together on one clean slide.\nSay which principle matters most for beginners.",
      "Revisit the opening question and answer it directly now.\nShow how each main point contributed to the answer.\nSay what to study next to go deeper.",
    ],
    ctas: [
      "Invite questions in the comments and answer the best ones next time.\nPoint learners to the practice resource or playlist.\nOn screen: end card with the next lesson.",
      "Ask viewers to explain the key idea back in their own words below.\nSubscribe ask, framed as the next lesson in the series.\nOn screen: the series playlist.",
    ],
  },
  calm: {
    hooks: [
      "Open quietly: one reassuring line about {topic} and who it helps.\nSet a gentle pace promise: no rush, no overwhelm.\nOn screen: soft title card, uncluttered.",
      "Begin with a small, calming result viewers can picture.\nSay plainly what this video will and will not ask of them.\nOn screen: one peaceful visual, held a moment longer than usual.",
      "Acknowledge that {topic} can feel like a lot, and that is normal.\nOffer the slower path this video will take.\nOn screen: a short, simple agenda.",
    ],
    setups: [
      "Explain the gentle approach and why it works for {topic}.\nPreview just a few points, so the video feels manageable.\nOn screen: the short agenda again, highlighted softly.",
      "Share a little context: how you came to this calmer way of doing {topic}.\nSet expectations about pace and pauses.\nOn screen: nothing busy; keep the frame simple.",
    ],
    points: [
      "Introduce the first small step, and nothing beyond it yet.\nShow it done slowly, with time to follow along.\nSay how it should feel when it is working.",
      "Add one gentle refinement to what viewers already practised.\nShow the difference it makes, without exaggerating.\nSay when to move on and when to stay longer.",
      "Cover the moment people usually give up on {topic}.\nShow a kinder way through that moment.\nSay the reassuring truth about slow progress.",
      "Cover how to make the practice fit an ordinary day.\nShow a realistic, unhurried example schedule.\nSay what to drop when time is short.",
    ],
    payoffs: [
      "Gather the points into one calm summary.\nShow the whole gentle routine on a single screen.\nSay the one sentence to carry into the week.",
      "Return to the opening worry and answer it with what was covered.\nShow how far the small steps actually reach.\nSay a brief, warm closing thought.",
    ],
    ctas: [
      "Invite viewers to save the video for a quiet moment.\nSuggest one small step to try today, and no more.\nOn screen: gentle end card with the next video.",
      "Ask viewers to share their own gentle tips in the comments.\nSubscribe ask, kept soft and pressure free.\nOn screen: the playlist for this series.",
    ],
  },
  bold: {
    hooks: [
      "Open with your strongest claim about {topic}, no hedging.\nTell viewers you will back it up point by point.\nOn screen: the claim in large, plain type.",
      "Name the popular advice on {topic} you believe is wrong.\nPromise the evidence, not just the opinion.\nOn screen: the bad advice, struck through.",
      "Start with the result nobody wants to admit about {topic}.\nSay this video is for people ready to hear it.\nOn screen: one stark statistic or outcome.",
    ],
    setups: [
      "Draw the line clearly: who this take on {topic} is for, and who it is not.\nPreview the points you will defend.\nOn screen: blunt chapter titles.",
      "Give the short version of your position on {topic} upfront.\nState the standard you will judge everything by.\nOn screen: the position as a single sentence.",
    ],
    points: [
      "Make the first argument and support it with a concrete case.\nShow the case, not just the claim.\nSay what the conventional approach got wrong.",
      "Tackle the strongest objection to your position on {topic}.\nShow why it fails, using a real example.\nSay what to do instead, precisely.",
      "Cover the uncomfortable cost of doing {topic} the usual way.\nShow the cost in time, money, or results.\nSay the bolder alternative and its price.",
      "Give the decisive action step, with no softening.\nShow it done properly, once, in full.\nSay the standard viewers should hold themselves to.",
    ],
    payoffs: [
      "Restate the position now that the evidence is on the table.\nShow the contrast between the two paths one final time.\nSay the choice viewers are actually making.",
      "Sum up the argument in three blunt sentences.\nShow them as text, one at a time.\nSay what changes tomorrow if they act on this.",
    ],
    ctas: [
      "Challenge viewers to act this week and report the result below.\nSubscribe ask for people who prefer direct advice.\nOn screen: end card, no clutter.",
      "Invite disagreement in the comments, with reasons.\nPoint to the video that takes the argument further.\nOn screen: the follow-up video link.",
    ],
  },
};

/** Planned time slots (seconds) for long-form outline sections. */
const LONGFORM_SLOTS = { hook: 30, setup: 45, point: 75, payoff: 60, cta: 30 } as const;

// ── Draft construction ─────────────────────────────────────────────

function pick<T>(bank: readonly T[], seed: number): T {
  return bank[seed % bank.length]!;
}

function fill(template: string, topic: string): string {
  return template.replaceAll("{topic}", topic);
}

export function buildScript(input: {
  topic: string;
  format: ScriptFormat;
  tone: ScriptTone;
  sourceText?: string;
}): ScriptDraft {
  const { format, tone } = input;
  const displayTopic = input.topic.trim() || "your topic";
  const base = stableHash(input.topic + tone + format);
  const pointCount = format === "reel30" ? 2 : format === "short60" ? 3 : 4;

  const keyPoints =
    input.sourceText && input.sourceText.trim()
      ? extractKeyPoints(input.sourceText, input.topic.trim(), pointCount)
      : [];

  const sections: ScriptSection[] = [];
  const add = (
    id: string,
    kind: ScriptSection["kind"],
    heading: string,
    text: string,
    seconds: number
  ) => {
    sections.push({ id, kind, heading, text, seconds, engine: "built-in" });
  };

  if (format === "longform") {
    const bank = LONGFORM_BANKS[tone];
    add("hook", "hook", "Hook", fill(pick(bank.hooks, base), displayTopic), LONGFORM_SLOTS.hook);
    add("setup", "setup", "Setup", fill(pick(bank.setups, base + 5), displayTopic), LONGFORM_SLOTS.setup);
    for (let i = 0; i < pointCount; i++) {
      const fromSource = keyPoints[i];
      add(
        `point-${i + 1}`,
        "point",
        fromSource ? `Main point ${i + 1} — from your material` : `Main point ${i + 1}`,
        fromSource ?? fill(pick(bank.points, base + 23 + i), displayTopic),
        LONGFORM_SLOTS.point
      );
    }
    add("payoff", "payoff", "Payoff", fill(pick(bank.payoffs, base + 11), displayTopic), LONGFORM_SLOTS.payoff);
    add("cta", "cta", "Call to action", fill(pick(bank.ctas, base + 17), displayTopic), LONGFORM_SLOTS.cta);
  } else {
    const bank = SHORT_BANKS[tone];
    const extended = format === "short60";

    let hookText = fill(pick(bank.hooks, base), displayTopic);
    if (extended) hookText += ` ${fill(pick(HOOK_KICKERS, base + 31), displayTopic)}`;
    add("hook", "hook", "Hook", hookText, spokenSeconds(hookText));

    let setupText = fill(pick(bank.setups, base + 5), displayTopic);
    if (extended) setupText += ` ${fill(pick(SETUP_EXTENSIONS, base + 37), displayTopic)}`;
    add("setup", "setup", "Setup", setupText, spokenSeconds(setupText));

    for (let i = 0; i < pointCount; i++) {
      const fromSource = keyPoints[i];
      if (fromSource) {
        add(
          `point-${i + 1}`,
          "point",
          `Main point ${i + 1} — from your material`,
          fromSource,
          spokenSeconds(fromSource)
        );
      } else {
        const point = pick(bank.points, base + 23 + i);
        let speak = fill(point.speak, displayTopic);
        if (extended) speak += ` ${fill(pick(POINT_DETAILS, base + 41 + i), displayTopic)}`;
        const text = `${speak}\nOn screen: ${point.visual}`;
        add(`point-${i + 1}`, "point", `Main point ${i + 1}`, text, spokenSeconds(text));
      }
    }

    let payoffText = fill(pick(bank.payoffs, base + 11), displayTopic);
    if (extended) payoffText += ` ${fill(pick(PAYOFF_EXTENSIONS, base + 43), displayTopic)}`;
    add("payoff", "payoff", "Payoff", payoffText, spokenSeconds(payoffText));

    let ctaText = fill(pick(bank.ctas, base + 17), displayTopic);
    if (extended) ctaText += ` ${fill(pick(CTA_EXTENSIONS, base + 47), displayTopic)}`;
    add("cta", "cta", "Call to action", ctaText, spokenSeconds(ctaText));
  }

  const wordCount = sections.reduce((sum, s) => sum + countWords(s.text), 0);
  const estDurationSec = sections.reduce((sum, s) => sum + s.seconds, 0);
  return {
    topic: displayTopic,
    format,
    tone,
    sections,
    wordCount,
    estDurationSec,
    usedSourceMaterial: keyPoints.length > 0,
  };
}

// ── Draft maintenance & export ─────────────────────────────────────

/**
 * Recomputes a section's timing after an edit. Long-form sections keep
 * their planned slots; short-format sections are re-timed from the text.
 */
export function retimeSection(section: ScriptSection, format: ScriptFormat): ScriptSection {
  if (format === "longform") return { ...section };
  return { ...section, seconds: spokenSeconds(section.text) };
}

/** Recomputes a draft's totals from its current sections. */
export function refreshDraft(draft: ScriptDraft): ScriptDraft {
  return {
    ...draft,
    sections: draft.sections.map((s) => ({ ...s })),
    wordCount: draft.sections.reduce((sum, s) => sum + countWords(s.text), 0),
    estDurationSec: draft.sections.reduce((sum, s) => sum + s.seconds, 0),
  };
}

function formatLabel(format: ScriptFormat): string {
  return SCRIPT_FORMAT_OPTIONS.find((o) => o.id === format)?.label ?? format;
}

function toneLabel(tone: ScriptTone): string {
  return SCRIPT_TONE_OPTIONS.find((o) => o.id === tone)?.label ?? tone;
}

function metaLine(draft: ScriptDraft): string {
  return `${formatLabel(draft.format)} · ${toneLabel(draft.tone)} · ≈${formatDuration(draft.estDurationSec)} · ${draft.wordCount} words`;
}

export function scriptToPlainText(draft: ScriptDraft): string {
  const parts: string[] = [`Script: ${draft.topic}`, metaLine(draft)];
  for (const section of draft.sections) {
    parts.push("", `[${section.heading} · ~${section.seconds}s]`, section.text);
  }
  return parts.join("\n") + "\n";
}

export function scriptToMarkdown(draft: ScriptDraft): string {
  const parts: string[] = [`# Script: ${draft.topic}`, metaLine(draft)];
  for (const section of draft.sections) {
    parts.push("", `## ${section.heading} (~${section.seconds}s)`, section.text);
  }
  return parts.join("\n") + "\n";
}

/** Just the words to be spoken, in order — the Voiceover hand-off text. */
export function scriptToSpokenText(draft: ScriptDraft): string {
  return draft.sections.map((s) => s.text).join("\n\n");
}
