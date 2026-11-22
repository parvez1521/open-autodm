"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { EASE_OUT } from "@/lib/motion/presets";
import { ChatCircle, PaperPlaneTilt, Image as ImageIcon, Clock, Lightning, Pencil, Copy, Stack, InstagramLogo, FacebookLogo, Warning, Trash, X, CursorClick, At, Link as LinkIcon } from "@/components/phosphor";
import { cn } from "@/lib/utils";
import type { AutomationFromDB } from "@/hooks/useAutomations";
import { usePostThumbnails, type ThumbnailRequestItem } from "@/hooks/usePostThumbnails";
import { PostThumb } from "@/components/automations/PostThumb";

const TYPE_CONFIG: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; className: string }> = {
    comment_dm: { label: "Comment → DM", icon: ChatCircle, className: "bg-[#F97316]/10 text-[#F97316]" },
    dm_reply: { label: "DM Reply", icon: PaperPlaneTilt, className: "bg-blue-500/10 text-blue-500" },
    story_reply: { label: "Story Reply", icon: ImageIcon, className: "bg-emerald-500/10 text-emerald-500" },
    reel_dm: { label: "Shared Reel → DM", icon: PaperPlaneTilt, className: "bg-rose-500/10 text-rose-500" },
    story_mention: { label: "Story Mention → DM", icon: At, className: "bg-amber-500/10 text-amber-500" },
    fb_comment_dm: { label: "Comment → Messenger", icon: FacebookLogo, className: "bg-[#1877F2]/10 text-[#1877F2]" },
    fb_dm_reply: { label: "Messenger Reply", icon: FacebookLogo, className: "bg-[#1877F2]/10 text-[#1877F2]" },
};

function triggerDescription(automation: AutomationFromDB): string {
    const keywords = automation.keywords;
    if (!keywords || keywords.length === 0 || keywords.includes("*ANY*")) {
        return "Any trigger";
    }
    return `"${keywords[0]}"${keywords.length > 1 ? ` +${keywords.length - 1}` : ""}`;
}

interface AutomationsListProps {
    automations: AutomationFromDB[];
    isLoading: boolean;
    onToggle: (id: string, currentlyActive: boolean) => void;
    onDelete: (id: string) => void;
    onEdit: (automation: AutomationFromDB) => void;
    /**
     * Duplicate (2026-11-22): copies the whole config under
     * "Copy of <name>", always starting INACTIVE. Optional so older
     * callers keep working; the page passes it.
     */
    onDuplicate?: (id: string) => void;
    /** Id of the row whose duplicate is in flight (button disabled). */
    duplicatingId?: string | null;
    deleteError?: string | null;
    /**
     * QA fix (2026-11-08): the list query's failure, surfaced by the
     * page. Before this, the page discarded the query error entirely,
     * so a failed fetch was indistinguishable from an empty list —
     * and while the fetch was wedged the loading skeleton below was
     * the only thing on screen, forever. The empty state now renders
     * ONLY for a settled, successful, genuinely-empty result.
     */
    loadError?: string | null;
    onRetry?: () => void;
    /**
     * Channel-aware empty state (2026-11-20): the /automations page
     * passes channel-specific copy so the empty state never hides
     * the real reason (e.g. no Facebook Page connected yet).
     * Defaults keep the original generic copy.
     */
    emptyTitle?: string;
    emptyMessage?: string;
}

