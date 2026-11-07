"use client";

/**
 * Viral Script Writer - a hook-first Instagram Reel script generator.
 *
 * The model is steered by the prompt system in lib/script-writer (there
 * is no fine-tune): hook 0-3s, open loop, one idea per section, and a
 * closing CTA that asks viewers to comment ONE keyword - the same
 * keyword the creator then uses as an open-autoDM automation trigger,
 * so the script and the funnel are written together.
 *
 * Generated scripts are kept in localStorage history only. Nothing is
 * written to Supabase and nothing touches the Instagram API.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  PencilLine, CircleNotch, Copy, Check, Robot, Warning, Clock,
  ChatText, Hash, FilmSlate, Trash, ClockCounterClockwise,
} from "@/components/phosphor";
import { cn } from "@/lib/utils";
import { apiClient, ApiError } from "@/lib/api/client";
import type { GeneratedScript } from "@/lib/script-writer/prompt";

const NICHES = [
  "Tech & AI Tools", "Education", "Fitness", "Finance & Business",
  "Motivation", "Comedy & Entertainment", "Food", "Travel",
  "Beauty & Fashion", "Other",
] as const;

const TONES = ["Educational", "Entertaining", "Shocking / Curiosity", "Storytelling", "Direct Value"] as const;

const HOOK_STYLES = [
  "Auto (strongest)", "Question", "Shocking statement", "Myth-bust",
  "List tease (e.g. 3 tools)", "Story / POV",
] as const;

const DURATIONS = [15, 30, 45, 60, 90] as const;

interface GenerateResponse {
  script: GeneratedScript;
  provider: string;
  model: string;
}

interface StatusResponse {
  workersAiRest: boolean;
  groq: boolean;
}

interface HistoryEntry {
  at: number;
  topic: string;
  provider: string;
  script: GeneratedScript;
}

const HISTORY_KEY = "open-autodm:script-writer-history";

const inputCls =
  "w-full h-9 px-3 rounded-lg bg-background border border-border text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus:border-foreground/30 transition-colors";
const labelCls = "micro-label block mb-1.5";

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          window.setTimeout(() => setDone(false), 1600);
        } catch { /* clipboard unavailable - no-op */ }
      }}
      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
    >
      {done ? <Check className="w-3.5 h-3.5 text-secondary" /> : <Copy className="w-3.5 h-3.5" />}
      {done ? "Copied" : label}
    </button>
  );
}

function scriptToText(s: GeneratedScript): string {
  const lines = [
    s.title,
    "",
    `HOOK OPTIONS:`,
    ...s.hooks.map((h, i) => `${i + 1}. ${h}`),
    "",
    "SCRIPT:",
    ...s.sections.flatMap((sec) => [
      `[${sec.time}] ${sec.label}: ${sec.spoken}`,
      `  On-screen: ${sec.onScreen}`,
      `  Show: ${sec.broll}`,
    ]),
    "",
    "CAPTION:",
    s.caption,
    s.hashtags.join(" "),
    "",
    `Comment keyword: ${s.ctaKeyword}`,
  ];
  return lines.join("\n");
}

