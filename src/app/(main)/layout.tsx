import { cookies } from "next/headers";
import { Sidebar, MobileSidebar } from "@/components/dashboard/Sidebar";
import { Topbar } from "@/components/dashboard/Topbar";
import { ScrollMorph } from "@/components/ui/ScrollMorph";
import { PageTransition } from "@/components/motion/primitives";
import { readWorkspaceFlags } from "@/lib/tenancy/workspaceFlags";
import { WorkspaceProvider } from "@/components/workspace/WorkspaceProvider";
import { createServerClient } from "@/lib/supabase";

/**
 * The signed-in user's email, read server-side for the shell's
 * account area (functional audit fix, 2026-11-08): getUser()
 * verifies the session with the Auth server — never a local token
 * decode. Any failure renders the shell without an email line
 * rather than failing the layout.
 */
async function readUserEmail(): Promise<string | null> {
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

export default async function MainLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    // Programme 18 / Phase G: the workspace flag is read server-side and
    // passed down as a prop. Flag OFF (default) ⇒ the provider is inert
    // and the sidebar renders exactly as before (no switcher, no nav
    // changes, no layout shift).
    const workspaceRuntimeEnabled = readWorkspaceFlags(process.env).workspaceRuntimeEnabled;
    const userEmail = await readUserEmail();
    return (
        <WorkspaceProvider workspaceRuntimeEnabled={workspaceRuntimeEnabled}>
        <div className="h-screen bg-background text-foreground flex overflow-hidden">

            {/* Desktop Sidebar (Collapsible) */}
            <Sidebar workspaceRuntimeEnabled={workspaceRuntimeEnabled} userEmail={userEmail} />

            {/* Mobile drawer (opened by the Topbar hamburger) */}
            <MobileSidebar workspaceRuntimeEnabled={workspaceRuntimeEnabled} userEmail={userEmail} />

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col overflow-hidden relative z-10">
                <Topbar />

                <ScrollMorph />
                <main className="flex-1 overflow-y-auto p-4 md:p-8 lg:p-10 scroll-smooth">
                    <PageTransition>{children}</PageTransition>
                </main>
            </div>
        </div>
        </WorkspaceProvider>
    );
}
