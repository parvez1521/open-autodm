"use client";
import { motion, AnimatePresence } from "motion/react";
import { useState } from "react";
import {
    X, Trash, Plus, Check,
    Image as ImageIcon, CaretDown, Chat, SquaresFour,
    Lightning, Warning,
} from "@/components/phosphor";
import { cn, truncateWithEllipsis } from "@/lib/utils";
import { PostThumb } from "@/components/automations/PostThumb";
import { getEditorSections, type EditorSectionId } from "@/lib/automation/editorSections";
import { apiClient, ApiError } from "@/lib/api/client";
import { AutomationFlowData, DMResponse, CardButton } from "../NewAutomationModal";
import { CommentsPhone, DMConversationPhone, StoryPhone } from "./PhoneComponents";
import { MAX_DM_RESPONSES, MAX_DM_OPENING_VARIATIONS } from "@/lib/api/schemas";

interface ConfigureStepProps {
    data: AutomationFlowData;
    onUpdate: (d: Partial<AutomationFlowData>) => void;
    creatorProfilePicUrl?: string | null;
    // Fresh thumbnail (2026-11-22): the stored postThumbnailUrl
    // snapshot expires within days (CDN signatures), so the modal
    // resolves a fresh URL at render time and passes it here. It is
    // deliberately a render-only prop — never written into flowData,
    // or the form would look dirty with no user change.
    freshThumbnailUrl?: string | null;
    // Takes the user back to step 1 "Choose a post" (the modal's
    // existing setStep(1) path). Without this the only way to change
    // the post was the header Back button, which users did not find.
    // Only rendered for comment flows — the Selected post box below
    // only exists for those — so step 1 always exists when it shows.
    onChangePost?: () => void;
}

function randomId() { return Math.random().toString(36).slice(2, 9); }

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB

// `overflow-y-auto` makes overflow-x compute to `auto`, so the form
// column could scroll horizontally and clip its own left edge (live:
// Name showed "mment funnel", labels lost their first letters, header
// and preview untouched). `overflow-x-clip` forbids horizontal
// scrolling entirely — even focus/programmatic scrolls — while keeping
// vertical scroll. Belt-and-braces with the `min-w-0` on the flex-row
// inputs below, the real fix for rows that could force the column wider.
const inputCls = "w-full min-w-0 text-[13px] bg-background border border-border rounded-lg px-3 py-2 outline-none focus:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/30 transition-colors";
const textareaCls = "w-full text-[13px] bg-background border border-border rounded-lg px-3 pt-2 pb-6 outline-none focus:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/30 transition-colors resize-none field-sizing-content";

/* Per-type copy - the builder speaks the trigger's language */
const TYPE_COPY: Record<string, {
    keywordModeSpecific: string;
    keywordModeAny: string;
    keywordPlaceholder: string;
    anyModeHint: string | null;
}> = {
    "comment-dm": {
        keywordModeSpecific: "Specific keywords",
        keywordModeAny: "Any comment",
        keywordPlaceholder: "Type a keyword and press Enter…",
        anyModeHint: null,
    },
    "dm-reply": {
        keywordModeSpecific: "Specific keywords",
        keywordModeAny: "Any message",
        keywordPlaceholder: "e.g. DIET, GUIDE, LINK…",
        anyModeHint: "Any message replies to EVERY DM you receive - including real conversations. Use specific keywords unless you're sure.",
    },
    "story-reply": {
        keywordModeSpecific: "Specific keywords",
        keywordModeAny: "Any reply",
        keywordPlaceholder: "e.g. DIET, GUIDE, LINK…",
        anyModeHint: null,
    },
    "reel-dm": {
        // Keyword fields below are unused since 2026-11-17 (the editor
        // renders no keyword UI for reel_dm) — kept only because the
        // TYPE_COPY shape requires them for every trigger type.
        keywordModeSpecific: "Specific keywords",
        keywordModeAny: "Any share",
        keywordPlaceholder: "e.g. DIET, GUIDE, LINK…",
        anyModeHint: "Triggers on every share of this reel — no keyword needed. Keywords only add an extra filter on the share's text, and most reels are shared with no text at all.",
    },
    "story-mention": {
        keywordModeSpecific: "Specific keywords",
        keywordModeAny: "Any mention",
        keywordPlaceholder: "e.g. DIET, GUIDE, LINK…",
        anyModeHint: "Triggers on every mention — no keyword needed. Keywords only add an extra filter on the mention's text, and most mentions carry no text at all.",
    },
    "fb-comment-dm": {
        keywordModeSpecific: "Specific keywords",
        keywordModeAny: "Any comment",
        keywordPlaceholder: "Type a keyword and press Enter…",
        anyModeHint: null,
    },
    "fb-dm-reply": {
        keywordModeSpecific: "Specific keywords",
        keywordModeAny: "Any message",
        keywordPlaceholder: "e.g. DIET, GUIDE, LINK…",
        anyModeHint: "Any message replies to EVERY message your Page receives - including real conversations. Use specific keywords unless you're sure.",
    },
};

/* ─── Toggle ─── */
function Toggle({ on, onChange, disabled }: { on: boolean; onChange: () => void; disabled?: boolean }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            onClick={onChange}
            disabled={disabled}
            className={cn(
                "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40 disabled:cursor-not-allowed",
                on ? "bg-secondary" : "bg-muted-foreground/25"
            )}
        >
            <span className={cn(
                "inline-block h-4 w-4 translate-y-[2px] rounded-full bg-white shadow-sm transition-transform duration-200",
                on ? "translate-x-[18px]" : "translate-x-[2px]"
            )} />
        </button>
    );
}

/* ─── Section header ─── */
function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
    return (
        <div className="flex items-center gap-3">
            <span className="micro-label text-foreground/80">{title}</span>
            <div className="h-px flex-1 bg-border" />
            {action}
        </div>
    );
}

/* ─── Accordion section ───
 * Stepped editor (2026-11-22, owner): the configure form shows one
 * section at a time — Post → Keyword → Follow required → DM message.
 * The header always shows a short summary of what is set, so progress
 * is visible at a glance without opening the section. "Continue" only
 * opens the next section — it never validates or saves; validation
 * still happens at Save in the modal footer, exactly as before. */
