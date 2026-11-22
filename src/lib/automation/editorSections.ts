/**
 * Stepped editor sections (2026-11-22, owner).
 *
 * The automation editor (ConfigureStep) shows its form as an accordion —
 * Post → Keyword → Follow required → DM message, one section open at a
 * time — because the old single long form felt cluttered. Only the
 * wrapping changed: every field, default, validation rule and save
 * payload is exactly as before.
 *
 * This module is the pure part of that layout: which sections a flow
 * type shows, in what order, with what header summary and done state.
 * It reads only the flow data, so it is unit-tested without a DOM.
 */

export type EditorSectionId = "post" | "keyword" | "follow" | "dm";

export interface EditorSection {
  id: EditorSectionId;
  title: string;
  /** Short summary of what is set, shown in the collapsed header. */
  summary: string;
  /** Whether the section is configured (shows a done check). */
  done: boolean;
}

/** Minimal shape of the flow data this module reads. */
export interface EditorSectionData {
  type?: string | null;
  postId?: string | null;
  postThumbnailUrl?: string | null;
  postCaption?: string | null;
  keywords: string[];
  keywordsAnyMode?: boolean;
  askToFollowEnabled: boolean;
  isAutoDmEnabled: boolean;
  dmOpeningMessageEnabled: boolean;
  dmOpeningMessageVariations: string[];
  dmResponses: readonly unknown[];
  followUpEnabled: boolean;
}

/** Any-mode label per type — mirrors TYPE_COPY's keywordModeAny in
 *  ConfigureStep; keep the two in sync when a type's wording changes. */
const ANY_MODE_LABEL: Record<string, string> = {
  "comment-dm": "Any comment",
  "dm-reply": "Any message",
  "story-reply": "Any reply",
  "story-mention": "Any mention",
  "fb-comment-dm": "Any comment",
  "fb-dm-reply": "Any message",
};

function postSummary(data: EditorSectionData): string {
  if (data.postThumbnailUrl) {
    return data.postCaption ? data.postCaption.slice(0, 70) : "No caption";
  }
  if (data.postId && data.postId !== "all") return "Specific post selected";
  if (data.type === "reel-dm") return "Any shared reel";
  return "All posts";
}

function keywordSummary(data: EditorSectionData, isAnyMode: boolean): string {
  if (isAnyMode) {
    return ANY_MODE_LABEL[data.type ?? "comment-dm"] ?? "Any comment";
  }
  const shown = data.keywords.slice(0, 3).join(", ");
  const extra = data.keywords.length > 3 ? ` +${data.keywords.length - 3} more` : "";
  return shown + extra;
}

function dmSummary(data: EditorSectionData): string {
  if (!data.isAutoDmEnabled) return "Auto DM off";
  const variations =
    data.dmOpeningMessageVariations.length > 0 ? data.dmOpeningMessageVariations.length : 1;
  const parts = [
    `${variations} opening variation${variations === 1 ? "" : "s"}`,
    `${data.dmResponses.length} response${data.dmResponses.length === 1 ? "" : "s"}`,
  ];
  if (data.followUpEnabled) parts.push("Follow-up on");
  return parts.join(" · ");
}

/**
 * Visible sections for a flow, in display order.
 *
 * - Post: only post-targeted flows (comment-dm, reel-dm, fb-comment-dm).
 * - Keyword: every type EXCEPT reel_dm — a shared reel is triggered by
 *   the share itself, keywords are forced *ANY* (2026-11-17).
 * - Follow required: every type EXCEPT Facebook — FB has no Page-follow
 *   signal (v1).
 * - DM message: always.
 */
export function getEditorSections(data: EditorSectionData): EditorSection[] {
  const flowType = data.type ?? "comment-dm";
  const isReelDm = flowType === "reel-dm";
  const isFacebook = flowType === "fb-comment-dm" || flowType === "fb-dm-reply";
  const isComment = flowType === "comment-dm" || flowType === "fb-comment-dm";
  const hasPostTarget = isComment || isReelDm;
  const isAnyMode = isReelDm || (data.keywordsAnyMode ?? data.keywords.length === 0);

  const sections: EditorSection[] = [];
  if (hasPostTarget) {
    sections.push({
      id: "post",
      title: "Post",
      summary: postSummary(data),
      done: !!data.postId,
    });
  }
  if (!isReelDm) {
    sections.push({
      id: "keyword",
      title: "Keyword",
      summary: keywordSummary(data, isAnyMode),
      done: isAnyMode || data.keywords.length > 0,
    });
  }
  if (!isFacebook) {
    sections.push({
      id: "follow",
      title: "Follow required",
      summary: data.askToFollowEnabled ? "On — must follow first" : "Off",
      done: data.askToFollowEnabled,
    });
  }
  sections.push({
    id: "dm",
    title: "DM message",
    summary: dmSummary(data),
    done:
      data.isAutoDmEnabled && (data.dmOpeningMessageEnabled || data.dmResponses.length > 0),
  });
  return sections;
}
