import { defineConfig, loadEnv } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { nitro } from "nitro/vite";
import { fileURLToPath } from "node:url";

// Neutral Vite/TanStack Start configuration (no editor-coupled presets).
// Composes the same plugins the previous managed config provided:
//   tailwindcss, tsconfig path alias, TanStack Start (SSR), React, and
//   Nitro (build-only, Cloudflare Module Worker preset).
export default defineConfig(({ command, mode }) => {
  // Mirror .env into process.env for the Node process that runs dev/preview
  // SSR. Vite only exposes VITE_* keys to client code via import.meta.env —
  // server modules (src/lib/env.server.ts, client.server.ts) read process.env
  // and would otherwise see nothing from .env locally. Real shell variables
  // always win (we never overwrite an existing process.env key).
  const fileEnv = loadEnv(mode, process.cwd(), "");
  for (const [key, value] of Object.entries(fileEnv)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return {
  css: { transformer: "lightningcss" },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    dedupe: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@tanstack/react-query",
      "@tanstack/query-core",
    ],
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
    ],
    ignoreOutdatedRequests: true,
  },
  server: { host: "::", port: 8080 },
  build: {
    // Modern browsers + the workererd runtime understand current syntax, so we
    // skip down-level transpilation to keep bundles smaller and parse faster.
    target: "esnext",
    // Skip gzip/brotli size estimation in CI — it only slows the build, the
    // real compression happens at the edge/CDN.
    reportCompressedSize: false,
    cssMinify: "lightningcss",
  },
  plugins: [
    tailwindcss(),
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({
      // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
      server: { entry: "server" },
      importProtection: {
        behavior: "error",
        client: {
          files: ["**/server/**"],
          specifiers: ["server-only"],
        },
      },
    }),
    // Nitro runs only for production builds; dev SSR is served by Vite.
    ...(command === "build" ? [nitro({ defaultPreset: "cloudflare-module" })] : []),
    viteReact(),
  ],
  };
});
