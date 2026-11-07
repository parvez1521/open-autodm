import dynamic from "next/dynamic";
import { readSaasFlags } from "@/lib/billing/flags";

// Loaded on demand: the signup form ships only when signup is open,
// and the page's default (invite-only) render — which the page tests
// exercise in a no-JSX-transform harness (tests/customer-journey) —
// stays free of client-component imports.
const SignupForm = dynamic(
  () => import("@/components/auth/SignupForm").then((m) => m.SignupForm),
);

/**
 * Signup page — lives at /get-started, NOT /signup, on purpose.
 * The route-name invariant (tests/signup-protection.test.ts) forbids
 * any route segment named for signup/registration.
 *
 * Behaviour is flag-gated by PUBLIC_SIGNUP_ENABLED:
 *  - OFF (the default): the page renders ONLY the disabled invite-only
 *    state below — no form, no auth call, exactly the Phase 10.4 S-02
 *    posture.
 *  - ON (owner's deliberate choice, e.g. a public-launch preview): the
 *    page renders the real SignupForm — the single component in this
 *    tree allowed to use the supabase.auth signUp method; see
 *    src/components/auth/SignupForm.tsx and the scoped exemption in
 *    tests/signup-protection.test.ts. The instance access gate
 *    (src/lib/signupProtection.ts) still applies to every identity
 *    afterwards: anonymous identities are always denied, and an owner
 *    allowlist, when configured, still narrows who may operate the
 *    instance — including self-registered users.
 */
export default function GetStartedPage() {
  const flags = readSaasFlags(process.env);

  if (!flags.publicSignupEnabled) {
    return (
      <div className="mx-auto max-w-md space-y-4 rounded-xl border border-border bg-card p-6" data-testid="signup-disabled">
        <h1 className="font-heading text-xl font-semibold">Signup is not open yet</h1>
        <p className="text-sm text-muted-foreground">
          open-autoDM is currently <strong>invite-only</strong>. Accounts are provisioned by the
          instance owner — there is no public registration. If you were invited, sign in with the
          account that was created for you.
        </p>
        <p className="text-[12px] text-muted-foreground">
          (Prototype note: public signup is gated by PUBLIC_SIGNUP_ENABLED, which is off by default.)
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-sm" data-testid="signup-form">
      <SignupForm />
      <p className="mt-4 text-center text-[12px] leading-relaxed text-muted-foreground">
        Next steps after signup: confirm your email, then sign in to your console and
        connect Instagram.
      </p>
    </div>
  );
}
