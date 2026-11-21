"use client";

import { motion, AnimatePresence } from "motion/react";
import { createPortal } from "react-dom";
import { X, ArrowLeft, Check, Warning, CircleNotch } from "@/components/phosphor";
import { useState, useEffect, useCallback } from "react";

import { SelectTypeStep } from "./steps/SelectTypeStep";
import { SelectPostStep } from "./steps/SelectPostStep";
import { ConfigureStep } from "./steps/ConfigureStep";
import { AUTOMATION_TEMPLATES, getAutomationTemplate, type AutomationTemplateId } from "@/lib/automation/templates";
import type { AiReplyLanguage } from "@/lib/types";
import { useInstagramAccounts } from "@/hooks/useInstagramAccounts";
import { useFacebookPages } from "@/hooks/useFacebookPages";
import { useCreateAutomation, useUpdateAutomation } from "@/hooks/useAutomations";
import type { AutomationFromDB } from "@/hooks/useAutomations";

interface NewAutomationModalProps {
    isOpen: boolean;
    onClose: () => void;
    editAutomation?: AutomationFromDB | null;
    /** The account this automation belongs to (the sidebar's active account). */
    accountId?: string | null;
    /** Facebook Page automations (2026-11-19): the facebook_pages row id
     *  of the Page selected in the switcher. Null = no Page connected. */
    facebookPageId?: string | null;
    /**
     * Keyword carried in from the Script Writer handoff (audit fix,
     * 2026-11-08): when creating (never when editing), the new flow
     * starts with this keyword already in the trigger keyword list.
     */
    initialKeyword?: string | null;
    /**
     * Channel the create flow opens on (2026-11-20): the
     * /automations channel toggle passes the selected tab so the
     * trigger picker shows that channel's triggers. Create mode
     * only — edit mode derives the channel from the stored row.
     */
    initialChannel?: "instagram" | "facebook";
}

export type CardButton = {
    id: string;
    title: string;
    link: string;
};

export type DMResponse = {
    id: string;
    type: "text" | "card" | "ask_follow" | "lead_form";
    content: string;
    buttonTitle?: string;
    buttonLink?: string;
    /** Text responses: link buttons, max 2 (2026-11-22). The legacy
     *  buttonTitle/buttonLink above are still the first button, so
     *  automations saved before this keep working unchanged. */
    buttons?: CardButton[];
    cardImage?: string;
    cardTitle?: string;
    cardSubtitle?: string;
    cardButtons?: CardButton[];
    /** Lead-form responses: which contact fields the ask collects. */
    leadFields?: ("email" | "phone")[];
};

export type AutomationFlowData = {
    name: string;
    type: string | null;
    postId: string | null;
    postThumbnailUrl?: string | null;
    postCaption?: string;
    keywords: string[];
    keywordsAnyMode: boolean;
    customReplies: string[];
    isAutoDmEnabled: boolean;
    dmOpeningMessageEnabled: boolean;
    dmOpeningMessage: string;
    /** Opening-message variations - one is picked at random per DM.
        Restored 2026-11-12; the 985ed5c redesign dropped this field. */
    dmOpeningMessageVariations: string[];
    dmOpeningMessageButtonTitle: string;
    askToFollowEnabled: boolean;
    askToFollowMessage: string;
    askToFollowVisitProfileButton: string;
    askToFollowConfirmButton: string;
    dmResponses: DMResponse[];
    followUpEnabled: boolean;
    followUpDelayMinutes: number;
    followUpMessage: string;
    /** AI reply language (2026-11-17): 'en' or 'hinglish'. */
    aiReplyLanguage: AiReplyLanguage;
};

const DB_TYPE_TO_FLOW: Record<string, string> = {
    comment_dm: "comment-dm",
    dm_reply: "dm-reply",
    story_reply: "story-reply",
    reel_dm: "reel-dm",
    story_mention: "story-mention",
    fb_comment_dm: "fb-comment-dm",
    fb_dm_reply: "fb-dm-reply",
};

const DEFAULT_NAMES: Record<string, string> = {
    "comment-dm": "Comment funnel",
    "dm-reply": "DM keyword reply",
    "story-reply": "Story reply funnel",
    "reel-dm": "Shared Reel funnel",
    "story-mention": "Story mention funnel",
    "fb-comment-dm": "Facebook comment funnel",
    "fb-dm-reply": "Facebook DM reply",
};

