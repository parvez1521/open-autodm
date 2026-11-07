"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Wrench, CheckCircle, Circle, ArrowRight, Plus, PencilLine, Clock } from "@/components/phosphor";
import { useAutomations } from "@/hooks/useAutomations";
import { useContacts } from "@/hooks/useContacts";
import { useAnalytics } from "@/hooks/useAnalytics";
import { useActiveAccount } from "@/hooks/useActiveAccount";
import { useSetupStatus } from "@/hooks/useSetup";
import { useActivity } from "@/hooks/useActivity";
import { TrafficGuardCard } from "@/components/dashboard/TrafficGuardCard";
import { cn } from "@/lib/utils";

function formatRelativeTime(dateStr: string): string {
    const timestamp = new Date(dateStr).getTime();
    if (isNaN(timestamp)) return "Recent";
    const diffSec = Math.floor((Date.now() - timestamp) / 1000);
    if (diffSec < 60) return "Just now";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
}

export default function DashboardPage() {
    const { account: connectedAccount, accountId } = useActiveAccount();
    const { data: automations } = useAutomations(accountId);
    const { data: setup } = useSetupStatus();
    const { data: contacts } = useContacts(accountId);

    // Fixed 30-day window, computed once per mount so the query key stays stable
    const analyticsRange = useMemo(() => {
        const now = Date.now();
        return {
            from: new Date(now - 30 * 86400_000).toISOString(),
            to: new Date(now).toISOString(),
        };
    }, []);
    const { data: analytics } = useAnalytics({ ...analyticsRange, automationId: "all", accountId });
    const { data: activities, isLoading: isActivityLoading } = useActivity(accountId, 15);

    const activeCount = automations?.filter(a => a.is_active).length ?? 0;
    const totalDms = automations?.reduce((sum, a) => sum + a.total_dms_sent, 0) ?? 0;

    const checklist = [
        { label: "Save your Meta app credentials", done: !!setup?.configured, href: "/setup" },
        { label: "Connect your Instagram account", done: !!connectedAccount, href: "/settings" },
        { label: "Create your first automation", done: (automations?.length ?? 0) > 0, href: "/automations" },
        { label: "Activate it", done: activeCount > 0, href: "/automations" },
    ];
    const allDone = checklist.every(c => c.done);

    const stats = [
        { label: "Active automations", value: String(activeCount) },
        { label: "Comments · 30d", value: (analytics?.totals.comments ?? 0).toLocaleString() },
        { label: "DMs delivered", value: totalDms.toLocaleString() },
        { label: "Contacts captured", value: String(contacts?.length ?? 0) },
    ];

    return (
        <div className="w-full max-w-5xl mx-auto space-y-8 pb-16">

            {/* Header */}
            <div className="flex items-end justify-between gap-4">
                <div>
                    <h1 className="text-xl font-heading font-semibold tracking-tight text-foreground">
                        {connectedAccount ? <>Welcome back, <span className="text-primary">@{connectedAccount.username}</span></> : "Welcome"}
                    </h1>
                    <p className="text-[13px] text-muted-foreground mt-1">
                        Your self-hosted Instagram automation console.
                    </p>
                </div>
                <Link
                    href="/automations"
                    className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-foreground text-background text-[13px] font-semibold hover:opacity-90 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                    <Plus className="w-3.5 h-3.5" />
                    New automation
                </Link>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {stats.map((stat) => (
                    <div key={stat.label} className="bg-card border border-border rounded-xl p-4">
                        <div className="flex items-center justify-between">
                            <span className="micro-label">{stat.label}</span>
                        </div>
                        <p className="text-2xl font-heading font-semibold tracking-tight text-foreground mt-2 tabular-nums">{stat.value}</p>
                    </div>
                ))}
            </div>

            {/* Smart Comment Traffic Guard (only with a connected account) */}
            {accountId && <TrafficGuardCard accountId={accountId} />}

            {/* Recent Activity Feed (release-prep row 22; content-sanitised,
                owner-scoped via /api/activity — metadata only, no message bodies) */}
            {accountId && (
                <div className="bg-card border border-border rounded-xl p-5 space-y-3" data-testid="recent-activity-feed">
                    <div className="flex items-center justify-between border-b border-border/50 pb-3">
                        <h2 className="text-[14px] font-heading font-semibold text-foreground flex items-center gap-1.5">
                            <Clock className="w-4 h-4 text-muted-foreground" />
                            Recent Activity
                        </h2>
                        <span className="text-[11px] text-muted-foreground font-medium">Real Event Trail</span>
                    </div>

                    {isActivityLoading ? (
                        <div className="py-8 text-center text-[12.5px] text-muted-foreground">Loading activity…</div>
                    ) : (activities?.length ?? 0) > 0 ? (
                        <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                            {activities?.map((act) => (
                                <div
                                    key={act.id}
                                    className="p-2.5 rounded-lg border border-border/60 bg-muted/20 text-[12px] space-y-1"
                                    data-testid="activity-item"
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="font-semibold text-foreground truncate">{act.automationName}</span>
                                        <span className={cn(
                                            "px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider shrink-0",
                                            act.status === "sent" ? "bg-secondary/15 text-secondary" :
                                            act.status === "scheduled" ? "bg-primary/15 text-primary" :
                                            act.status === "held" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" :
                                            act.status === "waiting_response" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" :
                                            act.status === "failed" ? "bg-destructive/15 text-destructive" :
                                            "bg-muted text-muted-foreground"
                                        )}>
                                            {act.status}
                                        </span>
                                    </div>
                                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                                        <span className="capitalize">{act.type.replace(/_/g, " ")}</span>
                                        <span>{formatRelativeTime(act.timestamp)}</span>
                                    </div>
                                    {act.errorMessage && (
                                        <p className="text-[10.5px] text-destructive truncate">{act.errorMessage}</p>
                                    )}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="py-8 text-center space-y-2">
                            <p className="text-[12.5px] font-medium text-foreground">No recent events</p>
                            <p className="text-[11px] text-muted-foreground">
                                Triggered DMs, comments, and scheduled follow-ups will be listed here in real time.
                            </p>
                        </div>
                    )}

                    <div className="pt-2 border-t border-border/40 text-[11px] text-muted-foreground">
                        Private message contents are sanitized to protect privacy.
                    </div>
                </div>
            )}

            {/* Viral Script Writer promo */}
            <Link href="/script-writer" className="block group focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-xl">
                <div className="relative overflow-hidden bg-card border border-primary/25 rounded-xl p-5">
                    <div className="flex items-start justify-between gap-4">
                        <div className="flex items-start gap-3.5 min-w-0">
                            <span className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                                <PencilLine className="w-5 h-5 text-muted-foreground" />
                            </span>
                            <div className="min-w-0">
                                <h2 className="text-[14px] font-heading font-semibold text-foreground">Viral Script Writer</h2>
                                <p className="text-[13px] text-muted-foreground mt-0.5">
                                    Generate a hook-first Reel script tuned for Instagram - then turn its CTA keyword into an automation.
                                </p>
                            </div>
                        </div>
                        <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0 mt-1" />
                    </div>
                </div>
            </Link>

            <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">

                {/* Getting started */}
                <div className="lg:col-span-3 bg-card border border-border rounded-xl p-5">
                    <h2 className="text-[14px] font-heading font-semibold text-foreground">Getting started</h2>
                    <p className="text-[13px] text-muted-foreground mt-0.5 mb-4">
                        {allDone
                            ? "Everything is configured - your automations are live."
                            : "Four steps between you and a working automation."}
                    </p>
                    <div className="space-y-1.5">
                        {checklist.map((item) => (
                            <Link key={item.label} href={item.href} className="block group focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-lg">
                                <div className={cn(
                                    "flex items-center justify-between h-10 px-3 rounded-lg border transition-colors",
                                    item.done
                                        ? "border-transparent bg-muted/40"
                                        : "border-border hover:border-foreground/25"
                                )}>
                                    <div className="flex items-center gap-2.5 min-w-0">
                                        {item.done
                                            ? <CheckCircle className="w-4 h-4 text-secondary shrink-0" />
                                            : <Circle className="w-4 h-4 text-muted-foreground/40 shrink-0" />}
                                        <span className={cn(
                                            "text-[13px] truncate",
                                            item.done ? "text-muted-foreground line-through" : "text-foreground font-medium"
                                        )}>
                                            {item.label}
                                        </span>
                                    </div>
                                    {!item.done && (
                                        <ArrowRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
                                    )}
                                </div>
                            </Link>
                        ))}
                    </div>
                </div>

                {/* System status */}
                <div className="lg:col-span-2 bg-card border border-border rounded-xl p-5">
                    <h2 className="text-[14px] font-heading font-semibold text-foreground mb-4">System</h2>
                    <div className="space-y-1.5">
                        {[
                            { label: "Meta app", ok: !!setup?.configured, detail: setup?.configured ? "Configured" : "Pending" },
                            { label: "Instagram", ok: !!connectedAccount, detail: connectedAccount ? `@${connectedAccount.username}` : "Not connected" },
                            { label: "Engine", ok: activeCount > 0, detail: activeCount > 0 ? `${activeCount} live` : "Idle" },
                        ].map((row) => (
                            <div key={row.label} className="flex items-center justify-between h-10 px-3 rounded-lg bg-muted/40">
                                <div className="flex items-center gap-2.5">
                                    <span className={cn("w-1.5 h-1.5 rounded-full", row.ok ? "bg-secondary" : "bg-muted-foreground/40")} />
                                    <span className="text-[13px] font-medium text-foreground">{row.label}</span>
                                </div>
                                <span className="text-[12px] text-muted-foreground truncate max-w-[120px]">{row.detail}</span>
                            </div>
                        ))}
                    </div>

                    {!setup?.configured && (
                        <Link
                            href="/setup"
                            className="mt-4 flex items-center justify-center gap-1.5 h-9 w-full rounded-lg bg-foreground text-background text-[13px] font-semibold hover:opacity-90 transition-opacity"
                        >
                            <Wrench className="w-3.5 h-3.5" />
                            Open Setup Wizard
                        </Link>
                    )}
                </div>
            </div>
        </div>
    );
}
