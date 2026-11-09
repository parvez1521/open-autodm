/**
 * Owner directive, 2026-11-10 — two standing rules pinned here.
 *
 * A1. NO user-visible surface may carry the old self-hosting /
 *     source-code framing, and GitHub must not appear on the
 *     website at all (the product is presented purely as the
 *     hosted service at opendm.in). The scan reads the rendered
 *     marketing / legal / auth / console sources and fails if the
 *     banned terms reappear in them. Out of scope by design:
 *     comments inside server-only modules and the never-imported
 *     GithubLogo export in components/phosphor.tsx — nothing there
 *     reaches a user. (This file itself necessarily names the
 *     banned terms; it is a test, not a surface.)
 *
 * A2. Active automations are UNLIMITED on every plan (catalogue
 *     limit null, like auto DMs since 2026-11-09), and the display
 *     surfaces render the words "Unlimited automations".
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PLANS } from "@/lib/billing/catalogue";

const read = (rel: string) =>
  fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");

const BANNED: { pattern: RegExp; label: string }[] = [
  { pattern: /self[- ]host/i, label: "self-host*" },
  { pattern: /open[- ]source/i, label: "open-source / open source" },
  { pattern: /github/i, label: "GitHub" },
  { pattern: /MIT licen[cs]e/i, label: "MIT licence/license" },
];

const USER_VISIBLE_FILES = [
  "src/app/page.tsx",
  "src/app/layout.tsx",
  "src/components/home/FaqSection.tsx",
  "src/components/home/DemoShowcase.tsx",
  "src/components/legal/LegalLayout.tsx",
  "src/components/pricing/PricingClient.tsx",
  "src/components/billing/BillingPanel.tsx",
  "src/app/login/page.tsx",
  "src/app/reset-password/page.tsx",
  "src/app/privacy-policy/page.tsx",
  "src/app/terms/page.tsx",
  "src/app/data-deletion/page.tsx",
  "src/app/(saas)/get-started/page.tsx",
  "src/components/auth/LoginForm.tsx",
  "src/app/(main)/settings/page.tsx",
  "src/app/(main)/settings/workspace/page.tsx",
  "src/app/(main)/studio/page.tsx",
  "src/app/(main)/studio/ideas/page.tsx",
  "src/app/(main)/studio/script/page.tsx",
  "src/app/(main)/studio/presentations/page.tsx",
  "src/lib/tenancy/journey.ts",
];

describe("owner directive 2026-11-10 — A1: no self-hosted / open-source / GitHub terms user-visible", () => {
  for (const file of USER_VISIBLE_FILES) {
    it(`${file} carries none of the banned terms`, () => {
      const src = read(file);
      for (const { pattern, label } of BANNED) {
        expect(pattern.test(src), `${file} must not contain ${label}`).toBe(false);
      }
    });
  }

  it("the landing page has no GitHub link left (header or footer)", () => {
    const page = read("src/app/page.tsx");
    expect(page).not.toContain("github.com");
    expect(page).not.toContain(">GitHub<");
  });
});

describe("owner directive 2026-11-10 — A2: automations unlimited", () => {
  it("every plan in the catalogue has activeAutomations null (unlimited)", () => {
    for (const plan of PLANS) {
      expect(plan.limits.activeAutomations, plan.id).toBeNull();
    }
  });

  it("the other limits are untouched: IG accounts 1/3/5, seats and workspaces still capped numbers", () => {
    const byId = new Map(PLANS.map((p) => [p.id, p]));
    expect(byId.get("free")!.limits.instagramAccounts).toBe(1);
    expect(byId.get("starter")!.limits.instagramAccounts).toBe(1);
    expect(byId.get("creator-pro")!.limits.instagramAccounts).toBe(3);
    expect(byId.get("agency")!.limits.instagramAccounts).toBe(5);
    for (const plan of PLANS) {
      expect(typeof plan.limits.teamSeats).toBe("number");
      expect(typeof plan.limits.workspaces).toBe("number");
    }
  });

  it("all three display surfaces render the words 'Unlimited automations'", () => {
    expect(read("src/app/page.tsx")).toContain("Unlimited automations");
    expect(read("src/components/pricing/PricingClient.tsx")).toContain("Unlimited automations");
    expect(read("src/components/billing/BillingPanel.tsx")).toContain("Unlimited automations");
  });

  it("no display surface renders the raw limit unbranched (would print 'null active automations')", () => {
    // The pre-2026-11-10 lines interpolated the numeric limit
    // directly; with the limit now null they must branch on it.
    expect(read("src/app/page.tsx")).not.toContain(
      "<span>{plan.limits.activeAutomations} active automations</span>",
    );
    expect(read("src/components/billing/BillingPanel.tsx")).not.toContain(
      "activeAutomations} active automations ·",
    );
    expect(read("src/components/pricing/PricingClient.tsx")).not.toContain(
      "orCustom(p, String(p.limits.activeAutomations))",
    );
  });
});
