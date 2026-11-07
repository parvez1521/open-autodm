"use client";

/**
 * Creator Studio — Niche Finder (Programme S1).
 *
 * Scores a topic with the built-in heuristic engine (lib/studio/
 * nicheEngine). The result is labelled on the page for what it is: a
 * relative estimate from built-in data — not live market data.
 */

import { useState } from "react";
import { Crosshair, Save, Check, Info } from "lucide-react";
import { analyseNiche } from "@/lib/studio/nicheEngine";
import { STUDIO_CATEGORIES, type NicheReport, type StudioCategory } from "@/lib/studio/types";
import {
  getBrowserProjectStore,
  STUDIO_PROJECTS_SAVE_FAILED_MESSAGE,
} from "@/lib/studio/projects";
import {
  StudioToolHeader,
  studioCardClass,
  studioInputClass,
  studioLabelClass,
  studioPrimaryButtonClass,
} from "@/components/studio/ui";
import { cn } from "@/lib/utils";

function ScoreBar({ label, value, invert = false }: { label: string; value: number; invert?: boolean }) {
  const good = invert ? value <= 45 : value >= 65;
  const mid = invert ? value <= 70 : value >= 45;
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{value}/100</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full",
            good ? "bg-emerald-500" : mid ? "bg-amber-500" : "bg-rose-500"
          )}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

export default function NicheFinderPage() {
  const [topic, setTopic] = useState("");
  const [category, setCategory] = useState<StudioCategory>("Tech & AI Tools");
  const [report, setReport] = useState<NicheReport | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const run = () => {
    if (!topic.trim()) return;
    setSaved(false);
    setReport(analyseNiche({ topic, category }));
  };

  const save = () => {
    if (!report) return;
    try {
      getBrowserProjectStore().save({
        kind: "niche",
        title: `Niche: ${report.topic}`,
        summary: `Score ${report.overall}/100 — ${report.verdict}`,
        payload: report,
      });
      setSaved(true);
      setSaveError(null);
    } catch {
      // Persist failed (quota/blocked storage): say so honestly; the
      // report stays on this page and Save can be retried.
      setSaved(false);
      setSaveError(STUDIO_PROJECTS_SAVE_FAILED_MESSAGE);
    }
  };

  return (
    <div className="space-y-5">
      <StudioToolHeader
        icon={Crosshair}
        title="Niche Finder"
        purpose="Score a topic before you commit to it — demand, competition, ease and earning potential."
        points={[
          "Scores for demand, competition, ease of starting and earning potential",
          "Audience size and indicative CPM bands for the niche",
          "Save the report to Projects to compare niches later",
        ]}
      />
      <div className={studioCardClass}>
        <p className="text-[13px] text-muted-foreground">
          Describe the niche you are considering. The Studio scores it against its
          built-in dataset of creator niches.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_220px_auto] sm:items-end">
          <div>
            <label className={studioLabelClass} htmlFor="niche-topic">Topic or niche</label>
            <input
              id="niche-topic"
              className={studioInputClass}
              placeholder="e.g. Faceless AI tools channel in Hindi"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
              maxLength={120}
            />
          </div>
          <div>
            <label className={studioLabelClass} htmlFor="niche-category">Category</label>
            <select
              id="niche-category"
              className={studioInputClass}
              value={category}
              onChange={(e) => setCategory(e.target.value as StudioCategory)}
            >
              {STUDIO_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <button type="button" className={studioPrimaryButtonClass} onClick={run} disabled={!topic.trim()}>
            Score this niche
          </button>
        </div>
      </div>

      {report && (
        <div className={studioCardClass}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm text-muted-foreground">
                Estimate for <span className="text-foreground font-medium">{report.topic}</span>{" "}
                (anchored to: {report.matchedNiche})
              </p>
              <p className="mt-2 text-4xl font-semibold tabular-nums">
                {report.overall}
                <span className="text-base text-muted-foreground"> /100</span>
              </p>
              <p className="mt-1 text-sm font-medium">{report.verdict}</p>
            </div>
            <button
              type="button"
              onClick={save}
              disabled={saved}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted/60 transition-colors disabled:opacity-60"
            >
              {saved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
              {saved ? "Saved to Projects" : "Save to Projects"}
            </button>
          </div>
          {saveError && (
            <p role="alert" className="mt-2 text-xs text-red-500">
              {saveError}
            </p>
          )}

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <ScoreBar label="Audience demand" value={report.subScores.demand} />
            <ScoreBar label="Competition (lower is better)" value={report.subScores.competition} invert />
            <ScoreBar label="Ease of starting" value={report.subScores.easeOfStarting} />
            <ScoreBar label="Earning potential" value={report.subScores.earningPotential} />
          </div>

          <dl className="mt-5 grid gap-3 sm:grid-cols-2 text-sm">
            <div className="rounded-lg bg-muted/50 p-3">
              <dt className="text-xs text-muted-foreground">Audience size</dt>
              <dd className="mt-0.5 font-medium">{report.audienceBand}</dd>
            </div>
            <div className="rounded-lg bg-muted/50 p-3">
              <dt className="text-xs text-muted-foreground">Indicative CPM (per 1,000 views)</dt>
              <dd className="mt-0.5 font-medium">{report.cpmBandInr}</dd>
            </div>
          </dl>

          <div className="mt-5">
            <h3 className="text-xs font-medium text-muted-foreground mb-1.5">Why this estimate</h3>
            <ul className="list-disc pl-5 space-y-1 text-[13px] text-muted-foreground">
              {report.signals.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>

          <p className="mt-5 flex gap-1.5 text-xs text-muted-foreground border-t border-border pt-3">
            <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
            Heuristic estimate from the Studio's built-in dataset — relative indices for
            comparing niches, not live market data. Use it to shortlist, then validate with
            a small test series.
          </p>
        </div>
      )}
    </div>
  );
}
