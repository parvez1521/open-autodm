"use client";

/**
 * Shared pill-toggle treatment (UI polish, 2026-11-25).
 *
 * Before this, every pill group in the app hand-rolled the same
 * classes — and they drifted apart. The /automations tabs used
 * rounded-[6px] (the 2026-11-22 corner fix: container rounded-lg
 * 8px minus 2px padding = 6px), while the small toggles and the
 * account-switcher popover still used a 7px radius, so their
 * active pill's corner arc overhung the container. The active state
 * was also muddy: `bg-card` on `bg-muted` with only `shadow-sm`
 * reads as a barely-lighter slab, not a selected control — the
 * owner called the toggles unprofessional on 2026-11-25.
 *
 * One component now owns the treatment: two sizes (md for page
 * tabs and channel toggles, sm for in-editor toggles), a crisp
 * active state (`bg-card` + `ring-1 ring-border` + shadow so the
 * selected pill has a defined edge), matched icon weight, and the
 * 6px inner radius everywhere. Behaviour is untouched — same
 * values, same onChange, same localStorage keys; this is
 * presentation only.
 */

import type { ComponentType } from "react";
import { FacebookLogo, InstagramLogo } from "@/components/phosphor";
import { cn } from "@/lib/utils";

export type PillToggleSize = "md" | "sm";

export interface PillToggleOption<T extends string | number | boolean> {
    value: T;
    label: string;
    /** Optional leading icon, rendered at the toggle's icon size. */
    icon?: ComponentType<{ className?: string }>;
}

interface PillToggleProps<T extends string | number | boolean> {
    options: PillToggleOption<T>[];
    value: T;
    onChange: (value: T) => void;
    size?: PillToggleSize;
    /** Stretch to the container width with equal-width buttons (popover use). */
    stretch?: boolean;
    /** Capitalize labels via CSS (keeps the option values lowercase). */
    capitalize?: boolean;
    ariaLabel?: string;
    className?: string;
}

const SIZE_CLASSES: Record<PillToggleSize, string> = {
    // md: page tabs + channel toggles. sm: in-editor toggles.
    // Both use rounded-[6px]: container rounded-lg (8px) minus the
    // 2px (p-0.5) inset — 7px overhangs the container's corners.
    md: "h-8 px-3.5 rounded-[6px] text-[13px]",
    sm: "h-7 px-3 rounded-[6px] text-[12px]",
};

const ICON_CLASSES: Record<PillToggleSize, string> = {
    md: "w-3.5 h-3.5",
    sm: "w-3 h-3",
};

export function PillToggle<T extends string | number | boolean>({
    options,
    value,
    onChange,
    size = "md",
    stretch = false,
    capitalize = false,
    ariaLabel,
    className,
}: PillToggleProps<T>) {
    return (
        <div
            className={cn(
                "items-center bg-muted rounded-lg p-0.5",
                stretch ? "flex w-full" : "inline-flex",
                className,
            )}
            role="tablist"
            aria-label={ariaLabel}
        >
            {options.map((opt) => {
                const Icon = opt.icon;
                const isActive = opt.value === value;
                return (
                    <button
                        key={String(opt.value)}
                        type="button"
                        onClick={() => onChange(opt.value)}
                        aria-pressed={isActive}
                        className={cn(
                            "font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                            SIZE_CLASSES[size],
                            stretch ? "flex-1 justify-center" : "shrink-0",
                            Icon ? "inline-flex items-center gap-1.5" : "inline-flex items-center justify-center",
                            capitalize && "capitalize",
                            // Crisp active state: the card surface plus a
                            // 1px border ring gives the selected pill a
                            // defined edge instead of a muddy slab.
                            isActive
                                ? "bg-card text-foreground shadow-sm ring-1 ring-border"
                                : "text-muted-foreground hover:text-foreground",
                        )}
                    >
                        {Icon && <Icon className={ICON_CLASSES[size]} />}
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
}

/**
 * Brand glyphs for the Instagram/Facebook channel toggles.
 *
 * Phosphor's default (regular) weight draws both logos as thin
 * outlines, but the two glyphs carry very different amounts of ink
 * — the Instagram camera (rounded square + inner circle + dot)
 * reads heavy while the Facebook circle-f reads thin, so the pair
 * looked mismatched in the same toggle. The `fill` weight renders
 * both as solid glyphs of matched visual weight.
 */
export function InstagramGlyph({ className }: { className?: string }) {
    return <InstagramLogo className={className} weight="fill" />;
}

export function FacebookGlyph({ className }: { className?: string }) {
    return <FacebookLogo className={className} weight="fill" />;
}
