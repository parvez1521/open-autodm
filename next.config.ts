import type { NextConfig } from 'next';

// Baseline security headers (security audit Phase B, 2026-11-10 —
// finding #9). Applied site-wide via headers(). Deliberately NO full
// enforcing CSP: only `frame-ancestors 'none'` (nothing legitimately
// iframes this site itself — the app's one iframe EMBEDS an external
// player, it is never framed), which pairs with X-Frame-Options: DENY
// as clickjacking defence-in-depth. HSTS is already sent by Vercel.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
];

const nextConfig: NextConfig = {
  // Instagram CDN thumbnails and Supabase Storage images are rendered with
  // plain <img> tags throughout the app, so the image optimizer is unused.
  // Keeping it disabled makes the build identical on Vercel and Cloudflare.
  images: { unoptimized: true },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
