/**
 * Creator Studio — Presentations engine (Programme S3).
 *
 * Offline deck generator: an original slide structure composed with
 * the creator's topic and audience, in one of four tones. Selection
 * from the template banks is deterministic (rotated by a stable hash
 * of topic + audience + tone + slide count) so the same input always
 * returns the same deck — no randomness, no clock.
 *
 * Deck shape is fixed by slide count: a title slide, an agenda slide
 * naming the sections, K section structures (each a section divider
 * followed by its content slides, distributed as evenly as the total
 * allows), and a closing slide with next steps.
 */

import { stableHash } from "./nicheEngine";
import type { Deck, DeckSlide, ScriptTone } from "./types";

export const DECK_MIN_SLIDES = 5;
export const DECK_MAX_SLIDES = 12;

export function clampSlideCount(n: number): number {
  if (!Number.isFinite(n)) return DECK_MIN_SLIDES;
  return Math.min(DECK_MAX_SLIDES, Math.max(DECK_MIN_SLIDES, Math.round(n)));
}

// ── Template banks (all copy original to Studio) ───────────────────

function fill(template: string, topic: string, audience: string): string {
  return template.replaceAll("{topic}", topic).replaceAll("{audience}", audience);
}

function pick<T>(bank: readonly T[], seed: number): T {
  return bank[seed % bank.length]!;
}

interface SectionDef {
  title: string;
  /** One-line promise shown on the section divider slide. */
  promises: string[];
  /** Content-slide bullet templates, per tone (at least 4 each). */
  bullets: Record<ScriptTone, string[]>;
}

