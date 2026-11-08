/**
 * Design pass (2026-11-07) — landing-page interactive additions.
 *
 * The owner asked for a more professional, interactive landing page.
 * Two components were added, both additive (no pinned copy moved):
 *  - DemoShowcase: a user-driven comment-to-DM simulation with three
 *    keyword scenarios, staged on timers, reduced-motion safe.
 *  - FaqSection: an accessible accordion whose answers stay
 *    product-truthful (free self-hosting, own Meta app, three
 *    permissions, shipped sending caps, hosted plan in preparation).
 * These pins keep the additions wired into the page and honest.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(process.cwd(), "src");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

describe("design pass — DemoShowcase", () => {
  const src = read("components/home/DemoShowcase.tsx");

  it("exists, is used by the landing page, and the page anchors it at #demo", () => {
    const page = read("app/page.tsx");
    expect(page).toContain("DemoShowcase");
    expect(page).toContain('id="demo"');
    expect(page).toContain('href: "#demo"');
  });

  it("carries the three keyword scenarios with product-truthful DM copy", () => {
    for (const kw of ["PRICE", "LINK", "DEMO"]) expect(src).toContain(kw);
    expect(src).toContain("Sent you the");
    expect(src).toContain("24-hour window");
  });

  it("is staged on timers, auto-runs once in view, and honours reduced motion", () => {
    expect(src).toContain("IntersectionObserver");
    expect(src).toContain("prefers-reduced-motion");
    expect(src).toContain("setTimeout");
  });
});

describe("design pass — FaqSection", () => {
  const src = read("components/home/FaqSection.tsx");

  it("exists, is used by the landing page, and the page anchors it at #faq", () => {
    const page = read("app/page.tsx");
    expect(page).toContain("FaqSection");
    expect(page).toContain('id="faq"');
    expect(page).toContain('href: "#faq"');
  });

  it("is an accessible accordion (real buttons, aria-expanded)", () => {
    expect(src).toContain("aria-expanded");
    expect(src).toContain('type="button"');
  });

  it("answers stay product-truthful: free self-host, own Meta app, three permissions, shipped caps", () => {
    expect(src).toContain("MIT licence");
    expect(src).toContain("exactly three Instagram permissions");
    expect(src).toContain("180 DMs per hour");
    expect(src).toContain("in preparation");
  });
});

describe("design pass round 2 — login split panel + mobile hero", () => {
  it("the login page carries the ink fact panel beside the unchanged form column", () => {
    const login = read("app/login/page.tsx");
    expect(login).toContain("bg-foreground");
    expect(login).toContain("Every comment answered. Every DM on time.");
    expect(login).toContain("180 DMs/hour, 24-hour window");
    expect(login).toContain("<LoginForm signupOpen={signupEnabled} />");
  });

  it("the landing hero has a mobile-only three-row loop visual (desktop keeps the NodeEditor)", () => {
    const page = read("app/page.tsx");
    expect(page).toContain("lg:hidden");
    expect(page).toContain("A visitor comments your keyword");
    expect(page).toContain("The DM lands in their inbox");
  });
});

describe("design pass round 3 — FlowBuilder, CountUp, hero loop chip", () => {
  const builder = read("components/home/FlowBuilder.tsx");

  it("the builder is wired into the landing at #builder with all three controls", () => {
    const page = read("app/page.tsx");
    expect(page).toContain("FlowBuilder");
    expect(page).toContain('id="builder"');
    expect(builder).toContain("Trigger keyword");
    expect(builder).toContain("Public reply style");
    expect(builder).toContain("What the DM carries");
    expect(builder).toContain('role="switch"');
  });

  it("the builder's texts stay template-true (three styles, three payloads, caps line)", () => {
    for (const label of ["Friendly", "Short", "Hinglish", "Send a link", "Send pricing", "Book a demo"]) {
      expect(builder).toContain(label);
    }
    expect(builder).toContain("180 DMs/hour, 24-hour window");
  });

  it("the safety figures animate via CountUp and stay the shipped caps", () => {
    const page = read("app/page.tsx");
    const counter = read("components/home/CountUp.tsx");
    expect(page).toContain("CountUp");
    expect(page).toContain("count: 180");
    expect(page).toContain('suffix: "h"');
    expect(counter).toContain("prefers-reduced-motion");
    expect(counter).toContain("IntersectionObserver");
  });

  it("the hero carries the cycling loop chip, reduced-motion aware", () => {
    const page = read("app/page.tsx");
    expect(page).toContain("HeroLoopChip");
    expect(page).toContain("comment 'PRICE'");
    expect(page).toContain("prefers-reduced-motion");
  });
});

/**
 * Design pass round 4 (2026-11-08) — owner-requested premium pass.
 *
 * The owner (overnight instruction, 2026-11-08) said the site felt
 * like "AI slop" and asked for: a proper marketing homepage feel,
 * SOME continuous animation, real generated images where necessary,
 * and an improved pricing presentation. Within the standing design
 * law (no hover transforms — the B-A3 pin above still guards the
 * page), this round added:
 *  - KeywordTicker: a pure-CSS marquee of real automation moments
 *    (the demo keywords + the shipped safety facts), reduced-motion
 *    static. Continuous motion the owner explicitly asked for.
 *  - Two generated editorial photographs (hero portrait, studio
 *    desk) + one generated ink texture band — ink/orange palette,
 *    no text baked in, real files under public/images.
 *  - The landing pricing teaser became the full plan band (all
 *    catalogue plans, INR monthly figures, "in preparation"
 *    honesty) and the pricing page gained a monthly/annual toggle
 *    + a limit-by-limit comparison table.
 * Round 5 (same day) superseded the pricing half of this round:
 * the owner approved the prices, so DRAFT labelling is gone —
 * see the round-5 describe at the end of this file.
 */
