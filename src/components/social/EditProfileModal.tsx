import { useState } from "react";
import { X, Camera, Loader2, Check } from "lucide-react";
import { Avatar } from "@/components/social/Avatar";
import type { Profile } from "@/lib/types";
import { currentUser } from "@/lib/profile-service";
import { updateUserProfile, uploadMedia } from "@/lib/api-client";
import { updateUserSession } from "@/lib/auth-state";
import { toast } from "sonner";

interface EditProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialProfile?: Profile;
  onProfileUpdated?: (updated: Profile) => void;
}

export function EditProfileModal({
  isOpen,
  onClose,
  initialProfile,
  onProfileUpdated,
}: EditProfileModalProps) {
  const base = initialProfile || currentUser;
  const [form, setForm] = useState({
    display_name: base.display_name,
    bio: base.bio,
    location: base.location,
    website: base.website,
    avatar_url: base.avatar_url,
  });
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingAvatar(true);
    try {
      const res = await uploadMedia(file, "avatars");
      setForm((prev) => ({ ...prev, avatar_url: res.url }));
      updateUserSession({ avatar_url: res.url });
      toast.success("Avatar image uploaded");
    } catch (err: any) {
      console.error("Avatar upload failed:", err);
      toast.error(err?.message || "Could not upload image. Please try again.");
    } finally {
      setUploadingAvatar(false);
      e.target.value = "";
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await updateUserProfile(form);
      const updatedUser = res.user || { ...currentUser, ...form };
      updateUserSession(updatedUser);
      onProfileUpdated?.(updatedUser as Profile);
      toast.success("Profile saved successfully!");
      onClose();
    } catch (err: any) {
      console.error("Saving profile failed:", err);
      toast.error(err?.message || "Could not save your profile. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div
        className="glass-panel relative w-full max-w-md overflow-hidden rounded-3xl p-6 shadow-2xl border border-border/80 bg-card/95"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-4 border-b border-border/60">
          <h2 className="text-lg font-bold">Edit Profile</h2>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          {/* Avatar Upload */}
          <div className="flex flex-col items-center gap-2">
            <div className="relative group cursor-pointer">
              <Avatar
                name={form.display_name}
                src={form.avatar_url}
                className="h-20 w-20 text-xl ring-4 ring-card"
              />
              <label
                htmlFor="avatar-upload"
                className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
              >
                {uploadingAvatar ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Camera className="h-5 w-5" />
                )}
              </label>
              <input
                id="avatar-upload"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarChange}
              />
            </div>
            <span className="text-xs text-muted-foreground">Click to upload new photo</span>
          </div>

          {/* Form Fields */}
          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1">
              Display Name
            </label>
            <input
              type="text"
              required
              value={form.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              className="w-full rounded-2xl bg-foreground/5 px-4 py-2.5 text-sm outline-none border border-transparent focus:border-brand/40"
            />
          </div>

          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1">
              Bio
            </label>
            <textarea
              rows={3}
              value={form.bio}
              onChange={(e) => setForm({ ...form, bio: e.target.value })}
              placeholder="Tell the community what you create..."
              className="w-full resize-none rounded-2xl bg-foreground/5 px-4 py-2.5 text-sm outline-none border border-transparent focus:border-brand/40"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1">
                Location
              </label>
              <input
                type="text"
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                placeholder="e.g. San Francisco"
                className="w-full rounded-2xl bg-foreground/5 px-3 py-2 text-sm outline-none border border-transparent focus:border-brand/40"
              />
            </div>

            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1">
                Website
              </label>
              <input
                type="text"
                value={form.website}
                onChange={(e) => setForm({ ...form, website: e.target.value })}
                placeholder="yoursite.com"
                className="w-full rounded-2xl bg-foreground/5 px-3 py-2 text-sm outline-none border border-transparent focus:border-brand/40"
              />
            </div>
          </div>

          {/* Submit buttons */}
          <div className="flex items-center justify-end gap-2 pt-4 border-t border-border/60">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-foreground/5"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-1.5 rounded-full bg-gradient-to-r from-brand to-brand-pink px-6 py-2.5 text-xs font-bold text-white shadow-soft hover:shadow-glow transition-all active:scale-95 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              Save Changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