const SECTION_BANK: SectionDef[] = [
  {
    title: "The problem",
    promises: [
      "We will name the real problem behind {topic} for {audience}.",
      "A clear look at what makes {topic} difficult for {audience} at the start.",
      "Why the usual first attempts at {topic} stall — and what changes that.",
    ],
    bullets: {
      energetic: [
        "{topic} feels urgent for {audience} because the cost of waiting keeps rising.",
        "Most of {audience} hit the same wall with {topic}: plenty of advice, no clear first step.",
        "The hidden friction in {topic} is not effort — it is starting in the wrong order.",
        "When {topic} goes wrong, {audience} usually lose time before they lose confidence.",
        "A quick reality check on {topic}: the problem is smaller and more specific than it looks.",
      ],
      educational: [
        "Start by defining the problem in {topic} precisely, in words {audience} already use.",
        "The difficulty with {topic} usually sits in one stage, not across the whole process.",
        "For {audience}, the common causes behind a stuck {topic} attempt repeat from case to case.",
        "A problem stated clearly is easier to solve: vague worries about {topic} help nobody.",
        "Notice what {audience} have already tried with {topic} — the pattern points at the cause.",
      ],
      calm: [
        "It is normal for {topic} to feel like a lot at first, especially for {audience}.",
        "The problem with {topic} is rarely ability; it is usually pace, pressure, or too many steps at once.",
        "Naming the hard part of {topic} out loud makes it smaller and easier to approach.",
        "For {audience}, one honest look at where {topic} breaks down is enough to begin.",
        "Nothing here needs fixing today — understanding the problem with {topic} is itself progress.",
      ],
      bold: [
        "Let us say it plainly: most of {audience} are avoiding the real problem in {topic}.",
        "The comfortable story about {topic} is wrong, and {audience} pay for believing it.",
        "{topic} is not failing {audience} — half-hearted attempts are.",
        "The problem is not a lack of information about {topic}. It is a lack of decisions.",
        "If {topic} keeps stalling for {audience}, the bottleneck is the thing nobody wants to cut.",
      ],
    },
  },
  {
    title: "Why it matters",
    promises: [
      "Why getting {topic} right changes real outcomes for {audience}.",
      "The payoff on offer: what improves for {audience} when {topic} works.",
      "A short, honest case for putting time into {topic} now rather than later.",
    ],
    bullets: {
      energetic: [
        "Get {topic} right and {audience} save the one resource nobody can refund: time.",
        "Every week of delay with {topic} compounds — momentum is the advantage for {audience}.",
        "{topic} done well gives {audience} a result they can point to, not just effort they can claim.",
        "The upside of {topic} is practical: fewer false starts and faster feedback for {audience}.",
        "Small wins in {topic} build the confidence {audience} need for the bigger moves after it.",
      ],
      educational: [
        "Understanding why {topic} matters helps {audience} judge advice instead of just following it.",
        "The benefits of {topic} for {audience} show up in sequence: clarity first, then speed, then results.",
        "Research and experience agree on one point about {topic}: starting structured beats starting big.",
        "For {audience}, {topic} connects to goals they already care about — that link is the motivation.",
        "Knowing the stakes of {topic} helps {audience} decide how much time it honestly deserves.",
      ],
      calm: [
        "{topic} matters because it removes a quiet, recurring stress for {audience}.",
        "A steadier approach to {topic} gives {audience} fewer rushed decisions and fewer regrets.",
        "The value of {topic} is not speed — it is the calm that comes from knowing the next step.",
        "For {audience}, progress in {topic} tends to spill gently into neighbouring parts of life and work.",
        "Caring about {topic} is really caring about how {audience} spend their ordinary days.",
      ],
      bold: [
        "{audience} who ignore {topic} do not stay neutral — they fall behind, quietly and steadily.",
        "The cost of postponing {topic} is real, and {audience} are already paying it.",
        "{topic} is a dividing line: {audience} either treat it seriously or keep explaining why not.",
        "Nobody hands {audience} the results of {topic}. They are taken, by people who start.",
        "If {topic} did not matter, {audience} would not keep coming back to it. It matters.",
      ],
    },
  },
  {
    title: "How it works",
    promises: [
      "The working method behind {topic}, broken into steps {audience} can follow.",
      "How {topic} actually works in practice — no jargon, just the sequence.",
      "The core process of {topic}, shown the way {audience} will really do it.",
    ],
    bullets: {
      energetic: [
        "Step one for {topic}: start with the smallest version {audience} can finish this week.",
        "Next in {topic}, copy a proven pattern first — originality comes after results, not before.",
        "The engine of {topic} is a short loop: try, measure, adjust, repeat — fast.",
        "For {audience}, the trick in {topic} is sequencing: the right steps in the right order.",
        "Keep {topic} moving with a visible checklist — {audience} work better when progress is on show.",
      ],
      educational: [
        "The process behind {topic} has three parts: prepare, practise in small units, then review.",
        "First, {audience} set up the basics of {topic} so each attempt starts from the same place.",
        "Then comes deliberate practice: short, focused repetitions of one part of {topic} at a time.",
        "Review is where {topic} improves — {audience} compare the result against a clear standard.",
        "Each cycle through {topic} builds on the last, which is why the order of steps matters.",
      ],
      calm: [
        "The method for {topic} is unhurried: one small step, done fully, before the next begins.",
        "{audience} begin {topic} with the easiest part, so the start itself builds confidence.",
        "Short, regular sessions suit {topic} better than rare, exhausting marathons.",
        "A simple rhythm carries {topic}: prepare quietly, work gently, note one thing learned.",
        "When {topic} feels heavy, {audience} shrink the step — the method stays the same.",
      ],
      bold: [
        "Here is how {topic} works when done seriously: decide, commit, execute, review — no drifting.",
        "First move in {topic}: cut the version down until {audience} cannot hide behind its size.",
        "The mechanism of {topic} is feedback — {audience} who seek it early improve fastest.",
        "No secret step exists in {topic}. The steps are known; doing them in order is the rarity.",
        "{audience} should treat {topic} like a standard to meet, not a mood to wait for.",
      ],
    },
  },
  {
    title: "Making it happen",
    promises: [
      "A concrete plan that turns {topic} into next steps for {audience}.",
      "From understanding to action: how {audience} start {topic} this week.",
      "The practical close — resources, timing, and the first move in {topic}.",
    ],
    bullets: {
      energetic: [
        "Give {topic} a start date this week — {audience} move faster with a real deadline.",
        "Block a short, protected slot for {topic} and treat it like an appointment, not a wish.",
        "Tell one person what {audience} are doing with {topic}; accountability speeds everything up.",
        "Prepare the tools for {topic} tonight so tomorrow starts with action, not setup.",
        "Review {topic} after the first attempt and lock in the next step while energy is high.",
      ],
      educational: [
        "Turn {topic} into a written plan: goal, first step, and a date to review progress.",
        "{audience} should gather the few resources {topic} needs before starting, not during.",
        "Schedule practice for {topic} at a consistent time — consistency teaches faster than intensity.",
        "Keep a simple log of each {topic} session; the record shows {audience} what is working.",
        "End the first week of {topic} with a review: keep what worked, adjust one thing only.",
      ],
      calm: [
        "Choose a gentle start date for {topic} — soon, but without pressure or drama.",
        "Give {topic} a small, kind slot in the week that {audience} can actually protect.",
        "Prepare one thing for {topic} in advance, so starting feels easy when the moment comes.",
        "Let {audience} judge the first attempt at {topic} by effort and honesty, not by outcome.",
        "Close each {topic} session by noting one small win — it makes returning easier.",
      ],
      bold: [
        "Commit publicly: {audience} state the {topic} goal and the date, out loud, to someone.",
        "Remove one excuse today — the obstacle {audience} keep citing about {topic} goes first.",
        "Set the standard for {topic} in writing, and measure the first week against it honestly.",
        "Schedule the review of {topic} now, before starting, so quitting quietly is not an option.",
        "Start {topic} before feeling ready. Readiness is a result of starting, not a condition for it.",
      ],
    },
  },
];

