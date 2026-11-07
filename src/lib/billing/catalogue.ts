/**
 * DRAFT pricing catalogue — Phase 11 (2026-11-06).
 *
 * STATUS: draft-unapproved. Nothing in this file is an approved price, an
 * approved limit, or an approved trial policy. Every number here is a
 * configurable proposal for owner review (see
 * saas/phase11-pricing-and-packaging.md and
 * saas/phase11-market-and-competitor-research.md). No code may charge a
 * customer from this catalogue until the owner approves exact prices,
 * limits, trial policy, provider, tax treatment and refund policy, and
 * until BILLING_ENABLED / PAYMENTS_LIVE_MODE are deliberately turned on
 * (they default OFF — see the programme checkpoint).
 *
 * Money rule: every price is an INTEGER in the currency's minor unit —
 * paise for INR (₹1 = 100), cents for USD ($1 = 100). Floats are never
 * used for money anywhere in billing.
 */

export const CATALOGUE_STATUS = 'draft-unapproved' as const;
export type CatalogueStatus = typeof CATALOGUE_STATUS;

export type CurrencyCode = 'INR' | 'USD';
export type BillingPeriod = 'monthly' | 'annual';
export type PlanId = 'free' | 'starter' | 'creator-pro' | 'agency';

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
   * Draft values mirror the DM allowance shape: follow-ups are a subset
   * of outbound messaging, capped separately so a workspace cannot spend
   * its whole DM budget on follow-up nudges. DRAFT — owner approval pending.
   */
  followUpsPerMonth: number;
}

/** Support tier for a plan (Phase 13 entitlement dimension). DRAFT. */
export type SupportLevel = 'community' | 'email' | 'priority-email' | 'dedicated';

export interface Plan {
  id: PlanId;
  /** Proposed display name — NOT approved. */
  proposedName: string;
  status: CatalogueStatus;
  /** Both currencies are present for every plan, paid or free. */
  prices: Record<CurrencyCode, PlanPrice>;
  limits: PlanLimits;
  /** Data-retention tier in days (Phase 13). DRAFT — owner approval pending. */
  dataRetentionDays: number;
  /** Support tier (Phase 13). DRAFT — owner approval pending. */
  supportLevel: SupportLevel;
  /** Human-readable capability notes for the pricing page draft. */
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
    proposedName: 'Free',
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
      dmsPerMonth: 250,
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
    ],
  },
  {
    id: 'starter',
    proposedName: 'Starter',
    status: CATALOGUE_STATUS,
    prices: {
      // ₹499/mo monthly; ₹399/mo billed annually (₹4,788/yr) — DRAFT
      INR: { monthlyMinor: 49900, annualMonthlyMinor: 39900, annualTotalMinor: 478800 },
      // $9/mo monthly; $7/mo billed annually ($84/yr) — DRAFT
      USD: { monthlyMinor: 900, annualMonthlyMinor: 700, annualTotalMinor: 8400 },
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
    ],
  },
  {
    id: 'creator-pro',
    proposedName: 'Creator Pro',
    status: CATALOGUE_STATUS,
    prices: {
      // ₹999/mo monthly; ₹799/mo billed annually (₹9,588/yr) — DRAFT
      INR: { monthlyMinor: 99900, annualMonthlyMinor: 79900, annualTotalMinor: 958800 },
      // $19/mo monthly; $15/mo billed annually ($180/yr) — DRAFT
      USD: { monthlyMinor: 1900, annualMonthlyMinor: 1500, annualTotalMinor: 18000 },
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
    ],
  },
  {
    id: 'agency',
    proposedName: 'Agency',
    status: CATALOGUE_STATUS,
    prices: {
      // ₹2,999/mo monthly; ₹2,399/mo billed annually (₹28,788/yr) — DRAFT
      INR: { monthlyMinor: 299900, annualMonthlyMinor: 239900, annualTotalMinor: 2878800 },
      // $59/mo monthly; $47/mo billed annually ($564/yr) — DRAFT
      USD: { monthlyMinor: 5900, annualMonthlyMinor: 4700, annualTotalMinor: 56400 },
    },
    limits: {
      workspaces: 10,
      instagramAccounts: 10,
      teamSeats: 10,
      activeAutomations: 200,
      dmsPerMonth: 50000,
      contactsPerMonth: 50000,
      aiDraftingGenerationsPerMonth: 2000,
      scriptWriterGenerationsPerMonth: 1000,
      followUpsPerMonth: 10000,
    },
    dataRetentionDays: 730,
    supportLevel: 'dedicated',
    capabilityNotes: [
      'Everything in Creator Pro, structured as client workspaces',
      'Workspace-level subscription, member roles (owner/admin/member) — requires the Phase 11 multi-tenant build, not yet implemented',
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

// ── Trial options as DATA, not decisions ────────────────────────────────────
// No trial option is selected. This list exists so a later owner decision
// can be expressed as a configuration choice. See
// saas/phase11-trial-policy-comparison.md for the comparison.

export type TrialCardModel =
  | 'card-upfront'
  | 'no-card-then-checkout'
  | 'authorized-mandate';

export type TrialExpiryBehaviour =
  | 'auto-downgrade-to-free'
  | 'payment-authorization-required';

export interface TrialOption {
  id: string;
  days: 7 | 14 | 30;
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
  trialOption(30, 'card-upfront', 'payment-authorization-required'),
  trialOption(30, 'no-card-then-checkout', 'auto-downgrade-to-free'),
  trialOption(30, 'authorized-mandate', 'payment-authorization-required'),
] as const;

/** No trial is selected in this draft catalogue. */
export const SELECTED_TRIAL_OPTION_ID: string | null = null;
