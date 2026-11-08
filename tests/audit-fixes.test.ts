/**
 * Functional-audit fixes (2026-11-08) — source pins.
 *
 * The owner-caught audit (~/workspace/opendm-audit-2026-11-08/
 * functional-audit.md §2/§4) found the account/session basics
 * missing: no sign-out in the shell, no password recovery or change,
 * no 404/error UI, no signed-in identity anywhere, auth_callback
 * errors swallowed, plus a set of half-wired controls. These pins
 * keep the fixes from regressing. Style matches the codebase's
 * other source-pin suites (home-design-pass, p18-workspace-ui).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const readSrc = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');
const srcExists = (rel: string): boolean =>
  existsSync(path.resolve(process.cwd(), 'src', rel));

const sidebarSrc = readSrc('components/dashboard/Sidebar.tsx');
const switcherSrc = readSrc('components/dashboard/AccountSwitcher.tsx');
const sessionFooterSrc = readSrc('components/dashboard/SessionFooter.tsx');
const layoutSrc = readSrc('app/(main)/layout.tsx');
const loginFormSrc = readSrc('components/auth/LoginForm.tsx');
const callbackSrc = readSrc('app/auth/callback/route.ts');

describe('audit fix 1 — sign-out lives in the shell', () => {
  it('the session footer signs out and is mounted in BOTH sidebars', () => {
    expect(sessionFooterSrc).toContain('supabase.auth.signOut()');
    expect(sessionFooterSrc).toContain('Sign out');
    const mounts = sidebarSrc.split('<SessionFooter').length - 1;
    expect(mounts).toBe(2);
  });

  it('the account menu (switcher popover) carries identity + sign-out too', () => {
    expect(switcherSrc).toContain('Signed in as');
    expect(switcherSrc).toContain('supabase.auth.signOut()');
    expect(switcherSrc).toContain('userEmail');
  });

  it('the layout reads the email server-side and passes it to both sidebars', () => {
    expect(layoutSrc).toContain('supabase.auth.getUser()');
    const passes = layoutSrc.split('userEmail={userEmail}').length - 1;
    expect(passes).toBe(2);
  });
});

describe('audit fix 2 — password recovery + change exist', () => {
  it('the forgot flow requests a reset email aimed at /reset-password', () => {
    const src = readSrc('components/auth/ForgotPasswordForm.tsx');
    expect(src).toContain('resetPasswordForEmail');
    expect(src).toContain('/reset-password');
    expect(loginFormSrc).toContain('Forgot password?');
    expect(loginFormSrc).toContain('ForgotPasswordForm');
  });

  it('the reset page completes the flow via updateUser', () => {
    expect(srcExists('app/reset-password/page.tsx')).toBe(true);
    const src = readSrc('components/auth/ResetPasswordForm.tsx');
    expect(src).toContain('exchangeCodeForSession');
    expect(src).toContain('updateUser');
  });

  it('settings carries a change-password form', () => {
    const settings = readSrc('app/(main)/settings/page.tsx');
    expect(settings).toContain('ChangePasswordForm');
    expect(readSrc('components/auth/ChangePasswordForm.tsx')).toContain('updateUser');
  });
});

describe('audit fix 3 — branded 404 / error UI exists', () => {
  it('not-found, error and global-error are all present', () => {
    expect(srcExists('app/not-found.tsx')).toBe(true);
    expect(srcExists('app/error.tsx')).toBe(true);
    expect(srcExists('app/global-error.tsx')).toBe(true);
    expect(readSrc('app/not-found.tsx')).toContain("doesn&apos;t exist");
    expect(readSrc('app/global-error.tsx')).toContain('<html lang="en">');
  });
});

describe('audit fix 5 — auth_error is surfaced, never swallowed', () => {
  it('the callback forwards failures to /login (not the landing page)', () => {
    expect(callbackSrc).toContain('/login?auth_error=');
    expect(callbackSrc).not.toContain('`/?auth_error=');
    expect(callbackSrc).not.toContain('`/?auth_error');
  });

  it('the login form reads auth_error and maps it to human copy', () => {
    expect(loginFormSrc).toContain('auth_error');
    expect(loginFormSrc).toContain('humanAuthError');
  });
});

describe('audit fix 6 — support + legal links inside the app shell', () => {
  it('the session footer carries the support mailto and legal links', () => {
    expect(sessionFooterSrc).toContain('SUPPORT_EMAIL = "work.techhacksai@gmail.com"');
    expect(sessionFooterSrc).toContain('mailto:${SUPPORT_EMAIL}');
    expect(sessionFooterSrc).toContain('/privacy-policy');
    expect(sessionFooterSrc).toContain('/terms');
  });
});

describe('audit fixes 7–14 — the half-wired controls', () => {
  it('dashboard renders skeletons instead of 0 / Not connected flashes', () => {
    const src = readSrc('app/(main)/dashboard/page.tsx');
    expect(src).toContain('statsLoading');
    expect(src).toContain('systemLoading');
    expect(src).toContain('animate-pulse');
  });

  it('the Script Writer CTA carries the keyword into Automations', () => {
    const sw = readSrc('app/(main)/script-writer/page.tsx');
    expect(sw).toContain('/automations?keyword=${encodeURIComponent(script.ctaKeyword)}');
    const automations = readSrc('app/(main)/automations/page.tsx');
    expect(automations).toContain('searchParams.get("keyword")');
    expect(automations).toContain('initialKeyword={initialKeyword}');
    const modal = readSrc('components/automations/new-flow/NewAutomationModal.tsx');
    expect(modal).toContain('initialKeyword');
    expect(modal).toContain('fd.keywords = [carried]');
  });

  it('the automations toggle works both ways', () => {
    const list = readSrc('components/automations/AutomationsList.tsx');
    expect(list).toContain('onClick={() => onToggle(automation.id, isActive)}');
    expect(list).not.toContain('Open edit to activate');
    expect(list).not.toContain('disabled={!isActive}');
  });

  it('the sidebar no longer links to the generic GitHub root', () => {
    expect(sidebarSrc).not.toContain('https://github.com');
    expect(sidebarSrc).not.toContain('GithubLogo');
  });

  it('the contacts counter renders its space explicitly', () => {
    const contacts = readSrc('components/automations/ContactsList.tsx');
    expect(contacts).toContain('`${filtered.length} contact${filtered.length !== 1 ? "s" : ""}`');
  });

  it('the tool is "Script Writer" everywhere in the shell (no "Viral" mismatch)', () => {
    expect(readSrc('components/dashboard/Topbar.tsx')).toContain('"/script-writer": "Script Writer"');
    expect(readSrc('components/dashboard/Topbar.tsx')).not.toContain('Viral Script Writer');
    expect(readSrc('app/(main)/script-writer/page.tsx')).not.toContain('Viral Script Writer');
    expect(readSrc('app/(main)/dashboard/page.tsx')).not.toContain('Viral Script Writer');
  });

  it('the setup wizard no longer references a nonexistent debug panel', () => {
    const setup = readSrc('app/(main)/setup/page.tsx');
    expect(setup).not.toContain('debug panel shows');
    expect(setup).toContain('signature mismatch');
  });

  it('Instagram avatars fall back to an initials tile on image error', () => {
    const avatar = readSrc('components/dashboard/IgAvatar.tsx');
    expect(avatar).toContain('onError');
    expect(switcherSrc).toContain('IgAvatar');
    expect(readSrc('app/(main)/settings/page.tsx')).toContain('IgAvatar');
  });
});
