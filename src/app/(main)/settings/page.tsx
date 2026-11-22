"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { InstagramLogo, FacebookLogo, CheckCircle, XCircle, CircleNotch, LinkBreak, Warning, ArrowsClockwise, Wrench, PauseCircle } from "@/components/phosphor";
import { cn } from "@/lib/utils";
import { BrandWave } from "@/components/ui/BrandWave";
import { createBrowserClient } from "@/lib/supabase";
import { ChangePasswordForm } from "@/components/auth/ChangePasswordForm";
import { IgAvatar } from "@/components/dashboard/IgAvatar";
import { apiClient, ApiError } from "@/lib/api/client";
import { useInstagramAccounts, useRefreshInstagramToken, useResubscribeWebhook, useCheckSubscription } from "@/hooks/useInstagramAccounts";
import { useFacebookPages, useDisconnectFacebookPage, useResubscribeFacebookPage } from "@/hooks/useFacebookPages";
import { useSetupStatus } from "@/hooks/useSetup";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { useQueryClient } from "@tanstack/react-query";
import { AppLoader } from "@/components/ui/AppLoader";

export default function SettingsPage() {
    return (
        <Suspense fallback={<AppLoader compact label="Loading settings…" />}>
            <SettingsContent />
        </Suspense>
    );
}

/** Facebook Page avatar with a graceful fallback — the stored
 * profile_picture_url is a Meta CDN link that expires (same class as
 * the post thumbnails); a dead one shows the Facebook mark instead
 * of a broken-image glyph (2026-11-22). Same pattern as IgAvatar. */
function FacebookPageAvatar({ page }: { page: { name: string; profile_picture_url: string | null } }) {
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        setFailed(false);
    }, [page.profile_picture_url]);
    if (page.profile_picture_url && !failed) {
        return <img src={page.profile_picture_url} alt={page.name} className="w-9 h-9 rounded-full object-cover shrink-0" onError={() => setFailed(true)} />;
    }
    return (
        <span className="w-9 h-9 rounded-full bg-[#1877F2]/10 flex items-center justify-center shrink-0">
            <FacebookLogo className="w-4 h-4 text-[#1877F2]" />
        </span>
    );
}

