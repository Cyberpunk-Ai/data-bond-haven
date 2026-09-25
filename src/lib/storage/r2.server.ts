import { AwsClient } from "aws4fetch";
import type { StorageProvider } from "@/lib/storage/provider.server";

/** True when all required R2 environment variables are present. */
export function r2IsConfigured(): boolean {
  return Boolean(
    process.env["R2_ACCOUNT_ID"] &&
      process.env["R2_ACCESS_KEY_ID"] &&
      process.env["R2_SECRET_ACCESS_KEY"] &&
      process.env["R2_BUCKET"],
  );
}

/**
 * Cloudflare R2 storage, spoken over the S3-compatible API via aws4fetch (no
 * Node-only AWS SDK, so this also runs fine on Worker-style runtimes).
 */
export function createR2Provider(): StorageProvider {
  const accountId = process.env["R2_ACCOUNT_ID"]!;
  const bucket = process.env["R2_BUCKET"]!;
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const client = new AwsClient({
    accessKeyId: process.env["R2_ACCESS_KEY_ID"]!,
    secretAccessKey: process.env["R2_SECRET_ACCESS_KEY"]!,
    service: "s3",
    region: "auto",
  });

  function objectUrl(key: string) {
    return `${endpoint}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  return {
    async put(key, body, contentType) {
      const res = await client.fetch(objectUrl(key), {
        method: "PUT",
        headers: { "content-type": contentType },
        body: body as BodyInit,
      });
      if (!res.ok) {
        throw new Error(`R2 upload failed (${res.status})`);
      }
      return { key };
    },
    async get(key) {
      const res = await client.fetch(objectUrl(key), { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 read failed (${res.status})`);
      const contentType = res.headers.get("content-type") || "application/octet-stream";
      const body = new Uint8Array(await res.arrayBuffer());
      return { body, contentType };
    },
    async delete(keys) {
      const removed: string[] = [];
      // S3 DELETE is idempotent; a 404 counts as "already gone" and is a
      // success for our purposes. Sequential keeps this dependency-free (no
      // XML DeleteObjects body / Content-MD5 signing) and uploads are small-N.
      for (const key of keys) {
        if (!key) continue;
        const res = await client.fetch(objectUrl(key), { method: "DELETE" });
        if (res.ok || res.status === 404 || res.status === 204) removed.push(key);
        else if (!res.ok) console.error(`R2 delete failed (${res.status}) for ${key}`);
      }
      return removed;
    },
    async stat(key) {
      const res = await client.fetch(objectUrl(key), { method: "HEAD" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 stat failed (${res.status})`);
      const size = Number(res.headers.get("content-length") ?? 0);
      const contentType = res.headers.get("content-type") || "application/octet-stream";
      return { size, contentType };
    },
  };
}

/** Public base URL for an R2 object, when the bucket is exposed via a custom domain / dev URL. */
export function r2PublicUrl(key: string): string | null {
  const base = process.env["R2_PUBLIC_BASE_URL"];
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/${key}`;
}
