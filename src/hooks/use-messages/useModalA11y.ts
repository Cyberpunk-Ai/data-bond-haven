import { useEffect, useRef } from "react";

/**
 * Wire a modal / sheet / popover up for keyboard and screen-reader use.
 *
 * Every overlay on the messaging surface previously trusted only a click on a
 * backdrop to close it: Escape did nothing, focus stayed behind the overlay so a
 * keyboard user could tab straight into the (now covered) page, and closing left
 * focus on a node that had just unmounted. This centralises the four behaviours a
 * dialog is expected to have so no sheet has to re-implement them:
 *
 *   1. Escape closes it (calls `onClose`);
 *   2. focus moves into the panel on open and returns to the trigger on close;
 *   3. Tab / Shift+Tab are trapped inside the panel;
 *   4. the document body stops scrolling behind it (for full-screen sheets).
 *
 * Attach the returned `ref` to the panel element — the one that should carry
 * `role="dialog" aria-modal="true"`.
 */
export function useModalA11y<T extends HTMLElement = HTMLDivElement>(options: {
  open: boolean;
  onClose: () => void;
  /** Skip the scroll lock for anchored popovers that don't cover the viewport. */
  trapScroll?: boolean;
}) {
  const { open, onClose, trapScroll = true } = options;
  const ref = useRef<T>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    // Remember what had focus so we can hand it back when we tear down.
    restoreTo.current = document.activeElement as HTMLElement | null;

    const node = ref.current;
    // Focus the first sensible control; fall back to the panel itself (which is
    // tabIndex=-1) so screen readers announce the dialog.
    const focusable = node?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    (focusable ?? node)?.focus();

    const prevOverflow = trapScroll ? document.body.style.overflow : null;
    if (trapScroll) document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !node) return;
      const items = Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (trapScroll && prevOverflow !== null) document.body.style.overflow = prevOverflow;
      // Return focus to wherever the user opened us from, if it's still there.
      const back = restoreTo.current;
      if (back && document.contains(back)) back.focus();
    };
  }, [open, onClose, trapScroll]);

  return ref;
}
