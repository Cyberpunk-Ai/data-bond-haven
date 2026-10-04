import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Camera, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Avatar } from "@/components/social/Avatar";
import { LogoEmojiField } from "@/components/social/LogoEmojiField";
import { uploadMedia } from "@/lib/api-client";
import { friendlyError } from "@/lib/error-messages";

export interface EditableWorkspace {
  id: string;
  name: string;
  bio: string;
  logoEmoji: string;
  avatarUrl: string | null;
}

interface EditWorkspaceModalProps {
  isOpen: boolean;
  workspace: EditableWorkspace;
  onClose: () => void;
  onSave: (patch: {
    name: string;
    bio: string;
    logoEmoji: string;
    avatarUrl: string | null;
  }) => Promise<void>;
}

/**
 * Team counterpart of EditProfileModal: same sheet, but writes the shared
 * brand account (name, logo emoji, uploaded avatar, bio) instead of a
 * personal profile. Only Owner/Admin should be able to open it — the write
 * itself is re-checked server-side by the "workspaces owner update" RLS
 * policy, so a stolen UI session still can't edit a team it doesn't manage.
 */
export function EditWorkspaceModal({
  isOpen,
  workspace,
  onClose,
  onSave,
}: EditWorkspaceModalProps) {
  const [form, setForm] = useState({
    name: workspace.name,
    bio: workspace.bio,
    logoEmoji: workspace.logoEmoji,
    avatarUrl: workspace.avatarUrl,
  });
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  // Re-seed the fields whenever the modal opens (or the team changes while
  // it is open) so a stale edit never overwrites a fresher server row.
  useEffect(() => {
    if (isOpen) {
      setForm({
        name: workspace.name,
        bio: workspace.bio,
        logoEmoji: workspace.logoEmoji,
        avatarUrl: workspace.avatarUrl,
      });
    }
  }, [
    isOpen,
    workspace.id,
    workspace.name,
    workspace.bio,
    workspace.logoEmoji,
    workspace.avatarUrl,
  ]);

  if (!isOpen) return null;

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingAvatar(true);
    try {
      const res = await uploadMedia(file, "avatars");
      setForm((prev) => ({ ...prev, avatarUrl: res.url }));
      toast.success("Team logo uploaded");
    } catch (err) {
      toast.error(friendlyError(err, "Could not upload image. Please try again."));
    } finally {
      setUploadingAvatar(false);
      e.target.value = "";
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("The team needs a name.");
      return;
    }
    setSaving(true);
    try {
      await onSave({
        name: form.name.trim(),
        bio: form.bio.trim(),
        logoEmoji: form.logoEmoji.trim() || "✨",
        avatarUrl: form.avatarUrl,
      });
      toast.success("Team profile updated.");
      onClose();
    } catch (err) {
      toast.error(friendlyError(err, "Could not save the team profile."));
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-[92dvh] overflow-y-auto rounded-3xl border border-border/80 bg-card p-6 shadow-2xl animate-in zoom-in-95 duration-200 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-black">Edit team profile</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Avatar / logo upload */}
          <div className="flex flex-col items-center gap-2">
            <div className="relative group cursor-pointer">
              {form.avatarUrl ? (
                <Avatar
                  name={form.name || workspace.name}
                  src={form.avatarUrl}
                  className="h-20 w-20 text-xl ring-4 ring-card"
                />
              ) : (
                <span className="flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-brand to-brand-pink text-3xl ring-4 ring-card">
                  {form.logoEmoji || "✨"}
                </span>
              )}
              <label
                htmlFor="ws-avatar-upload"
                className="absolute inset-0 flex items-center justify-center rounded-3xl bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
              >
                {uploadingAvatar ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Camera className="h-5 w-5" />
                )}
              </label>
              <input
                id="ws-avatar-upload"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarChange}
              />
            </div>
            <span className="text-xs text-muted-foreground">
              Click to upload a team logo (or pick an emoji below)
            </span>
          </div>

          <div className="grid grid-cols-[7.5rem_1fr] gap-3">
            <LogoEmojiField
              label="Emoji"
              value={form.logoEmoji}
              onChange={(logoEmoji) => setForm((prev) => ({ ...prev, logoEmoji }))}
              inputClassName="rounded-2xl px-3 py-2.5 text-lg"
            />
            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1">
                Team Name
              </label>
              <input
                type="text"
                required
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                maxLength={60}
                className="w-full rounded-2xl bg-muted/40 border border-border px-3.5 py-2.5 text-sm font-semibold outline-none focus:border-brand"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1">
              Bio
            </label>
            <textarea
              value={form.bio}
              onChange={(e) => setForm((prev) => ({ ...prev, bio: e.target.value }))}
              rows={3}
              maxLength={280}
              placeholder="What does this team post about?"
              className="w-full rounded-2xl bg-muted/40 border border-border px-3.5 py-2.5 text-sm outline-none resize-none focus:border-brand"
            />
            <p className="mt-1 text-right text-[11px] text-muted-foreground">
              {form.bio.length}/280
            </p>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-2xl border border-border py-2.5 text-xs font-bold hover:bg-muted transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 rounded-2xl bg-gradient-to-r from-brand to-brand-pink py-2.5 text-xs font-bold text-white shadow-soft hover:shadow-glow transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save profile"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
