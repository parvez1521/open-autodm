"use client";

/**
 * Programme 18 / Phase G — workspace settings / members page body.
 *
 * Server-gated by its page wrapper (settings/workspace/page.tsx reads
 * the flag server-side and passes `workspaceRuntimeEnabled` down; when
 * off, the wrapper renders an inert state and this component is never
 * mounted).
 *
 * Role presentation follows the Phase B contract:
 *   - member list: readable by every member, viewers included;
 *   - invite / role-change / remove controls: owner/admin only
 *     (canManageMembers) — hidden entirely for member/viewer, AND the
 *     API still denies them server-side (403);
 *   - viewer (and plain member): a read-only presentation with NO
 *     write controls (data-testid="workspace-members-readonly").
 *
 * Denied state: when a workspace-scoped call returns 403/404 (the
 * workspace layer's not-a-member posture), the page shows the
 * "you no longer have access" state and asks the provider to drop
 * that workspace from the switcher.
 *
 * Programme 34 (UX-1 + UX-2): the member list renders an explicit
 * "Email not stored" affordance when a membership has no email
 * (the standing posture — memberships store no email and it is
 * never derived from user metadata — so a bare user ID is no
 * longer presented as the member's identity); the accessibility
 * pass added live-region announcements for notice/error/loading,
 * accessible names for the placeholder-only inputs and the
 * per-member Remove buttons, deliberate focus-visible rings, and
 * fixed the invite button's label contrast (see the audit in
 * `saas/PHASE_34_STUDIO_RESIDUAL_HARDENING_AND_UX.md` §4).
 */

import { useCallback, useEffect, useState } from "react";
import { CircleNotch } from "@/components/phosphor";
import { ApiError } from "@/lib/api/client";
import { useWorkspace } from "./WorkspaceProvider";

interface MemberRow {
    userId: string | null;
    email: string | null;
    role: string | null;
    joined_at: string | null;
}

interface InviteResult {
    token: string;
    acceptLink: string;
    email: string;
    role: string;
}

