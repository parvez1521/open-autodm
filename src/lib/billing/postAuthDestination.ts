/**
 * Client half of the post-auth routing (owner directive,
 * 2026-11-10, Task F).
 *
 * The email/password forms (LoginForm, SignupForm) authenticate
 * in the browser, so they cannot decide the landing page
 * themselves: after a successful sign-in/sign-up they ask
 * GET /api/billing/plan-choice — which resolves the destination
 * server-side (lib/billing/planChoiceServer) from the verified
 * session — and navigate there. Email-link and OAuth (Google)
 * flows never call this: /auth/callback resolves the same
 * destination before redirecting.
 *
 * Fails open to /dashboard on ANY problem (network, timeout,
 * malformed payload): a customer who has signed in must always
 * land somewhere usable, and the dashboard carries the plan
 * choice as a checklist step + banner anyway.
 */

import { apiClient } from "@/lib/api/client";

export async function fetchPostAuthDestination(): Promise<string> {
  try {
    const res = await apiClient<{ destination?: unknown }>("/billing/plan-choice");
    return typeof res.destination === "string" && res.destination.startsWith("/")
      ? res.destination
      : "/dashboard";
  } catch {
    return "/dashboard";
  }
}