function AccordionSection({ index, title, summary, summaryTitle, done, open, onToggle, onContinue, isLast, children }: {
    index: number;
    title: string;
    summary: string;
    /** Full text behind a truncated summary — header tooltip. Falls back to the summary itself. */
    summaryTitle?: string;
    done: boolean;
    open: boolean;
    onToggle: () => void;
    onContinue: () => void;
    isLast: boolean;
    children: React.ReactNode;
}) {
    return (
        <div className="border border-border rounded-lg overflow-hidden">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 bg-muted/50 hover:bg-muted/70 transition-colors text-left"
            >
                <span className={cn(
                    "w-5 h-5 rounded-full text-[11px] font-bold flex items-center justify-center shrink-0",
                    done ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                )}>
                    {done ? <Check className="w-3 h-3" /> : index}
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-foreground">{title}</span>
                    <span className="block text-[11px] text-muted-foreground truncate" title={summaryTitle ?? summary}>{summary}</span>
                </span>
                <CaretDown className={cn("w-4 h-4 text-muted-foreground transition-transform shrink-0", open && "rotate-180")} />
            </button>
            {/* Audit fix (2026-11-22): the open/close animation used
                to be a motion.div animating height 0 -> "auto" with
                overflow-hidden — motion measures "auto" once, when
                the animation starts, so content that appears AFTER
                the section opens (the Any-mode DM warning, toggled on
                later; the AI-reply note below it) was vertically
                clipped by the stale measured height, cut off
                mid-sentence with no ellipsis. The grid-rows technique
                sizes intrinsically instead: the row is 1fr of the
                content's own height, so later-appearing content
                grows the section and is never clipped. Sections stay
                mounted while closed (rows 0fr + invisible), so
                in-progress input is kept, not reset, on reopen. */}
            <div
                className={cn(
                    "grid transition-[grid-template-rows] duration-200 ease-out",
                    open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                )}
            >
                <div className={cn("overflow-hidden min-h-0 transition-opacity duration-200", open ? "opacity-100" : "opacity-0 invisible")} aria-hidden={!open}>
                    <div className="p-3 space-y-3">
                        {children}
                        {!isLast && (
                            <div className="flex justify-end pt-1">
                                <button
                                    type="button"
                                    onClick={onContinue}
                                    className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-[13px] font-semibold hover:bg-primary/90 transition-colors"
                                >
                                    Continue
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

/* ─── AI drafting control (Phase 7, owner-approved mixed scope) ───
 * One owner-only drafting call to POST /api/ai/generate. Sends only the
 * owner's own prompt (+ automation name / post caption where the action
 * uses them) — no audience data is involved. The generated text is shown
 * to the owner in the builder and is only used if they save the automation;
 * generation itself sends nothing anywhere. The prompt input is transient
 * local state and is never persisted. */
type AiDraftAction = "opening_variations" | "public_replies" | "response_draft" | "follow_up_draft";

function AiDraftControl({ action, label, placeholder, defaultPrompt, automationName, postCaption, language, disabled, onResult }: {
    action: AiDraftAction;
    label: string;
    placeholder: string;
    defaultPrompt: string;
    automationName: string;
    postCaption?: string;
    /** AI reply language for the generated text (2026-11-17): 'en' or 'hinglish'. */
    language?: "en" | "hinglish";
    disabled?: boolean;
    onResult: (res: { variations?: string[]; draft?: string; status?: string }) => void;
}) {
    const [prompt, setPrompt] = useState(defaultPrompt);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const generate = async () => {
        if (busy || disabled) return;
        setBusy(true);
        setError("");
        try {
            const res = await apiClient<{ success: boolean; variations?: string[]; draft?: string; status?: string; error?: string }>("/ai/generate", {
                method: "POST",
                body: JSON.stringify({
                    action,
                    prompt: prompt.trim(),
                    automationName,
                    ...(postCaption ? { postCaption } : {}),
                    ...(language ? { language } : {}),
                    count: 5,
                }),
            });
            onResult(res);
        } catch (e) {
            setError(e instanceof ApiError ? (e.body.error ?? e.body.message ?? e.message) : "Generation failed. Try again.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="space-y-1.5">
            <div className="flex items-start gap-1.5">
                <textarea
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); generate(); } }}
                    placeholder={placeholder}
                    disabled={disabled}
                    rows={2}
                    className={cn(inputCls, "resize-none")}
                />
                <button
                    onClick={generate}
                    disabled={busy || disabled}
                    className="inline-flex items-center gap-1.5 h-[34px] px-3 rounded-lg text-[12px] font-semibold border border-border text-foreground hover:bg-muted disabled:cursor-not-allowed transition-colors shrink-0"
                >
                    <Lightning className="w-3.5 h-3.5 text-primary" />
                    {busy ? "Generating…" : label}
                </button>
            </div>
            {error && <p className="text-[12px] text-destructive font-medium">{error}</p>}
        </div>
    );
}

/* ─── Keyword input ─── */
function KeywordInput({ keywords, onChange, anyMode, onAnyModeChange, copy }: {
    keywords: string[];
    onChange: (kws: string[]) => void;
    anyMode: boolean;
    onAnyModeChange: (isAny: boolean) => void;
    copy: typeof TYPE_COPY[string];
}) {
    const [input, setInput] = useState("");

    const addKw = (raw: string) => {
        const trimmed = raw.trim().toUpperCase();
        if (trimmed && !keywords.includes(trimmed)) {
            onChange([...keywords, trimmed]);
        }
        setInput("");
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            addKw(input);
        } else if (e.key === "Backspace" && !input && keywords.length > 0) {
            onChange(keywords.slice(0, -1));
        }
    };

    return (
        <div className="space-y-2.5">
            <div className="inline-flex items-center bg-muted rounded-lg p-0.5">
                {[
                    { label: copy.keywordModeSpecific, value: false },
                    { label: copy.keywordModeAny, value: true },
                ].map(opt => (
                    <button
                        key={String(opt.value)}
                        onClick={() => onAnyModeChange(opt.value)}
                        className={cn(
                            "h-7 px-3 rounded-[7px] text-[12px] font-medium transition-colors",
                            anyMode === opt.value
                                ? "bg-card text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {opt.label}
                    </button>
                ))}
            </div>

            {anyMode && copy.anyModeHint && (
                <div className="flex items-start gap-2 text-[12px] text-amber-600 bg-amber-500/10 rounded-lg px-3 py-2">
                    <Warning className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    {copy.anyModeHint}
                </div>
            )}

            {!anyMode && (
                <div>
                    <div className="flex flex-wrap gap-1.5 p-1.5 bg-background border border-border rounded-lg min-h-[40px] focus-within:border-foreground/30 transition-colors">
                        {keywords.map(kw => (
                            <span key={kw} className="inline-flex items-center gap-1 bg-primary/10 text-primary text-[11.5px] font-semibold px-2 py-1 rounded-md">
                                {kw}
                                <button onClick={() => onChange(keywords.filter(k => k !== kw))} className="opacity-60 hover:opacity-100">
                                    <X className="w-2.5 h-2.5" />
                                </button>
                            </span>
                        ))}
                        <input
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            onKeyDown={onKeyDown}
                            onBlur={() => input.trim() && addKw(input)}
                            placeholder={keywords.length === 0 ? copy.keywordPlaceholder : "Add another…"}
                            className="flex-1 min-w-[110px] bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/50 px-1 py-0.5"
                        />
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">Separate with Enter or comma. Case-insensitive, whole-word match.</p>
                </div>
            )}
        </div>
    );
}

/* ─── Card editor ─── */
function CardEditor({ res, onUpdate }: { res: DMResponse; onUpdate: (p: Partial<DMResponse>) => void }) {
    const [sizeError, setSizeError] = useState("");
    const buttons = res.cardButtons ?? [];

    const handleFile = (file: File | undefined) => {
        setSizeError("");
        if (!file) return;
        if (file.size > MAX_IMAGE_BYTES) {
            setSizeError("Image must be under 2 MB.");
            return;
        }
        const reader = new FileReader();
        reader.onload = ev => onUpdate({ cardImage: ev.target?.result as string });
        reader.readAsDataURL(file);
    };

    const addBtn = () => onUpdate({ cardButtons: [...buttons, { id: randomId(), title: "Learn more", link: "" }] });
    const updateBtn = (id: string, patch: Partial<CardButton>) =>
        onUpdate({ cardButtons: buttons.map(b => b.id === id ? { ...b, ...patch } : b) });
    const removeBtn = (id: string) => onUpdate({ cardButtons: buttons.filter(b => b.id !== id) });

    return (
        <div className="space-y-3">
            <div className="border border-dashed border-border rounded-lg overflow-hidden">
                {res.cardImage ? (
                    <div className="relative">
                        <img src={res.cardImage} className="w-full h-32 object-cover" alt="card" />
                        <button onClick={() => onUpdate({ cardImage: "" })} className="absolute top-2 right-2 bg-black/60 text-white rounded-full p-1">
                            <X className="w-3 h-3" />
                        </button>
                    </div>
                ) : (
                    <label className="flex flex-col items-center justify-center h-24 cursor-pointer hover:bg-muted/40 transition-colors gap-1.5">
                        <ImageIcon className="w-5 h-5 text-muted-foreground/40" />
                        <span className="text-[12px] text-muted-foreground font-medium">Upload an image</span>
                        <span className="text-[10px] text-muted-foreground/60">Max 2 MB · JPG, PNG, WebP</span>
                        <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
                            onChange={e => handleFile(e.target.files?.[0])} />
                    </label>
                )}
            </div>
            {sizeError && <p className="text-[12px] text-destructive font-medium">{sizeError}</p>}

            <div>
                <label className="micro-label block mb-1">Card title</label>
                <input value={res.cardTitle ?? ""} onChange={e => onUpdate({ cardTitle: e.target.value })} maxLength={80}
                    placeholder="e.g. The Complete Creator Toolkit" className={inputCls} />
            </div>

            <div>
                <label className="micro-label block mb-1">Subtitle</label>
                <input value={res.cardSubtitle ?? ""} onChange={e => onUpdate({ cardSubtitle: e.target.value })} maxLength={80}
                    placeholder="Short description" className={inputCls} />
            </div>

            <div>
                <div className="flex items-center justify-between mb-1.5">
                    <label className="micro-label">Buttons (max 3)</label>
                    {buttons.length < 3 && (
                        <button onClick={addBtn} className="text-[12px] text-primary font-semibold flex items-center gap-1 hover:opacity-80">
                            <Plus className="w-3 h-3" /> Add
                        </button>
                    )}
                </div>
                <div className="space-y-1.5">
                    {buttons.map(btn => (
                        <div key={btn.id} className="flex gap-1.5">
                            <input value={btn.title} onChange={e => updateBtn(btn.id, { title: e.target.value })} placeholder="Button label" className={inputCls} />
                            <input value={btn.link} onChange={e => updateBtn(btn.id, { link: e.target.value })} placeholder="https://" className={inputCls} />
                            <button onClick={() => removeBtn(btn.id)} className="p-2 text-muted-foreground hover:text-destructive shrink-0">
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

/* ─── Text response editor ─── */
/* Link buttons (2026-11-22): a text step carries up to 2 link buttons.
 * Stored as `buttons` (max 2); the legacy buttonTitle/buttonLink fields
 * stay synced to buttons[0] so old automations and every legacy reader
 * keep working unchanged. */
const DRAFT_LINK_BUTTON_ID = "draft-link-1";

function TextEditor({ res, onUpdate }: { res: DMResponse; onUpdate: (p: Partial<DMResponse>) => void }) {
    const storedButtons = res.buttons ?? [];
    // Legacy single-button rows have no `buttons` array — read them as one button.
    const legacyButton: CardButton[] = res.buttonLink?.trim()
        ? [{ id: "legacy", title: res.buttonTitle ?? "", link: res.buttonLink }]
        : [];
    const buttons = storedButtons.length > 0 ? storedButtons : legacyButton;
    const [showBtn, setShowBtn] = useState(buttons.length > 0);
    // First visit to the block (no button stored yet): show one empty
    // draft row without writing anything until the user types.
    const visibleButtons = showBtn
        ? (buttons.length > 0 ? buttons : [{ id: DRAFT_LINK_BUTTON_ID, title: "", link: "" }])
        : [];

    const syncButtons = (next: CardButton[]) => onUpdate({
        buttons: next,
        buttonTitle: next[0]?.title ?? "",
        buttonLink: next[0]?.link ?? "",
    });
    const updateButton = (id: string, patch: Partial<CardButton>) =>
        syncButtons(visibleButtons.map(b => b.id === id ? { ...b, ...patch } : b));
    const addButton = () => syncButtons([...visibleButtons, { id: randomId(), title: "", link: "" }]);
    const removeButton = (id: string) => {
        const next = buttons.filter(b => b.id !== id);
        if (next.length === 0) setShowBtn(false);
        syncButtons(next);
    };

    return (
        <div className="space-y-2.5">
            <div className="relative">
                <textarea
                    value={res.content}
                    onChange={e => onUpdate({ content: e.target.value })}
                    maxLength={1000}
                    rows={3}
                    placeholder="Type your message…"
                    className={textareaCls}
                />
                <span className="absolute bottom-2 right-3 text-[10px] text-muted-foreground tabular-nums">{res.content.length}/1000</span>
            </div>

            {visibleButtons.map((btn, i) => (
                <div key={btn.id} className="rounded-lg border border-border overflow-hidden">
                    <div className="px-3 py-1.5 bg-muted/50 border-b border-border flex items-center justify-between">
                        <span className="micro-label">Link button{i > 0 ? ` ${i + 1}` : ""}</span>
                        <button onClick={() => removeButton(btn.id)}
                            className="text-muted-foreground hover:text-destructive">
                            <X className="w-3 h-3" />
                        </button>
                    </div>
                    <div className="p-2.5 space-y-1.5">
                        <input value={btn.title} onChange={e => updateButton(btn.id, { title: e.target.value })}
                            placeholder="Button label (e.g. Get the guide)" className={inputCls} />
                        <input value={btn.link} onChange={e => updateButton(btn.id, { link: e.target.value })}
                            placeholder="https://your-link.com" className={inputCls} />
                        {i === 0 && <p className="text-[10px] text-muted-foreground">Delivered as a tappable button inside the DM.</p>}
                    </div>
                </div>
            ))}

            {showBtn ? (
                buttons.length === 1 && (
                    <button onClick={addButton}
                        className="flex items-center gap-1 text-[12px] font-semibold text-primary hover:opacity-80 transition-opacity">
                        <Plus className="w-3 h-3" /> Add another link
                    </button>
                )
            ) : (
                <button onClick={() => setShowBtn(true)}
                    className="flex items-center gap-1 text-[12px] font-semibold text-primary hover:opacity-80 transition-opacity">
                    <Plus className="w-3 h-3" /> Add link button
                </button>
            )}
        </div>
    );
}

/* ─── Lead form editor ───
 * A lead_form response sends its ask text as a plain DM, then stores the
 * audience member's next reply as a lead (email and/or phone) when it
 * looks like the requested value. Captured values appear on the Leads
 * tab of the Contacts page. At least one field must stay selected. */
function LeadFormEditor({ res, onUpdate }: { res: DMResponse; onUpdate: (p: Partial<DMResponse>) => void }) {
    const fields = res.leadFields ?? ["email"];
    const toggleField = (field: "email" | "phone") => {
        const next = fields.includes(field)
            ? fields.filter(f => f !== field)
            : [...fields, field];
        // Never allow zero fields — an ask with nothing to collect is meaningless.
        if (next.length === 0) return;
        onUpdate({ leadFields: next });
    };

    return (
        <div className="space-y-2.5">
            <div className="relative">
                <textarea
                    value={res.content}
                    onChange={e => onUpdate({ content: e.target.value })}
                    maxLength={1000}
                    rows={3}
                    placeholder="e.g. What's your email? I'll send the guide there."
                    className={textareaCls}
                />
                <span className="absolute bottom-2 right-3 text-[10px] text-muted-foreground tabular-nums">{res.content.length}/1000</span>
            </div>
            <div>
                <label className="micro-label block mb-1.5">Collect</label>
                <div className="flex gap-1.5">
                    {(["email", "phone"] as const).map(field => (
                        <button
                            key={field}
                            type="button"
                            onClick={() => toggleField(field)}
                            aria-pressed={fields.includes(field)}
                            className={cn(
                                "inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium border transition-colors capitalize",
                                fields.includes(field)
                                    ? "border-foreground/40 bg-muted text-foreground"
                                    : "border-border text-muted-foreground hover:text-foreground"
                            )}
                        >
                            {field === "email" ? "Email" : "Phone"}
                        </button>
                    ))}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1.5">
                    Their next reply is saved as a lead when it looks like {fields.join(" or ")}. Answers appear on the Leads tab of the Contacts page.
                </p>
            </div>
        </div>
    );
}

/* ─── Response block ─── */
function ResponseBlock({ res, idx, onUpdate, onDelete }: {
    res: DMResponse;
    idx: number;
    onUpdate: (p: Partial<DMResponse>) => void;
    onDelete: () => void;
}) {
    const [open, setOpen] = useState(true);
    const typeLabel = res.type === "card" ? "Card message" : res.type === "lead_form" ? "Lead form" : "Text message";

    return (
        <div className="border border-border rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-3 h-9 bg-muted/50 border-b border-border">
                <div className="flex items-center gap-2">
                    <span className="w-[18px] h-[18px] rounded-full bg-primary/10 text-primary text-[10px] font-bold flex items-center justify-center shrink-0">{idx + 1}</span>
                    <span className="text-[12px] font-semibold text-foreground">{typeLabel}</span>
                </div>
                <div className="flex items-center">
                    <button onClick={() => setOpen(o => !o)} className="p-1.5 text-muted-foreground hover:text-foreground rounded-md transition-colors">
                        <CaretDown className={cn("w-3.5 h-3.5 transition-transform", open && "rotate-180")} />
                    </button>
                    <button onClick={onDelete} className="p-1.5 text-muted-foreground hover:text-destructive rounded-md transition-colors">
                        <Trash className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>
            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="overflow-hidden"
                    >
                        <div className="p-3">
                            {res.type === "card"
                                ? <CardEditor res={res} onUpdate={onUpdate} />
                                : res.type === "lead_form"
                                    ? <LeadFormEditor res={res} onUpdate={onUpdate} />
                                    : <TextEditor res={res} onUpdate={onUpdate} />
                            }
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

/* ═══════════════════════ Main ConfigureStep ═══════════════════════ */
export function ConfigureStep({ data, onUpdate, creatorProfilePicUrl, onChangePost, freshThumbnailUrl }: ConfigureStepProps) {
    const [phonePhase, setPhonePhase] = useState<"initial" | "clicked" | "followed">("initial");
    const [repliesSaved, setRepliesSaved] = useState(data.customReplies.length > 0);
    const [commentInput, setCommentInput] = useState("");
    // AI-drafted opening variations offered as a picker (transient, never persisted).
    const [openingAiOptions, setOpeningAiOptions] = useState<string[] | null>(null);
    // True when the shown picker items are template suggestions because no
    // AI provider answered (status 'fallback') — surfaced honestly in the
    // picker header instead of presenting canned lines as AI output.
    const [openingAiFallback, setOpeningAiFallback] = useState(false);
    // Opening-message variations - the tab the editor is looking at.
    // One variation is picked at random for each DM the engine sends.
    const variations = data.dmOpeningMessageVariations.length > 0
        ? data.dmOpeningMessageVariations
        : [data.dmOpeningMessage];
    const [activeVariationTab, setActiveVariationTab] = useState(0);
    const safeVariationTab = Math.min(activeVariationTab, variations.length - 1);
    const activeOpeningMessage = variations[safeVariationTab] ?? data.dmOpeningMessage;
    // Small screens show form OR live preview, never both - xl shows both.
    const [mobileTab, setMobileTab] = useState<"form" | "preview">("form");

    const updateVariation = (idx: number, value: string) => {
        const next = [...variations];
        next[idx] = value;
        // Variation 1 stays mirrored into the legacy single-message field.
        onUpdate({ dmOpeningMessageVariations: next, dmOpeningMessage: next[0] ?? value });
    };
    const addVariation = () => {
        if (variations.length >= MAX_DM_OPENING_VARIATIONS) return;
        const next = [...variations, ""];
        onUpdate({ dmOpeningMessageVariations: next });
        setActiveVariationTab(next.length - 1);
    };
    const removeVariation = (idx: number) => {
        if (variations.length <= 1) return;
        const next = variations.filter((_, i) => i !== idx);
        onUpdate({ dmOpeningMessageVariations: next, dmOpeningMessage: next[0] ?? data.dmOpeningMessage });
        setActiveVariationTab(Math.max(0, Math.min(safeVariationTab, next.length - 1)));
    };

    const flowType = data.type ?? "comment-dm";
    const isComment = flowType === "comment-dm" || flowType === "fb-comment-dm";
    const isStory = flowType === "story-reply";
    const isStoryMention = flowType === "story-mention";
    const isReelDm = flowType === "reel-dm";
    /** Facebook triggers (2026-11-19) — no require-follow (no Page-follow
     *  signal), no lead form and no scheduled follow-ups in v1; the API
     *  rejects those fields with 400. */
    const isFacebook = flowType === "fb-comment-dm" || flowType === "fb-dm-reply";
    // Post-targeted flows (comment-dm, reel-dm, fb-comment-dm) show the selected post.
    const hasPostTarget = isComment || isReelDm;
    const copy = TYPE_COPY[flowType] ?? TYPE_COPY["comment-dm"]!;

    // Shared Reel funnels are always "any share" (2026-11-17): the share
    // itself is the trigger, so there is no keyword mode to pick — the
    // editor offers no keyword UI for reel_dm at all.
    const isAnyMode = isReelDm || (data.keywordsAnyMode ?? data.keywords.length === 0);
    const previewKeywords = isAnyMode ? ["😍", "🔥✨", "❤️🙌"] : data.keywords.slice(0, 3);
    // Mentions usually carry no text, so the preview shows the mention
    // label with no trigger bubble (the phone renders the label alone).
    const previewTriggerText = isAnyMode ? (isStory ? "Love this! 🔥" : isStoryMention ? "" : "Hey! 👋") : (data.keywords[0] ?? "DIET");

    const addResponse = (type: "text" | "card" | "lead_form") => {
        onUpdate({
            dmResponses: [
                ...data.dmResponses,
                {
                    id: randomId(),
                    type,
                    content: "",
                    ...(type === "card" ? { cardTitle: "", cardSubtitle: "", cardButtons: [] } : {}),
                    ...(type === "lead_form" ? { leadFields: ["email"] as ("email" | "phone")[] } : {}),
                },
            ],
        });
    };

    const updateResponse = (idx: number, patch: Partial<DMResponse>) => {
        const updated = [...data.dmResponses];
        updated[idx] = { ...updated[idx]!, ...patch } as DMResponse;
        onUpdate({ dmResponses: updated });
    };

    const deleteResponse = (idx: number) => {
        onUpdate({ dmResponses: data.dmResponses.filter((_, i) => i !== idx) });
    };

    const addCommentReply = () => {
        const t = commentInput.trim();
        if (!t) return;
        onUpdate({ customReplies: [...data.customReplies, t] });
        setCommentInput("");
    };

    const canAddMoreResponses =
        data.dmResponses.length < MAX_DM_RESPONSES &&
        (data.dmOpeningMessageEnabled ? true : data.dmResponses.length < 1);

    // Stepped sections (2026-11-22, owner): the configure form is an
    // accordion — Post → Keyword → Follow required → DM message, one
    // open at a time. Only the wrapping changed: every block below is
    // the same JSX, moved unchanged, and the save payload is untouched.
    const sections = getEditorSections(data);
    const [openSection, setOpenSection] = useState<EditorSectionId>(sections[0]?.id ?? "dm");
    const openIndex = sections.findIndex((s) => s.id === openSection);
    const goToNextSection = () => {
        if (openIndex >= 0 && openIndex < sections.length - 1) {
            setOpenSection(sections[openIndex + 1]!.id);
        }
    };

    // Section 1 — Post. The selected-post box (with Change post) from
    // the old flat form. reel_dm keeps its "share is the trigger" note
    // here, since it has no keyword section. The thumbnail is the
    // fresh URL when the modal resolved one (2026-11-22) — the stored
    // snapshot expires within days, so a raw <img> of it shows a
    // broken icon; PostThumb falls back to a clean muted box.
    const postThumbUrl = freshThumbnailUrl ?? data.postThumbnailUrl;
    const postContent = (
        <>
            {data.postId && data.postId !== "all" ? (
                <div className="flex items-center gap-2.5 p-2.5 bg-muted/40 rounded-lg">
                    <PostThumb
                        src={postThumbUrl}
                        alt="post"
                        className="w-9 h-9 rounded-md shrink-0"
                        fallback={
                            <div className="w-9 h-9 rounded-md bg-muted flex items-center justify-center shrink-0">
                                <ImageIcon className="w-4 h-4 text-muted-foreground/60" />
                            </div>
                        }
                    />
                    <div className="min-w-0 flex-1">
                        <p className="micro-label">Selected post</p>
                        <p className="text-[12px] text-foreground truncate" title={data.postCaption ?? undefined}>
                            {data.postCaption ? truncateWithEllipsis(data.postCaption, 70) : "No caption"}
                        </p>
                    </div>
                    {onChangePost && (
                        <button
                            type="button"
                            onClick={onChangePost}
                            className="inline-flex items-center h-7 px-2.5 text-[12px] font-medium border border-border hover:bg-muted rounded-lg transition-colors shrink-0"
                        >
                            Change post
                        </button>
                    )}
                </div>
            ) : (
                <div className="flex items-center gap-2 px-3 py-2 bg-muted/40 rounded-lg">
                    <Lightning className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-[12px] font-medium text-muted-foreground">
                        {isReelDm ? "Triggers on any shared reel" : "Triggers on all posts"}
                    </span>
                </div>
            )}
            {isReelDm && (
                <p className="text-[12px] text-muted-foreground">
                    The share itself is the trigger — every time someone shares this reel in a DM, they get the link. No keyword needed.
                </p>
            )}
        </>
    );

    // Section 2 — Keyword / comment. Trigger keywords, the AI reply
    // language and the public comment replies (comment flows only).
    const keywordContent = (
        <div className="space-y-3">
            <KeywordInput
                keywords={data.keywords}
                onChange={kws => onUpdate({ keywords: kws })}
                anyMode={isAnyMode}
                onAnyModeChange={isAny => onUpdate({ keywordsAnyMode: isAny })}
                copy={copy}
            />

            {/* AI reply language (2026-11-17) — the language AI-drafted
                replies are generated in. The labels here stay in
                English; only the generated reply text changes. */}
            <section className="space-y-2">
                <SectionHeader title="AI reply language" />
                <p className="text-[12px] text-muted-foreground">
                    Language for AI-drafted replies in this automation. Hinglish is Hindi in Roman script, for an audience that speaks it.
                </p>
                <div className="inline-flex items-center bg-muted rounded-lg p-0.5">
                    {(["en", "hinglish"] as const).map((lang) => (
                        <button
                            key={lang}
                            type="button"
                            onClick={() => onUpdate({ aiReplyLanguage: lang })}
                            aria-pressed={data.aiReplyLanguage === lang}
                            className={cn(
                                "h-7 px-3 rounded-[7px] text-[12px] font-medium transition-colors",
                                data.aiReplyLanguage === lang
                                    ? "bg-card text-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            {lang === "en" ? "English" : "Hinglish"}
                        </button>
                    ))}
                </div>
            </section>

            {/* Public comment replies - comment automations only */}
            {isComment && (
                <section className="space-y-2.5">
                    <SectionHeader
                        title="Public comment reply"
                        action={<span className="text-[11px] font-medium text-muted-foreground shrink-0">{data.customReplies.length} variation{data.customReplies.length === 1 ? "" : "s"}</span>}
                    />
                    <p className="text-[12px] text-muted-foreground">
                        A random line from this list is posted publicly under the trigger comment.
                    </p>

                    <div className="space-y-1.5">
                        {data.customReplies.map((r, i) => (
                            <div key={i} className="flex items-center gap-1.5 group">
                                <span className="flex-1 min-w-0 text-[13px] text-foreground bg-muted/40 rounded-lg px-3 py-1.5 truncate">{r}</span>
                                <button
                                    onClick={() => onUpdate({ customReplies: data.customReplies.filter((_, j) => j !== i) })}
                                    className="opacity-50 hover:opacity-100 focus-visible:opacity-100 p-1.5 text-muted-foreground hover:text-destructive transition-all shrink-0"
                                    title="Remove this variation"
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            </div>
                        ))}
                    </div>

                    <div className="flex gap-1.5">
                        <input
                            value={commentInput}
                            onChange={e => setCommentInput(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addCommentReply(); } }}
                            placeholder="Type a reply and press Enter…"
                            className={inputCls}
                        />
                        <button
                            onClick={() => { addCommentReply(); setRepliesSaved(true); }}
                            className="w-9 h-9 flex items-center justify-center bg-muted rounded-lg hover:bg-muted/70 transition-colors shrink-0"
                        >
                            <Plus className="w-3.5 h-3.5" />
                        </button>
                    </div>

                    <AiDraftControl
                        action="public_replies"
                        label="Generate with AI"
                        placeholder="Describe the vibe for the replies…"
                        defaultPrompt="Generate warm, natural 1-sentence Instagram comment replies confirming we sent them a DM"
                        automationName={data.name}
                        language={data.aiReplyLanguage}
                        postCaption={data.postCaption}
                        onResult={res => {
                            if (res.variations && res.variations.length > 0) {
                                onUpdate({ customReplies: res.variations });
                                setRepliesSaved(true);
                            }
                        }}
                    />
                    <p className="text-[11px] text-muted-foreground">AI drafts replacement replies from your prompt, review, edit or delete them before saving.</p>
                </section>
            )}
        </div>
    );

    // Section 3 — Follow required. The card is the same one that used
    // to live inside the Auto DM block; it only makes sense with Auto
    // DM on, so while Auto DM is off this section says so instead of
    // showing fields that could never fire.
    const followContent = !data.isAutoDmEnabled ? (
        <p className="text-[12px] text-muted-foreground">
            Turn on Auto DM in the DM message section to require a follow.
        </p>
    ) : (
        // Require follow — Facebook has no "follows the Page" signal,
        // so this section is hidden for FB triggers (the follow section
        // only exists for non-Facebook types).
        <div className="border border-border rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2.5 bg-muted/50 border-b border-border">
                <div>
                    <p className="text-[12.5px] font-semibold text-foreground">Require follow</p>
                    <p className="text-[11px] text-muted-foreground">Deliver only after Instagram confirms they follow you</p>
                </div>
                <Toggle on={data.askToFollowEnabled} onChange={() => onUpdate({ askToFollowEnabled: !data.askToFollowEnabled })} />
            </div>

            <AnimatePresence>
                {data.askToFollowEnabled && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="overflow-hidden"
                    >
                        <div className="p-3 space-y-2.5">
                            <div>
                                <label className="micro-label block mb-1">&ldquo;Not following&rdquo; message</label>
                                <textarea
                                    value={data.askToFollowMessage}
                                    onChange={e => onUpdate({ askToFollowMessage: e.target.value })}
                                    rows={2}
                                    maxLength={80}
                                    placeholder="Hey! It seems you're not following me yet…"
                                    className={textareaCls}
                                />
                                <p className="text-[10px] text-muted-foreground mt-0.5">Max 80 chars (card title limit).</p>
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="micro-label block mb-1">Profile button</label>
                                    <input
                                        value={data.askToFollowVisitProfileButton}
                                        onChange={e => onUpdate({ askToFollowVisitProfileButton: e.target.value })}
                                        maxLength={20}
                                        placeholder="Visit Profile"
                                        className={inputCls}
                                    />
                                </div>
                                <div>
                                    <label className="micro-label block mb-1">Confirm button</label>
                                    <input
                                        value={data.askToFollowConfirmButton}
                                        onChange={e => onUpdate({ askToFollowConfirmButton: e.target.value })}
                                        maxLength={20}
                                        placeholder="I'm following ✅"
                                        className={inputCls}
                                    />
                                </div>
                            </div>
                            <p className="text-[10px] text-muted-foreground">
                                Follow status is really checked via Instagram&apos;s profile API - followers skip this card,
                                and the confirm tap re-checks before delivering.
                            </p>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );

    // Section 4 — DM message. Auto DM (opening message + responses),
    // with the scheduled follow-up message below it in the same
    // section, as the owner asked.
    const dmContent = (
        <div className="space-y-3">
            <SectionHeader
                title="Auto DM"
                action={<Toggle on={data.isAutoDmEnabled} onChange={() => onUpdate({ isAutoDmEnabled: !data.isAutoDmEnabled })} />}
            />

            <AnimatePresence>
                {data.isAutoDmEnabled && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.18 }}
                        className="overflow-hidden space-y-3"
                    >
                        {/* Opening message */}
                        <div className="border border-border rounded-lg overflow-hidden">
                            <div className="flex items-center justify-between px-3 py-2.5 bg-muted/50 border-b border-border">
                                <div>
                                    <p className="text-[12.5px] font-semibold text-foreground">Opening message</p>
                                    <p className="text-[11px] text-muted-foreground">The first DM, sent automatically on trigger</p>
                                </div>
                                <Toggle
                                    on={data.dmOpeningMessageEnabled}
                                    onChange={() => onUpdate({ dmOpeningMessageEnabled: !data.dmOpeningMessageEnabled })}
                                />
                            </div>
                            <AnimatePresence>
                                {data.dmOpeningMessageEnabled && (
                                    <motion.div
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: "auto", opacity: 1 }}
                                        exit={{ height: 0, opacity: 0 }}
                                        transition={{ duration: 0.18 }}
                                        className="overflow-hidden"
                                    >
                                        <div className="p-3 space-y-2.5">
                                            {/* Variations - one is picked at random for each DM.
                                                Restored 2026-11-12: this selector was lost in
                                                the 985ed5c redesign, so the editor showed a
                                                single message and the "3 variations" were
                                                nowhere to be found. */}
                                            <div className="flex items-center gap-1 flex-wrap">
                                                <div className="inline-flex items-center bg-muted rounded-lg p-0.5">
                                                    {variations.map((_, i) => (
                                                        <button
                                                            key={i}
                                                            onClick={() => setActiveVariationTab(i)}
                                                            className={cn(
                                                                "h-7 px-3 rounded-[7px] text-[12px] font-medium transition-colors",
                                                                safeVariationTab === i
                                                                    ? "bg-card text-foreground shadow-sm"
                                                                    : "text-muted-foreground hover:text-foreground"
                                                            )}
                                                        >
                                                            Variation {i + 1}
                                                        </button>
                                                    ))}
                                                </div>
                                                {variations.length < MAX_DM_OPENING_VARIATIONS && (
                                                    <button
                                                        onClick={addVariation}
                                                        className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg text-[12px] font-semibold text-primary hover:bg-primary/10 transition-colors"
                                                    >
                                                        <Plus className="w-3 h-3" /> Add variation
                                                    </button>
                                                )}
                                                {variations.length > 1 && (
                                                    <button
                                                        onClick={() => removeVariation(safeVariationTab)}
                                                        className="inline-flex items-center gap-1 h-7 px-2 text-[12px] font-medium text-muted-foreground hover:text-destructive transition-colors"
                                                    >
                                                        <Trash className="w-3 h-3" /> Remove
                                                    </button>
                                                )}
                                            </div>
                                            <p className="text-[11px] text-muted-foreground">
                                                {variations.length} variation{variations.length === 1 ? "" : "s"} - one is picked at random for each DM, so repeat commenters don&apos;t get the identical message every time.
                                            </p>
                                            <div className="relative">
                                                <textarea
                                                    value={activeOpeningMessage}
                                                    onChange={e => updateVariation(safeVariationTab, e.target.value)}
                                                    rows={4}
                                                    maxLength={1000}
                                                    placeholder="Hey! Thanks so much for stopping by…"
                                                    className={textareaCls}
                                                />
                                                <span className="absolute bottom-2 right-3 text-[10px] text-muted-foreground tabular-nums">{activeOpeningMessage.length}/1000</span>
                                            </div>
                                            {isComment && (
                                                <p className="text-[10px] text-muted-foreground">
                                                    Tip: <code className="font-mono bg-muted px-1 rounded">{"{username}"}</code> becomes the commenter&apos;s @handle.
                                                </p>
                                            )}

                                            <AiDraftControl
                                                action="opening_variations"
                                                label="Generate variations"
                                                placeholder="Describe the opening message…"
                                                defaultPrompt="Warm, friendly opening DM that thanks them for commenting and offers the link"
                                                automationName={data.name}
                                                language={data.aiReplyLanguage}
                                                postCaption={data.postCaption}
                                                onResult={res => {
                                                    if (res.variations && res.variations.length > 0) {
                                                        setOpeningAiOptions(res.variations);
                                                        setOpeningAiFallback(res.status === "fallback");
                                                    }
                                                }}
                                            />
                                            {openingAiOptions && openingAiOptions.length > 0 && (
                                                <div className="space-y-1.5">
                                                    <div className="flex items-center justify-between gap-2">
                                                        <p className="micro-label">AI variations, pick one</p>
                                                        {openingAiFallback && (
                                                            <p className="text-[11px] text-muted-foreground shrink-0">AI unavailable — template suggestions</p>
                                                        )}
                                                        <button onClick={() => { setOpeningAiOptions(null); setOpeningAiFallback(false); }} className="text-muted-foreground hover:text-foreground">
                                                            <X className="w-3.5 h-3.5" />
                                                        </button>
                                                    </div>
                                                    {openingAiOptions.map((v, i) => (
                                                        <button
                                                            key={i}
                                                            onClick={() => { updateVariation(safeVariationTab, v); setOpeningAiOptions(null); setOpeningAiFallback(false); }}
                                                            className="block w-full text-left text-[13px] text-foreground bg-muted/40 hover:bg-muted rounded-lg px-3 py-2 transition-colors"
                                                        >
                                                            {v}
                                                        </button>
                                                    ))}
                                                </div>
                                            )}

                                            <div className="rounded-lg border border-border p-2.5 space-y-1.5">
                                                <p className="micro-label">Reveal button</p>
                                                <p className="text-[11px] text-muted-foreground">They tap this to receive your responses - the tap confirms real interest.</p>
                                                <input
                                                    value={data.dmOpeningMessageButtonTitle}
                                                    onChange={e => onUpdate({ dmOpeningMessageButtonTitle: e.target.value })}
                                                    maxLength={20}
                                                    placeholder="Send me the link"
                                                    className={inputCls}
                                                />
                                                <p className="text-[10px] text-muted-foreground">Max 20 characters{isFacebook ? "" : " (Instagram limit)"}. Leave empty to send responses immediately.</p>
                                            </div>
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>

                        {/* Responses */}
                        <div className="space-y-2.5">
                            <SectionHeader title="Responses" />

                            {data.dmResponses.length >= MAX_DM_RESPONSES && (
                                <div className="text-[12px] text-muted-foreground bg-muted/50 rounded-lg px-3 py-2">
                                    Max {MAX_DM_RESPONSES} responses per flow - each one is a separate Instagram send, and short flows keep your account safe and your audience reading.
                                </div>
                            )}

                            {!data.dmOpeningMessageEnabled && data.dmResponses.length >= 1 && (
                                <div className="text-[12px] text-amber-600 bg-amber-500/10 rounded-lg px-3 py-2 font-medium">
                                    Opening message is off - only one response is sent.
                                </div>
                            )}

                            {data.dmResponses.map((res, idx) => (
                                <ResponseBlock
                                    key={res.id}
                                    res={res}
                                    idx={idx}
                                    onUpdate={p => updateResponse(idx, p)}
                                    onDelete={() => deleteResponse(idx)}
                                />
                            ))}

                            <div className="flex gap-1.5 flex-wrap">
                                <button
                                    onClick={() => canAddMoreResponses && addResponse("text")}
                                    disabled={!canAddMoreResponses}
                                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium border border-border text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                >
                                    <Chat className="w-3.5 h-3.5" /> Text message
                                </button>
                                <button
                                    onClick={() => canAddMoreResponses && addResponse("card")}
                                    disabled={!canAddMoreResponses}
                                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium border border-border text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                >
                                    <SquaresFour className="w-3.5 h-3.5" /> Card message
                                </button>
                                {/* Lead forms are not supported for
                                    Facebook in v1 (API rejects them). */}
                                {!isFacebook && (
                                <button
                                    onClick={() => canAddMoreResponses && addResponse("lead_form")}
                                    disabled={!canAddMoreResponses}
                                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium border border-border text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                >
                                    <Chat className="w-3.5 h-3.5" /> Lead form
                                </button>
                                )}
                            </div>

                            <AiDraftControl
                                action="response_draft"
                                label="AI draft"
                                placeholder="Describe the response…"
                                defaultPrompt="Helpful DM response delivering the requested resource and offering help"
                                automationName={data.name}
                                language={data.aiReplyLanguage}
                                postCaption={data.postCaption}
                                disabled={!canAddMoreResponses}
                                onResult={res => {
                                    if (res.draft) {
                                        onUpdate({
                                            dmResponses: [
                                                ...data.dmResponses,
                                                { id: randomId(), type: "text", content: res.draft },
                                            ],
                                        });
                                    }
                                }}
                            />
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Follow-up message (scheduled check-in) — not supported
                    for Facebook in v1 (API rejects it). */}
            {!isFacebook && (
            <section className="space-y-3">
                <SectionHeader
                    title="Follow-up message"
                    action={<Toggle on={data.followUpEnabled} onChange={() => onUpdate({ followUpEnabled: !data.followUpEnabled })} />}
                />
                <AnimatePresence>
                    {data.followUpEnabled && (
                        <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.18 }}
                            className="overflow-hidden space-y-3"
                        >
                            <p className="text-[12px] text-muted-foreground">
                                One check-in DM, sent after the person replies (button tap or a matching DM).
                                It is never sent to someone who opted out, and only inside Meta&apos;s 24-hour window.
                            </p>
                            <div>
                                <label className="micro-label block mb-1">Send after</label>
                                <select
                                    value={data.followUpDelayMinutes}
                                    onChange={e => onUpdate({ followUpDelayMinutes: Number(e.target.value) })}
                                    className={inputCls}
                                >
                                    <option value={10}>10 minutes</option>
                                    <option value={20}>20 minutes</option>
                                    <option value={60}>1 hour</option>
                                    <option value={120}>2 hours</option>
                                </select>
                            </div>
                            <div>
                                <label className="micro-label block mb-1">Message</label>
                                <textarea
                                    value={data.followUpMessage}
                                    onChange={e => onUpdate({ followUpMessage: e.target.value })}
                                    placeholder="e.g. Hey {username}, just checking in, did the guide help?"
                                    rows={3}
                                    maxLength={1000}
                                    className={textareaCls}
                                />
                                <p className="text-[11px] text-muted-foreground mt-1">Sent exactly as written (with {"{username}"} personalised). No AI rewriting.</p>
                                <AiDraftControl
                                    action="follow_up_draft"
                                    label="Generate draft"
                                    placeholder="Describe the check-in…"
                                    defaultPrompt="Polite check-in asking if they got a chance to look at the link"
                                    automationName={data.name}
                                    language={data.aiReplyLanguage}
                                    onResult={res => {
                                        if (res.draft) {
                                            onUpdate({ followUpMessage: res.draft });
                                        }
                                    }}
                                />
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </section>
            )}
        </div>
    );

    const sectionContent: Record<EditorSectionId, React.ReactNode> = {
        post: postContent,
        keyword: keywordContent,
        follow: followContent,
        dm: dmContent,
    };

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Form / Preview switch - small screens only. Below xl the
                phone preview used to be unreachable (hidden xl:flex with
                no way to see it); xl still shows both side by side. */}
            <div className="flex xl:hidden items-center gap-1 px-3 pt-3 shrink-0">
                <div className="inline-flex items-center bg-muted rounded-lg p-0.5">
                    {(["form", "preview"] as const).map((tab) => (
                        <button
                            key={tab}
                            onClick={() => setMobileTab(tab)}
                            className={cn(
                                "h-7 px-3 rounded-[7px] text-[12px] font-medium capitalize transition-colors",
                                mobileTab === tab
                                    ? "bg-card text-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            {tab === "form" ? "Edit" : "Preview"}
                        </button>
                    ))}
                </div>
            </div>

            <div className="flex flex-1 min-h-0 overflow-hidden">
            {/* ── Left - form ── (overflow-x-clip: this column must never scroll sideways — see note on inputCls) */}
            <div className={cn("flex-1 min-w-0 overflow-y-auto overflow-x-clip p-5 space-y-6 custom-scrollbar", mobileTab === "preview" && "hidden xl:block")}>

                {/* Name */}
                <section className="space-y-2">
                    <SectionHeader title="Name" />
                    <input
                        value={data.name}
                        onChange={e => onUpdate({ name: e.target.value })}
                        placeholder="e.g. Diet guide funnel"
                        className={inputCls}
                    />
                </section>

                {/* Stepped sections — one open at a time, in order. */}
                <div className="space-y-2.5">
                    {sections.map((section, i) => (
                        <AccordionSection
                            key={section.id}
                            index={i + 1}
                            title={section.title}
                            summary={section.summary}
                            summaryTitle={section.summaryTitle}
                            done={section.done}
                            open={openSection === section.id}
                            onToggle={() => setOpenSection(section.id)}
                            onContinue={goToNextSection}
                            isLast={i === sections.length - 1}
                        >
                            {sectionContent[section.id]}
                        </AccordionSection>
                    ))}
                </div>

            </div>

            {/* ── Right - phones ── */}
            <div className={cn("w-full xl:w-[600px] shrink-0 bg-[#0a0a0b] border-l border-border overflow-hidden relative", mobileTab === "preview" ? "flex" : "hidden xl:flex")}>
                <motion.div
                    initial={{ y: 24, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ type: "spring", damping: 30, stiffness: 240, delay: 0.05 }}
                    className="flex items-center justify-center gap-5 w-full h-full p-5"
                >
                    {isComment && (
                        <CommentsPhone
                            postThumbnailUrl={postThumbUrl}
                            previewComments={previewKeywords}
                            anyMode={isAnyMode}
                            repliesSaved={repliesSaved || data.customReplies.length > 0}
                            customReplies={data.customReplies}
                            creatorProfilePicUrl={creatorProfilePicUrl}
                        />
                    )}
                    {isStory && <StoryPhone keyword={previewTriggerText} />}

                    {data.isAutoDmEnabled && (
                        <DMConversationPhone
                            openingEnabled={data.dmOpeningMessageEnabled}
                            openingMessage={activeOpeningMessage}
                            openingBtnTitle={data.dmOpeningMessageButtonTitle}
                            askToFollowEnabled={data.askToFollowEnabled}
                            askToFollowMessage={data.askToFollowMessage}
                            askToFollowVisitBtn={data.askToFollowVisitProfileButton}
                            askToFollowConfirmBtn={data.askToFollowConfirmButton}
                            responses={data.dmResponses}
                            phase={phonePhase}
                            onPhaseChange={setPhonePhase}
                            creatorProfilePicUrl={creatorProfilePicUrl}
                            trigger={!isComment ? { kind: isStoryMention ? "mention" : isStory ? "story" : "dm", text: previewTriggerText } : null}
                        />
                    )}
                </motion.div>
            </div>
            </div>
        </div>
    );
}
