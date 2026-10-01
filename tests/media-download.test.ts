import { describe, expect, it } from "vitest";

import {
  asciiName,
  attachmentHref,
  contentDisposition,
  downloadErrorMessage,
  extensionOf,
  fileNameFromMessageBody,
  fileNameFromUrl,
  isPrivateMediaPath,
  isProxiedMediaUrl,
  mediaStorageKey,
  planDownload,
  sanitizeFileName,
  withMediaToken,
} from "@/lib/media-download";
import { mediaKeyFromUrl } from "@/lib/storage/provider.server";

/**
 * Saving a chat attachment, which used to be one `<a download>` and never worked.
 *
 * The stored URL is a private proxy path, so clicking it navigated with no
 * capability and got the read proxy's fail-closed 404 — "download fails" in the
 * report. These rules are the parts that can be checked without a browser: what
 * name a file is saved under, which URL is allowed to carry it, and what the
 * user is told when even that does not work.
 */

describe("the name a file is saved as", () => {
  it("uses the name the sender chose, not the random storage key", () => {
    const body = "📄 Document: [Quarterly report.pdf] [/api/public/media/messages/c1/9f3a.pdf]";
    expect(fileNameFromMessageBody(body)).toBe("Quarterly report.pdf");
    // The object on disk is a uuid; handing that back is the old behaviour.
    expect(fileNameFromUrl("/api/public/media/messages/c1/9f3a.pdf")).toBe("9f3a.pdf");
  });

  it("returns null when a URL genuinely has no name", () => {
    expect(fileNameFromUrl("/api/public/media/messages/c1/9f3a")).toBeNull();
    expect(fileNameFromUrl("")).toBeNull();
  });

  it("strips what would break a Content-Disposition header", () => {
    // A download name arrives from a chat message, and the proxy puts it into a
    // response header. Quotes and newlines are how header injection starts.
    expect(sanitizeFileName('a"b\nc.pdf')).toBe("abc.pdf");
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("   ")).toBe("attachment");
  });

  it("keeps the extension when it has to truncate", () => {
    const long = `${"x".repeat(200)}.docx`;
    const saved = sanitizeFileName(long);
    expect(saved.length).toBeLessThanOrEqual(120);
    expect(saved.endsWith(".docx")).toBe(true);
  });

  it("reads an extension out of a filename", () => {
    expect(extensionOf("notes.MD")).toBe("md");
    expect(extensionOf("noEXT")).toBe("");
  });
});

describe("which object a download is allowed to read", () => {
  const cases = [
    "/api/public/media/messages/c1/9f3a.pdf",
    "https://app.example.com/api/public/media/recordings/s1/live.webm",
    "/api/public/media/messages/c1/9f3a.pdf?mt=abc123",
    "messages/c1/9f3a.pdf",
    "https://cdn.example.com/elsewhere.png",
    "",
  ];

  it("agrees with the server's own rule for every shape", () => {
    // These two functions are the same rule written twice, once for the browser
    // and once for the proxy. If they ever drift, a download resolves a key the
    // server refuses to read — which looks exactly like the file having gone.
    for (const url of cases) {
      expect(mediaStorageKey(url)).toBe(mediaKeyFromUrl(url));
    }
  });

  it("cuts a proxy URL down to its object path", () => {
    expect(mediaStorageKey("https://x/app/api/public/media/messages/c1/a.png?mt=t")).toBe(
      "messages/c1/a.png",
    );
    // An absolute URL we do not serve is not a storage key, whatever it ends with.
    expect(mediaStorageKey("https://cdn.example.com/elsewhere.png")).toBeNull();
  });

  it("only claims control over our own proxy", () => {
    expect(isProxiedMediaUrl("/api/public/media/messages/c1/a.png")).toBe(true);
    expect(isProxiedMediaUrl("https://cdn.example.com/a.png")).toBe(false);
  });
});