describe("design pass round 4 — KeywordTicker, images, pricing band", () => {
  const page = read("app/page.tsx");
  const ticker = read("components/home/KeywordTicker.tsx");
  const css = read("app/globals.css");

  it("the ticker is wired under the hero and carries the real loop moments", () => {
    expect(page).toContain("KeywordTicker");
    for (const kw of ["PRICE", "LINK", "DEMO"]) expect(ticker).toContain(kw);
    expect(ticker).toContain("24-hour window");
    expect(ticker).toContain("180 / hour");
    expect(ticker).toContain("HMAC-SHA-256 verified");
  });

  it("the ticker motion is pure CSS, seamless (two copies), and reduced-motion safe", () => {
    expect(css).toContain("@keyframes ticker-scroll");
    expect(css).toContain(".ticker-track");
    expect(css).toContain("prefers-reduced-motion");
    expect(ticker).toContain("aria-hidden");
    expect(ticker).not.toContain("setTimeout");
    expect(ticker).not.toContain("setInterval");
  });

  it("the landing places the three generated images with honest alt text", () => {
    // Images ship as data URIs from lib/landing-images (the
    // connector push flow is text-only; masters live in
    // public/images/ locally — see that module's header).
    expect(page).toContain("landing-images");
    expect(page).toContain("HERO_CREATOR_IMG");
    expect(page).toContain("STUDIO_DESK_IMG");
    expect(page).toContain("INK_TEXTURE_IMG");
    expect(page).toContain("A creator recording a short video");
    expect(page).toContain("A creator's desk with a laptop");
    const mod = read("lib/landing-images.ts");
    expect(mod).toContain("data:image/jpeg;base64");
    for (const img of ["hero-creator.jpg", "studio-desk.jpg", "ink-texture.jpg"]) {
      expect(fs.existsSync(path.join(process.cwd(), "public/images", img)), img).toBe(true);
    }
  });

  it("the landing pricing band shows every plan and stays honest", () => {
    expect(page).toContain("PLANS");
    // Round 5: prices are owner-approved — no DRAFT labelling; the
    // honesty line is now "checkout is being switched on".
    expect(page).not.toContain("DRAFT");
    expect(page).toContain("checkout is being switched on");
    expect(page).toContain("nothing can");
  });

  it("the before/after chapter is present and labelled illustrative", () => {
    expect(page).toContain("The same launch evening, twice");
    expect(page).toContain("One illustrative evening");
    expect(page).toContain("Links actually delivered");
    expect(page).toContain("On autopilot");
  });

  it("the pricing page renders the toggle and the comparison table from the catalogue", () => {
    // Single-file on purpose (see the page header): the render
    // harness cannot parse a statically imported JSX subcomponent,
    // so the toggle + table live in the pricing page itself.
    const pricing = read("app/(saas)/pricing/page.tsx");
    expect(pricing).toContain('aria-pressed');
    expect(pricing).toContain("Compare every limit");
    expect(pricing).toContain("data-testid");
    expect(pricing).toContain("plan-");
    for (const dim of ["Instagram accounts", "Active automations", "DMs / month", "Data retention", "Support", "Free trial", "Creator Studio"]) {
      expect(pricing).toContain(dim);
    }
    // Round 5: approved labelling replaced the DRAFT chip text.
    expect(pricing).not.toContain("DRAFT, unapproved");
    expect(pricing).toContain("OWNER-APPROVED");
  });
});

