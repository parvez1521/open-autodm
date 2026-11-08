/**
 * Pricing catalogue — OWNER-APPROVED 2026-11-08 (design pass round 5).
 *
 * STATUS: approved. The owner set the prices, the account counts, the
 * Enterprise shape and the trial policy himself on 2026-11-08:
 *   Free ₹0 · Starter ₹299/mo (1 Instagram account) · Growth ₹500/mo
 *   (3 accounts) · Pro ₹799/mo (5 accounts) · Enterprise — custom
 *   pricing for Business / Agency, sold by conversation (Contact Us),
 *   never by self-serve checkout.
 * Creator Studio is included on EVERY plan — full on paid plans,
 * LIMITED on Free (owner instruction, 2026-11-08 ~19:38 IST: Free
 * carries 1,000 auto DMs a month plus the limited Studio). Every
 * self-serve paid plan starts with a 15-day free trial, no card
 * upfront; at expiry the workspace drops back to Free unless its
 * owner checks out — nobody is ever silently charged.
 *
 * Display rules (owner instruction, 2026-11-08 ~19:38 IST): pricing
 * surfaces render MONTHLY figures only, in ONE currency chosen by
 * the visitor's country (lib/billing/geo.ts). The annual fields
 * stay in the data (checkout/trial APIs still accept the period)
 * but no surface renders an annual price or a period toggle.
 *
 * Price approval is NOT billing go-live: BILLING_ENABLED /
 * PAYMENTS_LIVE_MODE still default OFF and no payment-provider keys
 * are configured, so no code can charge a customer from this
 * catalogue until the owner deliberately flips those at go-live
 * (tax treatment and refund policy are recorded at that step).
 *
 * Money rule: every price is an INTEGER in the currency's minor unit —
 * paise for INR (₹1 = 100), cents for USD ($1 = 100). Floats are never
 * used for money anywhere in billing.
 */

export const CATALOGUE_STATUS = 'approved' as const;
export type CatalogueStatus = typeof CATALOGUE_STATUS;

export type CurrencyCode = 'INR' | 'USD';
export type BillingPeriod = 'monthly' | 'annual';
export type PlanId = 'free' | 'starter' | 'creator-pro' | 'agency' | 'enterprise';

/** Prices for one currency. All fields are integer minor units. */
export interface PlanPrice {
  /** Price for one month on monthly billing. */
  monthlyMinor: number;
  /** Effective per-month price when billed annually. */
  annualMonthlyMinor: number;
  /** Total charged once for a full annual term (= annualMonthlyMinor × 12). */
  annualTotalMinor: number;
}

/**
 * Configurable numeric limits. Every value is a plain non-negative number
 * so limits can be tuned without code changes. There is deliberately no
 * "unlimited" sentinel: a very large business need is expressed as a
 * larger number by the owner, never as -1 / Infinity, so entitlement
 * checks stay simple comparisons.
 */
export interface PlanLimits {
  workspaces: number;
  instagramAccounts: number;
  teamSeats: number;
  activeAutomations: number;
  /** Automated DMs sent per calendar month, per workspace. */
  dmsPerMonth: number;
  /** Distinct audience contacts stored/interacted with per month. */
  contactsPerMonth: number;
  /** AI drafting generations per month (drafting only — see Phase 7 scope). */
  aiDraftingGenerationsPerMonth: number;
  /** Viral Script Writer generations per month. */
  scriptWriterGenerationsPerMonth: number;
  /**
   * Follow-up messages per month (Phase 13 entitlement dimension).
   * Follow-ups are a subset of outbound messaging, capped separately
   * so a workspace cannot spend its whole DM budget on follow-up
   * nudges.
   */
  followUpsPerMonth: number;
}

/** Support tier for a plan (Phase 13 entitlement dimension). */
export type SupportLevel = 'community' | 'email' | 'priority-email' | 'dedicated';

export interface Plan {
  id: PlanId;
  /** Display name (owner-approved 2026-11-08). */
  name: string;
  status: CatalogueStatus;
  /**
   * True only for Enterprise: pricing is custom and sales-led, so the
   * plan carries NO price figure anywhere and can never be bought
   * through self-serve checkout (its stored prices stay zero and the
   * checkout route refuses zero-amount plans).
   */
  customPricing?: boolean;
  /** Both currencies are present for every plan, paid or free. */
  prices: Record<CurrencyCode, PlanPrice>;
  limits: PlanLimits;
  /** Data-retention tier in days (Phase 13). */
  dataRetentionDays: number;
  /** Support tier (Phase 13). */
  supportLevel: SupportLevel;
  /** Human-readable capability notes for the pricing surfaces. */
  capabilityNotes: string[];
}