describe("the attachment URL the proxy will actually save", () => {
  it("asks for an attachment with a safe name", () => {
    const href = attachmentHref("/api/public/media/messages/c1/9f3a.pdf", "Invoice (march).pdf");
    expect(href).toContain("/api/public/media/messages/c1/9f3a.pdf?");
    expect(href).toContain("dl=1");
    expect(href).toContain("name=Invoice+%28march%29.pdf");
  });

  it("refuses to build a href for something we do not serve", () => {
    expect(attachmentHref("https://cdn.example.com/a.png", "a.png")).toBeNull();
  });

  it("never walks out of the bucket", () => {
    expect(attachmentHref("/api/public/media/../secrets.env", "x")).toBeNull();
  });

  it("plans both halves of a save", () => {
    const plan = planDownload("/api/public/media/messages/c1/9f3a.pdf", "Report.pdf");
    expect(plan.name).toBe("Report.pdf");
    expect(plan.saveHref).toContain("dl=1");
    expect(plan.saveHref).toContain("name=Report.pdf");
  });
});

describe("the header the proxy stamps on the file", () => {
  it("carries a non-ASCII name in the form browsers decode", () => {
    // `filename="…"` is 7-bit: an accented or CJK name sent only in that field
    // arrives mangled, which is a silent corruption of the sender's filename.
    const header = contentDisposition("attachment", "résumé.pdf");
    expect(header).toContain('filename="rsum.pdf"');
    expect(header).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  });

  it("escapes what would end the quoted field", () => {
    const header = contentDisposition("attachment", 'a"b\\c.txt');
    expect(header).not.toContain('a"b');
    expect(header).toContain('filename="abc.txt"');
  });

  it("keeps RFC 5987 attr-char honest by encoding the rest", () => {
    // Apostrophes and parentheses are legal filenames but are not attr-char.
    expect(contentDisposition("attachment", "Q3 (final).docx")).toContain(
      "filename*=UTF-8''Q3%20%28final%29.docx",
    );
  });

  it("never hands over an empty quoted value", () => {
    expect(contentDisposition("attachment", "你好")).toContain('filename="media"');
    expect(asciiName("")).toBe("media");
  });

  it("says inline only when the caller meant inline", () => {
    expect(contentDisposition("inline", "a.png").startsWith("inline; ")).toBe(true);
    expect(contentDisposition("attachment", "a.png").startsWith("attachment; ")).toBe(true);
  });
});

describe("the capability that unlocks a private object", () => {
  it("recognises a private folder however the URL is written", () => {
    // Both forms are the same bytes, and the proxy refuses both without a token.
    expect(isPrivateMediaPath("/api/public/media/messages/c1/a.png")).toBe(true);
    expect(isPrivateMediaPath("https://app.example.com/api/public/media/stories/u1/s.png")).toBe(
      true,
    );
    expect(isPrivateMediaPath("/api/public/media/avatars/u1/me.png")).toBe(false);
    expect(isPrivateMediaPath(null)).toBe(false);
    expect(isPrivateMediaPath("")).toBe(false);
  });

  it("adds the token where a query can actually start", () => {
    // `path&mt=…` without a `?` puts the token inside the last path segment: the
    // proxy then reports the object as missing and the user is told the file is
    // gone when all that happened is a wrongly built URL.
    expect(withMediaToken("/api/public/media/messages/c1/a.png", "tok")).toBe(
      "/api/public/media/messages/c1/a.png?mt=tok",
    );
    expect(withMediaToken("/api/public/media/messages/c1/a.png?dl=1", "tok")).toBe(
      "/api/public/media/messages/c1/a.png?dl=1&mt=tok",
    );
  });

  it("never mints a second token onto a URL that already carries one", () => {
    const minted = "/api/public/media/messages/c1/a.png?mt=abc";
    expect(withMediaToken(minted, "other")).toBe(minted);
  });

  it("leaves a public object exactly as it was", () => {
    const href = "/api/public/media/posts/p1/a.png?dl=1&name=a.png";
    expect(withMediaToken(href, null)).toBe(href);
    expect(withMediaToken(href, "")).toBe(href);
  });
});

describe("what the user is told when it still fails", () => {
  it("names the real reason instead of a generic error", () => {
    // 404 here is the object being gone. "Please try again" would be a lie.
    expect(downloadErrorMessage(404)).toContain("no longer available");
    expect(downloadErrorMessage(403)).toContain("no longer available");
    expect(downloadErrorMessage(401)).toContain("Sign in");
    expect(downloadErrorMessage(429)).toContain("Try again");
    expect(downloadErrorMessage(null)).toContain("couldn't start");
  });
});