export default function ScriptWriterPage() {
  const [topic, setTopic] = useState("");
  const [niche, setNiche] = useState<string>(NICHES[0]);
  const [language, setLanguage] = useState<"english" | "hindi" | "hinglish">("hinglish");
  const [duration, setDuration] = useState<number>(30);
  const [tone, setTone] = useState<string>(TONES[0]);
  const [hookStyle, setHookStyle] = useState<string>(HOOK_STYLES[0]);
  const [audience, setAudience] = useState("");
  const [ctaKeyword, setCtaKeyword] = useState("LINK");
  const [ctaResource, setCtaResource] = useState("");
  const [provider, setProvider] = useState<"auto" | "workers-ai" | "groq">("auto");

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ kind: string; message: string } | null>(null);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    apiClient<StatusResponse>("/script-writer").then(setStatus).catch(() => setStatus(null));
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) setHistory(JSON.parse(raw) as HistoryEntry[]);
    } catch { /* ignore */ }
  }, []);

  const canGenerate = topic.trim().length >= 3 && ctaKeyword.trim().length >= 1 && !loading;

  async function onGenerate() {
    if (!canGenerate) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient<GenerateResponse>("/script-writer", {
        method: "POST",
        body: JSON.stringify({
          topic: topic.trim(),
          niche,
          language,
          durationSeconds: duration,
          tone,
          hookStyle,
          audience: audience.trim() || undefined,
          ctaKeyword: ctaKeyword.trim(),
          ctaResource: ctaResource.trim() || undefined,
          provider,
        }),
      });
      setResult(res);
      const entry: HistoryEntry = { at: Date.now(), topic: topic.trim(), provider: res.provider, script: res.script };
      setHistory((prev) => {
        const next = [entry, ...prev].slice(0, 8);
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore */ }
        return next;
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setError({
          kind: err.body.error ?? "error",
          message: err.body.message ?? err.body.error ?? `Request failed (${err.status})`,
        });
      } else {
        setError({ kind: "network", message: "Network error - please try again." });
      }
    } finally {
      setLoading(false);
    }
  }

  const script = result?.script;

  return (
    <div className="w-full max-w-5xl mx-auto space-y-4 pb-16">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-heading font-semibold tracking-tight text-foreground">
            Viral Script Writer
          </h1>
          <p className="text-[13px] text-muted-foreground mt-1 max-w-xl leading-relaxed">
            Hook-first Reel scripts written for Instagram retention, on a free model
            (Cloudflare Workers AI, Groq fallback). The script ends with your comment
            keyword, ready to become an automation.
          </p>
        </div>
        {status && (
          <div className="hidden sm:flex flex-col items-end gap-1 shrink-0" data-no-reveal>
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <span className={cn("w-1.5 h-1.5 rounded-full", status.groq || status.workersAiRest ? "bg-secondary" : "bg-muted-foreground/50")} />
              {status.workersAiRest ? "Workers AI ready" : status.groq ? "Groq ready" : "Workers AI binding / Groq"}
            </span>
            <span className="text-[11px] text-muted-foreground/70">Groq: {status.groq ? "configured" : "not set"} · Workers AI REST: {status.workersAiRest ? "configured" : "not set"}</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">

        {/* Form */}
        <div className="lg:col-span-2 bg-card border border-border rounded-xl p-5 space-y-4">
          <div>
            <label className={labelCls} htmlFor="sw-topic">Video topic *</label>
            <textarea
              id="sw-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              rows={3}
              placeholder="e.g. 3 free AI websites that replace paid tools for students"
              className={cn(inputCls, "h-auto py-2.5 resize-none leading-relaxed")}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="sw-niche">Niche</label>
              <select id="sw-niche" value={niche} onChange={(e) => setNiche(e.target.value)} className={inputCls}>
                {NICHES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="sw-duration">Duration</label>
              <select id="sw-duration" value={duration} onChange={(e) => setDuration(Number(e.target.value))} className={inputCls}>
                {DURATIONS.map((d) => <option key={d} value={d}>{d} seconds</option>)}
              </select>
            </div>
          </div>

          <div>
            <span className={labelCls}>Script language</span>
            <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Script language">
              {([
                { v: "hinglish", l: "Hinglish" },
                { v: "english", l: "English" },
                { v: "hindi", l: "Hindi" },
              ] as const).map((o) => (
                <button
                  key={o.v}
                  type="button"
                  role="radio"
                  aria-checked={language === o.v}
                  onClick={() => setLanguage(o.v)}
                  className={cn(
                    "h-9 rounded-lg border text-[13px] font-medium transition-colors",
                    language === o.v
                      ? "bg-foreground text-background border-foreground"
                      : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/60",
                  )}
                >
                  {o.l}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="sw-tone">Tone</label>
              <select id="sw-tone" value={tone} onChange={(e) => setTone(e.target.value)} className={inputCls}>
                {TONES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="sw-hook">Hook style</label>
              <select id="sw-hook" value={hookStyle} onChange={(e) => setHookStyle(e.target.value)} className={inputCls}>
                {HOOK_STYLES.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className={labelCls} htmlFor="sw-audience">Target audience (optional)</label>
            <input id="sw-audience" value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="e.g. college students, beginner creators" className={inputCls} />
          </div>

          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3.5 space-y-3">
            <p className="micro-label !text-primary flex items-center gap-1.5"><Robot className="w-3.5 h-3.5" /> AutoDM connection</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls} htmlFor="sw-keyword">Comment keyword *</label>
                <input
                  id="sw-keyword"
                  value={ctaKeyword}
                  onChange={(e) => setCtaKeyword(e.target.value.toUpperCase())}
                  placeholder="LINK"
                  className={cn(inputCls, "uppercase font-semibold tracking-wider")}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="sw-provider">Model provider</label>
                <select id="sw-provider" value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)} className={inputCls}>
                  <option value="auto">Auto (Workers AI → Groq)</option>
                  <option value="workers-ai">Workers AI only</option>
                  <option value="groq">Groq only</option>
                </select>
              </div>
            </div>
            <div>
              <label className={labelCls} htmlFor="sw-resource">What they get in DM</label>
              <input id="sw-resource" value={ctaResource} onChange={(e) => setCtaResource(e.target.value)} placeholder="e.g. the list of all 3 websites with links" className={inputCls} />
            </div>
          </div>

          <button
            type="button"
            onClick={onGenerate}
            disabled={!canGenerate}
            className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-lg bg-foreground text-background text-[13px] font-semibold hover:opacity-90 transition-opacity disabled:opacity-40 disabled:pointer-events-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {loading ? <CircleNotch className="w-4 h-4 animate-spin" /> : <PencilLine className="w-4 h-4" />}
            {loading ? "Writing your script..." : "Generate script"}
          </button>
          <p className="text-[11.5px] text-muted-foreground/80 leading-relaxed">
            Free tier: roughly 80 scripts/day on Workers AI (70B) before the daily
            allocation resets. Review facts and prices before you film - AI can be wrong.
          </p>
        </div>

        {/* Output */}
        <div className="lg:col-span-3 space-y-4">
          {error && (
            <div className="bg-card border border-amber-500/30 rounded-xl p-5" role="alert">
              <h2 className="text-[14px] font-heading font-semibold text-foreground flex items-center gap-2">
                <Warning className="w-4 h-4 text-amber-500" />
                {error.kind === "ai_unavailable" ? "Script model not configured yet" : "Generation failed"}
              </h2>
              <p className="text-[13px] text-muted-foreground mt-1.5 leading-relaxed">{error.message}</p>
              {error.kind === "ai_unavailable" && (
                <ol className="text-[13px] text-muted-foreground mt-3 space-y-1.5 list-decimal list-inside leading-relaxed">
                  <li>Cloudflare deploy: the Workers AI binding ships in <span className="text-foreground font-medium">wrangler.jsonc</span> - just redeploy.</li>
                  <li>Or set <span className="text-foreground font-medium">CLOUDFLARE_ACCOUNT_ID</span> + <span className="text-foreground font-medium">CLOUDFLARE_API_TOKEN</span> for the REST path.</li>
                  <li>Or add a free <span className="text-foreground font-medium">GROQ_API_KEY</span> from console.groq.com as the fallback.</li>
                </ol>
              )}
              <button type="button" onClick={onGenerate} disabled={loading} className="mt-4 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border text-[12.5px] font-medium hover:bg-muted/60 transition-colors disabled:opacity-40">
                Try again
              </button>
            </div>
          )}

          {!script && !error && (
            <div className="bg-card border border-border rounded-xl p-8 text-center" data-no-reveal>
              <span className="mx-auto w-11 h-11 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                <FilmSlate className="w-5 h-5 text-primary" />
              </span>
              <h2 className="text-[14px] font-heading font-semibold text-foreground mt-3">Your script will appear here</h2>
              <p className="text-[13px] text-muted-foreground mt-1 max-w-sm mx-auto leading-relaxed">
                Fill the topic, pick a duration and language, and generate. You will get 3 hook
                options, a timestamped script, a ready caption and shooting tips.
              </p>
            </div>
          )}

          {script && (
            <>
              <div className="bg-card border border-border rounded-xl p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-[15px] font-heading font-semibold text-foreground leading-snug">{script.title}</h2>
                    <p className="text-[12px] text-muted-foreground mt-0.5 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5" /> {duration}s · via {result.provider === "groq" ? "Groq" : "Workers AI"} · {result.model.split("/").pop()}
                    </p>
                  </div>
                  <CopyButton text={scriptToText(script)} label="Copy full script" />
                </div>

                <div className="mt-4">
                  <p className="micro-label mb-2">Hook options - tap one to copy</p>
                  <div className="space-y-1.5">
                    {script.hooks.map((h, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => navigator.clipboard.writeText(h).catch(() => {})}
                        className={cn(
                          "w-full text-left px-3 py-2.5 rounded-lg border text-[13px] leading-relaxed transition-colors",
                          h === script.chosenHook
                            ? "border-primary/40 bg-primary/5 text-foreground font-medium"
                            : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/50",
                        )}
                      >
                        <span className="text-primary font-bold mr-1.5">{i + 1}.</span>
                        {h}
                        {h === script.chosenHook && <span className="ml-2 text-[11px] font-medium text-primary">Picked</span>}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="bg-card border border-border rounded-xl p-5">
                <p className="micro-label mb-3 flex items-center gap-1.5"><ChatText className="w-3.5 h-3.5" /> Timestamped script</p>
                <div className="space-y-3">
                  {script.sections.map((sec, i) => (
                    <div key={i} className="flex gap-3">
                      <span className="shrink-0 h-fit text-[11px] font-semibold tabular-nums bg-muted rounded-md px-2 py-1 text-foreground">{sec.time}</span>
                      <div className="min-w-0 flex-1 border-b border-border/60 pb-3">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">{sec.label}</p>
                        <p className="text-[14px] text-foreground font-medium leading-relaxed mt-0.5">{sec.spoken}</p>
                        <p className="text-[12.5px] text-muted-foreground mt-1"><span className="font-medium text-foreground/80">On-screen:</span> {sec.onScreen}</p>
                        <p className="text-[12.5px] text-muted-foreground"><span className="font-medium text-foreground/80">Show:</span> {sec.broll}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center rounded-md border border-border bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-foreground">
                    Comment “{script.ctaKeyword}”
                  </span>
                  <Link href="/automations" className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-foreground text-background text-[12.5px] font-semibold hover:opacity-90 transition-opacity">
                    <Robot className="w-3.5 h-3.5" /> Create automation with this keyword
                  </Link>
                  <span className="text-[11.5px] text-muted-foreground">Opens Automations - use {script.ctaKeyword} as the trigger keyword.</span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="bg-card border border-border rounded-xl p-5">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <p className="micro-label">Caption</p>
                    <CopyButton text={`${script.caption}\n${script.hashtags.join(" ")}`} />
                  </div>
                  <p className="text-[13px] text-foreground leading-relaxed whitespace-pre-wrap">{script.caption}</p>
                  <p className="text-[12.5px] text-primary/90 leading-relaxed mt-2 flex items-start gap-1">
                    <Hash className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {script.hashtags.join(" ")}
                  </p>
                </div>
                <div className="bg-card border border-border rounded-xl p-5">
                  <p className="micro-label mb-2">Shooting tips</p>
                  <ul className="space-y-1.5">
                    {script.shootingTips.map((tip, i) => (
                      <li key={i} className="text-[13px] text-muted-foreground leading-relaxed flex gap-2">
                        <span className="text-primary font-bold shrink-0">{i + 1}.</span> {tip}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </>
          )}

          {history.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-5">
              <div className="flex items-center justify-between gap-2">
                <p className="micro-label flex items-center gap-1.5"><ClockCounterClockwise className="w-3.5 h-3.5" /> Recent scripts (this browser)</p>
                <button
                  type="button"
                  onClick={() => { setHistory([]); try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ } }}
                  className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-destructive transition-colors"
                >
                  <Trash className="w-3.5 h-3.5" /> Clear
                </button>
              </div>
              <div className="mt-3 space-y-1.5">
                {history.map((h) => (
                  <button
                    key={h.at}
                    type="button"
                    onClick={() => setResult({ script: h.script, provider: h.provider, model: "" })}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-border text-left hover:bg-muted/50 transition-colors"
                  >
                    <span className="text-[13px] text-foreground truncate">{h.script.title}</span>
                    <span className="text-[11.5px] text-muted-foreground shrink-0">{new Date(h.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} · {h.provider}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
