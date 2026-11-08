"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Plus, CircleNotch } from "@/components/phosphor";
import { cn } from "@/lib/utils";
import { AutomationsList } from "@/components/automations/AutomationsList";
import { ContactsList } from "@/components/automations/ContactsList";
import { NewAutomationModal } from "@/components/automations/new-flow/NewAutomationModal";
import { useAutomations, useToggleAutomation, useDeleteAutomation } from "@/hooks/useAutomations";
import { useActiveAccount } from "@/hooks/useActiveAccount";
import type { AutomationFromDB } from "@/hooks/useAutomations";
import { AutomationDebugPanel } from "@/components/debug/AutomationDebugPanel";

export default function AutomationsPage() {
    return (
        <Suspense fallback={<div className="w-full max-w-5xl mx-auto py-24 flex justify-center"><CircleNotch className="w-5 h-5 animate-spin text-muted-foreground" /></div>}>
            <AutomationsContent />
        </Suspense>
    );
}

function AutomationsContent() {
    const searchParams = useSearchParams();
    const [activeTab, setActiveTab] = useState<"automations" | "contacts">("automations");
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingAutomation, setEditingAutomation] = useState<AutomationFromDB | null>(null);
    const [initialKeyword, setInitialKeyword] = useState<string | null>(null);

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

    const { accountId } = useActiveAccount();
    const { data: automations, isLoading } = useAutomations(accountId);
    const toggleMutation = useToggleAutomation();
    const deleteMutation = useDeleteAutomation();

    const handleToggle = (id: string, currentlyActive: boolean) => {
        toggleMutation.mutate({ id, isActive: !currentlyActive });
    };

    const handleDelete = (id: string) => {
        deleteMutation.mutate(id);
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
        <div className="w-full max-w-5xl mx-auto space-y-6 pb-16">

            {/* Tabs + new */}
            <div className="flex items-center justify-between gap-4">
                <div className="inline-flex items-center bg-muted rounded-lg p-0.5">
                    {(["automations", "contacts"] as const).map((tab) => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            className={cn(
                                "h-8 px-3.5 rounded-[7px] text-[13px] font-medium capitalize transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                                activeTab === tab
                                    ? "bg-card text-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            {tab}
                        </button>
                    ))}
                </div>

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
                    <AutomationsList
                        automations={automations ?? []}
                        isLoading={isLoading}
                        onToggle={handleToggle}
                        onDelete={handleDelete}
                        onEdit={handleEdit}
                        deleteError={deleteMutation.error?.message ?? null}
                    />
                ) : (
                    <ContactsList />
                )}
            </div>

            <NewAutomationModal
                isOpen={isModalOpen}
                onClose={handleModalClose}
                editAutomation={editingAutomation}
                accountId={accountId}
                initialKeyword={initialKeyword}
            />

            {/* Debug panel - visible only when NEXT_PUBLIC_DEBUG=true */}
            <AutomationDebugPanel />
        </div>
    );
}
