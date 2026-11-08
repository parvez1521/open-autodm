/**
 * Client hook for the geo display currency (owner instruction,
 * 2026-11-08 ~19:38 IST — see lib/billing/geo.ts for the rules).
 *
 * The initial state is INR, which is exactly what the server
 * renders, so hydration never mismatches; on mount the hook
 * resolves the real currency (middleware cookie → timezone →
 * INR default) and the surface re-renders in that one currency.
 * A visitor therefore only ever sees a single currency per render.
 */

import { useEffect, useState } from "react";
import {
  GEO_CURRENCY_COOKIE,
  currencyForTimezone,
  isCurrencyCode,
} from "./geo";
import type { CurrencyCode } from "./catalogue";

/** Resolve the display currency from cookie, then timezone, then INR. */
export function resolveDisplayCurrency(): CurrencyCode {
  if (typeof document !== "undefined") {
    const match = document.cookie.match(
      new RegExp(`(?:^|;\\s*)${GEO_CURRENCY_COOKIE}=([^;]*)`),
    );
    const fromCookie = match ? decodeURIComponent(match[1]!) : null;
    if (isCurrencyCode(fromCookie)) return fromCookie;
  }
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timeZone) return currencyForTimezone(timeZone);
  } catch {
    /* Intl unavailable — fall through to the INR default. */
  }
  return "INR";
}

/** INR on first paint (matching SSR); corrected on mount if needed. */
export function useDisplayCurrency(): CurrencyCode {
  const [currency, setCurrency] = useState<CurrencyCode>("INR");
  useEffect(() => {
    setCurrency(resolveDisplayCurrency());
  }, []);
  return currency;
}
