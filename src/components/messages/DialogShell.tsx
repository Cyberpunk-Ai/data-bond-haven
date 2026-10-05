import { cn } from "@/lib/utils";
import { createPortal } from "react-dom";
import { useModalA11y } from "@/hooks/use-messages/useModalA11y";

/**
 * The overlay + panel that every messaging sheet (New Message, Forward, Message
 * Info, Conversation Info, reaction picker) is built from, so they share one
 * accessibility contract: `role="dialog"`, `aria-modal`, a labelled title, Escape
 * to close, focus moved in on open and returned to the trigger on close, and a
 * backdrop click that dismisses.
 */
export function DialogShell({
  open,
  onClose,
  labelledBy,
  variant = "centered",
  className,
  panelClassName,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** id of the element naming this dialog (its heading). */
  labelledBy: string;
  variant?: "centered" | "sheet";
  className?: string;
  panelClassName?: string;
  children: React.ReactNode;
}) {
  const panelRef = useModalA11y<HTMLDivElement>({ open, onClose });
  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-50 flex bg-black/60 backdrop-blur-xs motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150",
        variant === "sheet"
          ? "items-end justify-center sm:items-center sm:p-4"
          : "items-center justify-center p-4",
        className,
      )}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "custom-scrollbar w-full outline-none motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-150",
          variant === "sheet" ? "max-w-md rounded-t-3xl sm:rounded-3xl" : "max-w-md rounded-3xl",
          "max-h-[calc(100dvh-2rem)] overflow-y-auto border border-border bg-card p-5 shadow-2xl [scrollbar-width:thin]",
          panelClassName,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