/**
 * Design pass round 5 (2026-11-08) — owner-approved pricing +
 * motion-graphics pass.
 *
 * Two owner decisions land here:
 *  1. PRICING (2026-11-08, final): ₹299/mo = 1 account, ₹500/mo = 3,
 *     ₹799/mo = 5, Enterprise custom — positioned "For Business /
 *     Agency" with a Contact Us action instead of any price figure;
 *     Free stays with its limits; Creator Studio is included on
 *     every plan; paid plans start with a 15-day free trial.
 *     Prices are approved (DRAFT labels removed) but checkout is
 *     genuinely not live yet, and the copy says so.
 *  2. MOTION (2026-11-08): the owner said the landing's motion was
 *     too weak ("maza nahi aaraha") and ordered a proper
 *     motion-graphics feel. This round adds hero entrance
 *     choreography, a scroll-motion kit (Reveal / RevealRule /
 *     Parallax), a packet travelling the pipeline rail, and staged
 *     framer-motion entrances in the demo — ambient/sequence motion
 *     only; the B-A3 ban on hover/focus transforms in p27 still
 *     stands untouched, and reduced motion collapses everything.
 *     (Superseded in part by round 7 below: the library is now the
 *     `motion` package and B-A3 was rewritten by the owner's
 *     2026-11-08 ~17:59 IST instruction.)
 */
describe("design pass round 5 — motion kit, hero choreography, pipeline packet", () => {
  const page = read("app/page.tsx");
  const reveal = read("components/home/Reveal.tsx");
  const pipeline = read("components/home/PipelineShowcase.tsx");
  const demo = read("components/home/DemoShowcase.tsx");

  it("the scroll-motion kit exists, is reduced-motion safe, and is wired into the page", () => {
    expect(reveal).toContain("useReducedMotion");
    expect(reveal).toContain("whileInView");
    expect(reveal).toContain("useScroll");
    for (const name of ["Reveal", "RevealRule", "Parallax"]) {
      expect(reveal).toContain(name);
      expect(page).toContain(name);
    }
  });

  it("the hero arrives as a staggered sequence under a reduced-motion-aware MotionConfig", () => {
    expect(page).toContain('reducedMotion="user"');
    expect(page).toContain("heroContainer");
    expect(page).toContain("heroItem");
    expect(page).toContain("staggerChildren");
    expect(page).toContain("motion.h1");
    // Exactly one h1, copy unchanged.
    expect(page.match(/<motion\.h1/g)).toHaveLength(1);
    expect(page).toContain("Turn comments into customers on autopilot");
  });

  it("a packet travels the pipeline rail while the loop plays", () => {
    expect(pipeline).toContain("STEP_MS.reduce");
    expect(pipeline).toContain("repeat: Infinity");
    expect(pipeline).toContain("aria-hidden");
  });

  it("the demo stages its entrances with the motion package and a progress thread", () => {
    // Motion pass (owner instruction 2026-11-08 ~17:59 IST): the
    // site migrated from framer-motion to motion.dev's `motion`
    // package — the pin now checks the new import source; the
    // staged-entrance behaviour it guards is unchanged.
    expect(demo).toContain("motion/react");
    expect(demo).toContain("AnimatePresence");
    expect(demo).toContain("stage / 4");
    // The round-1 pins still hold: timers, in-view auto-run, truth.
    expect(demo).toContain("prefers-reduced-motion");
    expect(demo).toContain("24-hour window");
  });

  it("the before/after panels slide in from opposite sides", () => {
    expect(page).toContain("x: -36");
    expect(page).toContain("x: 36");
  });
});

