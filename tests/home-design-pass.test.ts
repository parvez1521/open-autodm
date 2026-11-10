/**
 * Design pass (2026-11-07) — landing-page interactive additions.
 *
 * The owner asked for a more professional, interactive landing page.
 * Two components were added, both additive (no pinned copy moved):
 *  - DemoShowcase: a user-driven comment-to-DM simulation with three
 *    keyword scenarios, staged on timers, reduced-motion safe.
 *  - FaqSection: an accessible accordion whose answers stay
 *    product-truthful (Free plan needs no card, own Meta app, three
 *    permissions, shipped sending caps). Updated 2026-11-10 by
 *    owner directive: the FAQ's self-hosting / MIT / "in
 *    preparation" answers were reworded to hosted-service framing —
 *    no self-hosted / open-source framing anywhere user-visible.
 * These pins keep the additions wired into the page and honest.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { currencyForCountry, currencyForTimezone, formatPriceMinor } from "@/lib/billing/geo";

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

  // Updated 2026-11-10 (owner directive): the old pins asserted the
  // self-hosting answers ("MIT licence", "in preparation"). The FAQ
  // now answers in hosted-service framing — Free plan / trial facts,
  // tokens encrypted at rest — and must carry NO self-hosted /
  // open-source / MIT wording.
  it("answers stay product-truthful: Free plan, own Meta app, three permissions, shipped caps — hosted framing (owner, 2026-11-10)", () => {
    expect(src).toContain("Free plan costs nothing");
    expect(src).toContain("15-day free trial");
    expect(src).toContain("AES-256-GCM");
    expect(src).toContain("exactly three Instagram permissions");
    expect(src).toContain("180 DMs per hour");
    expect(src).not.toContain("MIT");
    expect(src).not.toMatch(/self[- ]host/i);
    expect(src).not.toMatch(/open[- ]source/i);
    expect(src).not.toContain("in preparation");
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
    // INK_TEXTURE_IMG's pin inverted 2026-11-10 (owner directive
    // ~02:19 IST): the decorative ink band between the FAQ and the
    // final CTA was removed, so the page must not reference it.
    expect(page).not.toContain("INK_TEXTURE_IMG");
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
    // 2026-11-09 (Open Caption style adopt): "twice" is wrapped in
    // <em> for the serif accent — markup only, the words are
    // unchanged, so the pin follows the markup.
    expect(page).toContain("The same launch evening, <em>twice</em>");
    expect(page).toContain("One illustrative evening");
    expect(page).toContain("Links actually delivered");
    expect(page).toContain("On autopilot");
  });

  it("the pricing page renders the comparison table from the catalogue (toggle removed 2026-11-08 ~19:38 IST)", () => {
    // Single-file on purpose (see the component header): the
    // render harness cannot parse a statically imported JSX
    // subcomponent, so the table lives in the pricing client
    // component itself (the route file is only a server wrapper
    // since the 2026-11-08 checkout-gate fix).
    // Owner instruction, 2026-11-08 ~19:38 IST: pricing is
    // MONTHLY ONLY — the monthly/annual toggle this test used to
    // pin (aria-pressed) was removed entirely, so the pin now
    // asserts its absence alongside the surviving table pins.
    const pricing = read("components/pricing/PricingClient.tsx");
    expect(pricing).not.toContain('aria-pressed');
    expect(pricing).not.toContain("billing-period-pill");
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
  const css = read("app/globals.css");
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

  it("the hero arrives as a staggered word sequence under a reduced-motion-aware MotionConfig", () => {
    expect(page).toContain('reducedMotion="user"');
    // Open Caption animation concepts (owner directive 2026-11-09):
    // the hero entrance moved from motion variants to the
    // reference's pure-CSS [data-hero] system — headline words rise
    // masked one by one, the serif accent word runs the gradient
    // text sweep, the primary CTA carries the conic pill, and the
    // brand intro holds the sequence until its sheet lifts.
    expect(page).toContain('data-hero="word"');
    expect(page).toContain('data-hero="word2"');
    expect(page).toContain("gradient-text-sweep");
    expect(page).toContain("conic-glow-pill");
    expect(page).toContain("BrandIntro");
    expect(css).toContain("@keyframes hero-up");
    expect(css).toContain('html[data-intro="play"]:not(.ce-out) [data-hero]');
    // Exactly one h1, copy unchanged (the words now sit in
    // per-word mask spans, so they are pinned word by word).
    expect(page.match(/<h1/g)).toHaveLength(1);
    for (const w of ["Turn", "comments", "into", "customers", "on", "autopilot"]) {
      expect(page).toContain(`>${w}<`);
    }
  });

  it("the brand intro plays a workflow animation, not the wave bars (owner directive 2026-11-10)", () => {
    // Owner directive 2026-11-10 ~02:19 IST: the intro's three-bar
    // wave read as "music lines" ("wo nahi chahiye tha") — the
    // sheet runs a workflow animation like Open Caption's instead.
    // BrandWave itself survives as the console page loader; only
    // its intro use is gone.
    //
    // Shape changed again 2026-11-10 ~02:44 IST (owner feedback):
    // the compact centered card read as too basic ("sirf beech me
    // chota sa box hai") — the workflow is now a wide horizontal
    // strip: three separate panels (Comment → AutoDM → DM) that
    // enter one by one LEFT → RIGHT with dashed connectors that
    // light up between them; on small screens the strip stacks
    // top→bottom in the same order.
    const intro = read("components/home/BrandIntro.tsx");
    const flow = read("components/home/IntroWorkflow.tsx");
    const gate = read("components/home/intro.ts");
    expect(intro).toContain("IntroWorkflow");
    expect(intro).not.toContain("BrandWave");
    for (const piece of [
      "intro-flow-panel-1",
      "intro-flow-panel-2",
      "intro-flow-panel-3",
      "intro-flow-link-1",
      "intro-flow-link-2",
      "max-w-[64rem]",
      "LINK",
      "AutoDM",
      "check your inbox",
      "Direct message",
      "Send me the link",
      "Delivered automatically",
    ]) {
      expect(flow).toContain(piece);
    }
    // The stacked single card is gone — no beat classes remain.
    expect(flow).not.toContain("intro-flow-beat");
    expect(css).not.toContain("intro-flow-beat");
    // Panels slide in one by one from the left (from above when
    // stacked) and the connectors draw between them.
    for (const kf of [
      "@keyframes intro-panel-in-x",
      "@keyframes intro-panel-in-y",
      "@keyframes intro-draw-x",
      "@keyframes intro-draw-y",
      "@keyframes intro-head-in",
      "@keyframes intro-chip-pop",
    ]) {
      expect(css).toContain(kf);
    }
    expect(css).toContain(".intro-flow-panel-3");
    expect(css).toContain(".intro-flow-link-2 .intro-flow-fill-h");
    // The gate gives the strip its ~2s before forcing the exit
    // (last panel lands ~1.95s).
    expect(gate).toContain("},2100)");
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
    // Offsets reduced 2026-11-09 (motion fail-visible fix, item P):
    // the panels still arrive from opposite sides, but from ±14px
    // and near-visible opacity instead of ±36px from opacity 0, so
    // the section is readable even before the entrance completes.
    expect(page).toContain("x: -14");
    expect(page).toContain("x: 14");
  });
});

describe("design pass round 5 — approved pricing on the landing band", () => {
  const page = read("app/page.tsx");
  const pricing = read("components/pricing/PricingClient.tsx");

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
    // UPDATED 2026-11-09 (persona-QA fix 6, owner-approved): the
    // pricing client no longer renders (or imports) the internal
    // CATALOGUE_STATUS attribution line; the constant itself stays
    // in the catalogue as data.
    expect(pricing).not.toContain("CATALOGUE_STATUS");
    // Checkout honesty (rewritten 2026-11-08, launch fix): the
    // "being switched on" sentence used to be static copy and went
    // stale the moment checkout was wired and the flags flipped
    // on. It still exists in the client — but renders ONLY while
    // checkout is closed; the server wrapper page computes
    // checkoutLive from the same billing state the checkout route
    // enforces (flags + configured provider).
    expect(pricing).toContain("Checkout is being switched on");
    expect(pricing).toContain("checkoutLive");
    const pricingPage = read("app/(saas)/pricing/page.tsx");
    expect(pricingPage).toContain("readBillingFlags");
    expect(pricingPage).toContain("resolveActiveBillingProvider");
    expect(pricingPage).toContain("checkoutLive");
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
 *    and layout-animated plan boxes (SUPERSEDED the same evening:
 *    the owner's ~19:38 IST instruction removed the toggle and
 *    all annual rendering — pricing is monthly-only now; see the
 *    "de-clutter + geo currency" describe at the end of this file);
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
  const pricing = read("components/pricing/PricingClient.tsx");
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

  it("pricing is monthly-only and geo-currency since 2026-11-08 ~19:38 IST (toggle pin superseded)", () => {
    // Was: "pricing's period toggle is a shared-indicator segmented
    // control with price flips" (round 7). The owner then ordered
    // the toggle removed ENTIRELY and prices shown in ONE geo
    // currency — the pin now guards that end state instead.
    expect(pricing).not.toContain('layoutId="billing-period-pill"');
    expect(pricing).not.toContain("Annual");
    expect(pricing).toContain("useDisplayCurrency");
    expect(pricing).toContain("staggerParent");
    // The catalogue figures did not move. The honesty line is no
    // longer static (2026-11-08 launch fix): it renders only while
    // the server-side checkout gate is closed — see the round-5
    // describe's rewritten pin for the wrapper assertions.
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
 * banner and a stronger outline. Figures and copy did not move.
 * (The round-7 toggle/stagger/price-flip language this redo
 * originally kept was itself superseded at ~19:38 IST the same
 * day: toggle and annual rendering removed, columns de-cluttered
 * to short key facts — see the final describe in this file.)
 */
