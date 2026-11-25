"use client";

/**
 * Instagram account avatar with a graceful fallback (functional
 * audit fix, 2026-11-08). Connected-account profile URLs are Meta
 * CDN links that expire; when the image fails (or none exists) the
 * tile shows the Instagram glyph on a solid brand-tinted tile
 * instead of a broken-image glyph.
 *
 * UI polish (2026-11-25): the fallback used to be the account's
 * first letter — so the switcher showed one real photo next to
 * plain "C" / "B" tiles, which looks unfinished. A platform glyph
 * on a tinted tile is one consistent, deliberate fallback for every
 * account (the Facebook fallback already worked this way). The
 * fresh picture is resolved at render time by useProfilePictures,
 * so the glyph only shows when Meta cannot serve a photo at all.
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
                ) : (
                    <span className="w-full h-full rounded-full bg-[#E1306C]/10 flex items-center justify-center">
                        <InstagramLogo className={cn("w-3 h-3 text-[#E1306C]", iconClassName)} weight="fill" />
                    </span>
                )}
            </div>
        </div>
    );
}