const DEFAULT_OPENING_MESSAGE =
    "Hey there!\n\nI'm so happy you're here, thank you so much for your interest 🥰\n\nClick below and I'll send you the link in just a sec ✨";

/** The 3 default opening variations - variation 1 is the message
    new automations already shipped with; 2 and 3 are the originals
    from the a091ade builder. One is picked at random per DM. */
const DEFAULT_OPENING_MESSAGE_VARIATIONS = [
    DEFAULT_OPENING_MESSAGE,
    "Thanks for your comment, {username}! Super excited to share this with you ✨",
    "Hey {username}! Really appreciate your interest! Here is everything you need 🚀",
];

const defaultFlowData = (): AutomationFlowData => ({
    name: "New automation",
    type: null,
    postId: null,
    postThumbnailUrl: null,
    postCaption: "",
    keywords: [],
    keywordsAnyMode: false,
    customReplies: ["Sent! 🚀", "Check your DMs 📬", "Got it, check your inbox! ✉️"],
    isAutoDmEnabled: true,
    dmOpeningMessageEnabled: true,
    dmOpeningMessage: DEFAULT_OPENING_MESSAGE,
    dmOpeningMessageVariations: [...DEFAULT_OPENING_MESSAGE_VARIATIONS],
    dmOpeningMessageButtonTitle: "Send me the link",
    askToFollowEnabled: false,
    askToFollowMessage: "Hey! It seems you're not following me yet 😊",
    askToFollowVisitProfileButton: "Visit Profile",
    askToFollowConfirmButton: "I'm following ✅",
    dmResponses: [],
    followUpEnabled: false,
    followUpDelayMinutes: 60,
    followUpMessage: "",
    aiReplyLanguage: "en",
});

function automationToFlowData(automation: AutomationFromDB): AutomationFlowData {
    const defaults = defaultFlowData();
    const rawKeywords = automation.keywords ?? [];
    // '*ANY*' is the explicit wildcard token (hardened matcher) — it is a
    // mode, not a keyword, so it never appears in the keyword chips.
    const hasWildcardToken = rawKeywords.some(k => k.trim().toUpperCase() === "*ANY*");
    const keywords = rawKeywords.filter(k => k.trim().toUpperCase() !== "*ANY*");
    return {
        name: automation.name,
        type: DB_TYPE_TO_FLOW[automation.type] ?? automation.type,
        postId: automation.post_id ?? null,
        postThumbnailUrl: automation.post_thumbnail_url ?? null,
        postCaption: automation.post_caption ?? "",
        keywords,
        keywordsAnyMode: hasWildcardToken || rawKeywords.length === 0,
        customReplies: automation.comment_reply_options.length > 0
            ? automation.comment_reply_options
            : defaults.customReplies,
        isAutoDmEnabled: automation.dm_opening_message_enabled,
        dmOpeningMessageEnabled: automation.dm_opening_message_enabled,
        dmOpeningMessage: automation.dm_opening_message || defaults.dmOpeningMessage,
        dmOpeningMessageVariations: automation.dm_opening_message_variations?.length > 0
            ? automation.dm_opening_message_variations
            : automation.dm_opening_message
                ? [automation.dm_opening_message]
                : defaults.dmOpeningMessageVariations,
        dmOpeningMessageButtonTitle: automation.dm_opening_message_button_title ?? defaults.dmOpeningMessageButtonTitle,
        askToFollowEnabled: automation.ask_to_follow_enabled,
        askToFollowMessage: automation.ask_to_follow_message || defaults.askToFollowMessage,
        askToFollowVisitProfileButton: automation.ask_to_follow_visit_profile_button || defaults.askToFollowVisitProfileButton,
        askToFollowConfirmButton: automation.ask_to_follow_confirm_button || defaults.askToFollowConfirmButton,
        dmResponses: automation.dm_responses as DMResponse[],
        followUpEnabled: automation.follow_up_enabled ?? defaults.followUpEnabled,
        followUpDelayMinutes: automation.follow_up_delay_minutes ?? defaults.followUpDelayMinutes,
        followUpMessage: automation.follow_up_message ?? defaults.followUpMessage,
        aiReplyLanguage: automation.ai_reply_language ?? defaults.aiReplyLanguage,
    };
}

