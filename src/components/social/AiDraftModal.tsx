import { useState } from "react";
import { Sparkles, X, Loader2, Wand2, Copy, Check, Lock, Zap } from "lucide-react";
import { generateAIDraft } from "@/lib/api-client";
import { usePlan, openUpgradeModal } from "@/lib/plan-state";
import { cn } from "@/lib/utils";

interface AiDraftModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectDraft: (text: string, tags?: string[]) => void;
  currentDraft?: string;
}

interface TonePreset {
  label: string;
  prompt: string;
  tier: "free" | "plus" | "pro";
  icon?: string;
}

const tonePresets: TonePreset[] = [
  {
    label: "Engaging & Thoughtful",
    prompt: "Share a thoughtful insight about modern creative work, design, or technology",
    tier: "free",
  },
  {
    label: "Quick Actionable Tip",
    prompt: "Share a quick, high-impact tip for creators or builders",
    tier: "free",
  },
  {
    label: "Viral Hook Builder 🚀",
    prompt:
      "Craft a high-converting, curiosity-sparking opening hook about breaking through noise in tech",
    tier: "plus",
  },
  {
    label: "Provocative Hot Take 🔥",
    prompt:
      "Share a bold, thought-provoking perspective challenging conventional wisdom in modern design",
    tier: "plus",
  },
  {
    label: "Deep Industry Analysis 🧠",
    prompt:
      "Write an authoritative, multi-perspective breakdown of emerging software trends and creator ecosystems",
    tier: "pro",
  },
  {
    label: "Poetic Storyteller Arc 📖",
    prompt:
      "Write a vivid, emotionally resonant micro-story reflecting on craft, persistence, and late night creation",
    tier: "pro",
  },
];