const CLOSING_TITLES: Record<ScriptTone, string[]> = {
  energetic: ["Let's get started", "Your move", "Time to start"],
  educational: ["What to do next", "Next steps", "Putting it into practice"],
  calm: ["A gentle next step", "When you are ready", "Next steps, gently"],
  bold: ["Make the call", "No more waiting", "Decide and begin"],
};

const CLOSING_BULLETS: Record<ScriptTone, string[]> = {
  energetic: [
    "Pick one first step for {topic} and do it today, while this is fresh.",
    "Share this deck with one person among {audience} who needs the same starting point.",
    "Save the plan from this session and review it after your first attempt at {topic}.",
    "Set a short deadline for {topic} and tell someone who will check in on it.",
    "Bring your first result back and use it to plan the next round of {topic}.",
  ],
  educational: [
    "Write down the first step for {topic} in your own words before you leave this deck.",
    "Schedule a short review session to check what your first attempt at {topic} taught you.",
    "Keep the section summaries from this deck as your checklist while you practise {topic}.",
    "Share one idea from this deck with another member of {audience} and compare notes.",
    "Choose the resource you will use for {topic} and have it ready before your first session.",
  ],
  calm: [
    "Choose one small step from this deck and try it once, without judging the result.",
    "Save this deck somewhere easy to find, and return to it when {topic} feels like a lot.",
    "Share this with someone in {audience} who might also appreciate a gentler start.",
    "Note the step that felt most doable — that is where your work on {topic} begins.",
    "Give yourself a quiet deadline for the first step, and be kind if it slips once.",
  ],
  bold: [
    "State your first step for {topic} out loud today — vague intentions do not count.",
    "Put the review date for {topic} in the calendar now, before motivation cools.",
    "Tell one person among {audience} exactly what you are committing to with {topic}.",
    "Remove the biggest obstacle to {topic} this week, not next month.",
    "Start before you feel ready, and let the first result teach you the rest.",
  ],
};

// ── Deck construction ──────────────────────────────────────────────

