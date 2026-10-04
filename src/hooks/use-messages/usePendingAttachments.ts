import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingAttachment } from "@/lib/message-helpers";

/** Media extensions that render inline; everything else becomes a document card. */
const MEDIA_EXT = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "avif",
  "mp4",
  "webm",
  "mov",
  "mp3",
  "wav",
  "ogg",
  "m4a",
];

function isMediaFile(file: File) {
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  return /^(image|video|audio)\//.test(file.type) || MEDIA_EXT.includes(ext);
}

/**
 * The composer's staged files. Selecting a file ONLY queues it here with a local
 * preview; nothing uploads or sends until the user presses Send — so picking the
 * wrong file is a one-tap undo, not a message already in the other person's inbox.
 *
 * Object URLs are revoked on drop and on unmount so the staged previews don't
 * leak memory for the lifetime of the page.
 */
export function usePendingAttachments() {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const urlsRef = useRef<Set<string>>(new Set());

  const stageFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    const next: PendingAttachment[] = files.map((file, i) => {
      const previewUrl = /^(image|video)\//.test(file.type) ? URL.createObjectURL(file) : "";
      if (previewUrl) urlsRef.current.add(previewUrl);
      return {
        id: `att_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 7)}`,
        file,
        name: file.name,
        sizeLabel: `${(file.size / (1024 * 1024)).toFixed(1)} MB`,
        isMedia: isMediaFile(file),
        previewUrl,
      };
    });
    setAttachments((prev) => [...prev, ...next]);
  }, []);

  const dropAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
        urlsRef.current.delete(target.previewUrl);
      }
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  const clearAttachments = useCallback(() => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current.clear();
    setAttachments([]);
  }, []);

  // Anything still staged when the composer unmounts shouldn't keep its blob alive.
  useEffect(() => {
    const urls = urlsRef.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  return { attachments, stageFiles, dropAttachment, clearAttachments };
}