export function AiDraftModal({ isOpen, onClose, onSelectDraft, currentDraft }: AiDraftModalProps) {
  const { currentPlan, planDetails, usage, recordAiDraftUsage, isPlus, isPro } = usePlan();
  const [customPrompt, setCustomPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ content: string; suggestedTags: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const maxDrafts = planDetails.limits.aiDraftsPerDay;
  const usedToday = usage.aiDraftsToday || 0;
  const isLimitReached = usedToday >= maxDrafts;

  async function handleGenerate(promptToUse: string, requiredTier?: "free" | "plus" | "pro") {
    if (requiredTier === "pro" && !isPro) {
      openUpgradeModal("Unlock Pro Industry Analysis & Unlimited AI");
      return;
    }
    if (requiredTier === "plus" && !isPlus) {
      openUpgradeModal("Unlock Plus Viral Hooks & AI Generation");
      return;
    }

    if (isLimitReached) {
      openUpgradeModal("Daily AI Draft Limit Reached");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const data = await generateAIDraft(promptToUse, currentDraft);
      setResult(data);
      recordAiDraftUsage();
    } catch (err: any) {
      const message = String(err?.message ?? "Couldn't generate a draft. Please try again.");
      setError(message);
      if (/upgrade|limit/i.test(message)) openUpgradeModal("Daily AI Draft Limit Reached");
    } finally {
      setLoading(false);
    }
  }

  function handleUseDraft() {
    if (!result) return;
    onSelectDraft(result.content, result.suggestedTags);
    onClose();
  }

  function handleCopy() {
    if (!result) return;
    navigator.clipboard.writeText(result.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div
        className="glass-panel relative w-full max-w-lg overflow-hidden rounded-3xl p-6 shadow-2xl border border-border/80 bg-card/95"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-border/60">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand to-brand-pink text-white shadow-soft">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold">Spaces Gemini Spark</h2>
                <span
                  className={cn(
                    "text-[0.65rem] font-bold px-1.5 py-0.5 rounded",
                    planDetails.badgeColor,
                  )}
                >
                  {planDetails.badge}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Draft high-engagement social posts with AI
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Plan Usage Bar */}
        <div className="mt-3 flex items-center justify-between rounded-xl bg-foreground/5 p-2.5 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-muted-foreground">
            <Zap className="h-3.5 w-3.5 text-brand" />
            <span>
              Drafts Today:{" "}
              <strong className="text-foreground">
                {usedToday} / {maxDrafts > 1000 ? "Unlimited" : maxDrafts}
              </strong>
            </span>
          </div>
          {currentPlan !== "pro" && (
            <button
              onClick={() => openUpgradeModal("Unlimited Gemini AI Drafting")}
              className="font-bold text-brand hover:underline flex items-center gap-1 text-[0.72rem]"
            >
              {currentPlan === "free" ? "Upgrade for 100/day" : "Get Unlimited Pro"}
            </button>
          )}
        </div>

        {isLimitReached && (
          <div className="mt-3 rounded-2xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-500 flex items-center justify-between">
            <span>You've used all {maxDrafts} daily free AI drafts.</span>
            <button
              onClick={() => openUpgradeModal("AI Limit Reached")}
              className="rounded-lg bg-rose-500 px-3 py-1 text-white font-bold text-xs"
            >
              Upgrade Now
            </button>
          </div>
        )}

        {/* Tone Presets */}
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Tone & Format Engine
            </label>
            <span className="text-[0.68rem] text-muted-foreground">
              {currentPlan === "free"
                ? "2 Free • 4 Plus/Pro Tones"
                : currentPlan === "plus"
                  ? "4 Unlocked • 2 Pro Tones"
                  : "All Tones Unlocked"}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {tonePresets.map((tp) => {
              const isLocked = (tp.tier === "plus" && !isPlus) || (tp.tier === "pro" && !isPro);

              return (
                <button
                  key={tp.label}
                  disabled={loading}
                  onClick={() => {
                    setCustomPrompt(tp.prompt);
                    handleGenerate(tp.prompt, tp.tier);
                  }}
                  className={cn(
                    "relative flex items-center justify-between rounded-2xl border p-3 text-left text-xs font-semibold transition-all active:scale-[0.98] disabled:opacity-50",
                    isLocked
                      ? "border-border/60 bg-foreground/[0.02] text-muted-foreground hover:border-brand/40"
                      : "border-border/80 bg-foreground/5 hover:border-brand/50 hover:bg-brand/5 text-foreground",
                  )}
                >
                  <span className="truncate pr-2">{tp.label}</span>
                  {isLocked ? (
                    <span className="flex items-center gap-0.5 rounded bg-brand/10 px-1 py-0.5 text-[0.6rem] font-bold text-brand shrink-0">
                      <Lock className="h-2.5 w-2.5" />
                      {tp.tier.toUpperCase()}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom Prompt Input */}
        <div className="mt-4 space-y-1.5">
          <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Or custom concept / instructions
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder="e.g. Write a launch teaser for a new spatial audio feature..."
              className="flex-1 rounded-2xl bg-foreground/5 px-4 py-2.5 text-sm outline-none border border-transparent focus:border-brand/40 focus:bg-background transition-all"
              onKeyDown={(e) =>
                e.key === "Enter" && customPrompt.trim() && handleGenerate(customPrompt)
              }
            />
            <button
              onClick={() => handleGenerate(customPrompt || "Share a creative thought for today")}
              disabled={loading || isLimitReached}
              className="flex items-center gap-1.5 rounded-2xl bg-gradient-to-r from-brand to-brand-pink px-4 py-2.5 text-sm font-bold text-white shadow-soft hover:shadow-glow transition-all active:scale-95 disabled:opacity-50"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wand2 className="h-4 w-4" />
              )}
              Generate
            </button>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mt-4 rounded-2xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        {/* Result Area */}
        {result && (
          <div className="mt-5 space-y-3 rounded-2xl border border-brand/20 bg-brand/5 p-4 animate-in fade-in duration-300">
            <div className="flex items-center justify-between text-xs text-brand font-bold">
              <span className="flex items-center gap-1">
                <Sparkles className="h-3 w-3" /> Generated with Gemini
              </span>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 hover:underline text-muted-foreground"
              >
                {copied ? (
                  <Check className="h-3 w-3 text-emerald-500" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{result.content}</p>

            {result.suggestedTags?.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {result.suggestedTags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-brand/10 px-2.5 py-0.5 text-[0.7rem] font-semibold text-brand"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t border-brand/10">
              <button
                onClick={onClose}
                className="rounded-full px-4 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-foreground/5"
              >
                Cancel
              </button>
              <button
                onClick={handleUseDraft}
                className="rounded-full bg-brand px-4 py-1.5 text-xs font-bold text-white shadow-soft hover:bg-brand/90 transition-all"
              >
                Insert into Post
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
