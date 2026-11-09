/**
 * open-autoDM logo — a chat bubble with a lightning bolt. The mark
 * keeps its shape; its gradient moved to the Open Caption palette
 * (orange -> emerald, no magenta) in the 2026-11-09 restyle. The
 * wordmark follows the reference's two-part treatment: bold sans
 * lead + Instrument Serif Italic accent. Used in the sidebar,
 * login page, and favicon.
 */

import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('w-8 h-8', className)} fill="none" aria-label="open-autoDM logo">
      <defs>
        <linearGradient id="oadm-grad" x1="8" y1="56" x2="56" y2="8" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFA946" />
          <stop offset="100%" stopColor="#34D399" />
        </linearGradient>
      </defs>
      {/* Chat bubble */}
      <path
        d="M32 6C17.6 6 6 16.4 6 29.3c0 7.4 3.8 14 9.8 18.3-.3 3.4-1.5 6.4-3.6 8.9-.5.6 0 1.6.8 1.5 4.9-.6 9-2.4 12.1-4.8 2.2.5 4.6.8 6.9.8 14.4 0 26-10.4 26-23.4S46.4 6 32 6Z"
        fill="url(#oadm-grad)"
      />
      {/* Lightning bolt */}
      <path
        d="M35.8 15.5 24 32.2c-.4.6 0 1.4.7 1.4h6.4l-2.9 12.6c-.2 1 1.1 1.6 1.7.8L41.9 30c.4-.6 0-1.4-.7-1.4h-6.5l2.8-12.3c.2-1-1.1-1.6-1.7-.8Z"
        fill="#FFFFEB"
      />
    </svg>
  );
}

export function LogoWordmark({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn('font-heading font-extrabold leading-none tracking-tight', className)}>
      {compact ? (
        <span className="font-accent font-normal italic">AutoDM</span>
      ) : (
        <>
          open-<span className="font-accent font-normal italic">autoDM</span>
        </>
      )}
    </span>
  );
}
