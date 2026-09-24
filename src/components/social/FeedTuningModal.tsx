import { useState, useEffect } from "react";
import {
  Sparkles,
  Sliders,
  X,
  Plus,
  Trash2,
  Check,
  Compass,
  Eye,
  ShieldAlert,
  RefreshCw,
} from "lucide-react";
import type { UserFeedPreferences } from "@/lib/types";
import { getFeedPreferences, updateFeedPreferences } from "@/lib/api-client";
import { toast } from "sonner";

interface FeedTuningModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPreferencesUpdated?: () => void;
}

export function FeedTuningModal({ isOpen, onClose, onPreferencesUpdated }: FeedTuningModalProps) {
  const [preferences, setPreferences] = useState<UserFeedPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newTagInput, setNewTagInput] = useState("");

  useEffect(() => {
    if (isOpen) {
      loadPreferences();
    }
  }, [isOpen]);

  async function loadPreferences() {
    setLoading(true);
    try {
      const res = await getFeedPreferences();
      setPreferences({
        preferredTags: [],
        mutedTags: [],
        mutedAuthors: [],
        serendipityLevel: "balanced",
        topicAffinities: {},
        ...res.preferences,
      });
    } catch (err) {
      toast.error("Failed to load feed preferences");
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(updated: Partial<UserFeedPreferences>) {
    if (!preferences) return;
    setSaving(true);
    try {
      const res = await updateFeedPreferences(updated);
      setPreferences(res.preferences);
      toast.success("Feed algorithm preferences updated");
      if (onPreferencesUpdated) onPreferencesUpdated();
    } catch (err) {
      toast.error("Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  function handleSerendipityChange(level: "focused" | "balanced" | "adventurous") {
    if (!preferences) return;
    const next = { ...preferences, serendipityLevel: level };
    setPreferences(next);
    handleSave({ serendipityLevel: level });
  }

  function handleAddTag() {
    if (!newTagInput.trim() || !preferences) return;
    const clean = newTagInput.trim().replace(/^#/, "").toLowerCase();
    const tags = preferences.preferredTags || [];
    if (tags.includes(clean)) {
      setNewTagInput("");
      return;
    }
    const updatedTags = [...tags, clean];
    const updatedAffinities = { ...preferences.topicAffinities, [clean]: 8 };
    setPreferences({
      ...preferences,
      preferredTags: updatedTags,
      topicAffinities: updatedAffinities,
    });
    setNewTagInput("");
    handleSave({ preferredTags: updatedTags, topicAffinities: updatedAffinities });
  }

  function handleRemovePreferredTag(tag: string) {
    if (!preferences) return;
    const tags = preferences.preferredTags || [];
    const updatedTags = tags.filter((t) => t !== tag);
    const updatedAffinities = { ...preferences.topicAffinities };
    delete updatedAffinities[tag];
    setPreferences({
      ...preferences,
      preferredTags: updatedTags,
      topicAffinities: updatedAffinities,
    });
    handleSave({ preferredTags: updatedTags, topicAffinities: updatedAffinities });
  }

  function handleUnmuteTag(tag: string) {
    if (!preferences) return;
    const muted = preferences.mutedTags || [];
    const updatedMuted = muted.filter((t) => t !== tag);
    setPreferences({ ...preferences, mutedTags: updatedMuted });
    handleSave({ mutedTags: updatedMuted });
  }

  function handleUnmuteAuthor(authorId: string) {
    if (!preferences) return;
    const authors = preferences.mutedAuthors || [];
    const updatedMuted = authors.filter((a) => a !== authorId);
    setPreferences({ ...preferences, mutedAuthors: updatedMuted });
    handleSave({ mutedAuthors: updatedMuted });
  }

  if (!isOpen) return null;

  return (
    <div
      id="feed-tuning-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        id="feed-tuning-modal-content"
        className="w-full max-w-lg bg-card border border-border/80 rounded-2xl shadow-2xl p-6 relative overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-border/60">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
              <Sliders className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground tracking-tight">
                Feed Tuning & Recommendations
              </h2>
              <p className="text-xs text-muted-foreground">
                Control what the algorithm surfaces and how much new content you discover
              </p>
            </div>
          </div>
          <button
            id="close-feed-tuning-modal-btn"
            onClick={onClose}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/80 rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="py-12 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <RefreshCw className="w-6 h-6 animate-spin text-primary" />
            <span className="text-xs font-medium">Loading your recommendation profile...</span>
          </div>
        ) : preferences ? (
          <div className="space-y-6 pt-5 max-h-[70vh] overflow-y-auto pr-1">
            {/* Exploration & Serendipity Balance */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <Compass className="w-3.5 h-3.5 text-primary" />
                  Discovery & Serendipity Level
                </label>
                <span className="text-xs font-medium text-primary capitalize px-2 py-0.5 rounded-full bg-primary/10">
                  {preferences.serendipityLevel}
                </span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Choose how often the feed balances familiar accounts vs. introducing rising creators
                and unexpected ideas.
              </p>

              <div className="grid grid-cols-3 gap-2 pt-1">
                {[
                  {
                    id: "focused",
                    title: "Focused",
                    desc: "Stick closely to followed creators and preferred tags",
                  },
                  {
                    id: "balanced",
                    title: "Balanced",
                    desc: "Optimal mix of affinity + 28% curated discoveries",
                  },
                  {
                    id: "adventurous",
                    title: "Adventurous",
                    desc: "Maximum discovery of new perspectives & emerging topics",
                  },
                ].map((tier) => {
                  const isActive = preferences.serendipityLevel === tier.id;
                  return (
                    <button
                      key={tier.id}
                      id={`serendipity-tier-${tier.id}`}
                      type="button"
                      onClick={() => handleSerendipityChange(tier.id as any)}
                      className={`p-3 rounded-xl border text-left flex flex-col justify-between transition-all duration-150 ${
                        isActive
                          ? "border-primary bg-primary/10 shadow-sm"
                          : "border-border/60 bg-muted/30 hover:bg-muted/60"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span
                          className={`text-xs font-semibold ${isActive ? "text-primary" : "text-foreground"}`}
                        >
                          {tier.title}
                        </span>
                        {isActive && <Check className="w-3.5 h-3.5 text-primary" />}
                      </div>
                      <span className="text-[11px] text-muted-foreground leading-snug">
                        {tier.desc}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Preferred Topics */}
            <div className="space-y-2.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-primary" />
                Active Interests & Preferred Topics
              </label>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Posts matching these topics receive higher ranking scores in your personal feed.
              </p>

              <div className="flex flex-wrap gap-2 pt-1">
                {(preferences.preferredTags || []).map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-muted text-foreground text-xs font-medium border border-border/70"
                  >
                    #{tag}
                    <button
                      type="button"
                      onClick={() => handleRemovePreferredTag(tag)}
                      className="text-muted-foreground hover:text-destructive p-0.5 rounded transition-colors"
                      title="Remove topic"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>

              {/* Add New Topic Input */}
              <div className="flex items-center gap-2 pt-1">
                <input
                  type="text"
                  placeholder="Add a topic (e.g. typography, robotics)..."
                  value={newTagInput}
                  onChange={(e) => setNewTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddTag();
                    }
                  }}
                  className="flex-1 bg-muted/50 border border-border/70 rounded-xl px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <button
                  id="add-feed-topic-btn"
                  type="button"
                  onClick={handleAddTag}
                  disabled={!newTagInput.trim()}
                  className="px-3 py-2 bg-primary text-primary-foreground text-xs font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add
                </button>
              </div>
            </div>

            {/* Muted Filters & Clean Content Shield */}
            {((preferences.mutedTags || []).length > 0 ||
              (preferences.mutedAuthors || []).length > 0) && (
              <div className="space-y-3 pt-2 border-t border-border/60">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <ShieldAlert className="w-3.5 h-3.5 text-amber-500" />
                  Muted Topics & Accounts
                </label>

                {(preferences.mutedTags || []).length > 0 && (
                  <div className="space-y-1">
                    <span className="text-[11px] text-muted-foreground font-medium">
                      Muted Tags:
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {(preferences.mutedTags || []).map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-destructive/10 text-destructive text-xs font-medium border border-destructive/20"
                        >
                          #{tag}
                          <button
                            type="button"
                            onClick={() => handleUnmuteTag(tag)}
                            className="text-destructive/70 hover:text-destructive"
                            title="Unmute tag"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {(preferences.mutedAuthors || []).length > 0 && (
                  <div className="space-y-1">
                    <span className="text-[11px] text-muted-foreground font-medium">
                      Muted Creators:
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {(preferences.mutedAuthors || []).map((author) => (
                        <span
                          key={author}
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-destructive/10 text-destructive text-xs font-medium border border-destructive/20"
                        >
                          @{author.replace("u_", "")}
                          <button
                            type="button"
                            onClick={() => handleUnmuteAuthor(author)}
                            className="text-destructive/70 hover:text-destructive"
                            title="Unmute author"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : null}

        {/* Footer */}
        <div className="mt-6 pt-4 border-t border-border/60 flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">
            Changes take effect instantly on your live feed.
          </span>
          <button
            id="done-feed-tuning-modal-btn"
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-primary text-primary-foreground text-xs font-medium rounded-xl hover:opacity-90 transition-opacity"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