export function AutomationsList({ automations, isLoading, onToggle, onDelete, onEdit, onDuplicate, duplicatingId, deleteError, loadError, onRetry, emptyTitle, emptyMessage }: AutomationsListProps) {
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

    // Fresh thumbnails (2026-11-22): the stored post_thumbnail_url
    // snapshot expires within days (CDN signatures), so resolve a
    // fresh URL per post at render time. Items are memoised by content
    // inside the hook's query key; while the refresh is pending the
    // stored snapshot still shows, and PostThumb falls back to the
    // platform icon if that is dead too.
    const thumbnailItems: ThumbnailRequestItem[] = automations
        .filter((a) => a.post_id)
        .map((a) => ({
            postId: a.post_id!,
            channel: a.channel === "facebook" ? "facebook" : "instagram",
            accountId: a.channel === "facebook" ? a.facebook_page_id ?? null : a.instagram_account_id,
        }));
    const { thumbnails: freshThumbnails } = usePostThumbnails(thumbnailItems);

    if (isLoading) {
        return (
            <div className="flex flex-col space-y-2">
                {[1, 2, 3].map((i) => (
                    <div key={i} className="h-[72px] rounded-xl bg-muted/40 border border-border animate-pulse" />
                ))}
            </div>
        );
    }

    if (loadError && automations.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center p-14 text-center border border-destructive/30 rounded-xl" role="alert">
                <div className="w-11 h-11 rounded-xl bg-destructive/10 flex items-center justify-center mb-4">
                    <Warning className="w-5 h-5 text-destructive" />
                </div>
                <h3 className="text-[15px] font-heading font-semibold mb-1 text-foreground">Couldn&apos;t load your automations</h3>
                <p className="text-[13px] text-muted-foreground max-w-xs">
                    {loadError} This is a loading problem, not an empty list — your automations were not changed.
                </p>
                {onRetry && (
                    <button
                        onClick={onRetry}
                        className="mt-4 inline-flex h-9 items-center rounded-lg bg-foreground px-4 text-sm font-semibold text-background transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    >
                        Try again
                    </button>
                )}
            </div>
        );
    }

    if (automations.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center p-14 text-center border border-border border-dashed rounded-xl">
                <div className="w-11 h-11 rounded-xl bg-muted flex items-center justify-center mb-4">
                    <Lightning className="w-5 h-5 text-muted-foreground" />
                </div>
                <h3 className="text-[15px] font-heading font-semibold mb-1 text-foreground">{emptyTitle ?? "No automations yet"}</h3>
                <p className="text-[13px] text-muted-foreground max-w-xs">
                    {emptyMessage ?? "Create one to reply to comments, DMs, or story replies automatically."}
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col space-y-2 w-full">
            {loadError && (
                <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-lg bg-destructive/10 text-[13px] text-destructive font-medium" role="alert">
                    <Warning className="w-3.5 h-3.5 shrink-0" />
                    Couldn&apos;t refresh the list — showing the last loaded automations.
                    {onRetry && (
                        <button onClick={onRetry} className="ml-auto shrink-0 font-semibold underline underline-offset-2 hover:opacity-80">
                            Retry
                        </button>
                    )}
                </div>
            )}

            {deleteError && (
                <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-lg bg-destructive/10 text-[13px] text-destructive font-medium">
                    <Warning className="w-3.5 h-3.5 shrink-0" />
                    {deleteError}
                </div>
            )}

            {automations.map((automation, idx) => {
                const isActive = automation.is_active;
                const typeConfig = TYPE_CONFIG[automation.type] ?? { label: automation.type, icon: ChatCircle, className: "bg-muted text-muted-foreground" };
                const TypeIcon = typeConfig.icon;
                const isConfirmingDelete = confirmDeleteId === automation.id;
                const hasPost = !!automation.post_id;
                // Fresh URL first, stored snapshot second (it may still
                // work for recent automations); PostThumb's onError
                // fallback covers a dead URL either way.
                const thumbUrl = hasPost
                    ? (freshThumbnails[automation.post_id!] ?? automation.post_thumbnail_url)
                    : null;

                return (
                    <motion.div
                        key={automation.id}
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: Math.min(idx * 0.04, 0.3), duration: 0.45, ease: EASE_OUT }}
                        className={cn(
                            "group relative bg-card rounded-xl border transition-colors overflow-hidden",
                            isActive ? "border-border hover:border-foreground/20" : "border-border"
                        )}
                    >
                        <div className="flex items-center justify-between gap-4 p-3.5">
                            {/* Left - thumb + info */}
                            <div className="flex items-center gap-3 flex-1 min-w-0">
                                <div className="shrink-0">
                                    {(automation.type === "comment_dm" || automation.type === "reel_dm" || automation.type === "fb_comment_dm") ? (
                                        hasPost ? (
                                            <PostThumb
                                                src={thumbUrl}
                                                alt="Post"
                                                className="w-10 h-10 rounded-lg"
                                                fallback={
                                                    <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                                                        {automation.channel === "facebook" ? (
                                                            <FacebookLogo className="w-4 h-4 text-muted-foreground/60" />
                                                        ) : (
                                                            <InstagramLogo className="w-4 h-4 text-muted-foreground/60" />
                                                        )}
                                                    </div>
                                                }
                                            />
                                        ) : (
                                            <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                                                <Stack className="w-4 h-4 text-muted-foreground/60" />
                                            </div>
                                        )
                                    ) : (
                                        <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center", typeConfig.className)}>
                                            <TypeIcon className="w-4 h-4" />
                                        </div>
                                    )}
                                </div>

                                <div className="flex flex-col gap-1 min-w-0">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <h3 className="text-[13.5px] font-semibold text-foreground leading-tight truncate">
                                            {automation.name}
                                        </h3>
                                        <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0", typeConfig.className)}>
                                            {typeConfig.label}
                                        </span>
                                        {automation.channel === "facebook" && (
                                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 bg-[#1877F2]/10 text-[#1877F2]">
                                                <FacebookLogo className="w-3 h-3" />
                                                Facebook{automation.facebook_pages?.name ? ` · ${automation.facebook_pages.name}` : ""}
                                            </span>
                                        )}
                                        {!isActive && (
                                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 bg-muted text-muted-foreground">
                                                {automation.paused_by_disconnect
                                                    ? "Paused — account disconnected"
                                                    : "Paused"}
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex items-center text-[12px] text-muted-foreground gap-3 min-w-0">
                                        <span className="flex items-center gap-1 truncate">
                                            <CursorClick className="w-3 h-3 opacity-60 shrink-0" />
                                            {triggerDescription(automation)}
                                        </span>
                                        {(automation.type === "comment_dm" || automation.type === "reel_dm" || automation.type === "fb_comment_dm") && (
                                            <span className="truncate hidden sm:inline">
                                                {hasPost ? (automation.post_caption ? automation.post_caption.slice(0, 44) : "Specific post") : automation.type === "reel_dm" ? "Any shared reel" : "All posts"}
                                            </span>
                                        )}
                                        <span className="items-center gap-1 hidden md:flex shrink-0">
                                            <Clock className="w-3 h-3 opacity-60" />
                                            {new Date(automation.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            {/* Right - stats + actions */}
                            <div className="flex items-center gap-4 shrink-0">
                                <div className="hidden sm:flex flex-col items-end">
                                    <span className="text-[15px] font-heading font-semibold tabular-nums leading-tight">{automation.total_dms_sent.toLocaleString()}</span>
                                    <span className="text-[10px] text-muted-foreground uppercase tracking-wider">DMs</span>
                                </div>
                                {/* Link clicks (2026-11-17): tracked /r/[code] opens
                                    across this automation's links; 0 when the
                                    migration is not applied yet. */}
                                <div className="hidden sm:flex flex-col items-end" title="Link clicks — how many people opened a link this automation sent">
                                    <span className="text-[15px] font-heading font-semibold tabular-nums leading-tight flex items-center gap-1">
                                        <LinkIcon className="w-3.5 h-3.5 text-muted-foreground" />
                                        {(automation.total_link_clicks ?? 0).toLocaleString()}
                                    </span>
                                    <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Clicks</span>
                                </div>

                                <div className="flex items-center gap-1">
                                    {/* Toggle - works both ways: pause or resume
                                        straight from the list. It used to be
                                        frozen while inactive ("open edit to
                                        activate"), which read as broken. */}
                                    <div className="relative mr-1">
                                        <button
                                            onClick={() => onToggle(automation.id, isActive)}
                                            role="switch"
                                            aria-checked={isActive}
                                            className={cn(
                                                "relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 cursor-pointer",
                                                isActive ? "bg-secondary" : "bg-muted-foreground/25"
                                            )}
                                            title={isActive ? "Pause automation" : "Resume automation"}
                                        >
                                            <span className={cn(
                                                "pointer-events-none inline-block h-4 w-4 translate-y-[2px] rounded-full bg-white shadow-sm transition-transform",
                                                isActive ? "translate-x-[18px]" : "translate-x-[2px]"
                                            )} />
                                        </button>
                                    </div>

                                    <button
                                        onClick={() => onEdit(automation)}
                                        className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
                                        title="Edit automation"
                                    >
                                        <Pencil className="w-3.5 h-3.5" />
                                    </button>
                                    {onDuplicate && (
                                        <button
                                            onClick={() => onDuplicate(automation.id)}
                                            disabled={duplicatingId === automation.id}
                                            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors disabled:opacity-50"
                                            title="Duplicate automation — copies the whole config as an inactive automation"
                                        >
                                            <Copy className="w-3.5 h-3.5" />
                                        </button>
                                    )}
                                    <button
                                        onClick={() => setConfirmDeleteId(automation.id)}
                                        className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors"
                                        title="Delete automation"
                                    >
                                        <Trash className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* Inline delete confirmation */}
                        <AnimatePresence>
                            {isConfirmingDelete && (
                                <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: "auto", opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.15 }}
                                    className="overflow-hidden"
                                >
                                    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 bg-destructive/5 border-t border-destructive/20">
                                        <span className="text-[13px] text-destructive font-medium truncate">
                                            Delete &ldquo;{automation.name}&rdquo;? This can&apos;t be undone.
                                        </span>
                                        <div className="flex items-center gap-1.5 shrink-0">
                                            <button
                                                onClick={() => setConfirmDeleteId(null)}
                                                className="inline-flex items-center gap-1 h-7 px-2.5 text-[12px] font-medium rounded-md border border-border hover:bg-muted transition-colors"
                                            >
                                                <X className="w-3 h-3" /> Cancel
                                            </button>
                                            <button
                                                onClick={() => { setConfirmDeleteId(null); onDelete(automation.id); }}
                                                className="inline-flex items-center gap-1 h-7 px-2.5 text-[12px] font-semibold text-white bg-destructive hover:bg-destructive/90 rounded-md transition-colors"
                                            >
                                                <Trash className="w-3 h-3" /> Delete
                                            </button>
                                        </div>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </motion.div>
                );
            })}
        </div>
    );
}
