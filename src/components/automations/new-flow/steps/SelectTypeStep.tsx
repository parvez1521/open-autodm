import { motion } from "motion/react";
import { ChatCircle, PaperPlaneTilt, Image, At, PlayCircle, Stack, FacebookLogo } from "@/components/phosphor";
import { AUTOMATION_TYPES } from "../constants";
import { AUTOMATION_TEMPLATES, type AutomationTemplateId } from "@/lib/automation/templates";
import { cn } from "@/lib/utils";

interface SelectTypeStepProps {
    onSelect: (typeId: string) => void;
    /** One-click starter: prefills the builder with the template's defaults (never auto-creates). */
    onTemplateSelect?: (templateId: AutomationTemplateId) => void;
    selectedType: string | null;
    /** Facebook trigger cards only render when a Page is connected —
     *  otherwise they would be dead ends (nothing to attach them to). */
    showFacebookTriggers?: boolean;
    /**
     * Channel preselect (2026-11-20): the /automations channel
     * toggle passes the selected tab so only that channel's
     * triggers show. Undefined = both channels (previous behaviour).
     */
    channelFilter?: "instagram" | "facebook";
}

const ICONS = {
    "message": ChatCircle,
    "send": PaperPlaneTilt,
    "image": Image,
    "at-sign": At,
    "play": PlayCircle,
    "facebook": FacebookLogo,
};

export function SelectTypeStep({ onSelect, onTemplateSelect, selectedType, showFacebookTriggers = false, channelFilter }: SelectTypeStepProps) {
    // Facebook cards (channel: 'facebook') are hidden until a Page is
    // connected; Instagram cards always show. A channel filter (from
    // the /automations toggle) narrows the grid to that channel only —
    // types without a channel field are Instagram.
    const visibleTypes = AUTOMATION_TYPES.filter((type) => {
        const channel = (type as { channel?: string }).channel ?? "instagram";
        if (channelFilter !== undefined && channel !== channelFilter) return false;
        return channel !== "facebook" || showFacebookTriggers;
    });
    return (
        <div className="flex flex-col items-center justify-center w-full h-full p-6 overflow-y-auto">
            <div className="max-w-2xl w-full mx-auto space-y-8 pb-8">
                <div className="text-center space-y-1.5 pt-6">
                    <h2 className="text-xl font-heading font-semibold tracking-tight text-foreground">
                        What starts this automation?
                    </h2>
                    <p className="text-[13px] text-muted-foreground max-w-md mx-auto">
                        Pick a trigger - you&apos;ll configure keywords and replies next.
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                    {visibleTypes.length === 0 && (
                        <p className="md:col-span-2 text-center text-[13px] text-muted-foreground py-8">
                            No triggers for this channel yet — connect a Facebook Page in Settings first.
                        </p>
                    )}
                    {visibleTypes.map((type, idx) => {
                        const Icon = ICONS[type.iconType as keyof typeof ICONS];
                        const isSelected = selectedType === type.id;

                        return (
                            <motion.button
                                key={type.id}
                                disabled={!type.available}
                                onClick={() => onSelect(type.id)}
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: idx * 0.05 }}
                                className={cn(
                                    "relative group text-left p-4 rounded-xl border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                                    !type.available
                                        ? "opacity-50 cursor-not-allowed border-border"
                                        : "cursor-pointer bg-card border-border hover:border-foreground/25",
                                    isSelected && type.available && "border-foreground/40 bg-muted/40"
                                )}
                            >
                                <div className="flex items-start gap-3">
                                    <div className={cn(
                                        "w-9 h-9 rounded-lg flex items-center justify-center shrink-0",
                                        type.available ? "bg-muted" : "bg-muted/50"
                                    )}>
                                        <Icon className={cn("w-4 h-4", type.iconColor)} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-0.5">
                                            <h3 className="text-[13.5px] font-semibold text-foreground">
                                                {type.name}
                                            </h3>
                                            {!type.available && (
                                                <span className="text-[9px] font-semibold uppercase tracking-widest bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full">
                                                    Soon
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-[12px] text-muted-foreground leading-relaxed">
                                            {type.description}
                                        </p>
                                    </div>
                                </div>
                            </motion.button>
                        );
                    })}
                </div>

                {/* Templates (2026-11-17): one-click starters that prefill
                    the builder — name, type, trigger, opening message and
                    link response. Nothing is created until the owner saves.
                    Templates are Instagram-only, so they stay hidden when the
                    trigger picker is filtered to Facebook. */}
                {onTemplateSelect && channelFilter !== "facebook" && (
                    <div className="space-y-3">
                        <div className="text-center space-y-1">
                            <h3 className="text-[13px] font-semibold text-foreground">Or start from a template</h3>
                            <p className="text-[12px] text-muted-foreground">
                                Prefilled and ready to edit — pick a post (or none) and save.
                            </p>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                            {AUTOMATION_TEMPLATES.map((template, idx) => (
                                <motion.button
                                    key={template.id}
                                    onClick={() => onTemplateSelect(template.id)}
                                    initial={{ opacity: 0, y: 8 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: idx * 0.05 }}
                                    className="relative group text-left p-4 rounded-xl border cursor-pointer bg-card border-border hover:border-foreground/25 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                                >
                                    <div className="flex items-start gap-3">
                                        <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
                                            <Stack className="w-4 h-4 text-foreground" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <h3 className="text-[13.5px] font-semibold text-foreground mb-0.5">
                                                {template.name}
                                            </h3>
                                            <p className="text-[12px] text-muted-foreground leading-relaxed">
                                                {template.description}
                                            </p>
                                        </div>
                                    </div>
                                </motion.button>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