export function NewAutomationModal({ isOpen, onClose, editAutomation, accountId, facebookPageId, initialKeyword, initialChannel }: NewAutomationModalProps) {
    const isEditMode = !!editAutomation;

    const [step, setStep] = useState(0);
    const [flowData, setFlowData] = useState<AutomationFlowData>(defaultFlowData());
    const [savedSnapshot, setSavedSnapshot] = useState<string>("");
    const [showConfirm, setShowConfirm] = useState(false);
    const [activateError, setActivateError] = useState<string | null>(null);
    const [pendingAction, setPendingAction] = useState<'save' | 'activate' | null>(null);
    // Portal gate: the modal renders into document.body (client-only),
    // so its `fixed` positioning is always viewport-relative. It must
    // not render on the server, where `document` does not exist.
    const [mounted, setMounted] = useState(false);
    useEffect(() => { setMounted(true); }, []);

    const { data: igAccounts, isLoading: accountsLoading } = useInstagramAccounts();
    const activeAccount = igAccounts?.find((a) => a.id === accountId) ?? igAccounts?.[0] ?? null;
    const firstAccountId = activeAccount?.id ?? null;
    // Facebook Page selection (2026-11-19) — mirrors the IG selection
    // above and is a SEPARATE selection: picking a Page never clears
    // the Instagram account, and vice versa.
    const { data: fbPages, isLoading: fbPagesLoading } = useFacebookPages();
    const activeFacebookPage = fbPages?.find((p) => p.id === facebookPageId) ?? fbPages?.[0] ?? null;
    const firstFacebookPageId = activeFacebookPage?.id ?? null;
    // The flow currently being built is a Facebook one when its type is
    // an fb_* type (create and edit alike — edit mode derives the type
    // from the stored row via automationToFlowData).
    const isFacebookFlow = flowData.type === "fb-comment-dm" || flowData.type === "fb-dm-reply";
    // Silent-save fix (2026-11-09): in create mode with NO connected
    // Instagram account, saving used to do nothing a user could see —
    // the only feedback was a truncated 12px note in the header, and
    // the row can never be created (automations.instagram_account_id
    // is NOT NULL in the schema, so an account-less draft is not
    // storable). The blocker is now a persistent banner at the save
    // step with both actions disabled — saving never fails silently.
    // Facebook flows check the Page instead (2026-11-19).
    const noAccountBlocker = !isEditMode && !accountsLoading && !fbPagesLoading && igAccounts !== undefined && fbPages !== undefined && (isFacebookFlow ? !firstFacebookPageId : !firstAccountId);
    const createMutation = useCreateAutomation();
    const updateMutation = useUpdateAutomation();

    const isDirty = JSON.stringify(flowData) !== savedSnapshot;

    useEffect(() => {
        if (isOpen) {
            setActivateError(null);
            setShowConfirm(false);
            setPendingAction(null);
            if (editAutomation) {
                const fd = automationToFlowData(editAutomation);
                setFlowData(fd);
                setSavedSnapshot(JSON.stringify(fd));
                setStep(2);
            } else {
                const fd = defaultFlowData();
                const carried = initialKeyword?.trim();
                if (carried) fd.keywords = [carried];
                setFlowData(fd);
                setSavedSnapshot(JSON.stringify(fd));
                setStep(0);
            }
        }
    }, [isOpen, editAutomation, initialKeyword]);

    const updateData = useCallback((patch: Partial<AutomationFlowData>) =>
        setFlowData(prev => ({ ...prev, ...patch })), []);

    const handleTypeSelect = (type: string) => {
        const name = flowData.name === "New automation" ? (DEFAULT_NAMES[type] ?? flowData.name) : flowData.name;
        if (type === "comment-dm" || type === "reel-dm" || type === "fb-comment-dm") {
            // Post-targeted triggers - pick the reel/post first.
            updateData({ type, name });
            setStep(1);
        } else {
            // DM / story triggers have no post target - straight to configure
            updateData({ type, name, postId: "all", postThumbnailUrl: null, postCaption: "" });
            setStep(2);
        }
    };

    /**
     * Template select (2026-11-17): a template only PREFILLS the builder —
     * name, type, trigger keyword, opening message, reveal button and the
     * link response. Nothing is auto-created: the owner reviews and edits
     * everything, then saves like any other automation. Post-targeted
     * templates still go through the post picker (step 1); the rest go
     * straight to configure (step 2).
     */
    const handleTemplateSelect = (templateId: AutomationTemplateId) => {
        const template = getAutomationTemplate(templateId);
        if (!template) return;
        const base = defaultFlowData();
        const fd: AutomationFlowData = {
            ...base,
            name: template.automationName,
            type: template.flowType,
            keywords: template.keyword ? [template.keyword] : [],
            keywordsAnyMode: !template.keyword,
            dmOpeningMessage: template.openingMessage,
            dmOpeningMessageVariations: [template.openingMessage],
            dmOpeningMessageButtonTitle: template.revealButton,
            dmResponses: [
                {
                    id: crypto.randomUUID(),
                    type: "text",
                    content: template.responseText,
                    buttonTitle: "Open link",
                    buttonLink: template.responseLink,
                },
            ],
            aiReplyLanguage: template.aiReplyLanguage,
        };
        setFlowData(fd);
        setSavedSnapshot(JSON.stringify(fd));
        if (template.flowType === "comment-dm" || template.flowType === "reel-dm") {
            setStep(1);
        } else {
            // DM / story templates have no post target (postId stays null,
            // which buildPayload maps to null for non-post-targeted types).
            setStep(2);
        }
    };

    const handleBack = () => setStep(s => {
        if (s === 2 && flowData.type !== "comment-dm" && flowData.type !== "reel-dm" && flowData.type !== "fb-comment-dm") return 0;
        return Math.max(s - 1, 0);
    });

    const handleClose = () => {
        if (isDirty && step >= 2) {
            setShowConfirm(true);
        } else {
            onClose();
        }
    };

    const buildPayload = (isActive: boolean | null) => {
        const typeMap: Record<string, "comment_dm" | "dm_reply" | "story_reply" | "reel_dm" | "story_mention" | "fb_comment_dm" | "fb_dm_reply"> = {
            "comment-dm": "comment_dm",
            "dm-reply": "dm_reply",
            "story-reply": "story_reply",
            "reel-dm": "reel_dm",
            "story-mention": "story_mention",
            "fb-comment-dm": "fb_comment_dm",
            "fb-dm-reply": "fb_dm_reply",
        };
        const dbType = typeMap[flowData.type ?? ""] ?? "comment_dm";
        const isComment = dbType === "comment_dm" || dbType === "fb_comment_dm";
        const isReelDm = dbType === "reel_dm";
        // Facebook v1 (2026-11-19): no require-follow (no Page-follow
        // signal), no lead form, no scheduled follow-ups — the API
        // rejects those fields with 400, so they are forced off here
        // even if a draft carried them (e.g. an older saved funnel).
        const isFacebook = dbType === "fb_comment_dm" || dbType === "fb_dm_reply";
        // Post-targeted triggers keep the picked post; every other type
        // has no post target. Nulling postId for reel_dm would silently
        // turn a per-reel funnel into an any-reel one.
        const hasPostTarget = isComment || isReelDm;
        return {
            name: flowData.name,
            type: dbType,
            isActive: isActive ?? true,
            postId: !hasPostTarget || flowData.postId === "all" ? null : flowData.postId,
            postThumbnailUrl: hasPostTarget ? flowData.postThumbnailUrl ?? null : null,
            postCaption: hasPostTarget ? flowData.postCaption ?? null : null,
            // Hardened matcher: "any" mode must be EXPLICIT — stored as the
            // '*ANY*' token. A null/empty keyword list now never triggers.
            // Shared Reel funnels are ALWAYS any-share (2026-11-17, owner):
            // the editor offers no keyword option for reel_dm, so saves
            // force the wildcard token even if the draft carried keywords
            // (template, carried keyword, or an older saved funnel).
            keywords: isReelDm ? ["*ANY*"] : (flowData.keywordsAnyMode ? ["*ANY*"] : (flowData.keywords.length > 0 ? flowData.keywords : null)),
            // Public comment replies only exist for comment automations.
            // The engine's public_reply_enabled gate is derived from whether
            // replies are configured, preserving this builder's promise.
            commentReplyOptions: isComment ? flowData.customReplies : [],
            publicReplyEnabled: isComment && flowData.customReplies.length > 0,
            publicReplyOptions: isComment ? flowData.customReplies : [],
            followUpEnabled: isFacebook ? false : flowData.followUpEnabled,
            followUpDelayMinutes: flowData.followUpDelayMinutes,
            followUpMessage: flowData.followUpMessage,
            dmOpeningMessageEnabled: flowData.isAutoDmEnabled && flowData.dmOpeningMessageEnabled,
            // Variation 1 stays mirrored into the legacy single-message
            // field so the engine's "opening off" check keeps working.
            dmOpeningMessage: flowData.dmOpeningMessageVariations[0] ?? flowData.dmOpeningMessage,
            dmOpeningMessageVariations: flowData.dmOpeningMessageVariations,
            dmOpeningMessageButtonTitle: flowData.dmOpeningMessageButtonTitle || null,
            dmOpeningMessageButtonLink: null,
            askToFollowEnabled: isFacebook ? false : flowData.askToFollowEnabled,
            askToFollowMessage: flowData.askToFollowMessage,
            askToFollowVisitProfileButton: flowData.askToFollowVisitProfileButton,
            askToFollowConfirmButton: flowData.askToFollowConfirmButton,
            dmResponses: flowData.dmResponses,
            aiReplyLanguage: flowData.aiReplyLanguage,
        };
    };

    const handleSave = (activate: boolean) => {
        setActivateError(null);
        setPendingAction(activate ? 'activate' : 'save');

        if (isEditMode && editAutomation) {
            const { name, commentReplyOptions, dmOpeningMessageEnabled, dmOpeningMessage, dmOpeningMessageVariations, dmOpeningMessageButtonTitle,
                askToFollowEnabled, askToFollowMessage, askToFollowVisitProfileButton,
                askToFollowConfirmButton, dmResponses, keywords, postThumbnailUrl, postCaption,
                publicReplyEnabled, publicReplyOptions, followUpEnabled, followUpDelayMinutes, followUpMessage, aiReplyLanguage } = buildPayload(null);
            updateMutation.mutate({
                id: editAutomation.id,
                is_active: activate ? true : editAutomation.is_active,
                name,
                keywords,
                comment_reply_options: commentReplyOptions,
                public_reply_enabled: publicReplyEnabled,
                public_reply_options: publicReplyOptions,
                follow_up_enabled: followUpEnabled,
                follow_up_delay_minutes: followUpDelayMinutes,
                follow_up_message: followUpMessage,
                ai_reply_language: aiReplyLanguage,
                dm_opening_message_enabled: dmOpeningMessageEnabled,
                dm_opening_message: dmOpeningMessage,
                dm_opening_message_variations: dmOpeningMessageVariations,
                dm_opening_message_button_title: dmOpeningMessageButtonTitle ?? null,
                dm_opening_message_button_link: null,
                post_thumbnail_url: postThumbnailUrl ?? null,
                post_caption: postCaption ?? null,
                ask_to_follow_enabled: askToFollowEnabled,
                ask_to_follow_message: askToFollowMessage,
                ask_to_follow_visit_profile_button: askToFollowVisitProfileButton,
                ask_to_follow_confirm_button: askToFollowConfirmButton,
                dm_responses: dmResponses,
            }, {
                onSuccess: () => {
                    setPendingAction(null);
                    setSavedSnapshot(JSON.stringify(flowData));
                    onClose();
                },
                onError: (err) => { setPendingAction(null); setActivateError(err.message); },
            });
        } else {
            // Facebook flows attach to the selected Page instead of an
            // Instagram account (2026-11-19); the API requires exactly
            // one of the two ids.
            const isFb = flowData.type === "fb-comment-dm" || flowData.type === "fb-dm-reply";
            if (isFb) {
                if (!firstFacebookPageId) {
                    setPendingAction(null);
                    setActivateError("Connect a Facebook Page first in Settings.");
                    return;
                }
                createMutation.mutate(
                    { instagramAccountId: null, facebookPageId: firstFacebookPageId, ...buildPayload(activate) },
                    {
                        onSuccess: () => {
                            setPendingAction(null);
                            setSavedSnapshot(JSON.stringify(flowData));
                            onClose();
                        },
                        onError: (err) => { setPendingAction(null); setActivateError(err.message); },
                    }
                );
                return;
            }
            if (!firstAccountId) {
                setPendingAction(null);
                setActivateError("Connect an Instagram account first in Settings.");
                return;
            }
            createMutation.mutate(
                { instagramAccountId: firstAccountId, ...buildPayload(activate) },
                {
                    onSuccess: () => {
                        setPendingAction(null);
                        setSavedSnapshot(JSON.stringify(flowData));
                        onClose();
                    },
                    onError: (err) => { setPendingAction(null); setActivateError(err.message); },
                }
            );
        }
    };

    const isSaving = pendingAction === 'save' && (createMutation.isPending || updateMutation.isPending);
    const isActivating = pendingAction === 'activate' && (createMutation.isPending || updateMutation.isPending);
    const isPending = isSaving || isActivating;

    const stepTitle = step === 0 ? "New automation"
        : step === 1 ? "Choose a post"
        : isEditMode ? `Edit - ${flowData.name}` : flowData.name || "Configure";

    // Portaled to document.body: rendered inside <main>, the modal's
    // `fixed inset-0` can be captured by a transformed ancestor (the
    // PageTransition motion wrapper), which shifts the whole panel
    // off-centre — live, the panel sat ~45px right of centre and the
    // form column's left edge slid under the panel edge. At the body
    // root, `fixed` is always viewport-relative, immune to that.
    // React context (queries, theme) flows through portals unchanged.
    if (!mounted) return null;
    return createPortal(
        <AnimatePresence>
            {isOpen && (
                <div data-no-reveal className="fixed inset-0 z-[200] flex items-center justify-center p-3">
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 bg-black/50"
                        onClick={handleClose}
                    />

                    {/* Modal */}
                    <motion.div
                        initial={{ opacity: 0, scale: 0.98, y: 12 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.98, y: 12 }}
                        transition={{ type: "spring", damping: 30, stiffness: 300 }}
                        className="relative w-full h-full max-w-[96vw] lg:max-w-6xl max-h-[92vh] bg-background border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden z-10"
                    >
                        {/* Header */}
                        <div className="h-12 shrink-0 border-b border-border flex items-center justify-between px-4 gap-3">
                            <span className="text-[13px] font-semibold text-foreground truncate">{stepTitle}</span>

                            <div className="flex items-center gap-1.5 shrink-0">
                                {step > 0 && (
                                    <button onClick={handleBack} className="inline-flex items-center gap-1 h-8 px-2.5 text-[13px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors">
                                        <ArrowLeft className="w-3.5 h-3.5" /> Back
                                    </button>
                                )}

                                {step === 2 && (
                                    <>
                                        <button
                                            disabled={isPending || noAccountBlocker}
                                            onClick={() => handleSave(false)}
                                            className="inline-flex items-center gap-1.5 h-8 px-3 text-[13px] font-medium text-foreground border border-border hover:bg-muted disabled:opacity-50 rounded-lg transition-colors"
                                        >
                                            {isSaving && <CircleNotch className="w-3 h-3 animate-spin" />}
                                            {isSaving ? "Saving…" : "Save"}
                                        </button>
                                        <button
                                            disabled={isPending || noAccountBlocker || (!isEditMode && (isFacebookFlow ? !firstFacebookPageId : !firstAccountId))}
                                            onClick={() => handleSave(true)}
                                            className="inline-flex items-center gap-1.5 h-8 px-3 text-[13px] font-semibold bg-foreground text-background hover:opacity-90 disabled:opacity-50 rounded-lg transition-opacity"
                                        >
                                            {isActivating ? <CircleNotch className="w-3 h-3 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                                            {isActivating ? "Activating…" : "Activate"}
                                        </button>
                                    </>
                                )}

                                <div className="w-px h-4 bg-border mx-0.5" />
                                <button onClick={handleClose} className="p-1.5 hover:bg-muted text-muted-foreground hover:text-foreground rounded-md transition-colors">
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                        </div>

                        {/* Save feedback — full-width and unmissable
                            (2026-11-09 silent-save fix): mutation
                            errors and the no-account blocker render
                            here, never as truncated header microcopy. */}
                        {step === 2 && noAccountBlocker && (
                            <div role="alert" className="shrink-0 border-b border-border bg-amber-500/10 px-4 py-2.5 flex items-center gap-2">
                                <Warning className="w-4 h-4 text-amber-600 shrink-0" />
                                <p className="text-[12.5px] font-medium text-foreground">
                                    {isFacebookFlow ? (
                                        <>No Facebook Page is connected to this workspace, so this automation cannot be saved yet.{" "}
                                        <a href="/settings" className="underline underline-offset-2">Connect a Page in Settings</a>{" "}
                                        first — your configuration here stays open while you do.</>
                                    ) : (
                                        <>No Instagram account is connected to this workspace, so this automation cannot be saved yet.{" "}
                                        <a href="/settings" className="underline underline-offset-2">Connect an account in Settings</a>{" "}
                                        first — your configuration here stays open while you do.</>
                                    )}
                                </p>
                            </div>
                        )}
                        {step === 2 && activateError && !noAccountBlocker && (
                            <div role="alert" className="shrink-0 border-b border-border bg-destructive/10 px-4 py-2.5 flex items-center gap-2">
                                <Warning className="w-4 h-4 text-destructive shrink-0" />
                                <p className="text-[12.5px] font-medium text-foreground">{activateError}</p>
                            </div>
                        )}

                        {/* Content */}
                        <div className="flex-1 overflow-hidden">
                            <AnimatePresence mode="wait">
                                <motion.div
                                    key={step}
                                    initial={{ opacity: 0, x: 8 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: -8 }}
                                    transition={{ duration: 0.15, ease: "easeOut" }}
                                    className="w-full h-full"
                                >
                                    {step === 0 && (
                                        <SelectTypeStep
                                            onSelect={handleTypeSelect}
                                            onTemplateSelect={handleTemplateSelect}
                                            selectedType={flowData.type}
                                            showFacebookTriggers={!!firstFacebookPageId}
                                            channelFilter={!isEditMode ? initialChannel : undefined}
                                        />
                                    )}
                                    {step === 1 && (
                                        <SelectPostStep
                                            onSelect={(postId, name, thumbnailUrl, caption) => {
                                                updateData({ postId, name, postThumbnailUrl: thumbnailUrl, postCaption: caption });
                                                setStep(2);
                                            }}
                                            selectedPost={flowData.postId}
                                            flowName={flowData.name}
                                            instagramAccountId={firstAccountId}
                                            channel={isFacebookFlow ? "facebook" : "instagram"}
                                            facebookPageId={firstFacebookPageId}
                                            // One automation per reel (owner decision,
                                            // 2026-11-15): a reel_dm funnel always
                                            // targets a specific reel, so there is no
                                            // "Trigger on all posts" for it, and the
                                            // picker opens on the Reels filter.
                                            allowAllPosts={flowData.type !== "reel-dm"}
                                            initialFilter={flowData.type === "reel-dm" ? "reels" : "all"}
                                        />
                                    )}
                                    {step === 2 && (
                                        <ConfigureStep
                                            data={flowData}
                                            onUpdate={updateData}
                                            creatorProfilePicUrl={isFacebookFlow ? (activeFacebookPage?.profile_picture_url ?? null) : (activeAccount?.profile_picture_url ?? null)}
                                            // The Selected post box's "Change post" button returns
                                            // to step 1 "Choose a post". The picker already
                                            // receives selectedPost={flowData.postId}, so the
                                            // current post comes back pre-selected, and
                                            // updateData merges — all other fields are preserved.
                                            // Only post-targeted flows (comment-dm, reel-dm)
                                            // render the box, and step 1 exists for those in
                                            // both create and edit mode.
                                            onChangePost={() => setStep(1)}
                                        />
                                    )}
                                </motion.div>
                            </AnimatePresence>
                        </div>

                        {/* Unsaved-changes confirmation */}
                        <AnimatePresence>
                            {showConfirm && (
                                <motion.div
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    className="absolute inset-0 z-20 flex items-center justify-center bg-black/50"
                                >
                                    <motion.div
                                        initial={{ scale: 0.97, y: 6 }}
                                        animate={{ scale: 1, y: 0 }}
                                        exit={{ scale: 0.97, y: 6 }}
                                        className="bg-card border border-border rounded-xl p-5 max-w-sm w-full mx-4 shadow-xl"
                                    >
                                        <div className="flex items-center gap-3 mb-4">
                                            <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
                                                <Warning className="w-4 h-4 text-amber-500" />
                                            </div>
                                            <div>
                                                <p className="text-[13.5px] font-semibold text-foreground">Unsaved changes</p>
                                                <p className="text-[12.5px] text-muted-foreground">Your edits haven&apos;t been saved.</p>
                                            </div>
                                        </div>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => setShowConfirm(false)}
                                                className="flex-1 h-9 rounded-lg border border-border text-[13px] font-medium hover:bg-muted transition-colors"
                                            >
                                                Keep editing
                                            </button>
                                            <button
                                                onClick={() => { setShowConfirm(false); onClose(); }}
                                                className="flex-1 h-9 rounded-lg bg-destructive text-white text-[13px] font-semibold hover:bg-destructive/90 transition-colors"
                                            >
                                                Discard
                                            </button>
                                        </div>
                                    </motion.div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>,
        document.body
    );
}
