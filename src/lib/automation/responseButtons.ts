/**
 * Link buttons on text responses (2026-11-22).
 *
 * A text response carries its link buttons as `buttons` (max 2, each
 * { id, title, link }). The older single-button fields buttonTitle /
 * buttonLink are still the first button: automations saved before this
 * keep working unchanged, and the editor keeps the legacy fields synced
 * to buttons[0] so every legacy reader still sees button 1.
 *
 * Platform limit, verified in code (not assumed): both senders accept
 * an array — sendInstagramLinkButtonDm (src/lib/instagram/api.ts) and
 * sendFacebookLinkButtonMessage (src/lib/facebook/api.ts) build a
 * button template with up to 3 web_url buttons. Two buttons fit.
 * A two-button send failure goes through the same throwFromMetaResponse
 * path as the one-button send (Meta's own message + code, classified:
 * 190/10/100/200 non-retryable, 4/17/32/613 rate-limit, 368
 * account-pause), with the raw status + provider response in the
 * server log — no new error path was needed.
 */

export const MAX_TEXT_LINK_BUTTONS = 2;

export interface TextLinkButtonInput {
  buttonTitle?: string;
  buttonLink?: string;
  buttons?: { id: string; title: string; link: string }[];
}

export interface TextLinkButton {
  title: string;
  link: string;
}

/**
 * Resolve the link buttons a text response actually sends, in order.
 * Prefers `buttons` (max 2, empty links dropped); falls back to the
 * legacy buttonTitle/buttonLink when no usable `buttons` entry exists,
 * so old single-button automations resolve to exactly one button.
 */
export function getTextLinkButtons(
  response: TextLinkButtonInput | null | undefined,
): TextLinkButton[] {
  if (!response) return [];
  if (response.buttons?.length) {
    const fromButtons = response.buttons
      .filter((b) => b.link?.trim())
      .slice(0, MAX_TEXT_LINK_BUTTONS)
      .map((b) => ({ title: b.title?.trim() || 'Open link', link: b.link.trim() }));
    if (fromButtons.length > 0) return fromButtons;
  }
  const link = response.buttonLink?.trim();
  if (!link) return [];
  return [{ title: response.buttonTitle?.trim() || 'Open link', link }];
}

/**
 * Inline-text form of the buttons, used when Meta rejects the button
 * template and the caller falls back to a plain DM.
 */
export function formatInlineLinkButtons(buttons: TextLinkButton[]): string {
  return buttons.map((b) => `${b.title}: ${b.link}`).join('\n');
}
