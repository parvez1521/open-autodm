/**
 * Creator Studio — Prompt Library (Programme S1).
 *
 * A curated bank of prompts written for this product. Every prompt is
 * original text authored for Open AutoDM's Studio — none is copied from
 * any other product. [Square brackets] mark the parts the creator fills
 * in before pasting the prompt into any AI chat tool.
 */

import type { PromptCategory, PromptItem } from "./types";

export const PROMPT_CATEGORIES: PromptCategory[] = [
  "Hooks",
  "Scripts",
  "Thumbnails",
  "SEO",
  "Video Ideas",
  "Sponsorship & Outreach",
];

export const PROMPT_BANK: PromptItem[] = [
  // ── Hooks ──────────────────────────────────────────────────────────
  {
    id: "hook-10-variants",
    title: "Ten hook variants for one topic",
    category: "Hooks",
    prompt:
      "Write 10 opening hooks (first 3 seconds each) for a video about [topic]. Mix these styles: a bold claim, a question, a mistake warning, a curiosity gap, and a personal result. Each hook must be under 12 words and understandable without context.",
  },
  {
    id: "hook-myth-opener",
    title: "Myth-bust opener",
    category: "Hooks",
    prompt:
      "I am making a video that busts this common myth about [topic]: [myth]. Write 5 opening lines that state the myth, challenge it, and promise proof later in the video. Keep each line under 15 words.",
  },
  {
    id: "hook-shorts",
    title: "Hooks for a 30-second Short",
    category: "Hooks",
    prompt:
      "Give me 8 first-line hooks for a 30-second Short about [topic] aimed at beginners. Each hook must create an open loop that only closes at the end of the Short. No clickbait that the video cannot deliver.",
  },
  {
    id: "hook-story",
    title: "Story-style cold open",
    category: "Hooks",
    prompt:
      "Turn this experience into a 20-second story-style cold open for a video: [describe what happened]. Start in the middle of the action, withhold the outcome, and end the open with a reason to keep watching.",
  },
  // ── Scripts ────────────────────────────────────────────────────────
  {
    id: "script-long-form",
    title: "Long-form script outline with retention beats",
    category: "Scripts",
    prompt:
      "Outline a 10-minute video script about [topic] for [audience]. Structure: hook (0:00–0:30), promise, three sections each ending with a small payoff and a tease of the next, one pattern interrupt in the middle, and a closing summary with a soft call to action. Give timings for each part.",
    useIn: "script",
  },
  {
    id: "script-short",
    title: "60-second Short script",
    category: "Scripts",
    prompt:
      "Write a word-for-word 60-second Short script about [topic]. Line 1 is the hook. Then one idea per line, short spoken sentences, a payoff in the last 5 seconds, and a final line that asks viewers to comment one specific keyword: [keyword].",
    useIn: "script",
  },
  {
    id: "script-rewrite-hook",
    title: "Rewrite a weak script opening",
    category: "Scripts",
    prompt:
      "Here is the opening of my script: [paste opening]. Rewrite it three ways — sharper, shorter, and more emotional — without changing the facts. Explain in one line why each version is stronger.",
    useIn: "script",
  },
  {
    id: "script-faceless",
    title: "Faceless channel narration script",
    category: "Scripts",
    prompt:
      "Write a narration-only script (no on-camera lines) about [topic], about [duration] minutes at a calm pace. Use short paragraphs a voiceover can breathe through, open with a question, and end with a line that naturally leads into the next video about [related topic].",
    useIn: "script",
  },
  {
    id: "script-listicle",
    title: "Listicle script with escalating value",
    category: "Scripts",
    prompt:
      "Write a listicle script: '[number] [things] about [topic]'. Order the items so the value escalates and the strongest item is last; tease the last item in the first 20 seconds without naming it. Add a one-line transition between items.",
    useIn: "script",
  },
  // ── Thumbnails ─────────────────────────────────────────────────────
  {
    id: "thumb-concepts",
    title: "Five thumbnail concepts for one title",
    category: "Thumbnails",
    prompt:
      "My video title is: [title]. Suggest 5 thumbnail concepts. For each: the main visual, the exact overlay text (max 3 words), the dominant colour, and the emotion on the face if a face is used. Concepts must be readable at phone size.",
    useIn: "thumbnail",
  },
  {
    id: "thumb-text",
    title: "Shorten thumbnail text",
    category: "Thumbnails",
    prompt:
      "Turn these video titles into thumbnail text of at most 3 words each, keeping the curiosity but removing anything the title already says: [paste titles]. Give two options per title — one safe, one bold.",
    useIn: "thumbnail",
  },
  {
    id: "thumb-image-prompt",
    title: "Image-generation prompt for a thumbnail background",
    category: "Thumbnails",
    prompt:
      "Write one detailed image-generation prompt for a YouTube thumbnail background about [topic]: dramatic lighting, one clear subject, empty space on the [left/right] for text, high contrast, no text in the image itself. Then give a simpler fallback version of the same prompt.",
    useIn: "thumbnail",
  },
  {
    id: "thumb-audit",
    title: "Audit my thumbnail like a viewer",
    category: "Thumbnails",
    prompt:
      "I will describe my thumbnail: [describe it]. Critique it as a viewer scrolling on a phone: what do you notice first, what is unreadable at small size, and what single change would most improve the click-through rate? Be specific, not general.",
    useIn: "thumbnail",
  },
  // ── SEO ────────────────────────────────────────────────────────────
  {
    id: "seo-titles",
    title: "Search-first title options",
    category: "SEO",
    prompt:
      "Generate 10 YouTube title options for a video about [topic]. The main keyword '[keyword]' must appear naturally in every title. Keep each under 70 characters. Mix how-to, number, question and comparison formats. Mark the three you judge strongest for search and say why.",
    useIn: "seo",
  },
  {
    id: "seo-description",
    title: "Description with chapters and keywords",
    category: "SEO",
    prompt:
      "Write a YouTube description for a video titled '[title]'. First two lines: a hook that repeats the main keyword naturally. Then a short summary paragraph, a chapters list using these timestamps [timestamps], a resources section, and exactly 3 hashtags at the end.",
    useIn: "seo",
  },
  {
    id: "seo-tags",
    title: "Tag set inside the 500-character budget",
    category: "SEO",
    prompt:
      "Build a YouTube tag list for a video about [topic] in the [category] niche. Start with the exact topic phrase, then close variations, then broader niche terms. The whole comma-separated list must stay under 500 characters — count and show the total.",
    useIn: "seo",
  },
  {
    id: "seo-shorts-pack",
    title: "Shorts title + caption pack",
    category: "SEO",
    prompt:
      "For a Short about [topic], give me: 5 titles under 40 characters, a 2-line caption with one question to drive comments, and 5 hashtags mixing one broad tag with four specific ones.",
  },
  // ── Video Ideas ────────────────────────────────────────────────────
  {
    id: "ideas-series",
    title: "Turn one topic into a 6-part series",
    category: "Video Ideas",
    prompt:
      "Turn the topic '[topic]' into a 6-part video series for [audience]. Each part needs a title, a one-line promise, and a reason it must come in that order. Part 1 should be the easiest entry point; part 6 the deepest.",
    useIn: "ideas",
  },
  {
    id: "ideas-comments",
    title: "Video ideas from audience comments",
    category: "Video Ideas",
    prompt:
      "Here are real comments from my viewers: [paste comments]. Cluster them into themes, then turn the five strongest themes into video titles with a one-line note on the exact viewer need each video answers.",
    useIn: "ideas",
  },
  {
    id: "ideas-low-effort",
    title: "Low-effort, high-value video formats",
    category: "Video Ideas",
    prompt:
      "Suggest 8 video ideas about [topic] that one person can film in under two hours with a phone and no crew. For each: the format, the hook, and what makes it worth watching despite the simple production.",
    useIn: "ideas",
  },
  // ── Sponsorship & Outreach ─────────────────────────────────────────
  {
    id: "outreach-brand-pitch",
    title: "Short brand pitch email",
    category: "Sponsorship & Outreach",
    prompt:
      "Write a sponsorship pitch email from me, a [niche] creator with [subscriber count] subscribers and about [average views] views per video, to [brand]. Keep it under 150 words: who my audience is, one specific video idea featuring their product, deliverables, and a polite call to discuss rates. No exaggerated claims.",
  },
  {
    id: "outreach-rate-reply",
    title: "Reply to a low sponsorship offer",
    category: "Sponsorship & Outreach",
    prompt:
      "A brand offered me [amount] for a dedicated video; my usual rate is [rate]. Draft a firm but friendly reply that thanks them, briefly justifies my rate with audience fit and past results, and offers one smaller-scope option at their budget without lowering my headline rate.",
  },
  {
    id: "outreach-collab",
    title: "Collaboration request to another creator",
    category: "Sponsorship & Outreach",
    prompt:
      "Write a short DM to a creator in the [niche] niche proposing a collaboration. I have [subscriber count] subscribers. Suggest two concrete video ideas we could make together — one for their channel, one for mine — and keep the message under 80 words and easy to say yes to.",
  },
];

export function searchPrompts(query: string, category?: PromptCategory | "All"): PromptItem[] {
  const q = query.trim().toLowerCase();
  return PROMPT_BANK.filter((p) => {
    if (category && category !== "All" && p.category !== category) return false;
    if (!q) return true;
    return (
      p.title.toLowerCase().includes(q) ||
      p.prompt.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q)
    );
  });
}
