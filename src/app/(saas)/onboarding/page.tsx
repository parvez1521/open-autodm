import { JOURNEY_STEPS, ONBOARDING_STEP_IDS } from "@/lib/tenancy/journey";

/**
 * Phase 13 prototype — onboarding checklist page.
 * Renders the onboarding subset of the journey state machine
 * (src/lib/tenancy/journey.ts) in canonical order. Static prototype:
 * completion state is illustrative, not persisted.
 */
export default function OnboardingPrototypePage() {
  const steps = ONBOARDING_STEP_IDS.map(
    (id) => JOURNEY_STEPS.find((s) => s.id === id)!,
  );
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Get set up</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The onboarding sequence for a new workspace. Steps complete in order.
        </p>
      </div>
      <ol className="space-y-2">
        {steps.map((step, i) => (
          <li key={step.id} className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[12px] font-semibold">
              {i + 1}
            </span>
            <div>
              <p className="text-sm font-medium">{step.title}</p>
              <p className="text-[13px] text-muted-foreground">{step.notes}</p>
              {step.gatedBy && (
                <p className="mt-1 text-[11px] text-muted-foreground">Gated by: {step.gatedBy}</p>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-sm font-medium">Before you connect Instagram</p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          You will be asked to grant the platform&apos;s Meta app permission to read comments on
          your account and send direct messages on your behalf. That is the minimum needed for
          comment-to-DM automations. You can disconnect at any time, and audience opt-outs and
          data-deletion requests are always honoured — on every plan, including Free.
        </p>
      </div>
    </div>
  );
}