describe("pricing columns — tall vertical columns side by side", () => {
  const page = read("app/page.tsx");
  const pricing = read("components/pricing/PricingClient.tsx");

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

/**
 * De-clutter + geo currency + monthly-only pass (owner
 * instruction, 2026-11-08 ~19:38 IST).
 *
 * The owner found the new pricing columns CLUTTERED and ordered:
 *  1. ONE currency per visitor, by country — India sees ₹ only,
 *     everyone else sees $ only; the two never render together.
 *  2. MONTHLY ONLY — the monthly/annual toggle removed entirely
 *     (it was added by round 7 the same day; this supersedes it),
 *     and no annual price renders anywhere.
 *  3. Free = unlimited auto DMs + Creator Studio (limited);
 *     paid plans keep the full Studio (pinned in
 *     billing-catalogue.test.ts). (The DM figure was 1,000/mo
 *     under the original instruction; the owner removed all DM
 *     caps on 2026-11-09.)
 *  4. Columns de-cluttered: name → price → CTA → a short
 *     key-facts list; the dense capability-notes lists no longer
 *     render in the columns.
 * Geo plumbing: the middleware stamps a `geo-currency` cookie
 * from the Vercel edge country header; client surfaces resolve
 * cookie → timezone → INR default via useDisplayCurrency, so the
 * SSR/first paint is always INR (single currency) and corrects
 * on mount for non-India visitors.
 */
describe("de-clutter + geo currency + monthly-only (owner, 2026-11-08 ~19:38 IST)", () => {
  const page = read("app/page.tsx");
  const pricing = read("components/pricing/PricingClient.tsx");
  const panel = read("components/billing/BillingPanel.tsx");
  const middleware = read("middleware.ts");

  it("the middleware stamps the geo-currency cookie from the edge country header", () => {
    expect(middleware).toContain("x-vercel-ip-country");
    expect(middleware).toContain("GEO_CURRENCY_COOKIE");
    expect(middleware).toContain("currencyForCountry");
  });

  it("country and timezone resolution follow the owner's one-currency rule", () => {
    expect(currencyForCountry("IN")).toBe("INR");
    expect(currencyForCountry("in")).toBe("INR");
    expect(currencyForCountry("US")).toBe("USD");
    expect(currencyForCountry("GB")).toBe("USD");
    expect(currencyForCountry(null)).toBe("USD");
    expect(currencyForTimezone("Asia/Kolkata")).toBe("INR");
    expect(currencyForTimezone("Asia/Calcutta")).toBe("INR");
    expect(currencyForTimezone("America/New_York")).toBe("USD");
    expect(formatPriceMinor(29900, "INR")).toBe("₹299");
    expect(formatPriceMinor(900, "USD")).toBe("$9");
    expect(formatPriceMinor(0, "USD")).toBe("$0");
    expect(formatPriceMinor(0, "INR")).toBe("₹0");
  });

  it("every price surface resolves the single geo currency — ₹ and $ never render together", () => {
    for (const src of [page, pricing, panel]) {
      expect(src).toContain("useDisplayCurrency");
      expect(src).toContain("formatPriceMinor");
    }
    // The old dual-currency price line ("₹299 / mo · $5 / mo") is gone.
    expect(pricing).not.toContain("/ mo ·");
    expect(pricing).not.toContain('prices.INR');
    expect(pricing).not.toContain('prices.USD');
  });

  it("no surface renders an annual price or a period toggle anymore", () => {
    for (const src of [page, pricing, panel]) {
      expect(src).not.toContain("Annual");
      expect(src).not.toContain("annualMonthlyMinor");
      expect(src).not.toContain("annualTotalMinor");
    }
    expect(pricing).not.toContain("billing-period-pill");
    expect(panel).not.toContain("billing-panel-period-pill");
    expect(pricing).not.toContain('aria-pressed');
  });

  it("the columns are de-cluttered: short key facts, no capability-notes dump", () => {
    expect(pricing).toContain("keyFacts");
    expect(pricing).not.toContain("capabilityNotes");
    expect(pricing).toContain("auto DMs / month");
    // Free's Studio is limited on every surface; paid stays full.
    for (const src of [page, pricing, panel]) {
      expect(src).toContain("Creator Studio (limited)");
    }
  });
});
