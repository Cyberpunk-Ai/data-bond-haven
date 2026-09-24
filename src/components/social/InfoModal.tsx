import { X, Sparkles, Shield, FileText, HelpCircle, Activity } from "lucide-react";

interface InfoModalProps {
  type: string | null;
  isOpen: boolean;
  onClose: () => void;
}

const infoContent: Record<string, { title: string; subtitle: string; icon: any; body: string[] }> =
  {
    About: {
      title: "About Spaces",
      subtitle: "Where moments come to life and creator communities thrive.",
      icon: Sparkles,
      body: [
        "Spaces is designed to bring back the calm, high-signal, and expressive nature of digital connection.",
        "Built with Supabase PostgreSQL, real-time live audio rooms, and generative intelligence.",
        "Every feed, room, and interaction is optimized for genuine collaboration and craft.",
      ],
    },
    Help: {
      title: "Help & Support",
      subtitle: "Everything you need to navigate Spaces smoothly.",
      icon: HelpCircle,
      body: [
        "• Feed & Posts: Share updates, gradients, hashtags, and participate in conversations.",
        "• Live Rooms: Host or listen in live audio rooms with real-time room chat and AI summaries.",
        "• Direct Messages: Secure messaging with attachments and AI smart replies.",
        "• Settings & Database: Switch database and storage drivers between Supabase and in-memory caches.",
      ],
    },
    Privacy: {
      title: "Privacy Policy",
      subtitle: "Your data, your ownership, transparent by design.",
      icon: Shield,
      body: [
        "We respect your digital privacy. All direct messages and bookmarks are encrypted and restricted to your account.",
        "Your personal information is never sold to third-party data brokers.",
        "You can export or delete your account data at any time.",
      ],
    },
    Terms: {
      title: "Terms of Service",
      subtitle: "The community guidelines and terms governing our platform.",
      icon: FileText,
      body: [
        "By using Spaces, you agree to foster an inclusive, respectful, and creative environment.",
        "Harassment, hate speech, and spam are strictly prohibited across feeds, comments, and live audio rooms.",
        "Content remains owned by the respective authors who published it.",
      ],
    },
    Guidelines: {
      title: "Community Guidelines",
      subtitle: "Standards for healthy, creative discourse.",
      icon: Sparkles,
      body: [
        "1. Be kind and constructive when reviewing creative work.",
        "2. Give credit to original artists and creators.",
        "3. Keep live audio rooms respectful and welcoming to all participants.",
      ],
    },
    Status: {
      title: "System & Service Status",
      subtitle: "Real-time infrastructure health.",
      icon: Activity,
      body: [
        "✓ Supabase Database: Operational (Live)",
        "✓ Supabase Storage (5 Buckets): Operational",
        "✓ Realtime Replication Channel: Active",
        "✓ Gemini Generative AI Services: Operational",
      ],
    },
  };

export function InfoModal({ type, isOpen, onClose }: InfoModalProps) {
  if (!isOpen || !type) return null;

  const content = infoContent[type] || {
    title: type,
    subtitle: "Spaces Community Information",
    icon: Sparkles,
    body: ["Information and details for " + type],
  };

  const Icon = content.icon;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div
        className="glass-panel relative w-full max-w-md overflow-hidden rounded-3xl p-6 shadow-2xl border border-border/80 bg-card/95"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-4 border-b border-border/60">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <Icon className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-lg font-bold">{content.title}</h2>
              <p className="text-xs text-muted-foreground">{content.subtitle}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5 space-y-3">
          {content.body.map((para, i) => (
            <p key={i} className="text-sm leading-relaxed text-foreground/90">
              {para}
            </p>
          ))}
        </div>

        <div className="mt-6 flex justify-end pt-4 border-t border-border/60">
          <button
            onClick={onClose}
            className="rounded-full bg-brand px-5 py-2 text-xs font-bold text-white shadow-soft hover:bg-brand/90 transition-all"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