const zeroPrice: PlanPrice = {
  monthlyMinor: 0,
  annualMonthlyMinor: 0,
  annualTotalMinor: 0,
};

export const PLANS: readonly Plan[] = [
  {
    id: 'free',
    name: 'Free',
    status: CATALOGUE_STATUS,
    prices: {
      INR: { ...zeroPrice },
      USD: { ...zeroPrice },
    },
    limits: {
      workspaces: 1,
      instagramAccounts: 1,
      teamSeats: 1,
      activeAutomations: 3,
      // Owner instruction, 2026-11-08 ~19:38 IST: Free carries
      // 1,000 auto DMs a month (was 250 in the draft catalogue).
      dmsPerMonth: 1000,
      contactsPerMonth: 250,
      aiDraftingGenerationsPerMonth: 20,
      scriptWriterGenerationsPerMonth: 10,
      followUpsPerMonth: 100,
    },
    dataRetentionDays: 30,
    supportLevel: 'community',
    capabilityNotes: [
      'Comment-to-DM, story-reply and keyword-DM automations',
      'Recipient opt-out handling, comment moderation basics, webhook safety and data-deletion compliance are included and unrestricted (see phase11-pricing-and-packaging.md §Safety floor)',
      'Creator Studio included (limited) — niche research, ideas, scripts, voiceover, SEO and projects',
    ],
  },
  {
    id: 'starter',
    name: 'Starter',
    status: CATALOGUE_STATUS,
    prices: {
      // ₹299/mo monthly; ₹239/mo billed annually (₹2,868/yr) — owner-approved 2026-11-08
      INR: { monthlyMinor: 29900, annualMonthlyMinor: 23900, annualTotalMinor: 286800 },
      // $5/mo monthly; $4/mo billed annually ($48/yr) — USD figures set alongside (round 5)
      USD: { monthlyMinor: 500, annualMonthlyMinor: 400, annualTotalMinor: 4800 },
    },
    limits: {
      workspaces: 1,
      instagramAccounts: 1,
      teamSeats: 1,
      activeAutomations: 10,
      dmsPerMonth: 2000,
      contactsPerMonth: 2000,
      aiDraftingGenerationsPerMonth: 100,
      scriptWriterGenerationsPerMonth: 50,
      followUpsPerMonth: 500,
    },
    dataRetentionDays: 90,
    supportLevel: 'email',
    capabilityNotes: [
      'Everything in Free, with higher DM/contact allowances',
      'Public comment replies and follow-up messages',
      'Creator Studio included',
    ],
  },
  {
    id: 'creator-pro',
    name: 'Growth',
    status: CATALOGUE_STATUS,
    prices: {
      // ₹500/mo monthly; ₹400/mo billed annually (₹4,800/yr) — owner-approved 2026-11-08
      INR: { monthlyMinor: 50000, annualMonthlyMinor: 40000, annualTotalMinor: 480000 },
      // $9/mo monthly; $7/mo billed annually ($84/yr)
      USD: { monthlyMinor: 900, annualMonthlyMinor: 700, annualTotalMinor: 8400 },
    },
    limits: {
      workspaces: 3,
      instagramAccounts: 3,
      teamSeats: 3,
      activeAutomations: 50,
      dmsPerMonth: 10000,
      contactsPerMonth: 10000,
      aiDraftingGenerationsPerMonth: 500,
      scriptWriterGenerationsPerMonth: 300,
      followUpsPerMonth: 2500,
    },
    dataRetentionDays: 365,
    supportLevel: 'priority-email',
    capabilityNotes: [
      'Everything in Starter, for creators running several accounts',
      'Flow-graph automations, Traffic Guard, analytics',
      'Creator Studio included',
    ],
  },
  {
    id: 'agency',
    name: 'Pro',
    status: CATALOGUE_STATUS,
    prices: {
      // ₹799/mo monthly; ₹639/mo billed annually (₹7,668/yr) — owner-approved 2026-11-08
      INR: { monthlyMinor: 79900, annualMonthlyMinor: 63900, annualTotalMinor: 766800 },
      // $15/mo monthly; $12/mo billed annually ($144/yr)
      USD: { monthlyMinor: 1500, annualMonthlyMinor: 1200, annualTotalMinor: 14400 },
    },
    limits: {
      workspaces: 5,
      instagramAccounts: 5,
      teamSeats: 5,
      activeAutomations: 200,
      dmsPerMonth: 50000,
      contactsPerMonth: 50000,
      aiDraftingGenerationsPerMonth: 2000,
      scriptWriterGenerationsPerMonth: 1000,
      followUpsPerMonth: 10000,
    },
    dataRetentionDays: 730,
    supportLevel: 'priority-email',
    capabilityNotes: [
      'Everything in Growth, with room for five accounts',
      'Workspace-level subscription, member roles (owner/admin/member)',
      'Creator Studio included',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    status: CATALOGUE_STATUS,
    // Custom pricing (owner instruction, 2026-11-08): positioned
    // "For Business / Agency" with a Contact Us action instead of a
    // price. Prices stay zero so no surface can render a figure and
    // checkout refuses the plan.
    customPricing: true,
    prices: {
      INR: { ...zeroPrice },
      USD: { ...zeroPrice },
    },
    limits: {
      workspaces: 25,
      instagramAccounts: 25,
      teamSeats: 25,
      activeAutomations: 500,
      dmsPerMonth: 200000,
      contactsPerMonth: 200000,
      aiDraftingGenerationsPerMonth: 5000,
      scriptWriterGenerationsPerMonth: 2500,
      followUpsPerMonth: 25000,
    },
    dataRetentionDays: 730,
    supportLevel: 'dedicated',
    capabilityNotes: [
      'For Business / Agency — many accounts under one roof, structured as client workspaces',
      'Custom limits — accounts, seats and volumes agreed with you',
      'Priority support',
      'Creator Studio included',
    ],
  },
] as const;

export function getPlan(id: PlanId): Plan {
  const plan = PLANS.find((p) => p.id === id);
  if (!plan) throw new Error(`Unknown plan id: ${id}`);
  return plan;
}

export function isPaidPlan(plan: Plan): boolean {
  return plan.id !== 'free';
}

/** Self-serve paid plans: buyable through checkout once billing is live. */
export function isSelfServePaidPlan(plan: Plan): boolean {
  return isPaidPlan(plan) && !plan.customPricing;
}

// ── Trial policy — owner-decided 2026-11-08 ─────────────────────────────
// Every self-serve paid plan starts with a 15-day free trial. No card
// is taken upfront (the signup flow captures no payment details); at
// expiry the workspace drops back to Free unless its owner checks
// out. The option list stays as data so the policy remains a
// configuration choice; the selected option is the owner's decision.

export type TrialCardModel =
  | 'card-upfront'
  | 'no-card-then-checkout'
  | 'authorized-mandate';

export type TrialExpiryBehaviour =
  | 'auto-downgrade-to-free'
  | 'payment-authorization-required';

export interface TrialOption {
  id: string;
  days: 7 | 14 | 15 | 30;
  cardModel: TrialCardModel;
  expiryBehaviour: TrialExpiryBehaviour;
  status: CatalogueStatus;
  /**
   * Invariant for every option, present and future: nobody is silently
   * auto-charged. A first charge requires clear consent plus a valid
   * payment mandate captured before the charge.
   */
  silentAutoChargeAllowed: false;
}

function trialOption(
  days: TrialOption['days'],
  cardModel: TrialCardModel,
  expiryBehaviour: TrialExpiryBehaviour,
): TrialOption {
  return {
    id: `${days}d-${cardModel}-${expiryBehaviour}`,
    days,
    cardModel,
    expiryBehaviour,
    status: CATALOGUE_STATUS,
    silentAutoChargeAllowed: false,
  };
}

export const TRIAL_OPTIONS: readonly TrialOption[] = [
  trialOption(7, 'card-upfront', 'payment-authorization-required'),
  trialOption(7, 'no-card-then-checkout', 'auto-downgrade-to-free'),
  trialOption(7, 'authorized-mandate', 'payment-authorization-required'),
  trialOption(14, 'card-upfront', 'payment-authorization-required'),
  trialOption(14, 'no-card-then-checkout', 'auto-downgrade-to-free'),
  trialOption(14, 'authorized-mandate', 'payment-authorization-required'),
  trialOption(15, 'card-upfront', 'payment-authorization-required'),
  trialOption(15, 'no-card-then-checkout', 'auto-downgrade-to-free'),
  trialOption(15, 'authorized-mandate', 'payment-authorization-required'),
  trialOption(30, 'card-upfront', 'payment-authorization-required'),
  trialOption(30, 'no-card-then-checkout', 'auto-downgrade-to-free'),
  trialOption(30, 'authorized-mandate', 'payment-authorization-required'),
] as const;

/** Selected by the owner on 2026-11-08: 15 days, no card, downgrade to Free. */
export const SELECTED_TRIAL_OPTION_ID: string | null =
  '15d-no-card-then-checkout-auto-downgrade-to-free';

export const SELECTED_TRIAL_OPTION: TrialOption | undefined = TRIAL_OPTIONS.find(
  (o) => o.id === SELECTED_TRIAL_OPTION_ID,
);

/** Trial length in days for every self-serve paid plan (owner-set: 15). */
export const TRIAL_DAYS: number = SELECTED_TRIAL_OPTION?.days ?? 0;
