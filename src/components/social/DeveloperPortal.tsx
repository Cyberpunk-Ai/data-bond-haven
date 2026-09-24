import { useState } from "react";
import {
  Key,
  Webhook,
  Code2,
  Copy,
  Plus,
  Trash2,
  Lock,
  Crown,
  Check,
  Terminal,
  Activity,
  Send,
} from "lucide-react";
import { useDeveloper } from "@/lib/developer-state";
import { usePlan, openUpgradeModal } from "@/lib/plan-state";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const AVAILABLE_EVENTS = [
  { id: "post.created", label: "post.created", desc: "When a new post is published" },
  { id: "tip.received", label: "tip.received", desc: "When a fan sends a creator tip" },
  { id: "space.started", label: "space.started", desc: "When an audio room starts" },
  { id: "follower.new", label: "follower.new", desc: "When a new user follows" },
];

export function DeveloperPortal() {
  const { isPro } = usePlan();
  const {
    apiKeys,
    webhooks,
    totalApiCallsThisMonth,
    generateApiKey,
    revokeApiKey,
    addWebhook,
    removeWebhook,
  } = useDeveloper();

  const [isKeyModalOpen, setIsKeyModalOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKeySecret, setCreatedKeySecret] = useState<string | null>(null);

  const [isWebhookModalOpen, setIsWebhookModalOpen] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookDesc, setWebhookDesc] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>(["post.created", "tip.received"]);

  const [activeCodeLang, setActiveCodeLang] = useState<"curl" | "typescript">("typescript");

  const handleGenerateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyName.trim()) return;
    const key = await generateApiKey(newKeyName.trim());
    if (key?.fullKey) {
      setCreatedKeySecret(key.fullKey);
      toast.success("API Key generated! Store it securely.");
    }
    setNewKeyName("");
  };

  const handleCreateWebhook = (e: React.FormEvent) => {
    e.preventDefault();
    if (!webhookUrl.startsWith("http")) {
      toast.error("Please enter a valid HTTPS webhook URL");
      return;
    }
    addWebhook(webhookUrl, webhookDesc || "Spaces Event Listener", selectedEvents);
    toast.success("Webhook endpoint registered!");
    setWebhookUrl("");
    setWebhookDesc("");
    setIsWebhookModalOpen(false);
  };

  const curlSnippet = `curl -X GET https://spaces.studio/api/v1/posts \\
  -H "Authorization: Bearer ${apiKeys[0]?.maskedKey || "spc_live_••••"}" \\
  -H "Content-Type: application/json"`;

  const tsSnippet = `import { SpacesClient } from "@spaces/sdk";

const spaces = new SpacesClient({
  apiKey: "${apiKeys[0]?.maskedKey || "spc_live_••••"}"
});

// Fetch latest trending posts
const { data: posts } = await spaces.posts.list({
  limit: 20
});`;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-black">Developer API & Webhooks</h2>
            <span className="flex items-center gap-1 text-[0.65rem] font-extrabold uppercase px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
              <Crown className="h-3 w-3" /> Pro Feature
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Programmatically query posts, publish content, stream spaces, and subscribe to real-time
            events.
          </p>
        </div>

        {isPro ? (
          <button
            onClick={() => {
              setCreatedKeySecret(null);
              setIsKeyModalOpen(true);
            }}
            className="flex items-center gap-1.5 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-xs font-bold text-white shadow-soft hover:brightness-105 transition-all cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Generate New API Key</span>
          </button>
        ) : (
          <button
            onClick={() => openUpgradeModal("Developer API & Webhooks")}
            className="flex items-center gap-1.5 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-xs font-bold text-white shadow-soft hover:brightness-105 transition-all cursor-pointer"
          >
            <Crown className="h-3.5 w-3.5" />
            <span>Upgrade to Pro ($29/mo)</span>
          </button>
        )}
      </div>

      {!isPro && (
        <div className="rounded-3xl border border-amber-500/30 bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-transparent p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="space-y-1 text-center sm:text-left">
            <div className="flex items-center justify-center sm:justify-start gap-2">
              <Lock className="h-4 w-4 text-amber-500" />
              <h4 className="text-sm font-black">Developer API & Webhooks Require Pro</h4>
            </div>
            <p className="text-xs text-muted-foreground">
              Generate production REST API keys, configure webhooks, and programmatically publish
              content with 500,000 monthly requests.
            </p>
          </div>
          <button
            onClick={() => openUpgradeModal("Developer API & Webhooks")}
            className="rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-5 py-2.5 text-xs font-bold text-white shadow-soft hover:brightness-105 transition-all cursor-pointer whitespace-nowrap"
          >
            Unlock Pro ($29/mo)
          </button>
        </div>
      )}

      {/* API Usage Meter */}
      <div className="rounded-3xl border border-border/80 bg-card p-5 md:p-6 space-y-3 shadow-soft">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-amber-500" />
            <h3 className="text-sm font-bold">Monthly API Requests</h3>
          </div>
          <span className="text-xs font-mono font-bold text-foreground">
            {totalApiCallsThisMonth.toLocaleString()} / 500,000 reqs
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted/60">
          <div
            className="h-full rounded-full bg-gradient-to-r from-amber-500 to-orange-500"
            style={{ width: `${(totalApiCallsThisMonth / 500000) * 100}%` }}
          />
        </div>
      </div>

      {/* API Keys Table */}
      <div className="rounded-3xl border border-border/80 bg-card p-5 md:p-6 space-y-4 shadow-soft">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold flex items-center gap-2">
            <Key className="h-4 w-4 text-amber-500" />
            <span>API Keys</span>
          </h3>
          <span className="text-xs text-muted-foreground">{apiKeys.length} Active Keys</span>
        </div>

        <div className="divide-y divide-border/60 max-h-[260px] overflow-y-auto custom-scrollbar pr-1">
          {apiKeys.map((k) => (
            <div
              key={k.id}
              className="py-3 flex items-center justify-between gap-3 flex-wrap text-xs"
            >
              <div className="space-y-0.5">
                <p className="font-bold text-foreground">{k.name}</p>
                <p className="font-mono text-muted-foreground">{k.maskedKey}</p>
                <div className="flex gap-2 text-[0.65rem] text-muted-foreground pt-0.5">
                  <span>Created: {k.createdAt}</span>
                  <span>·</span>
                  <span>Last used: {k.lastUsed}</span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(k.fullKey || k.maskedKey);
                    toast.success("API key copied to clipboard!");
                  }}
                  className="flex items-center gap-1 rounded-xl border border-border px-2.5 py-1.5 font-bold hover:bg-muted transition-colors cursor-pointer"
                >
                  <Copy className="h-3 w-3" />
                  <span>Copy</span>
                </button>
                {isPro && (
                  <button
                    onClick={() => {
                      revokeApiKey(k.id);
                      toast.success("API key revoked");
                    }}
                    className="rounded-xl border border-border p-1.5 text-rose-500 hover:bg-rose-500/10 transition-colors cursor-pointer"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Webhooks Section */}
      <div className="rounded-3xl border border-border/80 bg-card p-5 md:p-6 space-y-4 shadow-soft">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold flex items-center gap-2">
            <Webhook className="h-4 w-4 text-orange-500" />
            <span>Webhook Endpoints</span>
          </h3>
          {isPro && (
            <button
              onClick={() => setIsWebhookModalOpen(true)}
              className="flex items-center gap-1 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs font-bold hover:bg-muted transition-colors cursor-pointer"
            >
              <Plus className="h-3 w-3" />
              <span>Add Endpoint</span>
            </button>
          )}
        </div>

        <div className="divide-y divide-border/60 max-h-[260px] overflow-y-auto custom-scrollbar pr-1">
          {webhooks.map((wh) => (
            <div key={wh.id} className="py-3 space-y-1.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-bold text-foreground">{wh.description}</span>
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[0.65rem] font-extrabold text-emerald-600 dark:text-emerald-400 capitalize">
                  ● {wh.status}
                </span>
              </div>
              <p className="font-mono text-muted-foreground break-all">{wh.url}</p>
              <div className="flex items-center justify-between pt-1">
                <div className="flex flex-wrap gap-1.5">
                  {wh.events.map((ev) => (
                    <span
                      key={ev}
                      className="rounded bg-muted px-1.5 py-0.5 text-[0.65rem] font-mono font-semibold"
                    >
                      {ev}
                    </span>
                  ))}
                </div>
                {isPro && (
                  <button
                    onClick={() => {
                      removeWebhook(wh.id);
                      toast.success("Webhook endpoint removed");
                    }}
                    className="text-rose-500 hover:text-rose-600 text-xs font-semibold"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Code Sandbox / Snippets */}
      <div className="rounded-3xl border border-border/80 bg-card p-5 md:p-6 space-y-3 shadow-soft">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-brand" />
            <h3 className="text-sm font-bold">API Quickstart</h3>
          </div>
          <div className="flex rounded-full border border-border bg-muted/40 p-0.5 text-xs">
            <button
              onClick={() => setActiveCodeLang("typescript")}
              className={cn(
                "rounded-full px-3 py-1 font-bold transition-all cursor-pointer",
                activeCodeLang === "typescript"
                  ? "bg-card text-foreground shadow-xs"
                  : "text-muted-foreground",
              )}
            >
              TypeScript
            </button>
            <button
              onClick={() => setActiveCodeLang("curl")}
              className={cn(
                "rounded-full px-3 py-1 font-bold transition-all cursor-pointer",
                activeCodeLang === "curl"
                  ? "bg-card text-foreground shadow-xs"
                  : "text-muted-foreground",
              )}
            >
              cURL
            </button>
          </div>
        </div>

        <pre className="rounded-2xl bg-neutral-950 p-4 text-xs font-mono text-emerald-400 overflow-x-auto max-h-[300px] overflow-y-auto custom-scrollbar border border-neutral-800">
          {activeCodeLang === "typescript" ? tsSnippet : curlSnippet}
        </pre>
      </div>

      {/* Pro Tier Lock Barrier */}
      {!isPro && (
        <div className="rounded-3xl border border-amber-500/30 bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-transparent p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="space-y-1 text-center sm:text-left">
            <div className="flex items-center justify-center sm:justify-start gap-2">
              <Lock className="h-4 w-4 text-amber-500" />
              <h4 className="text-sm font-black">Developer API & Webhooks Require Pro</h4>
            </div>
            <p className="text-xs text-muted-foreground">
              Unlock 500k monthly API requests, real-time webhooks, and full REST & WebSocket
              access.
            </p>
          </div>
          <button
            onClick={() => openUpgradeModal("API & Webhooks Access")}
            className="rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-5 py-2.5 text-xs font-bold text-white shadow-soft hover:brightness-105 transition-all cursor-pointer whitespace-nowrap"
          >
            Upgrade to Pro ($29/mo)
          </button>
        </div>
      )}

      {/* Key Creation Modal */}
      {isKeyModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-200"
          onClick={() => setIsKeyModalOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-3xl border border-border/80 bg-card p-6 shadow-2xl animate-in zoom-in-95 duration-200 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-black">
                {createdKeySecret ? "Save Your API Key" : "Generate API Key"}
              </h3>
              <button
                onClick={() => setIsKeyModalOpen(false)}
                className="text-muted-foreground hover:text-foreground text-sm font-bold"
              >
                ✕
              </button>
            </div>

            {createdKeySecret ? (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Copy this key now. For your security, you will not be able to view it again.
                </p>
                <div className="rounded-2xl border border-amber-500/30 bg-muted/40 p-3 flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-amber-500 break-all">
                    {createdKeySecret}
                  </span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(createdKeySecret);
                      toast.success("API key copied!");
                    }}
                    className="p-2 rounded-xl bg-amber-500 text-white hover:brightness-105 transition-all cursor-pointer shrink-0"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
                <button
                  onClick={() => setIsKeyModalOpen(false)}
                  className="w-full rounded-2xl bg-foreground py-2.5 text-xs font-bold text-background cursor-pointer"
                >
                  Done
                </button>
              </div>
            ) : (
              <form onSubmit={handleGenerateKey} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    Key Name / Service
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g., Discord Auto-Poster Bot"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    className="w-full rounded-2xl bg-muted/40 border border-border px-3.5 py-2.5 text-xs font-semibold outline-none focus:border-amber-500"
                  />
                </div>

                <div className="flex items-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setIsKeyModalOpen(false)}
                    className="flex-1 rounded-2xl border border-border py-2.5 text-xs font-bold hover:bg-muted transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="flex-1 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-500 py-2.5 text-xs font-bold text-white shadow-soft hover:brightness-105 transition-all cursor-pointer"
                  >
                    Create Key
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Webhook Modal */}
      {isWebhookModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-200"
          onClick={() => setIsWebhookModalOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-3xl border border-border/80 bg-card p-6 shadow-2xl animate-in zoom-in-95 duration-200 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-black">Register Webhook Endpoint</h3>
              <button
                onClick={() => setIsWebhookModalOpen(false)}
                className="text-muted-foreground hover:text-foreground text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateWebhook} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  Payload URL (HTTPS)
                </label>
                <input
                  type="url"
                  required
                  placeholder="https://yourserver.com/webhooks/spaces"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  className="w-full rounded-2xl bg-muted/40 border border-border px-3.5 py-2.5 text-xs font-semibold outline-none focus:border-amber-500"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  Description
                </label>
                <input
                  type="text"
                  placeholder="e.g. Analytics Pipeline"
                  value={webhookDesc}
                  onChange={(e) => setWebhookDesc(e.target.value)}
                  className="w-full rounded-2xl bg-muted/40 border border-border px-3.5 py-2.5 text-xs font-semibold outline-none focus:border-amber-500"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  Subscribed Events
                </label>
                <div className="space-y-2">
                  {AVAILABLE_EVENTS.map((ev) => {
                    const isChecked = selectedEvents.includes(ev.id);
                    return (
                      <label
                        key={ev.id}
                        className="flex items-center gap-2.5 rounded-xl border border-border/60 p-2.5 text-xs font-medium cursor-pointer hover:bg-muted/30"
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedEvents([...selectedEvents, ev.id]);
                            } else {
                              setSelectedEvents(selectedEvents.filter((id) => id !== ev.id));
                            }
                          }}
                          className="rounded text-amber-500 focus:ring-amber-500"
                        />
                        <div>
                          <p className="font-mono font-bold text-foreground">{ev.label}</p>
                          <p className="text-[0.65rem] text-muted-foreground">{ev.desc}</p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsWebhookModalOpen(false)}
                  className="flex-1 rounded-2xl border border-border py-2.5 text-xs font-bold hover:bg-muted transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-500 py-2.5 text-xs font-bold text-white shadow-soft hover:brightness-105 transition-all cursor-pointer"
                >
                  Save Endpoint
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
