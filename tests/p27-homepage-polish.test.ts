/**
 * Programme 27 (B) — homepage & key-surface polish.
 *
 * Pins, at source level (the copy's convention for UI wiring — these
 * are SOURCE PINS, not browser tests), the defects fixed and the
 * functional animation added in P27 (B):
 *
 *   B-1  The landing footer now links the legal routes that exist
 *        (/privacy-policy, /terms, /data-deletion) — they were
 *        unreachable from the landing page before.
 *   B-2  Exactly one <h1> on the landing page (the hero headline);
 *        the LoginForm card heading is an <h2>.
 *   B-3  LoginForm labels are programmatically associated
 *        (htmlFor/id pairs).
 *   B-4  The LoginForm error is announced (role="alert").
 *   B-5  PipelineShowcase has a persistent Pause/Play control and
 *        auto-advance is gated on it; clicking a step to inspect
 *        also pauses (previously hover was the only suspension —
 *        unavailable to touch/keyboard users).
 *   B-A2 The Script Writer sample is the interactive
 *        ScriptSampleShowcase: same sample content, in-view paced
 *        playback, click-to-jump with pause, reduced-motion static,
 *        segmented pacing rail.
 *   B-A3 SUPERSEDED 2026-11-07 by the owner's design ban (no hover
 *        animations): the pin asserted the landing page carries
 *        NO hover/focus transform micro-interaction at all.
 *        REWRITTEN 2026-11-08 (~17:59 IST) on the owner's explicit
 *        instruction: he ordered motion.dev-style animation across
 *        the whole site, which supersedes the no-hover-transform
 *        rule for MOTION-SYSTEM springs (whileHover/whileTap from
 *        the shared presets). The pin's assertions are unchanged —
 *        CSS-class hover/focus transforms (group-hover:translate,
 *        transition-transform and friends) remain banned; hover
 *        feedback may only arrive as a motion spring, never as a
 *        utility-class transform.
 *
 * No claim, statistic, testimonial, or logo was added anywhere: a pin
 * below asserts the sample copy moved verbatim into the component.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');
const pageSrc = read('src/app/page.tsx');
const loginSrc = read('src/components/auth/LoginForm.tsx');
const pipelineSrc = read('src/components/home/PipelineShowcase.tsx');

describe('B-1 — landing footer reaches the legal routes', () => {
  it('links Privacy Policy, Terms, and Data Deletion', () => {
    expect(pageSrc).toContain('href="/privacy-policy"');
    expect(pageSrc).toContain('href="/terms"');
    expect(pageSrc).toContain('href="/data-deletion"');
  });

  it('the linked routes exist as pages', () => {
    for (const rel of ['src/app/privacy-policy/page.tsx', 'src/app/terms/page.tsx', 'src/app/data-deletion/page.tsx']) {
      expect(existsSync(path.join(process.cwd(), rel)), rel).toBe(true);
    }
  });

  it('every in-page anchor used on the landing page resolves to an element id', () => {
    // Owner redesign (2026-11-07): the login form no longer lives on the
    // landing page — sign-in is the dedicated /login route, and the
    // landing carries platform/automation/creator-studio anchors instead.
    for (const anchor of ['id="platform"', 'id="automation"', 'id="how"', 'id="script-writer"', 'id="creator-studio"']) {
      expect(pageSrc).toContain(anchor);
    }
    expect(pageSrc).toContain('href="/login"');
    // The header nav carries its anchors in a data array (rendered
    // dynamically), same convention as the FEATURES cards below.
    expect(pageSrc).toContain('href: "#how"');
    // The Script Writer feature card carries its anchor in the
    // FEATURES data (rendered as href={f.href}).
    expect(pageSrc).toContain('href: "#script-writer"');
    expect(pageSrc).toContain('href={f.href}');
  });
});

describe('B-2/B-3/B-4 — LoginForm semantics', () => {
  it('the landing page has exactly one h1 (the hero); LoginForm contributes none', () => {
    // Round 5 (2026-11-08): the hero h1 is a motion.h1 (owner-ordered
    // entrance choreography) — still exactly one h1 element.
    const h1Count =
      (pageSrc.split('<h1').length - 1) + (pageSrc.split('<motion.h1').length - 1);
    expect(h1Count).toBe(1);
    expect(loginSrc).not.toContain('<h1');
    expect(loginSrc).toContain('<h2');
    expect(loginSrc).toContain('Welcome back');
  });

  it('labels are associated with their inputs', () => {
    expect(loginSrc).toContain('htmlFor="login-email"');
    expect(loginSrc).toContain('id="login-email"');
    expect(loginSrc).toContain('htmlFor="login-password"');
    expect(loginSrc).toContain('id="login-password"');
  });

  it('the sign-in error is announced to assistive technology', () => {
    expect(loginSrc).toContain('role="alert"');
  });
});

describe('B-5 — PipelineShowcase pause control', () => {
  it('auto-advance is gated on an explicit user pause state', () => {
    expect(pipelineSrc).toContain('const [userPaused, setUserPaused] = useState(false)');
    expect(pipelineSrc).toContain('!userPaused');
  });

  it('a labelled Pause/Play toggle exists and is hidden only when nothing auto-plays (reduced motion)', () => {
    expect(pipelineSrc).toContain('aria-pressed={userPaused}');
    expect(pipelineSrc).toContain('Pause the pipeline animation');
    expect(pipelineSrc).toContain('Play the pipeline animation');
    expect(pipelineSrc).toContain('{!reduced && (');
  });

  it('clicking a step to inspect it also pauses the loop', () => {
    expect(pipelineSrc).toContain('setStep(i);');
    expect(pipelineSrc).toContain('setUserPaused(true);');
  });
});

describe('B-A2 — ScriptSampleShowcase (functional pacing demo)', () => {
  const samplePath = 'src/components/home/ScriptSampleShowcase.tsx';

  it('exists, is used by the landing page, and the static sample markup is gone from page.tsx', () => {
    expect(existsSync(path.join(process.cwd(), samplePath))).toBe(true);
    expect(pageSrc).toContain('<ScriptSampleShowcase />');
    expect(pageSrc).not.toContain('SAMPLE_SECTIONS');
  });

  it('carries the same sample content verbatim (no invented copy)', () => {
    const src = read(samplePath);
    expect(src).toContain('3 free AI websites — student edition');
    expect(src).toContain('Paid tools pe paise waste karna band karo');
    expect(src).toContain('Teeno ke links chahiye to comment me LINK likho, DM me bhej dunga.');
    expect(src).toContain('Example output');
  });

  it('auto-plays only in view, pauses on hover and on demand, and honours reduced motion', () => {
    const src = read(samplePath);
    expect(src).toContain('IntersectionObserver');
    expect(src).toContain('prefers-reduced-motion: reduce');
    // Programme 28 (2026-11-07): the playing gate now also includes
    // !focusWithin (focus pause, below) — the P27 string without it
    // is superseded.
    expect(src).toContain('const playing = inView && !hovering && !focusWithin && !reduced && !userPaused;');
    expect(src).toContain('aria-pressed={userPaused}');
    expect(src).toContain('setUserPaused(true);');
  });

  // Programme 28 (2026-11-07) — ScriptSampleShowcase follow-through:
  // focus-within pause and state-driven progress.
  it('pauses while keyboard focus is within the card (focus-within via bubbling focus/blur)', () => {
    const src = read(samplePath);
    expect(src).toContain('const [focusWithin, setFocusWithin] = useState(false)');
    expect(src).toContain('onFocus={() => setFocusWithin(true)}');
    expect(src).toContain('onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false); }}');
    expect(src).toContain('!focusWithin');
  });

  it('drives beats and rail from one state-driven rAF clock that holds its fraction on pause', () => {
    const src = read(samplePath);
    expect(src).toContain('const [progress, setProgress] = useState(0)');
    expect(src).toContain('const progressRef = useRef(0)');
    expect(src).toContain('const start = performance.now() - progressRef.current * hold;');
    expect(src).toContain('requestAnimationFrame(tick)');
    expect(src).toContain('cancelAnimationFrame(raf)');
    expect(src).toContain('progressRef.current = f;');
    expect(src).toContain('setProgress(f);');
    // Advancing and beat-click both reset the held fraction.
    expect(src).toContain('progressRef.current = 0;');
    expect(src).toContain('setProgress(0);');
    // The rail is a plain span whose scaleX is the progress state —
    // no transition to retarget on pause.
    expect(src).toContain('style={{ transform: `scaleX(${i < active ? 1 : reduced ? 1 : progress})` }}');
  });

  it('no longer uses the old setTimeout timer or the framer-motion rail retarget', () => {
    const src = read(samplePath);
    expect(src).not.toContain('setTimeout');
    expect(src).not.toContain('motion.span');
    expect(src).not.toContain('0.25');
    expect(src).not.toContain('framer-motion');
  });

  it('each beat is a real button that jumps to it (aria-current on the active beat)', () => {
    const src = read(samplePath);
    expect(src).toContain('aria-current={isActive ? "true" : undefined}');
    expect(src).toContain('setActive(i);');
  });
});

describe('B-A3 — rewritten 2026-11-08 on the owner instruction: hover feedback only via motion springs, never CSS-class transforms', () => {
  it('the landing page carries no CSS-class hover/focus transform micro-interaction', () => {
    // History: the P27 arrow micro-interaction was removed in 2026-11-07
    // when the owner's design ban prohibited hover animations outright.
    // The owner's 2026-11-08 ~17:59 IST instruction (motion.dev-style
    // animation across the whole site) supersedes that ban ONLY for
    // springs from the shared motion system (whileHover / whileTap in
    // src/lib/motion/presets.ts) — those are asserted present by the
    // round-7 pins in home-design-pass.test.ts. Utility-class transform
    // hovers stay banned, so these assertions stand as they were.
    expect(pageSrc).not.toContain('group-hover:translate');
    expect(pageSrc).not.toContain('group-focus-visible:translate');
    expect(pageSrc).not.toContain('transition-transform');
  });
});