/** "9 Nov 2026" style; an unparseable/missing value renders "—". */
function formatJoinedDate(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
        ? "—"
        : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

const ROLE_OPTIONS = ["owner", "admin", "member", "viewer"] as const;
const INVITE_ROLE_OPTIONS = ["admin", "member", "viewer"] as const;

export function WorkspaceMembers({ workspaceRuntimeEnabled }: { workspaceRuntimeEnabled: boolean }) {
    const {
        selectedWorkspace,
        selectedWorkspaceId,
        canManageMembers,
        workspaceFetch,
        dropWorkspace,
        refreshWorkspaces,
        droppedWorkspaceId,
    } = useWorkspace();

    const [members, setMembers] = useState<MemberRow[]>([]);
    const [loadingMembers, setLoadingMembers] = useState(false);
    const [denied, setDenied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const [inviteEmail, setInviteEmail] = useState("");
    const [inviteRole, setInviteRole] = useState<string>("member");
    const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);
    const [inviting, setInviting] = useState(false);

    const [acceptToken, setAcceptToken] = useState("");
    const [accepting, setAccepting] = useState(false);

    const [newWorkspaceName, setNewWorkspaceName] = useState("");
    const [creating, setCreating] = useState(false);

    const loadMembers = useCallback(async () => {
        if (!selectedWorkspaceId) {
            setMembers([]);
            return;
        }
        setLoadingMembers(true);
        try {
            const data = await workspaceFetch<{ members: MemberRow[] }>(
                `/workspaces/${selectedWorkspaceId}/members`,
            );
            setMembers(data.members ?? []);
            setDenied(false);
        } catch (err) {
            if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
                setDenied(true);
                dropWorkspace(selectedWorkspaceId);
            } else {
                setError(err instanceof ApiError ? err.message : "Could not load members");
            }
        } finally {
            setLoadingMembers(false);
        }
    }, [selectedWorkspaceId, workspaceFetch, dropWorkspace]);

    useEffect(() => {
        void loadMembers();
    }, [loadMembers]);

    if (!workspaceRuntimeEnabled) return null;

    if (denied || droppedWorkspaceId) {
        return (
            <div
                className="w-full max-w-3xl mx-auto space-y-4 rounded-xl border border-border bg-card p-6"
                data-testid="workspace-no-access"
            >
                <h1 className="font-heading text-xl font-semibold">Workspace access lost</h1>
                <p className="text-sm text-muted-foreground">
                    You no longer have access to this workspace. Your membership may have been
                    removed or changed, the workspace has been removed from your switcher. Pick
                    another workspace, or ask a workspace owner/admin to invite you again.
                </p>
            </div>
        );
    }

    const handleInvite = async () => {
        if (!selectedWorkspaceId) return;
        setInviting(true);
        setError(null);
        try {
            const data = await workspaceFetch<InviteResult & { invitation: unknown }>(
                `/workspaces/${selectedWorkspaceId}/invitations`,
                {
                    method: "POST",
                    body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
                },
            );
            // The raw token is shown ONCE here — only its hash was stored.
            setInviteResult({
                token: data.token,
                acceptLink: data.acceptLink,
                email: inviteEmail,
                role: inviteRole,
            });
            setNotice("Invitation created. Copy the link now, it is shown only once and no email is sent.");
        } catch (err) {
            if (err instanceof ApiError && err.status === 403) {
                setError("Permission denied: only workspace owners and admins can invite members.");
            } else {
                setError(err instanceof ApiError ? err.message : "Could not create the invitation");
            }
        } finally {
            setInviting(false);
        }
    };

    const handleRoleChange = async (userId: string, role: string) => {
        if (!selectedWorkspaceId) return;
        setError(null);
        try {
            await workspaceFetch(`/workspaces/${selectedWorkspaceId}/members/${userId}`, {
                method: "PATCH",
                body: JSON.stringify({ role }),
            });
            setNotice("Member role updated.");
            await loadMembers();
        } catch (err) {
            setError(
                err instanceof ApiError && err.status === 403
                    ? "Permission denied: only workspace owners and admins can change roles."
                    : err instanceof ApiError
                      ? err.message
                      : "Could not change the role",
            );
        }
    };

    const handleRemove = async (userId: string) => {
        if (!selectedWorkspaceId) return;
        setError(null);
        try {
            await workspaceFetch(`/workspaces/${selectedWorkspaceId}/members/${userId}`, {
                method: "DELETE",
            });
            setNotice("Member removed.");
            await loadMembers();
        } catch (err) {
            setError(err instanceof ApiError ? err.message : "Could not remove the member");
        }
    };

    const handleAccept = async () => {
        setAccepting(true);
        setError(null);
        try {
            await workspaceFetch("/workspaces/accept", {
                method: "POST",
                body: JSON.stringify({ token: acceptToken.trim() }),
            });
            setNotice("Invitation accepted. The workspace now appears in your switcher.");
            setAcceptToken("");
            await refreshWorkspaces();
        } catch (err) {
            setError(
                err instanceof ApiError
                    ? err.message
                    : "Could not accept the invitation (it may be expired, already used, or addressed to a different email).",
            );
        } finally {
            setAccepting(false);
        }
    };

    const handleCreate = async () => {
        setCreating(true);
        setError(null);
        try {
            await workspaceFetch("/workspaces", {
                method: "POST",
                body: JSON.stringify({ name: newWorkspaceName }),
            });
            setNewWorkspaceName("");
            setNotice("Workspace created, you are its owner.");
            await refreshWorkspaces();
        } catch (err) {
            setError(err instanceof ApiError ? err.message : "Could not create the workspace");
        } finally {
            setCreating(false);
        }
    };

    return (
        <div className="w-full max-w-3xl mx-auto space-y-6">
            <div>
                <h1 className="font-heading text-2xl font-semibold">Workspace</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                    {selectedWorkspace
                        ? `${selectedWorkspace.name ?? selectedWorkspace.workspaceId}, your role: ${selectedWorkspace.role}`
                        : "No workspace selected."}
                </p>
            </div>

            {notice && (
                <p role="status" className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">{notice}</p>
            )}
            {error && (
                <p role="alert" className="rounded-lg border border-destructive/40 px-4 py-3 text-sm text-destructive" data-testid="workspace-action-error">
                    {error}
                </p>
            )}

            {/* Member list — readable by every member, viewers included. */}
            <section className="rounded-xl border border-border bg-card p-5 space-y-3">
                <h2 className="text-sm font-semibold">Members</h2>
                {loadingMembers ? (
                    <span role="status" className="inline-flex">
                        <CircleNotch className="w-4 h-4 animate-spin text-muted-foreground" />
                        <span className="sr-only">Loading members…</span>
                    </span>
                ) : members.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No members found.</p>
                ) : (
                    <ul className="divide-y divide-border">
                        {members.map((m, idx) => {
                            // Accessible-name identity (round-2 QA fix,
                            // 2026-11-09): memberships store no email
                            // (see the row copy below), so the old
                            // email-or-userId fallback put the raw
                            // member UUID into the Role/Remove accessible
                            // names. Fall back to the row's position —
                            // distinct, human, and free of internal ids.
                            const memberLabel = m.email ?? `member ${idx + 1}`;
                            return (
                            <li key={m.userId ?? `member-${idx}`} className="py-2.5 flex items-center gap-3">
                                <div className="flex flex-col min-w-0 flex-1">
                                    <span className="text-[13px] font-medium truncate">
                                        {m.email ??
                                            (m.userId ? (
                                                // UX-1 (Programme 34): memberships
                                                // store no email (deliberate posture —
                                                // never derived from user metadata),
                                                // so email is null in practice. Say
                                                // so explicitly instead of presenting
                                                // a bare user ID as the identity.
                                                <span
                                                    className="font-normal text-muted-foreground"
                                                    data-testid="member-email-not-stored"
                                                    title="This workspace does not store member email addresses"
                                                >
                                                    Email not stored
                                                </span>
                                            ) : (
                                                "Unknown user"
                                            ))}
                                    </span>
                                    <span className="text-[11px] text-muted-foreground truncate">
                                        {/* 2026-11-09: human-readable joined
                                            date; the raw member UUID that
                                            used to ride this line is gone
                                            (it is an internal id, not
                                            support information). */}
                                        Joined {formatJoinedDate(m.joined_at)}
                                    </span>
                                </div>
                                <span className="text-[10px] font-medium uppercase tracking-wide rounded-full border border-border px-1.5 py-0.5 text-muted-foreground">
                                    {m.role}
                                </span>
                                {canManageMembers && m.userId && (
                                    <>
                                        <select
                                            aria-label={`Role for ${memberLabel}`}
                                            defaultValue={m.role ?? "member"}
                                            onChange={(e) => void handleRoleChange(m.userId!, e.target.value)}
                                            className="text-[12px] rounded-md border border-border bg-background px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        >
                                            {ROLE_OPTIONS.map((r) => (
                                                <option key={r} value={r}>
                                                    {r}
                                                </option>
                                            ))}
                                        </select>
                                        <button
                                            onClick={() => void handleRemove(m.userId!)}
                                            aria-label={`Remove ${memberLabel}`}
                                            className="rounded-sm px-1 text-[12px] font-medium text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        >
                                            Remove
                                        </button>
                                    </>
                                )}
                            </li>
                            );
                        })}
                    </ul>
                )}
                {!canManageMembers && (
                    <p className="text-[12px] text-muted-foreground" data-testid="workspace-members-readonly">
                        Read-only: only workspace owners and admins can invite members, change
                        roles, or remove members.
                    </p>
                )}
            </section>

            {/* Invite by link — owner/admin only; the API also denies others. */}
            {canManageMembers && (
                <section className="rounded-xl border border-border bg-card p-5 space-y-3" data-testid="workspace-invite-panel">
                    <h2 className="text-sm font-semibold">Invite by link</h2>
                    <p className="text-[12px] text-muted-foreground">
                        No email is sent. Copy the one-time link and share it manually; it is
                        shown only once (only a hash is stored).
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <input
                            type="email"
                            value={inviteEmail}
                            onChange={(e) => setInviteEmail(e.target.value)}
                            placeholder="invitee@example.com"
                            aria-label="Invitee email address"
                            className="flex-1 min-w-[200px] rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                        <select
                            aria-label="Invited role"
                            value={inviteRole}
                            onChange={(e) => setInviteRole(e.target.value)}
                            className="rounded-md border border-border bg-background px-2 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            {INVITE_ROLE_OPTIONS.map((r) => (
                                <option key={r} value={r}>
                                    {r}
                                </option>
                            ))}
                        </select>
                        <button
                            onClick={() => void handleInvite()}
                            disabled={inviting || !inviteEmail}
                            // UX-2 (Programme 34): white on the brand
                            // primary (#F97316) measures 2.80:1 — below
                            // WCAG AA for this 14px label. The darker
                            // filled shade keeps the primary action
                            // visually primary at 5.18:1 (hover 7.31:1)
                            // without touching the global token.
                            className="rounded-md bg-orange-700 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-800 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            {inviting ? "Creating…" : "Create invite link"}
                        </button>
                    </div>
                    {inviteResult && (
                        <div className="rounded-lg bg-muted/40 px-3 py-2 space-y-1" data-testid="workspace-invite-result">
                            <p className="text-[12px] break-all">{inviteResult.acceptLink}</p>
                            <p className="text-[11px] text-muted-foreground break-all">
                                Token (shown once): {inviteResult.token}
                            </p>
                        </div>
                    )}
                </section>
            )}

            {/* Accept an invitation — any signed-in user with a link. */}
            <section className="rounded-xl border border-border bg-card p-5 space-y-3">
                <h2 className="text-sm font-semibold">Accept an invitation</h2>
                <div className="flex flex-wrap gap-2">
                    <input
                        value={acceptToken}
                        onChange={(e) => setAcceptToken(e.target.value)}
                        placeholder="Paste the invitation token"
                        aria-label="Invitation token"
                        className="flex-1 min-w-[200px] rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <button
                        onClick={() => void handleAccept()}
                        disabled={accepting || !acceptToken.trim()}
                        className="rounded-md border border-border px-3 py-2 text-sm font-medium disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        {accepting ? "Accepting…" : "Accept invitation"}
                    </button>
                </div>
                <p className="text-[12px] text-muted-foreground">
                    Acceptance only works when the invitation was addressed to the email of the
                    account you are signed in with.
                </p>
            </section>

            {/* Create a workspace — any authenticated user; creator becomes owner. */}
            <section className="rounded-xl border border-border bg-card p-5 space-y-3">
                <h2 className="text-sm font-semibold">Create a workspace</h2>
                <div className="flex flex-wrap gap-2">
                    <input
                        value={newWorkspaceName}
                        onChange={(e) => setNewWorkspaceName(e.target.value)}
                        placeholder="Workspace name"
                        aria-label="New workspace name"
                        className="flex-1 min-w-[200px] rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <button
                        onClick={() => void handleCreate()}
                        disabled={creating || !newWorkspaceName.trim()}
                        className="rounded-md border border-border px-3 py-2 text-sm font-medium disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        {creating ? "Creating…" : "Create workspace"}
                    </button>
                </div>
            </section>
        </div>
    );
}
