import { readWorkspaceFlags } from "@/lib/tenancy/workspaceFlags";
import { WorkspaceMembers } from "@/components/workspace/WorkspaceMembers";

/**
 * Programme 18 / Phase G — workspace settings / members page.
 *
 * Server-gated: the flag is read HERE, server-side, and passed down as
 * a prop (no client-side env var is invented). While
 * WORKSPACE_RUNTIME_ENABLED is off (the default) the page renders an
 * inert state and no workspace UI or data exists.
 */
export default function WorkspaceSettingsPage() {
    const workspaceRuntimeEnabled = readWorkspaceFlags(process.env).workspaceRuntimeEnabled;

    if (!workspaceRuntimeEnabled) {
        return (
            <div
                className="w-full max-w-3xl mx-auto rounded-xl border border-border bg-card p-6 space-y-3"
                data-testid="workspace-runtime-disabled"
            >
                <h1 className="font-heading text-xl font-semibold">Workspaces are not enabled</h1>
                <p className="text-sm text-muted-foreground">
                    Workspace runtime is gated by WORKSPACE_RUNTIME_ENABLED, which is off by
                    default. This instance keeps its single-owner behaviour.
                </p>
            </div>
        );
    }

    return <WorkspaceMembers workspaceRuntimeEnabled={workspaceRuntimeEnabled} />;
}
