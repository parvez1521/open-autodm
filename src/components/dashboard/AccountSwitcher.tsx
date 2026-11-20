"use client";

/**
 * Sidebar account switcher - pick which connected Instagram account the whole
 * console is looking at. Switching is instant (client state); every list on
 * every page re-scopes to the chosen account. "Add account" runs the same
 * OAuth connect flow as Settings.
 */

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Check, CaretUpDown, Plus, CircleNotch, SignOut, FacebookLogo, InstagramLogo } from "@/components/phosphor";
import { cn } from "@/lib/utils";
import { apiClient, ApiError } from "@/lib/api/client";
import { createBrowserClient } from "@/lib/supabase";
import { useActiveAccount } from "@/hooks/useActiveAccount";
import { useActiveFacebookPage } from "@/hooks/useActiveFacebookPage";
import type { FacebookPage } from "@/hooks/useFacebookPages";
import { IgAvatar } from "@/components/dashboard/IgAvatar";
import type { InstagramAccount } from "@/hooks/useInstagramAccounts";

type SwitcherChannel = "instagram" | "facebook";

/** Switcher popover tab persistence (2026-11-20): the selected
 *  channel survives reloads; Instagram is the default on first
 *  visit. Deliberately a SEPARATE key from the /automations tab
 *  (opendm-automations-channel): sharing it would let a popover
 *  tab switch silently flip the automations list filter. */
const SWITCHER_CHANNEL_STORAGE_KEY = "opendm-switcher-channel";

function AccountAvatar({ account, size = 7 }: { account: InstagramAccount | null; size?: 6 | 7 }) {
    return (
        <IgAvatar
            username={account?.username}
            pictureUrl={account?.profile_picture_url}
            className={size === 6 ? "w-6 h-6" : "w-7 h-7"}
        />
    );
}

function FacebookPageAvatar({ page, size = 7 }: { page: FacebookPage | null; size?: 6 | 7 }) {
    if (page?.profile_picture_url) {
        return <img src={page.profile_picture_url} alt={page.name} className={size === 6 ? "w-6 h-6 rounded-full object-cover shrink-0" : "w-7 h-7 rounded-full object-cover shrink-0"} />;
    }
    return (
        <span className={size === 6 ? "w-6 h-6 rounded-full bg-[#1877F2]/10 flex items-center justify-center shrink-0" : "w-7 h-7 rounded-full bg-[#1877F2]/10 flex items-center justify-center shrink-0"}>
            <FacebookLogo className={size === 6 ? "w-3.5 h-3.5 text-[#1877F2]" : "w-4 h-4 text-[#1877F2]"} />
        </span>
    );
}

