/**
 * SEO implementation (2026-11-10) — pins for the application plan in
 * workspace/opendm-persona-qa-2026-11-09/seo-research-2026-11-10.md
 * (priorities P0/P1/P2/P3 + the P4 internal links):
 *
 *  - robots.ts allows the public surface, disallows the app
 *    surface, welcomes AI crawlers and declares the sitemap.
 *  - sitemap.ts lists exactly the public indexable routes,
 *    including the new /auto-dm flagship.
 *  - Root layout carries metadataBase + the "%s | open-autoDM"
 *    title template + the home title/description as defaults, and
 *    renders Organization + WebSite JSON-LD.
 *  - The SoftwareApplication schema is built from the catalogue:
 *    real INR prices (0/299/500/799), Enterprise priceless, and NO
 *    aggregateRating / review — nothing fake.
 *  - /auto-dm exists with the plan's H1, its 8 FAQ questions, the
 *    FAQ/Breadcrumb/SoftwareApplication schemas and unlimited-DM /
 *    unlimited-automation facts.
 *  - Utility pages (login, forgot/reset) are noindex; the console
 *    and admin layouts are noindex.
 *  - The new surfaces carry none of the owner-banned terms
 *    (2026-11-10 directive: no self-host / open-source / GitHub).
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import {
  AUTO_DM_DESCRIPTION,
  AUTO_DM_TITLE,
  HOME_DESCRIPTION,
  HOME_TITLE,
  faqPageJsonLd,
  organizationJsonLd,
  softwareApplicationJsonLd,
  websiteJsonLd,
} from "@/lib/seo/schema";

const read = (rel: string) =>
  fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");

describe("SEO P0 — robots.txt", () => {
  const r = robots();
  const rules = Array.isArray(r.rules) ? r.rules : [r.rules];

  it("allows everything publicly and disallows the app surface", () => {
    const star = rules.find((x) => x.userAgent === "*");
    expect(star?.allow).toBe("/");
    const disallow = (star?.disallow as string[]) ?? [];
    for (const p of ["/dashboard", "/admin", "/api/", "/auth/", "/studio", "/billing"]) {
      expect(disallow, p).toContain(p);
    }
  });

  it("welcomes AI-search crawlers explicitly", () => {
    const ai = rules.find(
      (x) => Array.isArray(x.userAgent) && x.userAgent.includes("GPTBot"),
    );
    expect(ai?.allow).toBe("/");
  });

  it("declares the sitemap on the canonical host", () => {
    expect(r.sitemap).toBe("https://opendm.in/sitemap.xml");
  });
});

describe("SEO P0 — sitemap.xml", () => {
  const urls = sitemap().map((e) => e.url);

  it("lists the public routes with /auto-dm near the top", () => {
    expect(urls[0]).toBe("https://opendm.in/");
    expect(urls).toContain("https://opendm.in/auto-dm");
    expect(urls).toContain("https://opendm.in/pricing");
    expect(urls).toContain("https://opendm.in/get-started");
    expect(urls).toContain("https://opendm.in/terms");
    expect(urls).toContain("https://opendm.in/privacy-policy");
  });

  it("excludes console and auth routes", () => {
    for (const u of urls) {
      expect(u).not.toMatch(/dashboard|login|admin|billing|onboarding|setup/);
    }
  });
});

describe("SEO P1/P3 — metadata foundation and schema entities", () => {
  it("root layout has metadataBase, the title template and home defaults", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain("metadataBase");
    expect(layout).toContain('template: "%s | open-autoDM"');
    expect(layout).toContain("organizationJsonLd()");
    expect(layout).toContain("websiteJsonLd()");
    expect(layout).toContain('alternates: { canonical: "/" }');
  });

  it("plan templates are the exact research strings", () => {
    expect(HOME_TITLE).toBe(
      "Instagram Auto DM Tool — Comment-to-DM Automation | open-autoDM",
    );
    expect(HOME_DESCRIPTION).toContain("Instagram auto DM tool");
    expect(AUTO_DM_TITLE).toBe(
      "Auto DM for Instagram — Automatic DMs from Comments",
    );
    expect(AUTO_DM_DESCRIPTION).toContain("follow check");
  });

  it("Organization/WebSite entities carry no guessed socials", () => {
    const org = organizationJsonLd() as Record<string, unknown>;
    expect(org["@type"]).toBe("Organization");
    expect(org.url).toBe("https://opendm.in/");
    expect(org).not.toHaveProperty("sameAs");
    expect(websiteJsonLd()["@type"]).toBe("WebSite");
  });

  it("SoftwareApplication offers are the real catalogue prices, nothing fake", () => {
    const app = softwareApplicationJsonLd() as unknown as {
      offers: { name: string; price?: number; priceCurrency?: string }[];
    };
    const prices = app.offers
      .filter((o) => o.price !== undefined)
      .map((o) => o.price);
    expect(prices).toEqual([0, 299, 500, 799]);
    for (const o of app.offers) {
      if (o.price !== undefined) expect(o.priceCurrency).toBe("INR");
    }
    expect(app.offers.find((o) => o.name === "Enterprise")?.price).toBeUndefined();
    const raw = JSON.stringify(app);
    expect(raw).not.toContain("aggregateRating");
    expect(raw).not.toContain("review");
  });

  it("FAQPage schema is built from the given visible entries", () => {
    const faq = faqPageJsonLd([{ q: "Q?", a: "A." }]) as unknown as {
      mainEntity: { name: string; acceptedAnswer: { text: string } }[];
    };
    expect(faq.mainEntity[0]?.name).toBe("Q?");
    expect(faq.mainEntity[0]?.acceptedAnswer.text).toBe("A.");
  });
});

describe("SEO P2 — the /auto-dm flagship page", () => {
  const page = read("src/app/auto-dm/page.tsx");

  it("carries the plan H1, canonical and all three schemas", () => {
    expect(page).toContain("Auto DM for Instagram: automatic DMs from");
    expect(page).toContain('alternates: { canonical: "/auto-dm" }');
    expect(page).toContain("softwareApplicationJsonLd()");
    expect(page).toContain("faqPageJsonLd(AUTO_DM_FAQS)");
    expect(page).toContain("breadcrumbJsonLd(");
  });

  it("answers the plan's eight FAQ questions", () => {
    for (const q of [
      "What is an auto DM on Instagram?",
      "Is open-autoDM free?",
      "Are auto DMs safe for my Instagram account?",
      "Does it work on Reels and posts?",
      "Can I send different DMs for different keywords?",
      "How many Instagram accounts can I connect?",
      "Is there a limit on DMs?",
      "Do I need to give my Instagram password?",
    ]) {
      expect(page, q).toContain(q);
    }
  });

  it("states the unlimited facts and the plan table", () => {
    expect(page).toContain("Unlimited on every plan");
    expect(page).toContain("15-day free trial");
    expect(page).toContain("official Meta API");
  });
});

describe("SEO P0/P4 — noindex utility pages + internal links", () => {
  it("login and password pages are noindex", () => {
    for (const f of [
      "src/app/login/page.tsx",
      "src/app/forgot-password/page.tsx",
      "src/app/reset-password/page.tsx",
    ]) {
      expect(read(f), f).toContain("robots: { index: false }");
    }
  });

  it("console and admin layouts are noindex", () => {
    expect(read("src/app/(main)/layout.tsx")).toContain("index: false");
    expect(read("src/app/(admin)/layout.tsx")).toContain("index: false");
  });

  it("home nav + footer and the SaaS shell link to /auto-dm", () => {
    const home = read("src/app/page.tsx");
    expect(home).toContain('href: "/auto-dm"');
    expect(home).toContain('href="/auto-dm"');
    expect(home).toContain("softwareApplicationJsonLd()");
    expect(home).toContain("faqPageJsonLd(FAQS)");
    expect(read("src/app/(saas)/layout.tsx")).toContain('href="/auto-dm"');
  });

  it("public pages set their template titles and canonicals", () => {
    expect(read("src/app/(saas)/pricing/page.tsx")).toContain("PRICING_TITLE");
    expect(read("src/app/(saas)/pricing/page.tsx")).toContain(
      'alternates: { canonical: "/pricing" }',
    );
    expect(read("src/app/(saas)/get-started/page.tsx")).toContain(
      "GET_STARTED_TITLE",
    );
    expect(read("src/app/terms/page.tsx")).toContain("title: 'Terms of Service'");
    expect(read("src/app/privacy-policy/page.tsx")).toContain(
      "title: 'Privacy Policy'",
    );
    expect(read("src/app/data-deletion/page.tsx")).toContain(
      "title: 'Data Deletion Instructions'",
    );
  });

  it("the OG image route exists at the brand size", () => {
    const og = read("src/app/opengraph-image.tsx");
    expect(og).toContain("width: 1200");
    expect(og).toContain("height: 630");
    expect(og).toContain("ImageResponse");
  });
});

describe("SEO surfaces honour the 2026-11-10 banned-terms directive", () => {
  const BANNED = [/self[- ]host/i, /open[- ]source/i, /github/i, /MIT licen[cs]e/i];
  for (const f of [
    "src/app/auto-dm/page.tsx",
    "src/lib/seo/schema.ts",
    "src/app/robots.ts",
    "src/app/sitemap.ts",
    "src/app/opengraph-image.tsx",
  ]) {
    it(`${f} carries none of the banned terms`, () => {
      const src = read(f);
      for (const pattern of BANNED) expect(pattern.test(src), f).toBe(false);
    });
  }
});
