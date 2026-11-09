"use client";

/**
 * Programme 18 / Phase G — workspace client context.
 *
 * Server-gated: the (main) layout reads WORKSPACE_RUNTIME_ENABLED
 * server-side and passes `workspaceRuntimeEnabled` down as a prop.
 * There is deliberately NO client-side env var for this flag. When the
 * flag is off the provider is inert: it performs no fetch and the
 * sidebar renders exactly as before.
 *
 * Selector convention (same as Phase D routes): the selected workspace
 * id travels as the `x-workspace-id` header (preferred) — see
 * workspaceFetch — never as proof; the server re-resolves membership
 * on every request.
 *
 * Selection persistence: localStorage only (local prototype). The
 * stored id is re-validated against GET /api/workspaces on load; a
 * stored id that is no longer in the member-derived list is dropped
 * and surfaced via `droppedWorkspaceId` (the "you no longer have
 * access" state).
 *
 * First-workspace provisioning (launch fix, 2026-11-08 —
 * lib/tenancy/provisioning.ts): signup never created a workspace,
 * so a fresh customer (or any account predating the SaaS wiring)
 * arrived here with an empty list and every workspace-scoped
 * surface dead-ended. When the loaded list is EMPTY, the provider
 * now creates the first workspace through POST /api/workspaces —
 * the app's own creation route (create_workspace RPC: workspace +
 * owner membership) — and re-reads the list, at most once per
 * provider mount (so a user who deliberately leaves their only
 * workspace is not handed a new one mid-session, and a failed
 * creation simply leaves the honest empty state in place).
 */

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { apiClient, ApiError } from "@/lib/api/client";
import { provisionIfEmpty } from "@/lib/tenancy/provisioning";
import type { WorkspaceRole } from "@/lib/tenancy/context";

export const WORKSPACE_SELECTION_STORAGE_KEY = "opendm:selected-workspace-id";

export interface WorkspaceSummary {
    id: string;
    workspaceId: string;
    name: string | null;
    role: WorkspaceRole;
    created_at: string | null;
}

export interface WorkspaceContextValue {
    workspaceRuntimeEnabled: boolean;
    workspaces: WorkspaceSummary[];
    selectedWorkspaceId: string | null;
    selectedWorkspace: WorkspaceSummary | null;
    role: WorkspaceRole | null;
    canManageMembers: boolean;
    loading: boolean;
    loadError: string | null;
    droppedWorkspaceId: string | null;
    selectWorkspace: (workspaceId: string) => void;
    refreshWorkspaces: () => Promise<void>;
    dropWorkspace: (workspaceId: string) => void;
    workspaceFetch: <T>(path: string, options?: RequestInit) => Promise<T>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
    const ctx = useContext(WorkspaceContext);
    if (!ctx) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
    return ctx;
}

