/**
 * Viral Script Writer - the Instagram tuning lives here, not in a
 * fine-tune. Free models cannot be fine-tuned for this product, so the
 * model is steered with a system prompt that encodes how high-retention
 * Reels are actually structured, plus strict output rules:
 *
 *  1. Hook first (0-3s): pattern interrupt / curiosity gap / bold claim.
 *     No intro, no "hey guys", no logo moment - the first line must make
 *     a scroller stop.
 *  2. Open loop: the hook promises something that is only paid off near
 *     the end, so viewers stay.
 *  3. Value in short spoken bursts, one idea per section, sized to the
 *     chosen duration at a natural speaking pace (~2.4 words/second).
 *  4. CTA tied to open-autoDM: the script ends by asking viewers to
 *     comment ONE keyword - the exact keyword the creator will use as
 *     their automation trigger - and tells them what arrives in DM.
 *  5. Language discipline: the script is written in exactly the
 *     language the creator picked (English / Hindi / Hinglish roman).
 *     Hinglish means Hindi in Roman script mixed with English tech
 *     words, the way Indian creators actually speak on camera.
 */

export interface ScriptWriterInput {
  topic: string;
  niche: string;
  language: "english" | "hindi" | "hinglish";
  durationSeconds: 15 | 30 | 45 | 60 | 90;
  tone: string;
  hookStyle: string;
  audience?: string;
  ctaKeyword: string;
  ctaResource?: string;
}

export interface ScriptSection {
  label: string;
  time: string;
  spoken: string;
  onScreen: string;
  broll: string;
}

export interface GeneratedScript {
  title: string;
  hooks: string[];
  chosenHook: string;
  sections: ScriptSection[];
  caption: string;
  hashtags: string[];
  ctaKeyword: string;
  shootingTips: string[];
}

const LANGUAGE_RULES: Record<ScriptWriterInput["language"], string> = {
  english:
    "Write every spoken line and on-screen text in clear, conversational English. Short sentences. Speak like a creator talking to one friend, not like an essay.",
  hindi:
    "Write every spoken line and on-screen text in Hindi (Devanagari script). Natural spoken Hindi, not textbook Hindi.",
  hinglish:
    "Write every spoken line and on-screen text in Hinglish: Hindi written in Roman (Latin) script, mixed with common English words (tool, free, link, video, AI) exactly the way Indian tech creators speak on camera. Example: 'Ye tool bilkul free hai aur tumhara kaam 10x fast kar dega.' Never use Devanagari in spoken lines.",
};

function wordBudget(seconds: number): number {
  // Natural on-camera pace is roughly 140-150 words per minute.
  return Math.round(seconds * 2.4);
}

export function buildScriptMessages(input: ScriptWriterInput): { role: "system" | "user"; content: string }[] {
  const words = wordBudget(input.durationSeconds);
  const system = `You are an expert Instagram Reels scriptwriter who has written scripts for top Indian and global creators. You write ONLY high-retention short-form scripts. You never write generic, essay-like content.

STRUCTURE YOU MUST FOLLOW:
- HOOK (0-3s): one spoken line, max 12 words. It must create a curiosity gap, a pattern interrupt, a myth-bust, or a bold specific claim. No greetings, no "in this video", no introducing yourself.
- OPEN LOOP: the second section must tease the payoff ("...aur last wala point sabse important hai") so viewers watch till the end.
- VALUE: each middle section carries exactly ONE idea, spoken in short punchy lines. Use specifics - numbers, names, steps - never vague advice.
- PAYOFF: deliver what the hook promised.
- CTA (last 3-5s): ask viewers to comment the exact keyword "${input.ctaKeyword.toUpperCase()}" to receive ${input.ctaResource ? `"${input.ctaResource}"` : "the resource"} in their DMs automatically. One keyword only. Also ask them to follow for more, in one short line maximum.

LANGUAGE: ${LANGUAGE_RULES[input.language]}

TIMING: Total spoken words across ALL sections must be close to ${words} words (for a ${input.durationSeconds}-second Reel at natural pace). Split the time range sensibly across 4-6 sections.

HOOKS: First generate 3 alternative hooks (different angles), then pick the strongest as chosenHook and build the script starting with it.

OUTPUT: Respond with ONLY a valid JSON object, no markdown fences, no commentary, in exactly this shape:
{
  "title": "short internal title for this script",
  "hooks": ["hook 1", "hook 2", "hook 3"],
  "chosenHook": "the hook you picked (must be one of hooks)",
  "sections": [
    { "label": "Hook", "time": "0-3s", "spoken": "exact words to say", "onScreen": "bold on-screen text for this part", "broll": "what to show on screen / B-roll idea" }
  ],
  "caption": "ready-to-paste Instagram caption, 2-4 lines, ending with the comment keyword CTA",
  "hashtags": ["#tag1", "#tag2"],
  "ctaKeyword": "${input.ctaKeyword.toUpperCase()}",
  "shootingTips": ["2-4 short practical tips for filming THIS script: framing, energy, captions, first-frame"]
}
Hashtags: 8-12, a mix of niche and broad reach tags, no spaces inside a tag. On-screen text must be short (max 6 words per section) and high-contrast readable.`;

  const user = `Write a viral Instagram Reel script with these inputs:
- Topic: ${input.topic}
- Niche: ${input.niche}
- Tone: ${input.tone}
- Hook style preference: ${input.hookStyle}
- Duration: ${input.durationSeconds} seconds
- Target audience: ${input.audience?.trim() ? input.audience : "general Instagram audience interested in this niche"}
- Comment keyword for the DM automation: ${input.ctaKeyword.toUpperCase()}
- What the viewer gets in DM: ${input.ctaResource?.trim() ? input.ctaResource : "the link / resource mentioned in the video"}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Parse a model response into a GeneratedScript. Tolerates code fences. */
export function parseGeneratedScript(raw: string): GeneratedScript | null {
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Partial<GeneratedScript>;
    if (!obj || !Array.isArray(obj.sections) || obj.sections.length === 0) return null;
    return {
      title: String(obj.title ?? "Untitled script"),
      hooks: Array.isArray(obj.hooks) ? obj.hooks.map(String) : [],
      chosenHook: String(obj.chosenHook ?? obj.hooks?.[0] ?? ""),
      sections: obj.sections.map((s) => ({
        label: String((s as ScriptSection).label ?? ""),
        time: String((s as ScriptSection).time ?? ""),
        spoken: String((s as ScriptSection).spoken ?? ""),
        onScreen: String((s as ScriptSection).onScreen ?? ""),
        broll: String((s as ScriptSection).broll ?? ""),
      })),
      caption: String(obj.caption ?? ""),
      hashtags: Array.isArray(obj.hashtags) ? obj.hashtags.map(String) : [],
      ctaKeyword: String(obj.ctaKeyword ?? ""),
      shootingTips: Array.isArray(obj.shootingTips) ? obj.shootingTips.map(String) : [],
    };
  } catch {
    return null;
  }
}