export function buildDeck(input: {
  topic: string;
  audience: string;
  slideCount: number;
  tone?: ScriptTone;
}): Deck {
  const tone: ScriptTone = input.tone ?? "educational";
  const topic = input.topic.trim() || "Your topic";
  const audience = input.audience.trim() || "your audience";
  const n = clampSlideCount(input.slideCount);
  const base = stableHash(`${topic}|${audience}|${tone}|${n}`);

  const middle = n - 3;
  const sectionCount = Math.min(4, Math.max(2, Math.round((n - 3) / 2)));
  const sections = SECTION_BANK.slice(0, sectionCount);

  const contentTotal = middle - sectionCount;
  const baseContent = Math.floor(contentTotal / sectionCount);
  const remainder = contentTotal % sectionCount;
  const contentCounts = sections.map((_, i) => baseContent + (i < remainder ? 1 : 0));

  const slides: DeckSlide[] = [];
  const addSlide = (kind: DeckSlide["kind"], title: string, bullets: string[]) => {
    const index = slides.length;
    slides.push({
      id: `slide-${base.toString(36)}-${index}-${kind}`,
      kind,
      title,
      bullets,
      engine: "built-in",
    });
  };

  addSlide("title", topic, [fill("A practical presentation on {topic}, prepared for {audience}.", topic, audience)]);
  addSlide(
    "agenda",
    "What we will cover",
    sections.map((s) => s.title)
  );

  sections.forEach((section, i) => {
    addSlide("section", section.title, [fill(pick(section.promises, base + i * 7), topic, audience)]);
    const bank = section.bullets[tone];
    for (let j = 0; j < contentCounts[i]!; j++) {
      const start = (base + i * 13 + j * 5) % bank.length;
      const bullets: string[] = [];
      for (let k = 0; k < 4; k++) {
        bullets.push(fill(bank[(start + k) % bank.length]!, topic, audience));
      }
      const title = j === 0 ? section.title : `${section.title} — continued`;
      addSlide("content", title, bullets);
    }
  });

  const closingBank = CLOSING_BULLETS[tone];
  const closingStart = (base + 29) % closingBank.length;
  const closingBullets: string[] = [];
  for (let k = 0; k < 3; k++) {
    closingBullets.push(fill(closingBank[(closingStart + k) % closingBank.length]!, topic, audience));
  }
  addSlide("closing", pick(CLOSING_TITLES[tone], base + 31), closingBullets);

  return { topic, audience, slides };
}

// ── Edit operations (pure — each returns a new Deck) ───────────────

export function updateSlide(
  deck: Deck,
  id: string,
  patch: { title?: string; bullets?: string[] }
): Deck {
  return {
    ...deck,
    slides: deck.slides.map((slide) => {
      if (slide.id !== id) return slide;
      return {
        ...slide,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.bullets !== undefined ? { bullets: [...patch.bullets] } : {}),
      };
    }),
  };
}

export function moveSlide(deck: Deck, id: string, direction: "up" | "down"): Deck {
  const index = deck.slides.findIndex((s) => s.id === id);
  if (index < 0) return { ...deck, slides: [...deck.slides] };
  // Anchor slides (title first, closing last) are immovable.
  if (index === 0 || index === deck.slides.length - 1) {
    return { ...deck, slides: [...deck.slides] };
  }
  const target = direction === "up" ? index - 1 : index + 1;
  // Non-anchor slides stay within index 1..len-2.
  if (target < 1 || target > deck.slides.length - 2) {
    return { ...deck, slides: [...deck.slides] };
  }
  const slides = [...deck.slides];
  const [moved] = slides.splice(index, 1);
  slides.splice(target, 0, moved!);
  return { ...deck, slides };
}

export function removeSlide(deck: Deck, id: string): Deck {
  const index = deck.slides.findIndex((s) => s.id === id);
  if (index < 0) return { ...deck, slides: [...deck.slides] };
  if (index === 0 || index === deck.slides.length - 1) {
    return { ...deck, slides: [...deck.slides] };
  }
  if (deck.slides.length - 1 < 3) {
    return { ...deck, slides: [...deck.slides] };
  }
  return { ...deck, slides: deck.slides.filter((s) => s.id !== id) };
}

export function addContentSlide(deck: Deck, afterId: string): Deck {
  const base = stableHash(`${deck.topic}|${deck.audience}|${deck.slides.length}`);
  let suffix = 0;
  let newId = `slide-${base.toString(36)}-added-${deck.slides.length}`;
  const existing = new Set(deck.slides.map((s) => s.id));
  while (existing.has(newId)) {
    suffix += 1;
    newId = `slide-${base.toString(36)}-added-${deck.slides.length}-${suffix}`;
  }
  const blank: DeckSlide = {
    id: newId,
    kind: "content",
    title: "New slide",
    bullets: [],
    engine: "built-in",
  };
  const afterIndex = deck.slides.findIndex((s) => s.id === afterId);
  const closingIndex = deck.slides.length - 1;
  // Insert after the named slide when that keeps it before the closing
  // slide; otherwise (named slide is the closing slide, or unknown)
  // insert directly before the closing slide.
  const insertAt =
    afterIndex >= 0 && afterIndex < closingIndex ? afterIndex + 1 : closingIndex;
  const slides = [...deck.slides];
  slides.splice(insertAt, 0, blank);
  return { ...deck, slides };
}

