-- ═══════════════════════════════════════════════════════════════════════════
-- open-autoDM - Meta data deletion requests
--
-- Durable record of every Meta data-deletion callback (POST
-- /api/meta/data-deletion). Meta requires the callback to initiate deletion
-- and return a public status URL + alphanumeric confirmation code; this
-- table is what the status endpoint/page reads.
--
-- meta_user_id is the app-scoped ID from the signed_request payload: for
-- Instagram Login that is the IG-scoped ID returned as `id` by the IG /me
-- endpoint at connect time - the same value stored in
-- instagram_accounts.instagram_user_id for connected accounts, and in the
-- audience columns (contacts.audience_ig_user_id etc.) for audience members.
--
-- Written and read ONLY by the service role (the callbacks are
-- unauthenticated by design; authenticity comes from the signed_request
-- HMAC). RLS is enabled with NO policies, exactly like job_queue.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.data_deletion_requests (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- App-scoped Meta/IG user ID from the verified signed_request.
  meta_user_id      TEXT        NOT NULL,

  -- Alphanumeric code returned to Meta and shown to the user; the sole
  -- lookup key for the public status endpoint (bearer knowledge by design).
  confirmation_code TEXT        NOT NULL UNIQUE,

  -- received → processing → completed | not_found | failed
  --   completed : matching data was found and deleted
  --   not_found : request processed, no data existed for this ID
  --   failed    : processing errored; safe to re-drive (deletion is idempotent)
  status            TEXT        NOT NULL DEFAULT 'received'
                    CHECK (status IN ('received', 'processing', 'completed', 'failed', 'not_found')),

  -- Set when the ID matched a connected account. SET NULL (never CASCADE):
  -- processing a request deletes that account row, and the deletion record
  -- itself must survive as the audit trail.
  account_id        UUID        REFERENCES public.instagram_accounts(id) ON DELETE SET NULL,
  operator_user_id  UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- Sanitised processing error (never contains secrets or tokens).
  error             TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX idx_data_deletion_requests_meta_user
  ON public.data_deletion_requests (meta_user_id, created_at DESC);

CREATE TRIGGER data_deletion_requests_updated_at
  BEFORE UPDATE ON public.data_deletion_requests
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Service-role only: no user policies.
ALTER TABLE public.data_deletion_requests ENABLE ROW LEVEL SECURITY;
