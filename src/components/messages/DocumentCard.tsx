import { File, FileArchive, FileCode, FileSpreadsheet, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { MediaDownloadButton } from "@/components/social/MediaDownloadButton";

/** A download card for a non-media file: parses the tagged body or a bare url. */
export function DocumentCard({ body, isMine }: { body: string; isMine: boolean }) {
  const value = body.trim();
  let fileUrl = value;
  let fileName = "Attached Document";
  let ext = "file";

  // Check for tagged format: 📄 Document: [filename] [url] or 📎 File: [filename] [url]
  const matchTagged = value.match(/^(?:📄|📎)\s*(.*?):\s*\[(.*?)\]\s*\[(.*?)\]/);
  if (matchTagged) {
    fileName = matchTagged[2] || matchTagged[1] || "Document";
    fileUrl = matchTagged[3] || value;
  } else {
    try {
      const parsedUrl = new URL(value, window.location.origin);
      const parts = parsedUrl.pathname.split("/");
      const lastPart = parts[parts.length - 1];
      if (lastPart && lastPart.includes(".")) fileName = decodeURIComponent(lastPart);
    } catch {
      // Unparseable URL — the defaults above (no extension) already handle it.
    }
  }

  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx > 0) ext = fileName.slice(dotIdx + 1).toLowerCase();

  // Downloads used to be a bare <a href={fileUrl} download>: the stored path is
  // private, so the navigation reached the read proxy with no capability and got
  // its fail-closed 404. Saving now mints access first (see MediaDownloadButton).
  const isPdf = ext === "pdf" || value.toLowerCase().includes(".pdf");
  const isCode = ["js", "ts", "py", "json", "html", "css", "cpp", "java", "sh", "md"].includes(ext);
  const isZip = ["zip", "rar", "7z", "tar", "gz"].includes(ext);
  const isSheet = ["csv", "xlsx", "xls"].includes(ext);

  return (
    <div
      className={cn(
        "flex max-w-[300px] items-center gap-3 rounded-[20px] border p-3 shadow-xs transition-all sm:max-w-[340px]",
        isMine
          ? "border-white/10 bg-black/15 text-white"
          : "border-border/40 bg-background/80 text-foreground dark:bg-neutral-900/60",
      )}
    >
      <div
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xs font-bold uppercase shadow-xs",
          isPdf
            ? "bg-rose-500 text-white"
            : isZip
              ? "bg-amber-500 text-white"
              : isCode
                ? "bg-emerald-500 text-white"
                : isSheet
                  ? "bg-teal-500 text-white"
                  : isMine
                    ? "bg-white/20 text-white"
                    : "bg-brand/15 text-brand",
        )}
      >
        {isPdf ? (
          <FileText className="h-5 w-5" />
        ) : isZip ? (
          <FileArchive className="h-5 w-5" />
        ) : isCode ? (
          <FileCode className="h-5 w-5" />
        ) : isSheet ? (
          <FileSpreadsheet className="h-5 w-5" />
        ) : (
          <File className="h-5 w-5" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-bold leading-tight">{fileName}</p>
        <p
          className={cn(
            "mt-0.5 font-mono text-[10px] uppercase tracking-wider",
            isMine ? "text-white/80" : "text-muted-foreground",
          )}
        >
          {ext} document
        </p>
      </div>

      <MediaDownloadButton
        url={fileUrl}
        name={fileName}
        title="Download File"
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-transform hover:scale-105 active:scale-95",
          isMine
            ? "bg-white/20 text-white hover:bg-white/30"
            : "bg-muted text-foreground hover:bg-muted/80",
        )}
      />
    </div>
  );
}
