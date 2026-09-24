/**
 * Official Paystack Client Integration
 *
 * In compliance with PCI-DSS Level 1 security standards, this application
 * NEVER collects, stores, or handles credit card numbers, CVVs, expiry dates,
 * or banking PINs.
 *
 * All payment processing is 100% delegated to Paystack's official secure infrastructure
 * (Paystack Inline Popup iframe or Paystack Hosted Checkout page).
 */

declare global {
  interface Window {
    PaystackPop?: {
      setup: (options: {
        key?: string;
        email?: string;
        amount?: number;
        currency?: string;
        ref?: string;
        metadata?: any;
        callback?: (response: {
          reference: string;
          status: string;
          trans: string;
          message: string;
        }) => void;
        onClose?: () => void;
      }) => {
        openIframe: () => void;
      };
    };
  }
}

export interface PaystackCheckoutOptions {
  authorizationUrl?: string | null;
  reference: string;
  email?: string;
  amountInCents?: number;
  currency?: string;
  onSuccess?: (reference: string) => void;
  onCancel?: () => void;
}

/**
 * Initiates secure payment directly on Paystack's PCI-DSS compliant interface.
 * If authorizationUrl is provided and user is on mobile or prefers redirect,
 * navigates to Paystack's hosted payment gateway.
 */
export function openPaystackPayment(options: PaystackCheckoutOptions) {
  const { authorizationUrl, reference, onSuccess, onCancel } = options;

  // If PaystackPop is loaded on the window and has setup available
  const publicKey = import.meta.env.VITE_PAYSTACK_PUBLIC_KEY;

  if (window.PaystackPop && publicKey && options.email && options.amountInCents) {
    try {
      const handler = window.PaystackPop.setup({
        key: publicKey,
        email: options.email,
        amount: options.amountInCents,
        currency: options.currency || "KES",
        ref: reference,
        callback: (res) => {
          if (onSuccess) onSuccess(res.reference || reference);
          else if (typeof window !== "undefined") {
            window.location.href = `/billing/callback?reference=${encodeURIComponent(res.reference || reference)}`;
          }
        },
        onClose: () => {
          if (onCancel) onCancel();
        },
      });
      handler.openIframe();
      return;
    } catch (e) {
      console.warn("Paystack Inline initialization notice, falling back to hosted checkout:", e);
    }
  }

  // Fallback to official Paystack hosted checkout URL
  if (authorizationUrl) {
    window.location.href = authorizationUrl;
  } else {
    // If no authorizationUrl is available, direct to verification callback or report
    window.location.href = `/billing/callback?reference=${encodeURIComponent(reference)}`;
  }
}
