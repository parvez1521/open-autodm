import { motion } from "motion/react";
import { ChatCircle, PlayCircle, Stack, MagnifyingGlass, InstagramLogo, Heart } from "@/components/phosphor";
import { cn } from "@/lib/utils";
import { useState, type FormEvent } from "react";
import { useInstagramPosts, useResolveInstagramPost } from "@/hooks/useInstagramPosts";
import { shouldShowLoadMore } from "./postPickerUtils";

interface SelectPostStepProps {
    onSelect: (postId: string, name: string, thumbnailUrl?: string | null, caption?: string) => void;
    selectedPost: string | null;
    flowName: string;
    instagramAccountId?: string | null;
}

export function SelectPostStep({ onSelect, selectedPost, flowName, instagramAccountId }: SelectPostStepProps) {
    const [searchQuery, setSearchQuery] = useState("");
    const [filter, setFilter] = useState<"all" | "reels" | "posts">("all");
    const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage, isFetching, refresh } = useInstagramPosts(instagramAccountId);
    const resolvePost = useResolveInstagramPost();
    const [pasteUrl, setPasteUrl] = useState("");
    const [pasteError, setPasteError] = useState<string | null>(null);
    const [pasteLoading, setPasteLoading] = useState(false);

    const allPosts = data?.pages.flatMap(p => p.posts) ?? [];

    // Paste-link: the list only ever shows posts the connected account
    // OWNS (collab posts owned by the other account never appear), so
    // a pasted link resolves the post by ID and selects it through the
    // exact same onSelect path as clicking a tile.
    async function handlePasteSubmit(e: FormEvent) {
        e.preventDefault();
        if (!instagramAccountId || pasteLoading) return;
        const url = pasteUrl.trim();
        if (!url) return;
        setPasteLoading(true);
        setPasteError(null);
        try {
            const post = await resolvePost(instagramAccountId, url);
            onSelect(post.id, flowName, post.thumbnail_url ?? post.media_url ?? null, post.caption ?? "");
        } catch (err) {
            setPasteError(err instanceof Error ? err.message : "Is post ko load nahi kar paye — link check karo.");
        } finally {
            setPasteLoading(false);
        }
    }

    const filteredPosts = allPosts.filter(post => {
        const matchesSearch = post.caption.toLowerCase().includes(searchQuery.toLowerCase());
        const matchesFilter =
            filter === "all" ||
            (filter === "reels" && post.type === "reel") ||
            (filter === "posts" && post.type !== "reel");
        return matchesSearch && matchesFilter;
    });

    const hasMore = shouldShowLoadMore(hasNextPage);

    return (
        <div className="flex flex-col w-full h-full">
            {/* Top bar */}
            <div className="sticky top-0 z-20 bg-background border-b border-border">
                <div className="px-5 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                        <div className="inline-flex items-center bg-muted rounded-lg p-0.5">
                            {(["all", "reels", "posts"] as const).map((f) => (
                                <button
                                    key={f}
                                    onClick={() => setFilter(f)}
                                    className={cn(
                                        "h-7 px-3 rounded-[7px] text-[12px] font-medium capitalize transition-colors",
                                        filter === f
                                            ? "bg-card text-foreground shadow-sm"
                                            : "text-muted-foreground hover:text-foreground"
                                    )}
                                >
                                    {f === "all" ? "All media" : f === "reels" ? "Reels" : "Photos"}
                                </button>
                            ))}
                        </div>
                        <button
                            onClick={() => onSelect("all", flowName, null, "")}
                            className="inline-flex items-center gap-1.5 h-8 px-3 text-[12px] font-medium border border-border hover:border-foreground/25 rounded-lg transition-colors"
                        >
                            <Stack className="w-3.5 h-3.5 opacity-60" />
                            Trigger on all posts
                        </button>
                        <button
                            type="button"
                            onClick={refresh}
                            disabled={isFetching}
                            title="Reload posts from Instagram (skips the 5-minute cache)"
                            className="inline-flex items-center gap-1.5 h-8 px-3 text-[12px] font-medium border border-border hover:border-foreground/25 rounded-lg transition-colors disabled:opacity-60"
                        >
                            {isFetching ? "Refreshing…" : "Refresh"}
                        </button>
                    </div>

                    <div className="relative w-full sm:w-60">
                        <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                        <input
                            type="text"
                            placeholder="Search captions…"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full h-8 bg-muted/50 border border-border rounded-lg pl-8 pr-3 text-[13px] outline-none focus:border-foreground/30 transition-colors"
                        />
                    </div>
                </div>
            </div>

            {/* Grid */}
            <div className="flex-1 overflow-y-auto p-5 custom-scrollbar">
                <div className="max-w-5xl mx-auto">
                    {!instagramAccountId ? (
                        <div className="flex flex-col items-center justify-center p-12 text-center border border-border border-dashed rounded-xl">
                            <InstagramLogo className="w-7 h-7 text-muted-foreground/30 mb-3" />
                            <p className="text-[13px] text-muted-foreground font-medium">No Instagram account connected.</p>
                            <p className="text-[12px] text-muted-foreground/70 mt-1">
                                Connect your account in Settings first.
                            </p>
                        </div>
                    ) : isLoading ? (
                        <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-2.5">
                            {Array.from({ length: 10 }).map((_, i) => (
                                <div key={i} className="aspect-[4/5] rounded-lg overflow-hidden">
                                    <div className="w-full h-full bg-muted/50 relative overflow-hidden">
                                        <div
                                            className="absolute inset-0 -translate-x-full animate-[shimmer_1.5s_infinite]"
                                            style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.05), transparent)" }}
                                        />
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : isError ? (
                        <div className="flex flex-col items-center justify-center p-12 text-center border border-destructive/20 border-dashed rounded-xl bg-destructive/5">
                            <p className="text-[13px] text-destructive font-medium">Couldn&apos;t load posts.</p>
                            <p className="text-[12px] text-muted-foreground mt-1">Check that your Instagram account is still connected.</p>
                        </div>
                    ) : filteredPosts.length === 0 ? (
                        <div className="flex flex-col items-center justify-center p-12 text-center border border-border border-dashed rounded-xl">
                            <p className="text-[13px] text-muted-foreground font-medium">No posts found.</p>
                        </div>
                    ) : (
                        <>
                            <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-2.5">
                                {filteredPosts.map((post, idx) => {
                                    const isSelected = selectedPost === post.id;
                                    const thumbUrl = post.thumbnail_url ?? post.media_url;

                                    return (
                                        <motion.button
                                            key={post.id}
                                            initial={{ opacity: 0, y: 10 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            transition={{ delay: Math.min(idx * 0.03, 0.3) }}
                                            onClick={() => onSelect(post.id, flowName, thumbUrl ?? null, post.caption ?? "")}
                                            className={cn(
                                                "group relative rounded-lg overflow-hidden cursor-pointer text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                                                isSelected
                                                    ? "ring-2 ring-foreground ring-offset-2 ring-offset-background"
                                                    : "ring-1 ring-border hover:ring-foreground/30"
                                            )}
                                        >
                                            <div className="aspect-[4/5] relative bg-muted w-full overflow-hidden">
                                                {thumbUrl ? (
                                                    <img
                                                        src={thumbUrl}
                                                        alt="Post thumbnail"
                                                        className="w-full h-full object-cover"
                                                    />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center bg-muted">
                                                        <InstagramLogo className="w-6 h-6 text-muted-foreground/30" />
                                                    </div>
                                                )}

                                                <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/55 flex items-center justify-center">
                                                    {post.type === "reel" ? <PlayCircle className="w-3 h-3 text-white" /> :
                                                     post.type === "carousel" ? <Stack className="w-3 h-3 text-white" /> :
                                                     <span className="w-2.5 h-2.5 bg-white rounded-[2px] opacity-80" />}
                                                </div>

                                                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-2.5 pt-8">
                                                    <p className="text-[11px] text-white/95 font-medium line-clamp-2 leading-snug mb-1">
                                                        {post.caption || <span className="text-white/50 italic">No caption</span>}
                                                    </p>
                                                    <div className="flex items-center justify-between text-white/70 text-[10px] font-medium tabular-nums">
                                                        <span className="flex items-center gap-1"><Heart className="w-2.5 h-2.5" />{post.like_count.toLocaleString()}</span>
                                                        <span className="flex items-center gap-1"><ChatCircle className="w-2.5 h-2.5" />{post.comments_count.toLocaleString()}</span>
                                                        <span>{new Date(post.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                                                    </div>
                                                </div>
                                            </div>

                                            {isSelected && (
                                                <div className="absolute top-2 left-2 w-6 h-6 bg-foreground rounded-full flex items-center justify-center">
                                                    <svg className="w-3.5 h-3.5 text-background" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                                    </svg>
                                                </div>
                                            )}
                                        </motion.button>
                                    );
                                })}
                            </div>

                            {(hasMore || isFetchingNextPage) && (
                                <div className="flex justify-center mt-6">
                                    <button
                                        onClick={() => void fetchNextPage()}
                                        disabled={isFetchingNextPage}
                                        className="inline-flex items-center gap-2 h-8 px-4 text-[12px] font-medium border border-border hover:bg-muted rounded-lg transition-colors disabled:opacity-60"
                                    >
                                        {isFetchingNextPage ? "Loading…" : "Load more"}
                                    </button>
                                </div>
                            )}
                        </>
                    )}

                    {/* Paste a post link — the grid only lists posts this
                        account owns; a collab reel owned by the other
                        account (e.g. the newest reel) never appears there,
                        so its link resolves it directly instead. */}
                    {instagramAccountId && (
                        <form onSubmit={handlePasteSubmit} className="mt-6 border border-border rounded-xl p-4">
                            <p className="text-[13px] font-medium">Post list mein nahi dikh raha?</p>
                            <p className="text-[12px] text-muted-foreground mt-0.5">
                                Agar tumhara post (jaise collab wala reel) list mein nahi aata, to uska Instagram link yahan paste karo.
                            </p>
                            <div className="flex flex-col sm:flex-row gap-2 mt-3">
                                <input
                                    type="text"
                                    placeholder="https://www.instagram.com/p/..."
                                    value={pasteUrl}
                                    onChange={(e) => setPasteUrl(e.target.value)}
                                    className="flex-1 h-9 bg-muted/50 border border-border rounded-lg px-3 text-[13px] outline-none focus:border-foreground/30 transition-colors"
                                />
                                <button
                                    type="submit"
                                    disabled={pasteLoading || !pasteUrl.trim()}
                                    className="inline-flex items-center justify-center h-9 px-4 text-[12px] font-medium border border-border hover:border-foreground/25 rounded-lg transition-colors disabled:opacity-60"
                                >
                                    {pasteLoading ? "Loading…" : "Load post"}
                                </button>
                            </div>
                            {pasteError && (
                                <p className="text-[12px] text-destructive mt-2">{pasteError}</p>
                            )}
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
}