export function AccountSwitcher({ isCollapsed, userEmail = null }: { isCollapsed: boolean; userEmail?: string | null }) {
    const { account, accounts, setActiveAccount } = useActiveAccount();
    // Facebook Pages (2026-11-19) — a SEPARATE selection from the IG
    // account above. Picking a Page never clears the IG selection:
    // the two consoles coexist, and the automations page shows the
    // funnels for both selections.
    const { page: fbPage, pages: fbPages, setActiveFacebookPage } = useActiveFacebookPage();
    const [open, setOpen] = useState(false);
    const [switcherChannel, setSwitcherChannel] = useState<SwitcherChannel>(() => {
        if (typeof window === "undefined") return "instagram";
        try {
            return window.localStorage.getItem(SWITCHER_CHANNEL_STORAGE_KEY) === "facebook" ? "facebook" : "instagram";
        } catch {
            return "instagram";
        }
    });
    const [connecting, setConnecting] = useState(false);
    const [connectError, setConnectError] = useState<string | null>(null);
    const [fbConnecting, setFbConnecting] = useState(false);
    const [fbConnectError, setFbConnectError] = useState<string | null>(null);
    const [signingOut, setSigningOut] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    // Persist the popover channel choice (same pattern as the
    // /automations channel tabs).
    useEffect(() => {
        try {
            window.localStorage.setItem(SWITCHER_CHANNEL_STORAGE_KEY, switcherChannel);
        } catch {
            // Storage unavailable (private mode) — the tab still
            // works for this visit; nothing else depends on it.
        }
    }, [switcherChannel]);

    // Open the popover on a channel: clicking the other channel's
    // row while open switches the tab; clicking the same row
    // again closes it. Selecting a channel never clears the other
    // channel's selection.
    const openChannel = (channel: SwitcherChannel) => {
        if (open && switcherChannel === channel) {
            setOpen(false);
            return;
        }
        setSwitcherChannel(channel);
        setOpen(true);
    };

    const handleSignOut = async () => {
        setSigningOut(true);
        const supabase = createBrowserClient();
        await supabase.auth.signOut();
        window.location.href = "/login";
    };

    // Close on outside click / Escape
    useEffect(() => {
        if (!open) return;
        const onClick = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onClick);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onClick);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    const handleConnect = async () => {
        setConnecting(true);
        setConnectError(null);
        try {
            const { url } = await apiClient<{ url: string }>("/instagram/connect");
            window.location.href = url;
        } catch (err) {
            setConnectError(err instanceof ApiError ? err.message : "Couldn't start the connection");
            setConnecting(false);
        }
    };

    const handleConnectFacebook = async () => {
        setFbConnecting(true);
        setFbConnectError(null);
        try {
            const { url } = await apiClient<{ url: string }>("/facebook/connect");
            window.location.href = url;
        } catch (err) {
            setFbConnectError(err instanceof ApiError ? err.message : "Couldn't start the connection");
            setFbConnecting(false);
        }
    };

    return (
        <div ref={rootRef} className="relative">
            {/* Trigger — one compact row per channel (2026-11-20):
                the Instagram row and the Facebook row are separate
                options; each opens the popover on its own channel.
                Collapsed: the two rows collapse to their icons with
                the existing title tooltips. */}
            <div className={cn("flex flex-col", isCollapsed ? "gap-1" : "gap-0.5")}>
                <button
                    onClick={() => openChannel("instagram")}
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    className={cn(
                        "w-full flex items-center rounded-lg p-2 hover:bg-muted/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                        isCollapsed ? "justify-center" : "gap-2.5"
                    )}
                    title={isCollapsed ? (account ? `@${account.username}` : "Instagram accounts") : undefined}
                >
                    <AccountAvatar account={account} />
                    {!isCollapsed && (
                        <>
                            <div className="flex flex-col min-w-0 flex-1 text-left">
                                {account ? (
                                    <>
                                        <span className="text-[12px] font-medium text-foreground truncate leading-tight">@{account.username}</span>
                                        <span className="text-[10px] text-muted-foreground leading-tight">
                                            {accounts.length > 1 ? `${accounts.length} accounts` : "Connected"}
                                        </span>
                                    </>
                                ) : (
                                    <>
                                        <span className="text-[12px] font-medium text-foreground leading-tight">No account</span>
                                        <span className="text-[10px] text-muted-foreground leading-tight">Connect Instagram</span>
                                    </>
                                )}
                            </div>
                            <CaretUpDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        </>
                    )}
                </button>
                <button
                    onClick={() => openChannel("facebook")}
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    className={cn(
                        "w-full flex items-center rounded-lg p-2 hover:bg-muted/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                        isCollapsed ? "justify-center" : "gap-2.5"
                    )}
                    title={isCollapsed ? (fbPage ? fbPage.name : "Facebook Pages") : undefined}
                >
                    <FacebookPageAvatar page={fbPage} />
                    {!isCollapsed && (
                        <>
                            <div className="flex flex-col min-w-0 flex-1 text-left">
                                {fbPage ? (
                                    <>
                                        <span className="text-[12px] font-medium text-foreground truncate leading-tight">{fbPage.name}</span>
                                        <span className="text-[10px] text-muted-foreground leading-tight">
                                            {fbPage.is_paused ? "Safety pause" : "Active"}
                                        </span>
                                    </>
                                ) : (
                                    <>
                                        <span className="text-[12px] font-medium text-foreground leading-tight">No Page connected</span>
                                        <span className="text-[10px] text-muted-foreground leading-tight">Connect Facebook</span>
                                    </>
                                )}
                            </div>
                            <CaretUpDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        </>
                    )}
                </button>
            </div>

            {/* Popover */}
            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, y: 6, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 6, scale: 0.98 }}
                        transition={{ duration: 0.12 }}
                        role="listbox"
                        className={cn(
                            "absolute bottom-full mb-2 w-56 bg-popover border border-border rounded-xl shadow-xl overflow-hidden z-[100]",
                            isCollapsed ? "left-0" : "left-0 right-0 w-auto min-w-[210px]"
                        )}
                    >
                        {/* Channel toggle (2026-11-20) — same pill style
                            as the /automations channel tabs; only the
                            selected channel's list + Add button show. */}
                        <div className="px-3 pt-2.5 pb-1">
                            <div className="flex items-center bg-muted rounded-lg p-0.5" role="tablist" aria-label="Account channel">
                                {(["instagram", "facebook"] as const).map((channel) => {
                                    const Icon = channel === "instagram" ? InstagramLogo : FacebookLogo;
                                    return (
                                        <button
                                            key={channel}
                                            onClick={() => setSwitcherChannel(channel)}
                                            aria-pressed={switcherChannel === channel}
                                            className={cn(
                                                "inline-flex flex-1 items-center justify-center gap-1.5 h-8 px-3.5 rounded-[7px] text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                                                switcherChannel === channel
                                                    ? "bg-card text-foreground shadow-sm"
                                                    : "text-muted-foreground hover:text-foreground"
                                            )}
                                        >
                                            <Icon className="w-3.5 h-3.5" />
                                            {channel === "instagram" ? "Instagram" : "Facebook"}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                        {switcherChannel === "instagram" && (
                        <>
                        <div className="px-3 pt-2.5 pb-1.5">
                            <span className="micro-label">Instagram accounts</span>
                        </div>
                        <div className="px-1.5 pb-1.5 max-h-56 overflow-y-auto custom-scrollbar">
                            {accounts.length === 0 && (
                                <p className="px-2 py-2 text-[12px] text-muted-foreground">Nothing connected yet.</p>
                            )}
                            {accounts.map((a) => {
                                const isActive = a.id === account?.id;
                                return (
                                    <button
                                        key={a.id}
                                        role="option"
                                        aria-selected={isActive}
                                        onClick={() => { setActiveAccount(a.id); setOpen(false); }}
                                        className={cn(
                                            "w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition-colors",
                                            isActive ? "bg-muted" : "hover:bg-muted/60"
                                        )}
                                    >
                                        <AccountAvatar account={a} size={6} />
                                        <div className="flex flex-col min-w-0 flex-1">
                                            <span className="text-[12.5px] font-medium text-foreground truncate leading-tight">@{a.username}</span>
                                            <span className="text-[10px] text-muted-foreground leading-tight">
                                                {a.is_paused ? "Safety pause" : a.token_status === "expired" ? "Token expired" : "Active"}
                                            </span>
                                        </div>
                                        {isActive && <Check className="w-3.5 h-3.5 text-foreground shrink-0" />}
                                    </button>
                                );
                            })}
                        </div>
                        <div className="border-t border-border p-1.5">
                            <button
                                onClick={() => void handleConnect()}
                                disabled={connecting}
                                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[12.5px] font-medium text-foreground hover:bg-muted/60 disabled:opacity-60 transition-colors"
                            >
                                {connecting ? <CircleNotch className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                                {connecting ? "Redirecting…" : "Add account"}
                            </button>
                            {connectError && <p className="px-2 pb-1 text-[11px] text-destructive">{connectError}</p>}
                        </div>
                        </>)}
                        {switcherChannel === "facebook" && (
                        <>
                        {/* Facebook Pages (2026-11-19) — same popover, its own
                            section and its own selection. */}
                        <div className="border-t border-border px-3 pt-2.5 pb-1.5">
                            <span className="micro-label">Facebook Pages</span>
                        </div>
                        <div className="px-1.5 pb-1.5 max-h-56 overflow-y-auto custom-scrollbar">
                            {fbPages.length === 0 && (
                                <p className="px-2 py-2 text-[12px] text-muted-foreground">No Page connected yet.</p>
                            )}
                            {fbPages.map((p) => {
                                const isActive = p.id === fbPage?.id;
                                return (
                                    <button
                                        key={p.id}
                                        role="option"
                                        aria-selected={isActive}
                                        onClick={() => { setActiveFacebookPage(p.id); setOpen(false); }}
                                        className={cn(
                                            "w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition-colors",
                                            isActive ? "bg-muted" : "hover:bg-muted/60"
                                        )}
                                    >
                                        <FacebookPageAvatar page={p} size={6} />
                                        <div className="flex flex-col min-w-0 flex-1">
                                            <span className="text-[12.5px] font-medium text-foreground truncate leading-tight">{p.name}</span>
                                            <span className="text-[10px] text-muted-foreground leading-tight">
                                                {p.is_paused ? "Safety pause" : "Active"}
                                            </span>
                                        </div>
                                        {isActive && <Check className="w-3.5 h-3.5 text-foreground shrink-0" />}
                                    </button>
                                );
                            })}
                        </div>
                        <div className="border-t border-border p-1.5">
                            <button
                                onClick={() => void handleConnectFacebook()}
                                disabled={fbConnecting}
                                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[12.5px] font-medium text-foreground hover:bg-muted/60 disabled:opacity-60 transition-colors"
                            >
                                {fbConnecting ? <CircleNotch className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                                {fbConnecting ? "Redirecting…" : "Add Page"}
                            </button>
                            {fbConnectError && <p className="px-2 pb-1 text-[11px] text-destructive">{fbConnectError}</p>}
                        </div>
                        </>)}
                        {/* Session — the signed-in user (functional audit fix:
                            identity + sign-out inside the account menu too) */}
                        <div className="border-t border-border p-1.5">
                            {userEmail && (
                                <p className="px-2 pt-1 pb-1.5 text-[11px] text-muted-foreground truncate" title={userEmail}>
                                    Signed in as <span className="text-foreground/80 font-medium">{userEmail}</span>
                                </p>
                            )}
                            <button
                                onClick={() => void handleSignOut()}
                                disabled={signingOut}
                                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[12.5px] font-medium text-muted-foreground hover:text-destructive hover:bg-muted/60 disabled:opacity-60 transition-colors"
                            >
                                {signingOut ? <CircleNotch className="w-3.5 h-3.5 animate-spin" /> : <SignOut className="w-3.5 h-3.5" />}
                                {signingOut ? "Signing out…" : "Sign out"}
                            </button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
