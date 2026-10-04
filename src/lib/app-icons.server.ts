// Server-only: reads the app's brand icon bytes straight off disk so they can be
// served through the Nitro request pipeline (a real route handler) rather than
// only through static hosting. Static `public/` serving is the thing that can
// differ between the apex domain and `www` on some CDN/DNS setups; a handler that
// answers `/favicon.ico` and the sized PNGs runs wherever the app itself runs,
// so the tab mark stops depending on a second asset-serving path being wired up.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The public assets this handler is willing to serve, and their MIME types. */
const ICON_ASSETS: Record<string, string> = {
  "favicon.ico": "image/x-icon",
  "icon-192.png": "image/png",
  "icon-512.png": "image/png",
  "apple-touch-icon.png": "image/png",
  "manifest.webmanifest": "application/manifest+json",
};

/** Candidate directories, dev (`public/`) first, then the built `.output/public`. */
function publicDirs(): string[] {
  const cwd = typeof process !== "undefined" && process.cwd ? process.cwd() : "";
  const here = typeof __dirname !== "undefined" ? __dirname : "";
  const roots = [cwd, join(here, ".."), join(here, "..", "..")].filter(Boolean);
  const dirs: string[] = [];
  for (const root of roots) {
    dirs.push(join(root, "public"), join(root, ".output", "public"));
  }
  return [...new Set(dirs)];
}

/**
 * Serve one of the whitelisted icon assets by name (never a caller-supplied
 * path). Falls back to 404 when the file genuinely isn't on disk, which the
 * browser handles by falling back to its own default icon.
 */
export async function serveIconAsset(name: string): Promise<Response> {
  const contentType = ICON_ASSETS[name];
  if (!contentType) return new Response("Not found", { status: 404 });

  for (const dir of publicDirs()) {
    const full = join(dir, name);
    if (!existsSync(full)) continue;
    try {
      const bytes = await readFile(full);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "content-type": contentType,
          // Icons are effectively immutable per build; cache hard at the edge.
          "cache-control": "public, max-age=31536000, immutable",
          "cross-origin-resource-policy": "cross-origin",
        },
      });
    } catch {
      // Try the next candidate directory; never leak a stack to the client.
    }
  }
  return new Response("Not found", { status: 404 });
}
