import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs))
}

/**
 * Truncates text to `max` characters with a trailing ellipsis when it is
 * longer. Short text is returned unchanged (no dangling "…" on text that
 * already fits). Used wherever a caption or summary is cut mid-word in
 * the UI — the list rows, the editor's Post section header and the
 * Selected-post row — so the cut is visibly marked instead of silently
 * dropping the tail. Pair with title={fullText} so the whole text stays
 * reachable on hover.
 */
export function truncateWithEllipsis(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max).trimEnd()}…`;
}
