/**
 * SEO structured data + shared metadata strings (SEO pass,
 * 2026-11-10 — application plan in
 * workspace/opendm-persona-qa-2026-11-09/seo-research-2026-11-10.md,
 * priorities P0/P1/P3).
 *
 * Every fact here is a shipped product fact: plan names, prices and
 * account counts come straight from the billing catalogue (the
 * single source), DMs and automations are unlimited on every plan
 * (owner decisions 2026-11-09 / 2026-11-10), and there are NO
 * ratings, reviews or testimonials in the schema — nothing fake,
 * mirroring the competitor's restraint.
 */

import { PLANS } from "@/lib/billing/catalogue";

export const SITE_URL = "https://opendm.in";
export const SITE_NAME = "open-autoDM";

export const HOME_TITLE =
  "Instagram Auto DM Tool — Comment-to-DM Automation | open-autoDM";
export const HOME_DESCRIPTION =
  "open-autoDM is an Instagram auto DM tool: when someone comments your keyword on a Reel or post, it replies publicly and sends them a DM automatically. Free plan, unlimited DMs, plans from ₹299/mo.";

export const AUTO_DM_TITLE =
  "Auto DM for Instagram — Automatic DMs from Comments";
export const AUTO_DM_DESCRIPTION =
  "Set a keyword and open-autoDM sends an automatic DM to everyone who comments it on your Reels and posts — with a public reply, follow check and your link. Free plan available; paid plans from ₹299/mo with unlimited DMs.";

export const PRICING_TITLE = "Pricing — Free, ₹299, ₹500 & ₹799 Plans";
export const PRICING_DESCRIPTION =
  "open-autoDM pricing: start free, or go Starter ₹299/mo, Growth ₹500/mo (3 Instagram accounts) or Pro ₹799/mo (5 accounts). Every paid plan has unlimited DMs and a 15-day free trial, no card needed.";

export const GET_STARTED_TITLE = "Get Started Free — Instagram Auto DM";
export const GET_STARTED_DESCRIPTION =
  "Create your free open-autoDM account and set up your first Instagram comment-to-DM automation in minutes. No card needed.";

export interface FaqEntry {
  q: string;
  a: string;
}

/** Site-wide Organization entity (root layout). sameAs is omitted
 *  until the owner confirms the brand's real social handles — an
 *  empty/guessed profile list would be worse than none. */
export function organizationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    url: `${SITE_URL}/`,
    logo: `${SITE_URL}/logo.svg`,
    description: HOME_DESCRIPTION,
  };
}

export function websiteJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: `${SITE_URL}/`,
  };
}

/**
 * The product entity, reused on /, /auto-dm and /pricing so search
 * engines see ONE canonical SoftwareApplication. Offers are built
 * from the catalogue: the four self-serve plans carry their real
 * INR monthly price; Enterprise is custom-priced, so its Offer
 * carries no price figure (exactly like the pricing page itself).
 */
export function softwareApplicationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    url: `${SITE_URL}/`,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    description: HOME_DESCRIPTION,
    publisher: { "@type": "Organization", name: SITE_NAME, url: `${SITE_URL}/` },
    offers: PLANS.map((plan) => {
      const base = {
        "@type": "Offer",
        name: plan.name,
        category: "subscription",
      };
      if (plan.customPricing) {
        return {
          ...base,
          description:
            "Custom pricing for Business / Agency — sold by conversation, never by self-serve checkout.",
        };
      }
      return {
        ...base,
        price: plan.prices.INR.monthlyMinor / 100,
        priceCurrency: "INR",
      };
    }),
  };
}

/** FAQPage built from the SAME entries the page renders visibly —
 *  schema text must match visible text (the safe pattern). */
export function faqPageJsonLd(faqs: readonly FaqEntry[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

export function breadcrumbJsonLd(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: `${SITE_URL}${item.path}`,
    })),
  };
}
