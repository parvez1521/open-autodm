-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 13 (productization COPY ONLY) — workspace_settings (per-workspace
-- half of the app_settings split, Phase 11 §B.5), platform_config +
-- platform_admins (service-only), usage_counters.
--
-- *** COPY-ONLY PRODUCTIZATION ARTIFACT — NOT part of the frozen
-- candidate's approved production apply-list (000021 required;
-- 000002/000003 conditional; 000022/000023 candidate-only). ***
--
-- The existing public.app_settings table and ALL its consumers are
-- deliberately NOT altered by this file.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── workspace_settings ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workspace_settings (
  workspace_id                  UUID        PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  timezone                      TEXT,
  ai_drafting_enabled           BOOLEAN     NOT NULL DEFAULT true,
  script_writer_enabled         BOOLEAN     NOT NULL DEFAULT true,
  default_public_reply_enabled  BOOLEAN,
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER workspace_settings_updated_at BEFORE UPDATE ON public.workspace_settings
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.workspace_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.workspace_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.workspace_settings TO authenticated;
GRANT ALL ON TABLE public.workspace_settings TO service_role;

DROP POLICY IF EXISTS ws_settings_select_member ON public.workspace_settings;
CREATE POLICY ws_settings_select_member ON public.workspace_settings
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
DROP POLICY IF EXISTS ws_settings_insert_owner_admin ON public.workspace_settings;
CREATE POLICY ws_settings_insert_owner_admin ON public.workspace_settings
  FOR INSERT TO authenticated WITH CHECK (public.workspace_role(workspace_id) = ANY (ARRAY['owner','admin']::public.workspace_role[]));
DROP POLICY IF EXISTS ws_settings_update_owner_admin ON public.workspace_settings;
CREATE POLICY ws_settings_update_owner_admin ON public.workspace_settings
  FOR UPDATE TO authenticated
  USING (public.workspace_role(workspace_id) = ANY (ARRAY['owner','admin']::public.workspace_role[]))
  WITH CHECK (public.workspace_role(workspace_id) = ANY (ARRAY['owner','admin']::public.workspace_role[]));
-- No authenticated DELETE policy: the row dies by workspace cascade only.

-- ── platform_config (service-only; successor posture of app_settings) ─────
CREATE TABLE IF NOT EXISTS public.platform_config (
  id                           INTEGER     PRIMARY KEY CHECK (id = 1),
  meta_app_id                  TEXT,
  meta_app_secret_encrypted    TEXT,
  meta_fb_app_secret_encrypted TEXT,
  secret_key_version           INTEGER     NOT NULL DEFAULT 1,
  webhook_verify_token         TEXT,
  setup_completed              BOOLEAN     NOT NULL DEFAULT false,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER platform_config_updated_at BEFORE UPDATE ON public.platform_config
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
ALTER TABLE public.platform_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_config FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.platform_config TO service_role;
-- Deliberately NO policies for anon/authenticated: platform-only.
INSERT INTO public.platform_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── platform_admins (service-only; grants NO tenant access by itself) ─────
CREATE TABLE IF NOT EXISTS public.platform_admins (
  user_id    UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_by UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_admins FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.platform_admins TO service_role;

-- ── usage_counters (readable by members; writable ONLY by service role) ───
CREATE TABLE IF NOT EXISTS public.usage_counters (
  workspace_id               UUID  NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  period_start               DATE  NOT NULL,
  dms_sent                   BIGINT NOT NULL DEFAULT 0,
  contacts_active            BIGINT NOT NULL DEFAULT 0,
  ai_drafting_generations    BIGINT NOT NULL DEFAULT 0,
  script_writer_generations  BIGINT NOT NULL DEFAULT 0,
  follow_ups_sent            BIGINT NOT NULL DEFAULT 0,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, period_start)
);
CREATE TRIGGER usage_counters_updated_at BEFORE UPDATE ON public.usage_counters
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
ALTER TABLE public.usage_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.usage_counters FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.usage_counters TO authenticated;
GRANT ALL ON TABLE public.usage_counters TO service_role;
DROP POLICY IF EXISTS usage_select_member ON public.usage_counters;
CREATE POLICY usage_select_member ON public.usage_counters
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
-- No authenticated INSERT/UPDATE/DELETE policies: counters are written
-- only by service-role server code (Phase 11 §B.4.7).
