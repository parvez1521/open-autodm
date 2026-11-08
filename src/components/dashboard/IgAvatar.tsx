"use client";

/**
 * Instagram account avatar with a graceful fallback (functional
 * audit fix, 2026-11-08). Connected-account profile URLs are Meta
 * CDN links that expire; when the image fails (or none exists) the
 * tile shows the account's initial instead of a broken-image glyph.
 * Shared by the sidebar account switcher and Settings.
 */

import { useEffect, useState } from "react";
import { InstagramLogo } from "@/components/phosphor";
import { cn } from "@/lib/utils";

export function IgAvatar({
    username,
    pictureUrl,
    className,
    iconClassName,
}: {
    username: string | null | undefined;
    pictureUrl: string | null | undefined;
    /** Sizing for the tile itself, e.g. "w-7 h-7". */
    className?: string;
    iconClassName?: string;
}) {
    const [failed, setFailed] = useState(false);

    // A fresh URL (token refresh / reconnect) gets a fresh attempt.
    useEffect(() => {
        setFailed(false);
    }, [pictureUrl]);

    const showImage = !!pictureUrl && !failed;
    const initial = username?.trim().charAt(0).toUpperCase();

    return (
        <div className={cn("relative rounded-full border border-border shrink-0", className)}>
            <div className="w-full h-full rounded-full bg-background flex items-center justify-center overflow-hidden">
                {showImage ? (
                    <img
                        src={pictureUrl}
                        alt={username ? `@${username}` : "Instagram account"}
                        className="w-full h-full object-cover rounded-full"
                        onError={() => setFailed(true)}
                    />
                ) : initial ? (
                    <span className="text-[11px] font-semibold text-muted-foreground select-none">
                        {initial}
                    </span>
                ) : (
                    <InstagramLogo className={cn("w-3 h-3 text-muted-foreground", iconClassName)} />
                )}
            </div>
        </div>
    );
}