// ── Standalone HTML export ─────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const KIND_LABELS: Record<DeckSlide["kind"], string> = {
  title: "Title",
  agenda: "Agenda",
  section: "Section",
  content: "Content",
  closing: "Closing",
};

export function deckToStandaloneHtml(deck: Deck): string {
  const total = deck.slides.length;
  const slidesHtml = deck.slides
    .map((slide, i) => {
      const bullets = slide.bullets.map((b) => `        <li>${escapeHtml(b)}</li>`).join("\n");
      const list = slide.bullets.length > 0 ? `      <ul>\n${bullets}\n      </ul>` : "";
      return `    <section class="slide${i === 0 ? " active" : ""}" data-kind="${escapeHtml(slide.kind)}">
      <span class="kind kind-${escapeHtml(slide.kind)}">${escapeHtml(KIND_LABELS[slide.kind])}</span>
      <h2>${escapeHtml(slide.title)}</h2>
${list}
    </section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(deck.topic)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #0f172a; }
  .chrome { display: flex; align-items: center; justify-content: center; gap: 16px; padding: 14px; color: #e2e8f0; }
  .chrome button { background: #1e293b; color: #e2e8f0; border: 1px solid #334155; border-radius: 8px; padding: 8px 16px; cursor: pointer; font-size: 14px; }
  .chrome button:hover { background: #334155; }
  #counter { font-size: 14px; min-width: 64px; text-align: center; }
  main { display: flex; justify-content: center; padding: 8px 16px 32px; }
  .slide { display: none; width: min(1100px, 96vw); aspect-ratio: 16 / 9; background: #ffffff; border-radius: 16px; padding: 48px 56px; flex-direction: column; justify-content: center; box-shadow: 0 24px 60px rgba(0,0,0,0.45); overflow: hidden; }
  .slide.active { display: flex; }
  .kind { align-self: flex-start; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; padding: 4px 10px; border-radius: 999px; background: #e2e8f0; color: #334155; margin-bottom: 18px; }
  .kind-title { background: #1e293b; color: #f8fafc; }
  .kind-section { background: #f59e0b; color: #1c1917; }
  .kind-closing { background: #059669; color: #ecfdf5; }
  .kind-agenda { background: #6366f1; color: #eef2ff; }
  .slide h2 { font-size: 40px; line-height: 1.15; margin: 0 0 20px; }
  .slide ul { margin: 0; padding-left: 24px; font-size: 21px; line-height: 1.55; color: #334155; }
  .slide li { margin-bottom: 10px; }
  @media print {
    body { background: #ffffff; }
    .chrome { display: none; }
    main { display: block; padding: 0; }
    .slide { display: flex; width: 100%; box-shadow: none; border-radius: 0; page-break-after: always; break-after: page; }
  }
</style>
</head>
<body>
  <div class="chrome">
    <button type="button" id="prevBtn">Previous</button>
    <span id="counter">1 / ${total}</span>
    <button type="button" id="nextBtn">Next</button>
  </div>
  <main>
${slidesHtml}
  </main>
<script>
  var slides = document.querySelectorAll('.slide');
  var counter = document.getElementById('counter');
  var current = 0;
  function show(n) {
    current = Math.max(0, Math.min(slides.length - 1, n));
    slides.forEach(function (s, i) { s.classList.toggle('active', i === current); });
    counter.textContent = (current + 1) + ' / ' + slides.length;
  }
  document.getElementById('prevBtn').addEventListener('click', function () { show(current - 1); });
  document.getElementById('nextBtn').addEventListener('click', function () { show(current + 1); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); show(current + 1); }
    if (e.key === 'ArrowLeft') { show(current - 1); }
  });
  document.addEventListener('click', function (e) {
    if (e.target.closest('.chrome')) return;
    if (e.clientX > window.innerWidth / 2) { show(current + 1); } else { show(current - 1); }
  });
  show(0);
</script>
</body>
</html>
`;
}
