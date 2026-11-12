/**
 * open-autoDM logo - a chat bubble with a lightning bolt, in the
 * original solid orange (#F97316, the brand primary). Used in the
 * sidebar, login page, loader, and favicon.
 *
 * NOTE: do not "refresh" this into a gradient. The owner wants the old
 * orange logo kept as-is - no sunset/purple gradient, no green.
 */

import { cn } from '@/lib/utils';

export const OPEN_AUTODM_ORANGE = '#F97316';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('w-8 h-8', className)} fill="none" aria-label="open-autoDM logo">
      {/* Chat bubble - solid brand orange */}
      <path
        d="M32 6C17.6 6 6 16.4 6 29.3c0 7.4 3.8 14 9.8 18.3-.3 3.4-1.5 6.4-3.6 8.9-.5.6 0 1.6.8 1.5 4.9-.6 9-2.4 12.1-4.8 2.2.5 4.6.8 6.9.8 14.4 0 26-10.4 26-23.4S46.4 6 32 6Z"
        fill="#F97316"
      />
      {/* Lightning bolt */}
      <path
        d="M35.8 15.5 24 32.2c-.4.6 0 1.4.7 1.4h6.4l-2.9 12.6c-.2 1 1.1 1.6 1.7.8L41.9 30c.4-.6 0-1.4-.7-1.4h-6.5l2.8-12.3c.2-1-1.1-1.6-1.7-.8Z"
        fill="white"
      />
    </svg>
  );
}

export function LogoWordmark({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn('font-heading font-bold tracking-widest uppercase', className)}>
      {compact ? (
        'AutoDM'
      ) : (
        <>
          open-<span className="text-[#F97316]">autoDM</span>
        </>
      )}
    </span>
  );
}
