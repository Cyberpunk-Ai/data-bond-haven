import { useState } from "react";
import { createPortal } from "react-dom";
import { ShieldAlert, X, Check, Loader2, Flag } from "lucide-react";
import { submitReport } from "@/lib/api-client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface ReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetType: "post" | "user" | "story" | "comment" | "space";
  targetId: string;
  targetPreview?: string;
  authorId?: string;
  authorName?: string;
}

const REPORT_REASONS = [
  {
    id: "spam",
    label: "Spam or automated scam",
    desc: "Commercial promotion, malicious links, or repetitive unsolicited posts",
  },
  {
    id: "harassment",
    label: "Harassment or hate speech",
    desc: "Bullying, personal threats, hate symbols, or discriminatory content",
  },
  {
    id: "misinformation",
    label: "Misinformation or deceit",
    desc: "Deliberately misleading claims, manipulated media, or fabricated events",
  },
  {
    id: "inappropriate",
    label: "Inappropriate or sensitive media",
    desc: "Graphic violence, NSFW content without warning tags, or gore",
  },
  {
    id: "impersonation",
    label: "Impersonation",
    desc: "Pretending to be another individual, organization, or brand",
  },
  {
    id: "copyright",
    label: "Copyright infringement",
    desc: "Unauthorized use of copyrighted intellectual work",
  },
  {
    id: "other",
    label: "Other platform violation",
    desc: "Any other violation of our community safety guidelines",
  },
] as const;

export function ReportModal({
  isOpen,
  onClose,
  targetType,
  targetId,
  targetPreview,
  authorId,
  authorName,
}: ReportModalProps) {
  const [selectedReason, setSelectedReason] = useState<
    | "spam"
    | "harassment"
    | "inappropriate"
    | "impersonation"
    | "copyright"
    | "misinformation"
    | "other"
  >("spam");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  if (!isOpen) return null;
  if (typeof document === "undefined") return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await submitReport({
        target_type: targetType,
        target_id: targetId,
        target_preview: targetPreview,
        author_id: authorId,
        author_name: authorName,
        reason: selectedReason,
        details: details.trim() || undefined,
      });
      setSubmitted(true);
      toast.success("Report received. Our moderation team has been notified.");
      setTimeout(() => {
        setSubmitted(false);
        onClose();
      }, 1600);
    } catch (err: any) {
      toast.error(err.message || "Failed to submit report. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-3xl border border-border/80 bg-card p-6 shadow-2xl animate-in zoom-in-95 duration-200 [scrollbar-width:thin]"
        onClick={(e) => e.stopPropagation()}
      >
        {submitted ? (
          <div className="flex flex-col items-center justify-center py-8 text-center space-y-3">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-rose-500/20 text-rose-500 ring-8 ring-rose-500/10">
              <Check className="h-8 w-8 stroke-[3]" />
            </div>
            <h3 className="text-xl font-extrabold">Report Submitted</h3>
            <p className="text-sm text-muted-foreground max-w-xs">
              Thank you for keeping our community safe. Our trust & safety team will review this{" "}
              {targetType}.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-rose-500/15 text-rose-600 dark:text-rose-400">
                  <Flag className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-foreground">Report {targetType}</h3>
                  <p className="text-xs text-muted-foreground">
                    {authorName ? `Created by @${authorName}` : "Submit for moderation review"}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full p-1.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {targetPreview && (
              <div className="rounded-2xl border border-border/70 bg-foreground/5 p-3 text-xs text-muted-foreground line-clamp-3 italic">
                "{targetPreview}"
              </div>
            )}

            <div className="space-y-2">
              <label className="block text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Reason for report
              </label>
              <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1 [scrollbar-width:thin]">
                {REPORT_REASONS.map((r) => {
                  const isSelected = selectedReason === r.id;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setSelectedReason(r.id)}
                      className={cn(
                        "w-full text-left rounded-xl p-2.5 border transition-all text-xs",
                        isSelected
                          ? "border-rose-500/60 bg-rose-500/10 text-foreground ring-1 ring-rose-500/30"
                          : "border-border/60 hover:bg-foreground/5 text-muted-foreground",
                      )}
                    >
                      <p className="font-bold text-foreground">{r.label}</p>
                      <p className="text-[0.7rem] text-muted-foreground mt-0.5">{r.desc}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Additional context (optional)
              </label>
              <textarea
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder="Describe why this content violates community standards..."
                rows={2}
                className="w-full resize-none rounded-xl bg-foreground/5 px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-rose-500/40 placeholder:text-muted-foreground/60"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="rounded-full px-4 py-2 text-xs font-semibold hover:bg-foreground/5 text-muted-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="flex items-center gap-1.5 rounded-full bg-rose-600 hover:bg-rose-500 text-white px-5 py-2 text-xs font-bold shadow-soft transition-all active:scale-95 disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldAlert className="h-3.5 w-3.5" />
                )}
                {submitting ? "Submitting..." : "Submit Report"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
