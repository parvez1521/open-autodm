"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Plus } from "@/components/phosphor";
import { PillToggle, InstagramGlyph, FacebookGlyph } from "@/components/ui/PillToggle";
import { BrandWave } from "@/components/ui/BrandWave";
import { AutomationsList } from "@/components/automations/AutomationsList";
import { ContactsList } from "@/components/automations/ContactsList";
import { NewAutomationModal } from "@/components/automations/new-flow/NewAutomationModal";
import { useAutomations, useToggleAutomation, useDeleteAutomation, useDuplicateAutomation } from "@/hooks/useAutomations";
import { useActiveAccount } from "@/hooks/useActiveAccount";
import { useActiveFacebookPage } from "@/hooks/useActiveFacebookPage";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import type { AutomationFromDB } from "@/hooks/useAutomations";
import { AutomationDebugPanel } from "@/components/debug/AutomationDebugPanel";

export default function AutomationsPage() {
    return (
        <Suspense fallback={<div className="w-full max-w-5xl mx-auto py-24 flex justify-center"><BrandWave /></div>}>
            <AutomationsContent />
        </Suspense>
    );
}

type ChannelTab = "instagram" | "facebook";

/** Channel toggle persistence (2026-11-20): the selected channel
 *  survives reloads; Instagram is the default on first visit. */
const CHANNEL_STORAGE_KEY = "opendm-automations-channel";

