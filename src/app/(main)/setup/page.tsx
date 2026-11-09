import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { createServerClient } from "@/lib/supabase";
import { isAdminEmail } from "@/lib/admin/panel";
import SetupWizard from "@/components/setup/SetupWizard";

// Per-request rendering, always: the gate reads the caller's live
// session (the same reason /admin is force-dynamic).
export const dynamic = "force-dynamic";

/**
 * Setup Wizard — server gate (owner directive, 2026-11-10).
 *
 * The wizard edits PLATFORM-level Meta config: one global app
 * configuration for the whole hosted service. Regular customers
 * must never see or reach it — it is not part of their setup,
 * which is: choose a plan, connect Instagram, automate.
 *
 * The gate mirrors /admin exactly: the session is resolved
 * server-side from the verified Supabase session (getUser —
 * never client state) and access requires the session email to
 * be listed in ADMIN_EMAILS. Anyone else gets notFound() — a
 * plain 404 that does not reveal the wizard exists. Anonymous
 * visitors never reach this wrapper: middleware redirects them
 * to /login first, as before. The wizard UI itself lives in
 * components/setup/SetupWizard (moved verbatim).
 */
async function readSessionEmail(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user?.email ?? null;
  } catch {
    return null;
  }
}

export default async function SetupPage() {
  const email = await readSessionEmail();
  if (!isAdminEmail(email, process.env)) notFound();

  return <SetupWizard />;
}
