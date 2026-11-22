'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A post thumbnail that never shows a broken-image icon (2026-11-22).
 *
 * The stored `post_thumbnail_url` snapshot expires within days, so a
 * plain <img> renders a broken icon for older automations. PostThumb
 * swaps to the caller's `fallback` (the same muted platform-icon box
 * the list/editor already render when no thumbnail exists) the moment
 * the image errors — and resets when `src` changes, so a refreshed
 * URL gets a fresh chance.
 */
export function PostThumb({
  src,
  alt,
  className,
  imgClassName,
  fallback,
  children,
}: {
  src?: string | null;
  alt?: string;
  /** Outer box classes (size, rounding). The image fills it. */
  className?: string;
  /** Extra classes on the <img> (e.g. opacity for a preview overlay). */
  imgClassName?: string;
  /** Rendered inside the box when there is no usable image. */
  fallback: ReactNode;
  /** Rendered inside the box on top of the image/fallback (overlays, labels). */
  children?: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [src]);

  const showImage = !!src && !failed;
  return (
    <div className={cn('overflow-hidden bg-muted', className)}>
      {showImage ? (
        <img
          src={src!}
          alt={alt ?? 'Post'}
          className={cn('h-full w-full object-cover', imgClassName)}
          onError={() => setFailed(true)}
        />
      ) : (
        fallback
      )}
      {children}
    </div>
  );
}
