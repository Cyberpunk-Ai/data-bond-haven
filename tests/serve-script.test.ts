import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { promisify } from "node:util";

const run = promisify(execFile);
const SERVE = fileURLToPath(new URL("../scripts/serve.mjs", import.meta.url));

/** `node scripts/serve.mjs …` — the wrapper exits on its own for every path here. */
async function serve(...args: string[]) {
  try {
    const { stdout, stderr } = await run(process.execPath, [SERVE, ...args], {
      timeout: 15_000,
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("scripts/serve.mjs", () => {
  it("prints usage without touching the filesystem", async () => {
    const { code, out } = await serve("--help");
    expect(code).toBe(0);
    expect(out).toContain("--build");
    expect(out).toContain("--open");
    expect(out).toContain("--port");
  });

  it("rejects an unusable port instead of binding something else", async () => {
    for (const bad of ["abc", "0", "70000"]) {
      const { code, out } = await serve("--port", bad);
      expect(code, bad).toBe(1);
      expect(out, bad).toContain(`Invalid port: ${bad}`);
    }
  });

  it("rejects an unknown option rather than silently ignoring it", async () => {
    const { code, out } = await serve("--serve-me");
    expect(code).toBe(1);
    expect(out).toContain("Unknown option: --serve-me");
  });

  // The port check runs before anything touches the disk, so this needs no build.
  it("says which process already holds the port", async () => {
    const { port, close } = await listen();
    try {
      const { code, out } = await serve("--port", String(port));
      expect(code).toBe(1);
      expect(out).toContain(`Port ${port} is already serving something`);
      // The point of the message: here is how to get a URL you can actually open.
      expect(out).toContain("npm start -- --port");

      // `npm run preview` builds first, and a live server makes that build fail
      // with a bare ENOTEMPTY on Windows - so the refusal has to say so.
      const built = await serve("--build", "--port", String(port));
      expect(built.code).toBe(1);
      expect(built.out).toContain("ENOTEMPTY");
    } finally {
      await close();
    }
  });
});