function AutomationsContent() {
    const searchParams = useSearchParams();
    const [activeTab, setActiveTab] = useState<"automations" | "contacts">("automations");
    const [channelTab, setChannelTab] = useState<ChannelTab>(() => {
        if (typeof window === "undefined") return "instagram";
        try {
            return window.localStorage.getItem(CHANNEL_STORAGE_KEY) === "facebook" ? "facebook" : "instagram";
        } catch {
            return "instagram";
        }
    });
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingAutomation, setEditingAutomation] = useState<AutomationFromDB | null>(null);
    const [initialKeyword, setInitialKeyword] = useState<string | null>(null);

    useEffect(() => {
        try {
            window.localStorage.setItem(CHANNEL_STORAGE_KEY, channelTab);
        } catch {
            // Storage unavailable (private mode) — the tab still
            // works for this visit; nothing else depends on it.
        }
    }, [channelTab]);

    // Script Writer handoff (audit fix, 2026-11-08): a ?keyword= from
    // the generated script opens the create flow with that keyword
    // already in the trigger list, then the URL is scrubbed.
    useEffect(() => {
        const keyword = searchParams.get("keyword");
        if (keyword && keyword.trim()) {
            setEditingAutomation(null);
            setInitialKeyword(keyword.trim());
            setIsModalOpen(true);
            window.history.replaceState({}, "", "/automations");
        }
    }, [searchParams]);

    const { accountId, isLoading: instagramAccountsLoading } = useActiveAccount();
    const { pageId: activeFacebookPageId, isLoading: facebookPagesLoading } = useActiveFacebookPage();
    const { loading: workspaceLoading } = useWorkspace();
    // QA fix (2026-11-08): the query error is no longer discarded —
    // AutomationsList renders an honest, retryable error state for it
    // instead of silently showing the empty state (settled failure)
    // or an endless skeleton (unsettled fetch).
    // Facebook automations (2026-11-19) live in the same table but
    // under a different account column, so the list fetches UNSCOPED
    // and filters client-side to the two selections: the active
    // Instagram account OR the selected Facebook Page. With neither
    // selected the list is empty — rows for an unselected account
    // never leak in.
    // Channel tabs (2026-11-20): the list shows ONE channel at a
    // time — the selected tab filters by channel first, then by the
    // active account/Page within it.
    const { data: allAutomations, isLoading, error: automationsError, refetch: refetchAutomations } = useAutomations(null);
    // Empty-state flash fix v2 (2026-11-22): v1 gated only on the
    // selection queries' isLoading — but those queries are DISABLED
    // (enabled: scope !== 'unavailable' in useInstagramAccounts /
    // useFacebookPages) until the WorkspaceProvider resolves a
    // selection, and a disabled TanStack query reports isLoading ===
    // false with data undefined. So on a reload the gate passed
    // while the workspace was still loading and the false "not
    // connected" empty state rendered immediately (browser-verified
    // 2026-11-22: it appeared while the sidebar still said "Loading
    // workspaces..."). The provider's `loading` flag is the
    // authoritative indeterminate signal — true from the first paint
    // while the runtime is enabled — so it must be part of the gate.
    // Only once the workspace has settled AND the selected channel's
    // selection query has settled does a null selection honestly
    // mean "not connected".
    const selectionLoading =
        workspaceLoading || (channelTab === "facebook" ? facebookPagesLoading : instagramAccountsLoading);
    const automations = (allAutomations ?? []).filter((a) =>
        channelTab === "facebook"
            ? a.channel === "facebook" && activeFacebookPageId !== null && a.facebook_page_id === activeFacebookPageId
            : a.channel !== "facebook" && a.instagram_account_id === accountId,
    );
    // Channel-aware empty state (2026-11-20): when the selected
    // channel has no account connected, say so plainly instead of
    // the generic "no automations" — the missing connection is the
    // real reason the list is empty.
    const channelEmptyCopy =
        channelTab === "facebook"
            ? activeFacebookPageId === null
                ? { title: "No Facebook Page connected", message: "Connect a Facebook Page in Settings to see its automations here." }
                : { title: "No Facebook automations yet", message: "Create one to reply to comments or DMs on your Page automatically." }
            : accountId === null
                ? { title: "No Instagram account selected", message: "Select an Instagram account to see its automations here." }
                : { title: "No Instagram automations yet", message: "Create one to reply to comments, DMs, or story replies automatically." };
    const toggleMutation = useToggleAutomation();
    const deleteMutation = useDeleteAutomation();
    const duplicateMutation = useDuplicateAutomation();

    const handleToggle = (id: string, currentlyActive: boolean) => {
        toggleMutation.mutate({ id, isActive: !currentlyActive });
    };

    const handleDelete = (id: string) => {
        deleteMutation.mutate(id);
    };

    // Duplicate (2026-11-22): the server copies the whole config
    // under "Copy of <name>" starting INACTIVE; the list refetch
    // shows the copy at once.
    const handleDuplicate = (id: string) => {
        duplicateMutation.mutate(id);
    };

    const handleEdit = (automation: AutomationFromDB) => {
        setEditingAutomation(automation);
        setIsModalOpen(true);
    };

    const handleModalClose = () => {
        setIsModalOpen(false);
        setEditingAutomation(null);
        setInitialKeyword(null);
    };

    return (
        <div data-no-reveal className="w-full max-w-5xl mx-auto space-y-6 pb-16">

            <div className="flex items-center justify-between gap-4">
                {/* Tabs + new — shared PillToggle treatment (2026-11-25):
                    one component owns the pill styling across the app,
                    so the two groups on this page can no longer drift
                    apart. Behaviour unchanged (same values/onChange). */}
                <PillToggle
                    value={activeTab}
                    onChange={setActiveTab}
                    capitalize
                    ariaLabel="Automations or contacts"
                    options={[
                        { value: "automations", label: "Automations" },
                        { value: "contacts", label: "Contacts" },
                    ]}
                />

                <button
                    onClick={() => { setEditingAutomation(null); setIsModalOpen(true); }}
                    className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-foreground text-background text-[13px] font-semibold hover:opacity-90 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                    <Plus className="w-3.5 h-3.5" />
                    New automation
                </button>
            </div>

            {/* Content */}
            <div className="min-h-[420px]">
                {activeTab === "automations" ? (
                    <>
                        {/* Channel toggle (2026-11-20): Instagram and
                            Facebook automations live in one table, but
                            the list shows one channel at a time. Shared
                            PillToggle treatment (2026-11-25). */}
                        <div className="mb-4">
                            <PillToggle
                                value={channelTab}
                                onChange={setChannelTab}
                                ariaLabel="Automation channel"
                                options={[
                                    { value: "instagram", label: "Instagram", icon: InstagramGlyph },
                                    { value: "facebook", label: "Facebook", icon: FacebookGlyph },
                                ]}
                            />
                        </div>
                        <AutomationsList
                            automations={automations ?? []}
                            isLoading={isLoading || selectionLoading}
                            onToggle={handleToggle}
                            onDelete={handleDelete}
                            onEdit={handleEdit}
                            onDuplicate={handleDuplicate}
                            duplicatingId={duplicateMutation.isPending ? (duplicateMutation.variables ?? null) : null}
                            deleteError={deleteMutation.error?.message ?? duplicateMutation.error?.message ?? null}
                            loadError={automationsError?.message ?? null}
                            onRetry={() => void refetchAutomations()}
                            emptyTitle={channelEmptyCopy.title}
                            emptyMessage={channelEmptyCopy.message}
                        />
                    </>
                ) : (
                    <ContactsList />
                )}
            </div>

            <NewAutomationModal
                isOpen={isModalOpen}
                onClose={handleModalClose}
                editAutomation={editingAutomation}
                accountId={accountId}
                facebookPageId={activeFacebookPageId}
                initialKeyword={initialKeyword}
                initialChannel={channelTab}
            />

            {/* Debug panel - visible only when NEXT_PUBLIC_DEBUG=true */}
            <AutomationDebugPanel />
        </div>
    );
}