export function WorkspaceProvider({
    workspaceRuntimeEnabled,
    children,
}: {
    workspaceRuntimeEnabled: boolean;
    children: ReactNode;
}) {
    const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
    const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [droppedWorkspaceId, setDroppedWorkspaceId] = useState<string | null>(null);
    const selectedRef = useRef<string | null>(null);
    selectedRef.current = selectedWorkspaceId;
    // First-workspace provisioning is attempted at most once per
    // EMPTY EPISODE (audit Bug 8 fix, 2026-11-09): the attempt flag
    // resets whenever a non-empty list is observed, so when the
    // loaded list later TRANSITIONS to empty mid-session (the
    // user's only workspace was deleted/left), the next refresh
    // re-runs provisioning instead of stranding the session on the
    // honest-but-dead empty state until a full page reload. While
    // the list stays continuously empty, refreshes do NOT loop
    // creation attempts (a deliberate leave does not resurrect a
    // workspace on the very next refresh — only a list that was
    // non-empty in between re-arms the attempt).
    const provisionAttemptedRef = useRef(false);

    const applyList = useCallback((list: WorkspaceSummary[]) => {
        setWorkspaces(list);
        const stored =
            typeof window !== "undefined"
                ? window.localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY)
                : null;
        const current = selectedRef.current;
        const candidate = current ?? stored;
        if (candidate && list.some((w) => w.workspaceId === candidate)) {
            setSelectedWorkspaceId(candidate);
            return;
        }
        if (candidate && !list.some((w) => w.workspaceId === candidate)) {
            // The previously selected workspace is no longer in the
            // member-derived list — membership was revoked (or the
            // stored id is stale). Drop it and say so.
            setDroppedWorkspaceId(candidate);
            if (typeof window !== "undefined") {
                window.localStorage.removeItem(WORKSPACE_SELECTION_STORAGE_KEY);
            }
        }
        // Explicit default: the FIRST workspace from the member-derived
        // list (mirrors the routeContext rule that a default must be
        // obtained explicitly via the list, never assumed server-side).
        setSelectedWorkspaceId(list[0]?.workspaceId ?? null);
    }, []);

    const refreshWorkspaces = useCallback(async () => {
        if (!workspaceRuntimeEnabled) return;
        setLoading(true);
        try {
            const fetchList = async (): Promise<WorkspaceSummary[]> => {
                const data = await apiClient<{ workspaces: WorkspaceSummary[] }>("/workspaces");
                return data.workspaces ?? [];
            };
            let list = await fetchList();
            if (list.length > 0) {
                // A non-empty observation re-arms provisioning for
                // the NEXT transition to empty (Bug 8 fix above).
                provisionAttemptedRef.current = false;
            }
            if (list.length === 0 && !provisionAttemptedRef.current) {
                provisionAttemptedRef.current = true;
                const ensured = await provisionIfEmpty(list, {
                    create: (name) =>
                        apiClient("/workspaces", {
                            method: "POST",
                            body: JSON.stringify({ name }),
                        }),
                    relist: fetchList,
                });
                list = ensured.workspaces;
            }
            applyList(list);
            setLoadError(null);
        } catch (err) {
            setLoadError(err instanceof ApiError ? err.message : "Could not load workspaces");
        } finally {
            setLoading(false);
        }
    }, [workspaceRuntimeEnabled, applyList]);

    useEffect(() => {
        void refreshWorkspaces();
    }, [refreshWorkspaces]);

    const selectWorkspace = useCallback((workspaceId: string) => {
        setSelectedWorkspaceId(workspaceId);
        setDroppedWorkspaceId(null);
        if (typeof window !== "undefined") {
            window.localStorage.setItem(WORKSPACE_SELECTION_STORAGE_KEY, workspaceId);
        }
    }, []);

    const dropWorkspace = useCallback(
        (workspaceId: string) => {
            setWorkspaces((prev) => prev.filter((w) => w.workspaceId !== workspaceId));
            if (selectedRef.current === workspaceId) {
                setSelectedWorkspaceId(null);
                setDroppedWorkspaceId(workspaceId);
                if (typeof window !== "undefined") {
                    window.localStorage.removeItem(WORKSPACE_SELECTION_STORAGE_KEY);
                }
            }
            void refreshWorkspaces();
        },
        [refreshWorkspaces],
    );

    /**
     * Fetch helper for workspace-scoped API calls: attaches the
     * `x-workspace-id` header for the currently selected workspace
     * (Phase D selector convention, header preferred over ?workspace=).
     */
    const workspaceFetch = useCallback(
        async <T,>(path: string, options?: RequestInit): Promise<T> => {
            const headers: Record<string, string> = {
                ...((options?.headers as Record<string, string> | undefined) ?? {}),
            };
            const selected = selectedRef.current;
            if (selected) headers["x-workspace-id"] = selected;
            return apiClient<T>(path, { ...options, headers });
        },
        [],
    );

    const selectedWorkspace = useMemo(
        () => workspaces.find((w) => w.workspaceId === selectedWorkspaceId) ?? null,
        [workspaces, selectedWorkspaceId],
    );

    const value: WorkspaceContextValue = {
        workspaceRuntimeEnabled,
        workspaces,
        selectedWorkspaceId,
        selectedWorkspace,
        role: selectedWorkspace?.role ?? null,
        canManageMembers:
            selectedWorkspace?.role === "owner" || selectedWorkspace?.role === "admin",
        loading,
        loadError,
        droppedWorkspaceId,
        selectWorkspace,
        refreshWorkspaces,
        dropWorkspace,
        workspaceFetch,
    };

    return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
