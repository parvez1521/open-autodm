import { readSaasFlags } from "@/lib/billing/flags";

/**
 * Phase 13 prototype — signup page.
 *
 * Route note: this page lives at /get-started, NOT /signup, on purpose.
 * The release's invite-only invariant (tests/signup-protection.test.ts)
 * forbids any route segment named for signup/registration, and this
 * prototype must not weaken that invariant.
 *
 * Behaviour: while PUBLIC_SIGNUP_ENABLED is off (the default) the page
 * renders ONLY the disabled / invite-only state — no form, no auth call.
 * When the owner deliberately enables the flag, a prototype form renders;
 * it is non-functional in this phase (no account creation is wired, and
 * no user-creation auth method is called anywhere in this tree).
 */
export default function GetStartedPrototypePage() {
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
    <div className="mx-auto max-w-md space-y-4 rounded-xl border border-border bg-card p-6" data-testid="signup-form-prototype">
      <h1 className="font-heading text-xl font-semibold">Create your account</h1>
      <p className="rounded bg-amber-500/15 px-2 py-1 text-[12px] text-amber-600 dark:text-amber-400">
        Prototype form — submission is disabled in Phase 13; no account is created.
      </p>
      <form aria-label="Prototype signup form">
        <label className="block text-sm">
          Email
          <input type="email" name="email" autoComplete="email" className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2" placeholder="you@example.com" />
        </label>
        <label className="mt-3 block text-sm">
          Password
          <input type="password" name="password" autoComplete="new-password" className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2" />
        </label>
        <button type="button" disabled className="mt-4 w-full rounded-lg bg-foreground px-3 py-2 text-sm font-semibold text-background opacity-50">
          Create account (disabled in prototype)
        </button>
      </form>
      <p className="text-[12px] text-muted-foreground">
        Next steps after signup would be: email verification → create your workspace → choose a plan.
      </p>
    </div>
  );
}
