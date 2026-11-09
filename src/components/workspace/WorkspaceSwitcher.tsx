"use client";

/**
 * Programme 18 / Phase G — workspace switcher for the dashboard
 * sidebar. Rendered ONLY when the workspace runtime is enabled (the
 * provider prop is server-gated in the (main) layout; this component
 * also returns null when disabled). Flag OFF ⇒ the sidebar renders
 * exactly as before — this component contributes nothing.
 *
 * Programme 34 (UX-2) — the popup now follows the listbox-button
 * keyboard model: opening moves focus to the selected option (or
 * the first), ArrowUp/ArrowDown/Home/End move between options,
 * Escape closes and returns focus to the trigger, selecting an
 * option returns focus to the trigger, and a pointer press outside
 * the popup closes it. Before this pass the popup was pointer-only:
 * it could not be dismissed from the keyboard, and activating an
 * option dropped focus to the document body when the option
 * unmounted. The collapsed (icon-only) trigger also gained a real
 * accessible name — it previously relied on the `title` attribute
 * alone. Options carry tabIndex={-1}: the trigger is the single
 * Tab stop and focus inside the popup is managed programmatically,
 * per the listbox-button pattern.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Buildings, Check, CaretUpDown, GearSix } from "@/components/phosphor";
import { cn } from "@/lib/utils";
import { useWorkspace } from "./WorkspaceProvider";

export function WorkspaceSwitcher({ isCollapsed }: { isCollapsed: boolean }) {
    const {
        workspaceRuntimeEnabled,
        workspaces,
        selectedWorkspace,
        selectedWorkspaceId,
        selectWorkspace,
        loading,
    } = useWorkspace();
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

    // On open: move focus into the popup (selected option first) and
    // watch for an outside pointer press. Runs only while open.
    useEffect(() => {
        if (!open) return;
        const activeIdx = workspaces.findIndex((w) => w.workspaceId === selectedWorkspaceId);
        const target = optionRefs.current[activeIdx >= 0 ? activeIdx : 0];
        target?.focus();
        const onPointerDown = (e: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("pointerdown", onPointerDown);
        return () => document.removeEventListener("pointerdown", onPointerDown);
    }, [open, workspaces, selectedWorkspaceId ]);

    if (!workspaceRuntimeEnabled) return null;

    const closeAndRefocus = () => {
        setOpen(false);
        triggerRef.current?.focus();
    };

    const onPopupKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault();
            closeAndRefocus();
            return;
        }
        const options = optionRefs.current.filter(
            (el): el is HTMLButtonElement => el !== null,
        );
        if (options.length === 0) return;
        const current = options.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "ArrowDown") {
            e.preventDefault();
            options[(current + 1) % options.length]?.focus();
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            options[(current - 1 + options.length) % options.length]?.focus();
        } else if (e.key === "Home") {
            e.preventDefault();
            options[0]?.focus();
        } else if (e.key === "End") {
            e.preventDefault();
            options[options.length - 1]?.focus();
        }
    };

    return (
        <div className="relative" data-testid="workspace-switcher" ref={rootRef}>
            <button
                ref={triggerRef}
                onClick={() => setOpen((o) => !o)}
                onKeyDown={(e) => {
                    if (e.key === "Escape" && open) {
                        e.preventDefault();
                        setOpen(false);
                    }
                }}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={
                    isCollapsed
                        ? selectedWorkspace
                            ? `Current workspace: ${selectedWorkspace.name ?? selectedWorkspace.workspaceId}`
                            : "Workspaces"
                        : undefined
                }
                className={cn(
                    "w-full flex items-center rounded-lg p-2 hover:bg-muted/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isCollapsed ? "justify-center" : "gap-2.5",
                )}
                title={isCollapsed ? (selectedWorkspace?.name ?? "Workspaces") : undefined}
            >
                <Buildings className="w-4 h-4 shrink-0 text-muted-foreground" />
                {!isCollapsed && (
                    <>
                        <div className="flex flex-col min-w-0 flex-1 text-left">
                            <span className="text-[12px] font-medium text-foreground truncate leading-tight">
                                {loading
                                    ? "Loading workspaces…"
                                    : (selectedWorkspace?.name ?? "No workspace")}
                            </span>
                            <span className="text-[10px] text-muted-foreground leading-tight">
                                {/* A load in flight is not "0 workspaces"
                                    (round-2 QA fix, 2026-11-09): the count
                                    renders only once the list has settled. */}
                                {loading
                                    ? "Loading…"
                                    : `${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}`}
                            </span>
                        </div>
                        {selectedWorkspace && (
                            <span
                                data-testid="workspace-role-badge"
                                className="text-[10px] font-medium uppercase tracking-wide rounded-full border border-border px-1.5 py-0.5 text-muted-foreground shrink-0"
                            >
                                {selectedWorkspace.role}
                            </span>
                        )}
                        <CaretUpDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    </>
                )}
            </button>

            {open && (
                <div
                    role="listbox"
                    aria-label="Workspaces"
                    onKeyDown={onPopupKeyDown}
                    className="absolute bottom-full mb-2 left-0 w-56 bg-popover border border-border rounded-xl shadow-xl overflow-hidden z-[100]"
                >
                    <div className="px-3 pt-2.5 pb-1.5">
                        <span className="micro-label">Workspaces</span>
                    </div>
                    <div className="px-1.5 pb-1.5 max-h-56 overflow-y-auto">
                        {workspaces.length === 0 && (
                            <p className="px-2 py-2 text-[12px] text-muted-foreground">
                                {loading ? "Loading workspaces…" : "No workspaces yet."}
                            </p>
                        )}
                        {workspaces.map((w, idx) => {
                            const isActive = w.workspaceId === selectedWorkspaceId;
                            return (
                                <button
                                    key={w.workspaceId}
                                    ref={(el) => {
                                        optionRefs.current[idx] = el;
                                    }}
                                    role="option"
                                    aria-selected={isActive}
                                    tabIndex={-1}
                                    onClick={() => {
                                        selectWorkspace(w.workspaceId);
                                        closeAndRefocus();
                                    }}
                                    className={cn(
                                        "w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition-colors focus:outline-none focus:ring-2 focus:ring-ring",
                                        isActive ? "bg-muted" : "hover:bg-muted/60",
                                    )}
                                >
                                    <div className="flex flex-col min-w-0 flex-1">
                                        <span className="text-[12.5px] font-medium text-foreground truncate leading-tight">
                                            {w.name ?? w.workspaceId}
                                        </span>
                                        <span className="text-[10px] text-muted-foreground leading-tight">
                                            {w.role}
                                        </span>
                                    </div>
                                    {isActive && <Check className="w-3.5 h-3.5 shrink-0" />}
                                </button>
                            );
                        })}
                    </div>
                    <div className="border-t border-border p-1.5">
                        <Link
                            href="/settings/workspace"
                            onClick={() => setOpen(false)}
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[12.5px] font-medium text-foreground hover:bg-muted/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <GearSix className="w-3.5 h-3.5" />
                            Workspace settings
                        </Link>
                    </div>
                </div>
            )}
        </div>
    );
}
