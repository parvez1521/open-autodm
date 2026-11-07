import { Sidebar, MobileSidebar } from "@/components/dashboard/Sidebar";
import { Topbar } from "@/components/dashboard/Topbar";
import { ScrollMorph } from "@/components/ui/ScrollMorph";
import { readWorkspaceFlags } from "@/lib/tenancy/workspaceFlags";
import { WorkspaceProvider } from "@/components/workspace/WorkspaceProvider";

export default function MainLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    // Programme 18 / Phase G: the workspace flag is read server-side and
    // passed down as a prop. Flag OFF (default) ⇒ the provider is inert
    // and the sidebar renders exactly as before (no switcher, no nav
    // changes, no layout shift).
    const workspaceRuntimeEnabled = readWorkspaceFlags(process.env).workspaceRuntimeEnabled;
    return (
        <WorkspaceProvider workspaceRuntimeEnabled={workspaceRuntimeEnabled}>
        <div className="h-screen bg-background text-foreground flex overflow-hidden">

            {/* Background Seamless Dotted Pattern */}
            <div
                className="fixed inset-0 z-0 opacity-[0.08] dark:opacity-20 pointer-events-none"
                style={{
                    backgroundImage: `radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)`,
                    backgroundSize: "32px 32px"
                }}
            />

            {/* Desktop Sidebar (Collapsible) */}
            <Sidebar workspaceRuntimeEnabled={workspaceRuntimeEnabled} />

            {/* Mobile drawer (opened by the Topbar hamburger) */}
            <MobileSidebar workspaceRuntimeEnabled={workspaceRuntimeEnabled} />

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col overflow-hidden relative z-10">
                <Topbar />

                <ScrollMorph />
                <main className="flex-1 overflow-y-auto p-4 md:p-8 lg:p-10 scroll-smooth">
                    {children}
                </main>
            </div>
        </div>
        </WorkspaceProvider>
    );
}