describe("design pass round 5 — approved pricing on the landing band", () => {
  const page = read("app/page.tsx");
  const pricing = read("app/(saas)/pricing/page.tsx");

  it("the band offers the trial and Studio inclusion from the catalogue", () => {
    expect(page).toContain("TRIAL_DAYS");
    expect(page).toContain("free trial — no card");
    expect(page).toContain("Creator Studio included");
    expect(page).not.toContain("DRAFT");
  });

  it("Enterprise carries Contact Us and the Business/Agency framing — never a price", () => {
    for (const src of [page, pricing]) {
      expect(src).toContain("For Business / Agency");
      expect(src).toContain("Contact us");
      expect(src).toContain("customPricing");
    }
    expect(page).toContain("CONTACT_HREF");
    expect(pricing).toContain("Custom pricing");
    expect(pricing).toContain("mailto:work.techhacksai@gmail.com");
  });

  it("the pricing page states the trial and keeps checkout honesty", () => {
    expect(pricing).toContain("TRIAL_DAYS");
    expect(pricing).toContain("no card needed");
    expect(pricing).toContain("Checkout is being switched on");
    expect(pricing).toContain("CATALOGUE_STATUS");
  });
});

/**
 * Design pass round 7 — the site-wide motion system (owner
 * instruction 2026-11-08 ~17:59 IST).
 *
 * The owner said he was very dissatisfied with the site's UI and
 * motion and ordered motion.dev-style animation across the WHOLE
 * site with overall design improvement. This round:
 *  - migrated every animation from framer-motion to the `motion`
 *    package ("motion/react") and built ONE shared system:
 *    src/lib/motion/presets.ts (springs/eases/variants) +
 *    src/components/motion/primitives.tsx (ScrollProgress,
 *    PageTransition, FadeIn, Stagger/StaggerItem);
 *  - mounted MotionConfig reducedMotion="user" in the root
 *    providers so every surface honours the preference;
 *  - gave both app shells route-content PageTransitions and the
 *    window-scrolled surfaces a sprung scroll-progress hairline;
 *  - made /pricing and the billing panel share a segmented period
 *    toggle (shared layoutId indicator) with price-figure flips
 *    and layout-animated plan boxes;
 *  - added press springs on primary CTAs, hover lift on plan
 *    boxes, and arrow nudges on index rows (superseding the old
 *    no-hover-transform rule — see the rewritten B-A3 pin in
 *    p27-homepage-polish.test.ts);
 *  - animated the FAQ with real height animation and unified the
 *    app lists' stagger easing on the shared preset.
 * Everything else — ban list, copy, prices — is untouched.
 */
