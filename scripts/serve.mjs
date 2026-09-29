#!/usr/bin/env node
// =============================================================================
// Local runner for the production build (`npm start`, `npm run preview`).
//
// `node .output/server/index.mjs` works, but two things go wrong in practice:
//   1. no build yet  → node prints a raw ENOENT stack;
//   2. port taken    → a leftover server (or another app) wins the port and
//      Nitro dies with EADDRINUSE, or you end up looking at the *old* build.
// Both then leave the same question: which URL do I open? So this checks the
// port, checks the build, prints the address it will really listen on (plus
// the LAN address for testing on a phone), and `--open` hands that link to the
// default browser once the port actually accepts connections.
//
//   node scripts/serve.mjs              serve .output/server/index.mjs
//   node scripts/serve.mjs --build      vite build first, then serve
//   node scripts/serve.mjs --open       also open the browser
//   node scripts/serve.mjs --port 3005  override PORT (also HOST for the bind)
//
// Port choice follows `--port` > process.env.PORT > PORT in .env > 3000, and is
// exported to the child so the URL we print cannot drift from the one bound.
//
// Deployment should keep running the built entry directly —
// `node .output/server/index.mjs` — so the server stays PID 1 and gets SIGTERM.
// `npm run serve` is exactly that, without the conveniences.
// =============================================================================
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
export const SERVER_ENTRY = join(repoRoot, ".output", "server", "index.mjs");
const VITE_BIN = join(repoRoot, "node_modules", "vite", "bin", "vite.js");
const DEFAULT_PORT = 3000;

/** Read PORT/HOST out of .env (or .dev.vars) without importing server-only code. */
export function readEnvFile(keys) {
  const found = {};
  for (const file of [".env", ".dev.vars"]) {
    const path = join(repoRoot, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m || !keys.includes(m[1])) continue;
      let value = m[2].trim();
      if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
      if (found[m[1]] === undefined) found[m[1]] = value;
    }
  }
  return found;
}

export function parseArgs(argv) {
  const flags = { build: false, open: false, help: false, port: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--build") flags.build = true;
    else if (arg === "--open") flags.open = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--port") flags.port = argv[++i];
    else if (arg.startsWith("--port=")) flags.port = arg.slice("--port=".length);
    else throw new Error(`Unknown option: ${arg}\nRun with --help for the usage line.`);
  }
  return flags;
}

/** `--port` wins over the shell, which wins over .env, which wins over 3000. */
export function resolvePort({ flag, shell, file }) {
  for (const candidate of [flag, shell, file]) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    const port = Number(candidate);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port: ${candidate}`);
    }
    return port;
  }
  return DEFAULT_PORT;
}

/** Every usable IPv4 - VPN/VM adapters exist, so guessing one is wrong half the time. */
export function lanAddresses() {
  const addresses = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) addresses.push({ name, address: net.address });
    }
  }
  return addresses;
}

export function banner({ port, host, open }) {
  const shown = host && host !== "0.0.0.0" && host !== "::" ? host : "localhost";
  const local = `http://${shown}:${port}/`;
  return [
    "",
    "  spaces1 · production build",
    `  ➜  Local:    ${local}`,
    ...lanAddresses().map(
      ({ name, address }) => `  ➜  Network:  http://${address}:${port}/  (${name})`,
    ),
    `  ➜  Health:   ${local}api/public/health`,
    open ? "  opening the browser as soon as it answers…" : "  press Ctrl+C to stop",
    "",
  ];
}

/** True when something already accepts TCP connections on host:port. */
export function portInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
      .on("connect", () => {
        socket.destroy();
        resolve(true);
      })
      .on("error", () => resolve(false));
    socket.setTimeout(1500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portInUse(port, host)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function openInBrowser(url) {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${args[0] ?? command} failed (exit ${code})`)),
    );
  });
}

export async function main(argv = process.argv.slice(2)) {
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    console.error(String(err.message));
    return 1;
  }
  if (flags.help) {
    console.log(
      "usage: node scripts/serve.mjs [--build] [--open] [--port <n>]\n" +
        "  --build  run vite build first\n" +
        "  --open   open the default browser once the server answers\n",
    );
    return 0;
  }

  const fileEnv = readEnvFile(["PORT", "HOST"]);
  let port;
  let host;
  try {
    port = resolvePort({ flag: flags.port, shell: process.env.PORT, file: fileEnv.PORT });
    // Left unset by default: the node-server preset already binds every
    // interface, and inventing a HOST value here could narrow that.
    host = process.env.HOST ?? fileEnv.HOST ?? null;
  } catch (err) {
    console.error(String(err.message));
    return 1;
  }

  // Check the port before touching the disk: a server left running from an
  // earlier `npm start` holds the build output open on Windows, so `vite build`
  // then aborts halfway through with a bare ENOTEMPTY and no hint at the cause.
  if (await portInUse(port, "127.0.0.1")) {
    console.error(
      `\n  Port ${port} is already serving something — an earlier server that is\n` +
        "  still running, most likely, and one that is serving the previous build.\n\n" +
        (flags.build
          ? "  Stop it before building: on Windows it locks .output/ and the build\n" +
            "  aborts with ENOTEMPTY.\n\n"
          : "") +
        `  Or pick another port:  npm start -- --port ${port + 5}\n` +
        (process.platform === "win32"
          ? `  Who holds it:  Get-NetTCPConnection -LocalPort ${port} -State Listen\n`
          : `  Who holds it:  lsof -i :${port}\n`),
    );
    return 1;
  }

  if (flags.build) {
    if (!existsSync(VITE_BIN)) {
      console.error("vite is not installed — run `npm install` first.");
      return 1;
    }
    console.log("\n  building (.output) …\n");
    try {
      await run(process.execPath, [VITE_BIN, "build"]);
    } catch (err) {
      console.error(`\n  ${err.message}`);
      return 1;
    }
  }

  if (!existsSync(SERVER_ENTRY)) {
    console.error(
      `\n  Nothing built yet: ${SERVER_ENTRY} does not exist.\n` +
        "  Run `npm run build` (or `npm run preview`, which builds first).\n",
    );
    return 1;
  }

  for (const line of banner({ port, host, open: flags.open })) console.log(line);

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, PORT: String(port), ...(host ? { HOST: host } : {}) },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  if (flags.open) {
    // Wait for the port instead of racing the server, so the browser never
    // lands on "connection refused".
    waitForPort(port, "127.0.0.1", 60_000).then((up) => {
      if (up) openInBrowser(`http://localhost:${port}/`);
      else
        console.error(`  still not answering on port ${port} - open the link above when it is up.`);
    });
  }
  return await new Promise((resolve) => {
    child.on("exit", (c) => resolve(c ?? 0));
    child.on("error", (err) => {
      console.error(`  could not start the server: ${err.message}`);
      resolve(1);
    });
  });
}

// Only boot when invoked as a command, so the helpers above stay importable
// from tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
