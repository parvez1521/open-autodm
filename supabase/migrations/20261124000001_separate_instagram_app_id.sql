-- Separate Instagram app ID (2026-11-24).
--
-- Instagram Business Login and Facebook Login need DIFFERENT app IDs,
-- but the site stored a single meta_app_id used by both OAuth flows:
--   * Instagram (instagram.com/oauth/authorize +
--     api.instagram.com/oauth/access_token) requires the INSTAGRAM app ID
--     (the ID under the Meta app's Instagram product, "API setup with
--     Instagram login").
--   * Facebook Login for Business requires the META app ID (App settings
--     -> Basic).
-- On 2026-11-19 the stored value was changed from the Instagram app ID
-- (1121249884134177) to the Meta app ID (1586956306036999) to fix the
-- Facebook connect, which silently broke the Instagram connect:
-- Instagram rejects the Meta app ID with "Invalid platform app".
--
-- This migration adds meta_instagram_app_id to both settings tables and
-- backfills the live value into app_settings (the effective source today:
-- platform_config id=1 is incomplete, so getMetaSettings falls back to
-- app_settings). The column is added to platform_config too so the
-- getMetaSettings precedence keeps working if that row ever becomes the
-- authoritative source. No other table, policy, or trigger changes.
-- Additive only; safe to re-run.

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS meta_instagram_app_id TEXT;

ALTER TABLE public.platform_config
  ADD COLUMN IF NOT EXISTS meta_instagram_app_id TEXT;

UPDATE public.app_settings
  SET meta_instagram_app_id = '1121249884134177'
  WHERE id = 1 AND meta_instagram_app_id IS NULL;
