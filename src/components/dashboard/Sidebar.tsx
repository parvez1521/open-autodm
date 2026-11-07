"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
    House,
    Robot,
    ChartBar,
    Gear,
    Wrench,
    GithubLogo,
    PencilLine,
    FilmSlate,
    CaretLeft,
    CaretRight,
    X,
} from "@/components/phosphor";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";
import { LogoMark, LogoWordmark } from "@/components/ui/Logo";
import { AccountSwitcher } from "@/components/dashboard/AccountSwitcher";
import { WorkspaceSwitcher } from "@/components/workspace/WorkspaceSwitcher";
import { useUiStore } from "@/lib/store";

const NAV = {
    Workspace: [
        { name: "Dashboard", href: "/dashboard", icon: House, external: false },
        { name: "Automations", href: "/automations", icon: Robot, external: false },
        { name: "Analytics", href: "/analytics", icon: ChartBar, external: false },
        { name: "Script Writer", href: "/script-writer", icon: PencilLine, external: false },
        // Creator Studio (Programme S1): in-app section under /studio.
        { name: "Creator Studio", href: "/studio", icon: FilmSlate, external: false },
    ],
    System: [
        { name: "Setup Wizard", href: "/setup", icon: Wrench, external: false },
        { name: "Settings", href: "/settings", icon: Gear, external: false },
        { name: "GitHub", href: "https://github.com", icon: GithubLogo, external: true },
    ],
};

/**
 * Shared nav groups, used by both the desktop sidebar and the mobile
 * drawer. The active item is marked by its filled row surface and
 * medium weight only.
 */
function NavGroups({
    collapsed,
    onNavigate,
}: {
    collapsed: boolean;
    onNavigate?: () => void;
}) {
    const pathname = usePathname();

    return (
        <>
            {Object.entries(NAV).map(([group, items]) => (
                <div key={group} className="mb-5">
                    {!collapsed && (
                        <div className="micro-label px-4 mb-1.5 opacity-70">{group}</div>
                    )}
                    <nav className="px-2 space-y-px">
                        {items.map((item) => {
                            const isActive = !item.external && pathname.startsWith(item.href);
                            return (
                                <Link
                                    key={item.name}
                                    href={item.href}
                                    target={item.external ? "_blank" : undefined}
                                    rel={item.external ? "noopener noreferrer" : undefined}
                                    title={collapsed ? item.name : undefined}
                                    onClick={onNavigate}
                                    className={cn(
                                        "group relative flex items-center h-8 rounded-md text-[13px] transition-colors",
                                        collapsed ? "justify-center" : "px-2.5 gap-2.5",
                                        isActive
                                            ? "bg-muted text-foreground font-medium"
                                            : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                                    )}
                                >
                                    <item.icon className={cn("w-4 h-4 shrink-0", isActive ? "text-foreground" : "")} />
                                    {!collapsed && <span className="truncate">{item.name}</span>}
                                </Link>
                            );
                        })}
                    </nav>
                </div>
            ))}
        </>
    );
}

export function Sidebar({ workspaceRuntimeEnabled = false }: { workspaceRuntimeEnabled?: boolean } = {}) {
    const [isCollapsed, setIsCollapsed] = useState(false);

    return (
        <motion.aside
            initial={false}
            animate={{ width: isCollapsed ? 64 : 232 }}
            transition={{ duration: 0.22, ease: "easeInOut" }}
            className="flex-shrink-0 h-screen sticky top-0 left-0 hidden lg:flex flex-col bg-background border-r border-border overflow-visible z-50"
        >
            {/* Collapse toggle */}
            <button
                onClick={() => setIsCollapsed(!isCollapsed)}
                className="absolute -right-2.5 top-7 w-5 h-5 bg-card border border-border rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors z-50"
                aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
                {isCollapsed ? <CaretRight className="w-3 h-3" /> : <CaretLeft className="w-3 h-3" />}
            </button>

            {/* Brand */}
            <div className={cn(
                "h-14 flex items-center border-b border-border transition-all",
                isCollapsed ? "justify-center px-0" : "gap-2.5 px-4"
            )}>
                <LogoMark className="w-6 h-6 shrink-0" />
                <AnimatePresence mode="popLayout">
                    {!isCollapsed && (
                        <motion.span
                            initial={{ opacity: 0, x: -6 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -6 }}
                            className="truncate"
                        >
                            <LogoWordmark className="text-[13px] tracking-[0.14em]" />
                        </motion.span>
                    )}
                </AnimatePresence>
            </div>

            {/* Nav */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-none py-4">
                <NavGroups collapsed={isCollapsed} />
            </div>

            {/* Workspace switcher — Programme 18 Phase G, flag-gated:
                rendered ONLY when the server passed workspaceRuntimeEnabled;
                flag OFF ⇒ this block contributes nothing. */}
            {workspaceRuntimeEnabled && (
                <div className={cn("border-t border-border p-2.5", isCollapsed && "px-2")}>
                    <WorkspaceSwitcher isCollapsed={isCollapsed} />
                </div>
            )}

            {/* Account switcher */}
            <div className={cn("border-t border-border p-2.5", isCollapsed && "px-2")}>
                <AccountSwitcher isCollapsed={isCollapsed} />
            </div>
        </motion.aside>
    );
}

/**
 * Mobile navigation drawer (< lg). Opened by the Topbar hamburger via
 * useUiStore; closes on backdrop tap, the X button, Escape, or navigation.
 */
export function MobileSidebar({ workspaceRuntimeEnabled = false }: { workspaceRuntimeEnabled?: boolean } = {}) {
    const isOpen = useUiStore((s) => s.mobileSidebarOpen);
    const close = useUiStore((s) => s.closeMobileSidebar);
    const pathname = usePathname();

    // Any route change closes the drawer
    useEffect(() => {
        close();
    }, [pathname, close]);

    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === "Escape") close();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [isOpen, close]);

    return (
        <AnimatePresence>
            {isOpen && (
                <div className="lg:hidden fixed inset-0 z-50">
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        onClick={close}
                        className="absolute inset-0 bg-black/45"
                    />

                    {/* Panel */}
                    <motion.aside
                        initial={{ x: -280 }}
                        animate={{ x: 0 }}
                        exit={{ x: -280 }}
                        transition={{ duration: 0.22, ease: "easeInOut" }}
                        className="absolute inset-y-0 left-0 w-[260px] flex flex-col bg-background border-r border-border shadow-2xl"
                    >
                        {/* Brand */}
                        <div className="h-14 flex items-center justify-between border-b border-border pl-4 pr-2">
                            <div className="flex items-center gap-2.5 min-w-0">
                                <LogoMark className="w-6 h-6 shrink-0" />
                                <LogoWordmark className="text-[13px] tracking-[0.14em]" />
                            </div>
                            <button
                                onClick={close}
                                className="p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                                aria-label="Close menu"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        {/* Nav */}
                        <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-none py-4">
                            <NavGroups collapsed={false} onNavigate={close} />
                        </div>

                        {/* Workspace switcher — flag-gated, as desktop. */}
                        {workspaceRuntimeEnabled && (
                            <div className="border-t border-border p-2.5">
                                <WorkspaceSwitcher isCollapsed={false} />
                            </div>
                        )}

                        {/* Account switcher */}
                        <div className="border-t border-border p-2.5">
                            <AccountSwitcher isCollapsed={false} />
                        </div>
                    </motion.aside>
                </div>
            )}
        </AnimatePresence>
    );
}
