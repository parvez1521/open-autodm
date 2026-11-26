"use client";

/**
 * Creator Studio — Voiceover Studio route wrapper.
 *
 * The studio itself (voiceoverClient.tsx) is browser-only: the Kokoro
 * export engine runs in the browser via kokoro-js, whose Node build
 * pulls in onnxruntime-node native (.node) binaries. If this page is
 * server-rendered, the server trace pulls those binaries into the
 * server bundle and the OpenNext/Cloudflare build fails in esbuild
 * ("No loader is configured for '.node' files"). Loading the studio
 * with ssr: false keeps kokoro-js out of the server bundle entirely
 * — the engine code ships only as a client chunk.
 *
 * Behaviour is unchanged: the same component renders, in the browser,
 * with the same state, voices and export flow.
 */

import dynamic from "next/dynamic";

const VoiceoverStudioPage = dynamic(() => import("./voiceoverClient"), {
  ssr: false,
  loading: () => (
    <p className="text-sm text-muted-foreground">Loading Voiceover Studio…</p>
  ),
});

export default function VoiceoverStudioPageWrapper() {
  return <VoiceoverStudioPage />;
}