function SettingsContent() {
    const searchParams = useSearchParams();
    const queryClient = useQueryClient();
    // QA fix (2026-11-08): the accounts query error is consumed, not
    // discarded — a failed fetch previously rendered the "No accounts
    // connected yet" empty state (a false claim) and an unsettled
    // fetch left the two pulse bars up indefinitely.
    //
    // Audit fix (2026-11-22): both list queries are disabled while
    // the workspace scope is 'unavailable' (selection still
    // resolving), and a disabled TanStack query reports isLoading
    // false with no data — so on arrival the page flashed the "No
    // accounts/Pages connected yet" empty states before the real
    // accounts populated. The WorkspaceProvider loading flag is the
    // authoritative signal (same gate as the automations-page flash
    // fix): while it is true, both sections stay on their skeletons.
    const { loading: workspaceLoading } = useWorkspace();
    const { data: accounts, isLoading, error: accountsError, refetch: refetchAccounts } = useInstagramAccounts();
    const { data: setup } = useSetupStatus();
    // Facebook Pages (2026-11-19) — same Settings page, its own section.
    const { data: fbPages, isLoading: fbLoading, error: fbError, refetch: refetchFbPages } = useFacebookPages();
    const fbDisconnectMutation = useDisconnectFacebookPage();
    const fbResubscribeMutation = useResubscribeFacebookPage();

    const refreshMutation = useRefreshInstagramToken();
    const resubscribeMutation = useResubscribeWebhook();
    const checkSubscriptionMutation = useCheckSubscription();
    const [connectingIG, setConnectingIG] = useState(false);
    const [connectingFB, setConnectingFB] = useState(false);
    const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
    const [disconnectingFbId, setDisconnectingFbId] = useState<string | null>(null);
    const [resubscribingFbId, setResubscribingFbId] = useState<string | null>(null);
    const [refreshingId, setRefreshingId] = useState<string | null>(null);
    const [resubscribingId, setResubscribingId] = useState<string | null>(null);
    const [checkingSubId, setCheckingSubId] = useState<string | null>(null);
    const [subStatus, setSubStatus] = useState<Record<string, { subscribedFields: string[]; hasComments: boolean; hasMessages: boolean } | null>>({});
    const [banner, setBanner] = useState<{ type: "success" | "error"; message: string } | null>(null);
    const [userEmail, setUserEmail] = useState<string | null>(null);

    // Signed-in identity for the Session section (audit fix): getUser()
    // verifies with the Auth server — never a local token decode.
    useEffect(() => {
        let cancelled = false;
        const supabase = createBrowserClient();
        void supabase.auth.getUser().then(({ data }) => {
            if (!cancelled) setUserEmail(data.user?.email ?? null);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        const igConnected = searchParams.get("instagram_connected");
        const igError = searchParams.get("instagram_error");
        const fbConnected = searchParams.get("facebook_connected");
        const fbError = searchParams.get("facebook_error");

        if (igConnected === "true") {
            setBanner({ type: "success", message: "Instagram account connected." });
            void queryClient.invalidateQueries({ queryKey: ["instagram-accounts"] });
            window.history.replaceState({}, "", "/settings");
        } else if (igError) {
            const errorMessages: Record<string, string> = {
                access_denied: "Instagram connection was cancelled.",
                no_instagram_business_account: "No Instagram Business or Creator account found. Switch your Instagram to a professional account first.",
                account_already_connected: "This Instagram account is already connected to another user on open-autoDM.",
                plan_limit_reached: "Your current plan's Instagram account limit has been reached. Upgrade your plan in Billing to connect another account.",
                state_mismatch: "The connection expired. Try again.",
                // Owner directive (2026-11-10): the Setup Wizard is
                // platform-admin only. Admins get the pointer to it;
                // customers get the honest state — the platform
                // setup is not theirs to complete.
                setup_required: setup?.isAdmin
                    ? "Save your Meta app credentials in the Setup Wizard first."
                    : "Instagram cannot connect yet — the platform setup is not complete.",
                server_error: "Something went wrong. Check the details and try again.",
                invalid_callback: "Invalid callback. Try again.",
                test_user_required: "Add this Instagram account as a test user to use the automation tool. In your Meta app, go to App Roles > Roles > Add People > Instagram Tester, then accept the invite in Instagram (Settings > Apps and websites > Tester invites) and connect again.",
            };
            const debugDetail = searchParams.get("debug");
            setBanner({
                type: "error",
                message: (errorMessages[igError] ?? `Error: ${igError}`) + (debugDetail ? ` - ${debugDetail}` : ""),
            });
            window.history.replaceState({}, "", "/settings");
        } else if (fbConnected) {
            // The callback passes the count of newly connected Pages.
            const count = Number(fbConnected) || 0;
            const skipped = Number(searchParams.get("facebook_skipped") ?? "0") || 0;
            setBanner({
                type: "success",
                message: count > 0
                    ? `${count} Facebook Page${count > 1 ? "s" : ""} connected.${skipped > 0 ? ` ${skipped} skipped (already connected elsewhere).` : ""}`
                    : "Facebook Page connected.",
            });
            void queryClient.invalidateQueries({ queryKey: ["facebook-pages"] });
            window.history.replaceState({}, "", "/settings");
        } else if (fbError) {
            const errorMessages: Record<string, string> = {
                access_denied: "Facebook connection was cancelled.",
                no_pages: "No Facebook Pages were granted. Pick at least one Page you admin in the Facebook dialog.",
                account_already_connected: "This Facebook Page is already connected to another user on open-autoDM.",
                plan_limit_reached: "Your current plan's connected-account limit has been reached. Upgrade your plan in Billing to connect another account.",
                state_mismatch: "The connection expired. Try again.",
                setup_required: setup?.isAdmin
                    ? "Save your Meta app credentials in the Setup Wizard first."
                    : "Facebook cannot connect yet — the platform setup is not complete.",
                server_error: "Something went wrong. Check the details and try again.",
                invalid_callback: "Invalid callback. Try again.",
            };
            const debugDetail = searchParams.get("debug");
            setBanner({
                type: "error",
                message: (errorMessages[fbError] ?? `Error: ${fbError}`) + (debugDetail ? ` - ${debugDetail}` : ""),
            });
            window.history.replaceState({}, "", "/settings");
        }
    }, [searchParams, queryClient, setup?.isAdmin]);

    useEffect(() => {
        if (!banner) return;
        const timer = setTimeout(() => setBanner(null), 8000);
        return () => clearTimeout(timer);
    }, [banner]);

    const handleConnectInstagram = async () => {
        setConnectingIG(true);
        try {
            const { url } = await apiClient<{ url: string }>("/instagram/connect");
            window.location.href = url;
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Couldn't start the Instagram connection";
            setBanner({ type: "error", message });
            setConnectingIG(false);
        }
    };

    const handleDisconnect = async (accountId: string) => {
        if (!confirm("Disconnect this Instagram account? Your automations will be paused — they'll resume automatically when you reconnect this account.")) return;
        setDisconnectingId(accountId);
        try {
            await apiClient(`/instagram/disconnect/${accountId}`, { method: "DELETE" });
            void queryClient.invalidateQueries({ queryKey: ["instagram-accounts"] });
            setBanner({ type: "success", message: "Instagram account disconnected." });
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Couldn't disconnect the account";
            setBanner({ type: "error", message });
        } finally {
            setDisconnectingId(null);
        }
    };

    // Facebook Pages (2026-11-19) — mirrors the Instagram handlers above.
    // Page tokens do not expire, so there is no refresh flow; the
    // webhook subscription is repaired with "Fix webhooks" instead of a
    // status check (no FB subscription-status route in v1).
    const handleConnectFacebook = async () => {
        setConnectingFB(true);
        try {
            const { url } = await apiClient<{ url: string }>("/facebook/connect");
            window.location.href = url;
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Couldn't start the Facebook connection";
            setBanner({ type: "error", message });
            setConnectingFB(false);
        }
    };

    const handleDisconnectFacebook = async (pageId: string) => {
        if (!confirm("Disconnect this Facebook Page? Your automations will be paused — they'll resume automatically when you reconnect this Page.")) return;
        setDisconnectingFbId(pageId);
        try {
            await fbDisconnectMutation.mutateAsync(pageId);
            setBanner({ type: "success", message: "Facebook Page disconnected." });
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Couldn't disconnect the Page";
            setBanner({ type: "error", message });
        } finally {
            setDisconnectingFbId(null);
        }
    };

    const handleResubscribeFacebook = async (pageId: string) => {
        setResubscribingFbId(pageId);
        try {
            const result = await fbResubscribeMutation.mutateAsync(pageId);
            setBanner({ type: "success", message: `Webhook subscription refreshed (${result.subscribedFields}). Comment on one of your Page posts to test.` });
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Couldn't refresh the webhook subscription";
            setBanner({ type: "error", message });
        } finally {
            setResubscribingFbId(null);
        }
    };

    const handleCheckSubscription = async (accountId: string) => {
        setCheckingSubId(accountId);
        try {
            const result = await checkSubscriptionMutation.mutateAsync(accountId);
            setSubStatus(prev => ({ ...prev, [accountId]: result }));
        } catch {
            setSubStatus(prev => ({ ...prev, [accountId]: null }));
        } finally {
            setCheckingSubId(null);
        }
    };

    const handleResubscribe = async (accountId: string) => {
        setResubscribingId(accountId);
        try {
            const result = await resubscribeMutation.mutateAsync(accountId);
            setBanner({ type: "success", message: `Webhook subscription refreshed (${result.subscribedFields}). Comment on one of your posts to test.` });
            void handleCheckSubscription(accountId);
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Couldn't refresh the webhook subscription";
            setBanner({ type: "error", message });
        } finally {
            setResubscribingId(null);
        }
    };

    const handleRefreshToken = async (accountId: string) => {
        setRefreshingId(accountId);
        try {
            await refreshMutation.mutateAsync(accountId);
            setBanner({ type: "success", message: "Token refreshed - good for another 60 days." });
        } catch (err) {
            const apiErr = err instanceof ApiError ? err : null;
            if (apiErr?.status === 400) {
                setBanner({ type: "error", message: "The token has expired. Reconnect your Instagram account." });
            } else {
                setBanner({ type: "error", message: "Couldn't refresh the token. Try again." });
            }
        } finally {
            setRefreshingId(null);
        }
    };

    const handleSignOut = async () => {
        const supabase = createBrowserClient();
        await supabase.auth.signOut();
        window.location.href = "/";
    };

    return (
        <div className="w-full max-w-3xl mx-auto space-y-5 pb-16">
            <div>
                <h1 className="text-xl font-heading font-semibold tracking-tight text-foreground">Settings</h1>
                <p className="text-[13px] text-muted-foreground mt-1">Connected accounts and your session.</p>
            </div>

            {banner && (
                <div className={cn(
                    "flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg text-[13px] font-medium",
                    banner.type === "success"
                        ? "bg-secondary/10 text-secondary"
                        : "bg-destructive/10 text-destructive"
                )}>
                    {banner.type === "success"
                        ? <CheckCircle className="w-4 h-4 shrink-0" />
                        : <XCircle className="w-4 h-4 shrink-0" />}
                    <span className="min-w-0">{banner.message}</span>
                </div>
            )}

            {/* Meta app — PLATFORM administration (owner directive,
                2026-11-10): the platform's Meta config and its Setup
                Wizard link render for admins only. Customers never
                see this section; their Instagram connection lives in
                the section below. Hidden until the setup status
                resolves, so a non-admin never flashes it. */}
            {setup?.isAdmin && (
            <section className="bg-card border border-border rounded-xl p-5 flex items-center justify-between gap-4">
                <div className="min-w-0">
                    <h2 className="text-[14px] font-heading font-semibold text-foreground">Meta app</h2>
                    <p className="text-[13px] text-muted-foreground mt-0.5 truncate">
                        {setup?.configured
                            ? <>Configured - app <code className="font-mono text-[11px] bg-muted px-1.5 py-0.5 rounded">{setup.metaAppId}</code></>
                            : "Not configured - the engine is offline until setup is complete."}
                    </p>
                </div>
                <Link
                    href="/setup"
                    className={cn(
                        "inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium transition-colors shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                        setup?.configured
                            ? "border border-border hover:bg-muted text-foreground"
                            : "bg-foreground text-background font-semibold hover:opacity-90"
                    )}
                >
                    <Wrench className="w-3.5 h-3.5" />
                    {setup?.configured ? "Setup Wizard" : "Complete setup"}
                </Link>
            </section>
            )}

            {/* Instagram accounts */}
            <section className="bg-card border border-border rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                        <h2 className="text-[14px] font-heading font-semibold text-foreground">Instagram accounts</h2>
                        <p className="text-[13px] text-muted-foreground mt-0.5">
                            Business or Creator accounts only.
                        </p>
                    </div>
                    <button
                        onClick={handleConnectInstagram}
                        disabled={connectingIG}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-foreground text-background text-[13px] font-semibold hover:opacity-90 disabled:opacity-60 transition-opacity shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    >
                        {connectingIG ? <CircleNotch className="w-3.5 h-3.5 animate-spin" /> : <InstagramLogo className="w-3.5 h-3.5" />}
                        {connectingIG ? "Connecting…" : "Connect"}
                    </button>
                </div>

                <div className="space-y-2">
                    {isLoading || workspaceLoading ? (
                        <div className="space-y-2">
                            {[1, 2].map((i) => (
                                <div key={i} className="h-16 rounded-lg bg-muted/50 animate-pulse" />
                            ))}
                        </div>
                    ) : accountsError && !accounts ? (
                        <div className="text-center py-8 text-[13px]" role="alert">
                            <Warning className="w-6 h-6 mx-auto mb-2 text-destructive/60" />
                            <p className="font-medium text-foreground">Couldn&apos;t load your Instagram accounts.</p>
                            <p className="text-muted-foreground mt-1 max-w-md mx-auto">
                                {accountsError.message} If you have connected an account it is still
                                connected — this list just failed to load.
                            </p>
                            <button
                                onClick={() => void refetchAccounts()}
                                className="mt-3 inline-flex h-8 items-center rounded-lg border border-border px-3 text-[13px] font-semibold hover:bg-muted transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                            >
                                Try again
                            </button>
                        </div>
                    ) : accounts && accounts.length > 0 ? (
                        accounts.map((account) => (
                            <div key={account.id} className="space-y-2">
                                {account.is_paused && (
                                    <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-[12px] font-medium bg-destructive/10 text-destructive">
                                        <PauseCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                        <span>
                                            <b>Safety pause</b> - Instagram flagged sends, so DMs are paused
                                            until {account.paused_until ? new Date(account.paused_until).toLocaleString() : "later"} to
                                            protect this account.
                                        </span>
                                    </div>
                                )}

                                {account.token_status !== "ok" && (
                                    <div className={cn(
                                        "flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg text-[12px] font-medium",
                                        account.token_status === "expired"
                                            ? "bg-destructive/10 text-destructive"
                                            : "bg-amber-500/10 text-amber-600"
                                    )}>
                                        <div className="flex items-center gap-2 min-w-0">
                                            <Warning className="w-3.5 h-3.5 shrink-0" />
                                            <span className="truncate">
                                                {account.token_status === "expired"
                                                    ? "Token expired - automations paused. Reconnect to resume."
                                                    : `Token expires in ${account.token_days_remaining} day${account.token_days_remaining === 1 ? "" : "s"} - the cron auto-refreshes it, or refresh now.`}
                                            </span>
                                        </div>
                                        {account.token_status === "expiring" ? (
                                            <button
                                                onClick={() => handleRefreshToken(account.id)}
                                                disabled={refreshingId === account.id}
                                                className="inline-flex items-center gap-1 font-semibold shrink-0 hover:opacity-80"
                                            >
                                                {refreshingId === account.id ? <CircleNotch className="w-3 h-3 animate-spin" /> : <ArrowsClockwise className="w-3 h-3" />}
                                                Refresh
                                            </button>
                                        ) : (
                                            <button
                                                onClick={handleConnectInstagram}
                                                disabled={connectingIG}
                                                className="inline-flex items-center gap-1 font-semibold shrink-0 hover:opacity-80"
                                            >
                                                Reconnect
                                            </button>
                                        )}
                                    </div>
                                )}

                                <div className="flex items-center justify-between p-3 rounded-lg border border-border">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <IgAvatar username={account.username} pictureUrl={account.profile_picture_url} className="w-9 h-9" iconClassName="w-4 h-4" />
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-[13px] font-semibold text-foreground truncate">@{account.username}</span>
                                                {account.token_status === "ok" && !account.is_paused
                                                    ? <CheckCircle className="w-3.5 h-3.5 text-secondary shrink-0" />
                                                    : <Warning className={cn("w-3.5 h-3.5 shrink-0", account.token_status === "expired" ? "text-destructive" : "text-amber-500")} />}
                                            </div>
                                            <span className="text-[11px] text-muted-foreground">
                                                Connected {new Date(account.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                                            </span>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-0.5 shrink-0">
                                        <button
                                            onClick={() => handleCheckSubscription(account.id)}
                                            disabled={checkingSubId === account.id}
                                            title="Check which webhook fields Meta has active for this account"
                                            className="inline-flex items-center gap-1 h-7 px-2 text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
                                        >
                                            {checkingSubId === account.id ? <CircleNotch className="w-3 h-3 animate-spin" /> : null}
                                            {checkingSubId === account.id ? "Checking…" : "Check status"}
                                        </button>
                                        <button
                                            onClick={() => handleResubscribe(account.id)}
                                            disabled={resubscribingId === account.id}
                                            title="Re-sync the webhook subscription"
                                            className="inline-flex items-center gap-1 h-7 px-2 text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
                                        >
                                            {resubscribingId === account.id ? <CircleNotch className="w-3 h-3 animate-spin" /> : <ArrowsClockwise className="w-3 h-3" />}
                                            {resubscribingId === account.id ? "Syncing…" : "Fix webhooks"}
                                        </button>
                                        <button
                                            onClick={() => handleDisconnect(account.id)}
                                            disabled={disconnectingId === account.id}
                                            className="inline-flex items-center gap-1 h-7 px-2 text-[12px] font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors"
                                        >
                                            {disconnectingId === account.id ? <CircleNotch className="w-3 h-3 animate-spin" /> : <LinkBreak className="w-3 h-3" />}
                                            Disconnect
                                        </button>
                                    </div>
                                </div>

                                {subStatus[account.id] !== undefined && (
                                    <div className={cn(
                                        "px-3 py-2.5 rounded-lg text-[12px] font-mono",
                                        subStatus[account.id] === null
                                            ? "bg-destructive/10 text-destructive"
                                            : subStatus[account.id]?.hasComments
                                            ? "bg-secondary/10 text-secondary"
                                            : "bg-amber-500/10 text-amber-600"
                                    )}>
                                        {subStatus[account.id] === null ? (
                                            <span>Couldn&apos;t fetch subscription status from Meta.</span>
                                        ) : (
                                            <div className="space-y-1">
                                                <div className="flex items-center gap-3">
                                                    <span className="font-bold">{subStatus[account.id]?.hasComments ? "✓ comments" : "✗ comments"}</span>
                                                    <span className="font-bold">{subStatus[account.id]?.hasMessages ? "✓ messages" : "✗ messages"}</span>
                                                </div>
                                                <div className="text-muted-foreground text-[10px]">
                                                    {subStatus[account.id]?.subscribedFields.join(", ") || "none"}
                                                </div>
                                                {!subStatus[account.id]?.hasComments && (
                                                    <div className="text-[10px]">
                                                        Comments aren&apos;t subscribed - use &ldquo;Fix webhooks&rdquo;, and check the Callback URL is verified in the Meta portal.
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))
                    ) : (
                        <div className="text-center py-8 text-[13px] text-muted-foreground">
                            <InstagramLogo className="w-6 h-6 mx-auto mb-2 opacity-30" />
                            <p>No accounts connected yet.</p>
                        </div>
                    )}
                </div>
            </section>

            {/* Facebook Pages (2026-11-19) */}
            <section className="bg-card border border-border rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                        <h2 className="text-[14px] font-heading font-semibold text-foreground">Facebook Pages</h2>
                        <p className="text-[13px] text-muted-foreground mt-0.5">
                            Pages you admin. Automations reply in Messenger when someone comments on a Page post or messages the Page.
                        </p>
                    </div>
                    <button
                        onClick={handleConnectFacebook}
                        disabled={connectingFB}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-foreground text-background text-[13px] font-semibold hover:opacity-90 disabled:opacity-60 transition-opacity shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    >
                        {connectingFB ? <CircleNotch className="w-3.5 h-3.5 animate-spin" /> : <FacebookLogo className="w-3.5 h-3.5" />}
                        {connectingFB ? "Connecting…" : "Connect"}
                    </button>
                </div>

                <div className="space-y-2">
                    {fbLoading || workspaceLoading ? (
                        <div className="space-y-2">
                            {[1, 2].map((i) => (
                                <div key={i} className="h-16 rounded-lg bg-muted/50 animate-pulse" />
                            ))}
                        </div>
                    ) : fbError && !fbPages ? (
                        <div className="text-center py-8 text-[13px]" role="alert">
                            <Warning className="w-6 h-6 mx-auto mb-2 text-destructive/60" />
                            <p className="font-medium text-foreground">Couldn&apos;t load your Facebook Pages.</p>
                            <p className="text-muted-foreground mt-1 max-w-md mx-auto">
                                {fbError.message} If you have connected a Page it is still
                                connected — this list just failed to load.
                            </p>
                            <button
                                onClick={() => void refetchFbPages()}
                                className="mt-3 inline-flex h-8 items-center rounded-lg border border-border px-3 text-[13px] font-semibold hover:bg-muted transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                            >
                                Try again
                            </button>
                        </div>
                    ) : fbPages && fbPages.length > 0 ? (
                        fbPages.map((page) => (
                            <div key={page.id} className="space-y-2">
                                {page.is_paused && (
                                    <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-[12px] font-medium bg-destructive/10 text-destructive">
                                        <PauseCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                        <span>
                                            <b>Safety pause</b> - Meta flagged sends, so messages are paused
                                            until {page.paused_until ? new Date(page.paused_until).toLocaleString() : "later"} to
                                            protect this Page.
                                        </span>
                                    </div>
                                )}

                                <div className="flex items-center justify-between p-3 rounded-lg border border-border">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <FacebookPageAvatar page={page} />
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-[13px] font-semibold text-foreground truncate">{page.name}</span>
                                                {page.is_paused
                                                    ? <Warning className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                                                    : <CheckCircle className="w-3.5 h-3.5 text-secondary shrink-0" />}
                                            </div>
                                            <span className="text-[11px] text-muted-foreground">
                                                Connected {new Date(page.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                                            </span>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-0.5 shrink-0">
                                        <button
                                            onClick={() => handleResubscribeFacebook(page.id)}
                                            disabled={resubscribingFbId === page.id}
                                            title="Re-sync the webhook subscription"
                                            className="inline-flex items-center gap-1 h-7 px-2 text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
                                        >
                                            {resubscribingFbId === page.id ? <CircleNotch className="w-3 h-3 animate-spin" /> : <ArrowsClockwise className="w-3 h-3" />}
                                            {resubscribingFbId === page.id ? "Syncing…" : "Fix webhooks"}
                                        </button>
                                        <button
                                            onClick={() => handleDisconnectFacebook(page.id)}
                                            disabled={disconnectingFbId === page.id}
                                            className="inline-flex items-center gap-1 h-7 px-2 text-[12px] font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors"
                                        >
                                            {disconnectingFbId === page.id ? <CircleNotch className="w-3 h-3 animate-spin" /> : <LinkBreak className="w-3 h-3" />}
                                            Disconnect
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))
                    ) : (
                        <div className="text-center py-8 text-[13px] text-muted-foreground">
                            <FacebookLogo className="w-6 h-6 mx-auto mb-2 opacity-30" />
                            <p>No Pages connected yet.</p>
                        </div>
                    )}
                </div>
            </section>

            {/* Password */}
            <section className="bg-card border border-border rounded-xl p-5 space-y-4">
                <div>
                    <h2 className="text-[14px] font-heading font-semibold text-foreground">Password</h2>
                    <p className="text-[13px] text-muted-foreground mt-0.5">
                        Change the password for your console login.
                    </p>
                </div>
                <ChangePasswordForm />
            </section>

            {/* Account */}
            <section className="bg-card border border-border rounded-xl p-5 flex items-center justify-between gap-4">
                <div className="min-w-0">
                    <h2 className="text-[14px] font-heading font-semibold text-foreground">Session</h2>
                    <p className="text-[13px] text-muted-foreground mt-0.5 truncate">
                        {userEmail ? (
                            <>Signed in as <span className="text-foreground/80 font-medium">{userEmail}</span></>
                        ) : (
                            "Signed in."
                        )}
                    </p>
                </div>
                <button
                    onClick={handleSignOut}
                    className="h-8 px-3 rounded-lg text-[13px] font-medium text-muted-foreground border border-border hover:text-destructive hover:border-destructive/40 transition-colors shrink-0"
                >
                    Sign out
                </button>
            </section>
        </div>
    );
}
