/**
 * Geo display currency — owner instruction, 2026-11-08 ~19:38 IST.
 *
 * Prices are NEVER shown in two currencies at once: a visitor sees
 * only their own country's currency — India → INR, everywhere else
 * → USD. The catalogue keeps both currencies' figures; this module
 * decides which ONE a surface renders.
 *
 * Resolution chain (first hit wins):
 *   1. The `geo-currency` cookie, set by src/middleware.ts from the
 *      Vercel edge country header (x-vercel-ip-country; cf-ipcountry
 *      as the Cloudflare fallback) — server-known, no extra calls.
 *   2. The browser timezone (Asia/Kolkata / Asia/Calcutta → INR) as
 *      a client-side fallback for requests the edge header missed.
 *   3. INR as the default — the SSR/first-paint render is always
 *      INR and the client corrects it on mount when the chain says
 *      USD (see useDisplayCurrency.ts).
 *
 * Pure functions + constants only: this file is imported by the
 * edge middleware, so it must stay dependency-free (the catalogue
 * import is type-only and erased at compile time).
 */

import type { CurrencyCode } from "./catalogue";

/** Cookie the middleware sets and client surfaces read. */
export const GEO_CURRENCY_COOKIE = "geo-currency";

/** India → INR; every other country (or an unknown one) → USD. */
export function currencyForCountry(country: string | null | undefined): CurrencyCode {
  return country?.trim().toUpperCase() === "IN" ? "INR" : "USD";
}

const INDIA_TIMEZONES = new Set(["Asia/Kolkata", "Asia/Calcutta"]);

/** Timezone fallback: Indian timezones → INR, anything else → USD. */
export function currencyForTimezone(timeZone: string | null | undefined): CurrencyCode {
  return timeZone && INDIA_TIMEZONES.has(timeZone) ? "INR" : "USD";
}

export function isCurrencyCode(value: string | null | undefined): value is CurrencyCode {
  return value === "INR" || value === "USD";
}

/**
 * The caller's geo currency as the SERVER can prove it for this
 * request — the edge country header (x-vercel-ip-country, with
 * cf-ipcountry as the Cloudflare fallback: the same headers the
 * middleware writes the geo cookie from), falling back to that
 * cookie. Returns null when the request carries NO geo signal at
 * all (local development, non-edge runtimes): callers must treat
 * null as "cannot verify" rather than as a country, because
 * currencyForCountry(null) would silently mean USD.
 *
 * Checkout/trial currency fix (2026-11-09, audit Bug 5): the routes
 * used to trust the body's currency outright, so a non-India buyer
 * could POST currency:"INR" and pay ₹299 instead of $5. They now
 * compare the body against this server-side resolution and refuse
 * a mismatch (400 CURRENCY_MISMATCH) whenever a signal exists.
 */
export function serverCurrencyForRequest(request: Request): CurrencyCode | null {
  const country =
    request.headers.get("x-vercel-ip-country") ?? request.headers.get("cf-ipcountry");
  if (country) return currencyForCountry(country);
  const cookie = request.headers.get("cookie");
  if (cookie) {
    const match = new RegExp(`(?:^|;\\s*)${GEO_CURRENCY_COOKIE}=([^;]*)`).exec(cookie);
    const value = match ? decodeURIComponent(match[1]!) : null;
    if (isCurrencyCode(value)) return value;
  }
  return null;
}

/**
 * Render an integer minor-unit amount in ONE currency — the shared
 * formatter for every pricing surface (₹299 / $9 style, no decimals
 * for the catalogue's whole-unit figures).
 */
export function formatPriceMinor(minor: number, currency: CurrencyCode): string {
  if (minor === 0) return currency === "INR" ? "₹0" : "$0";
  const major = minor / 100;
  return currency === "INR"
    ? `₹${major.toLocaleString("en-IN")}`
    : `$${major.toLocaleString("en-US")}`;
}