describe("design pass round 7 — shared motion system (motion package)", () => {
  const presets = read("lib/motion/presets.ts");
  const primitives = read("components/motion/primitives.tsx");
  const page = read("app/page.tsx");
  const pricing = read("app/(saas)/pricing/page.tsx");
  const providers = read("components/providers/Providers.tsx");

  it("the site depends on the motion package, not framer-motion", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));
    expect(pkg.dependencies.motion).toBeTruthy();
    expect(pkg.dependencies["framer-motion"]).toBeUndefined();
    expect(page).toContain('from "motion/react"');
    expect(page).not.toContain("framer-motion");
  });

  it("one shared system: presets carry the springs/eases, primitives the components", () => {
    for (const name of ["EASE_OUT", "SPRING_SOFT", "SPRING_SNAPPY", "SPRING_PRESS", "staggerParent", "pageVariants"]) {
      expect(presets).toContain(name);
    }
    for (const name of ["ScrollProgress", "PageTransition", "FadeIn", "Stagger", "StaggerItem"]) {
      expect(primitives).toContain(name);
    }
    expect(primitives).toContain("useScroll");
    expect(primitives).toContain("useReducedMotion");
  });

  it("reduced motion is honoured globally from the root providers", () => {
    expect(providers).toContain("MotionConfig");
    expect(providers).toContain('reducedMotion="user"');
  });

  it("the landing gained the scroll-progress hairline and press/lift micro-interactions", () => {
    expect(page).toContain("ScrollProgress");
    expect(page).toContain("whileTap");
    expect(page).toContain("whileHover");
    expect(page).toContain("SPRING_PRESS");
  });

  it("pricing's period toggle is a shared-indicator segmented control with price flips", () => {
    expect(pricing).toContain('layoutId="billing-period-pill"');
    expect(pricing).toContain("AnimatePresence");
    expect(pricing).toContain("staggerParent");
    // The catalogue figures and honesty lines did not move.
    expect(pricing).toContain("Checkout is being switched on");
    expect(pricing).toContain("OWNER-APPROVED");
  });

  it("both shells transition route content; the (saas) shell shows scroll progress", () => {
    const main = read("app/(main)/layout.tsx");
    const saas = read("app/(saas)/layout.tsx");
    expect(main).toContain("PageTransition");
    expect(saas).toContain("PageTransition");
    expect(saas).toContain("ScrollProgress");
  });
});

/**
 * Pricing columns redo (2026-11-08, owner screenshot reference
 * ~18:36 IST — a classic ThemeGrill-style pricing table).
 *
 * Two earlier attempts missed what the owner meant by
 * "vertical": round 6 put each plan in its own outlined box but
 * split the box into side-by-side columns inside, and the
 * 18:18 fix (f7a25c3) stacked the boxes full-width one below
 * another. The owner's screenshot settled it: plans are TALL
 * VERTICAL COLUMNS standing SIDE BY SIDE — inside each column
 * the content flows top-to-bottom (name → price → CTA → limits
 * and features going down the column), and the Growth column
 * is highlighted as the best-value pick with a flat brand
 * banner and a stronger outline. The toggle (shared layoutId
 * pill), stagger and price flips from round 7 are unchanged;
 * figures and copy did not move.
 */
describe("pricing columns — tall vertical columns side by side", () => {
  const page = read("app/page.tsx");
  const pricing = read("app/(saas)/pricing/page.tsx");

  it("/pricing lays the five plans out as side-by-side columns, not stacked bands", () => {
    expect(pricing).toContain("grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5");
    expect(pricing).not.toContain("space-y-5");
    expect(pricing).toContain("flex h-full flex-col");
    expect(pricing).toContain("border border-border");
  });

  it("Growth is the highlighted column — flat Best value banner, stronger brand outline", () => {
    for (const src of [page, pricing]) {
      expect(src).toContain('plan.id === "creator-pro"');
      expect(src).toContain("Best value");
      expect(src).toContain("border-primary");
    }
  });

  it("the landing band uses the same side-by-side column grid", () => {
    expect(page).toContain("grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5");
    expect(page).not.toContain("mt-10 space-y-4");
  });
});
