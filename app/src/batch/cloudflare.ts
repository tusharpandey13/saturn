// Cloudflare REST access for the daily batch (GitHub Actions, Node). Same Db interface as the Worker's D1 binding,
// so src/store.ts SQL runs unchanged. Token scopes: CLOUDFLARE_D1_TOKEN Account -> D1 -> Edit only (the batch marks and
// prunes inbox rows; account-owned, never the deploy token). Until it exists the batch falls back to CLOUDFLARE_API_TOKEN
// (today the deploy token: docs/platform/auth-review.md #5). CLOUDFLARE_R2_TOKEN Account -> Workers R2 Storage -> Read
// (optional: falls back to the D1 token, which then needs both scopes). Errors never include response bodies (they can echo PHI).

import type { Db, Stmt } from "../store.js";
import type { Media } from "../types.js";

const API = "https://api.cloudflare.com/client/v4";

export interface CloudflareConfig {
  token: string;
  /** Token for the R2 object GET; defaults to `token`. Lets D1 and R2 rights live in separate tokens. */
  r2Token?: string;
  accountId: string;
  databaseId: string;
  bucket: string;
  /** REST base; overridable only so the local e2e tier can point the batch at a fake (scripts/e2e-local.mjs). */
  apiBase?: string;
  fetchFn?: typeof fetch;
}

export function cloudflareFromEnv(env = process.env): CloudflareConfig {
  const token = env.CLOUDFLARE_D1_TOKEN || env.CLOUDFLARE_API_TOKEN;
  const need = ["CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID", "R2_BUCKET"] as const;
  const missing: string[] = need.filter((k) => !env[k]);
  if (!token) missing.unshift("CLOUDFLARE_D1_TOKEN");
  if (missing.length) throw new Error(`missing env: ${missing.join(", ")}`);
  return {
    token,
    r2Token: env.CLOUDFLARE_R2_TOKEN || undefined,
    accountId: env.CLOUDFLARE_ACCOUNT_ID!,
    databaseId: env.D1_DATABASE_ID!,
    bucket: env.R2_BUCKET!,
    apiBase: env.CLOUDFLARE_API_BASE || undefined,
  };
}

async function call(cfg: CloudflareConfig, path: string, init: RequestInit = {}, token = cfg.token): Promise<Response> {
  const f = cfg.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await f(`${cfg.apiBase ?? API}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  } catch {
    throw new Error(`cloudflare ${init.method ?? "GET"} ${path.split("/")[3] ?? ""}: network error`);
  }
  if (!res.ok) throw new Error(`cloudflare ${path.includes("/d1/") ? "d1" : "r2"} failed: ${res.status}`);
  return res;
}

/** D1 over the REST /query endpoint. One HTTP call per statement; no multi-statement transactions. */
export function d1Http(cfg: CloudflareConfig): Db {
  const query = async (sql: string, params: unknown[]) => {
    const res = await call(cfg, `/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`, { method: "POST", body: JSON.stringify({ sql, params }) });
    const json: any = await res.json();
    if (!json.success) throw new Error(`d1 query failed: ${(json.errors ?? []).map((e: any) => e.code).join(",")}`);
    return json.result[0] as { results: any[]; meta: { changes?: number } };
  };
  return {
    prepare(sql: string): Stmt {
      let params: unknown[] = [];
      const stmt: Stmt = {
        bind: (...v) => ((params = v.map((x) => (x === undefined ? null : x))), stmt),
        run: async () => ({ meta: { changes: (await query(sql, params)).meta?.changes ?? 0 } }),
        all: async <T>() => ({ results: (await query(sql, params)).results as T[] }),
        first: async <T>() => (((await query(sql, params)).results[0] as T) ?? null),
      };
      return stmt;
    },
  };
}

/** R2 object read via the Cloudflare REST API. */
export function r2Http(cfg: CloudflareConfig): { get(key: string): Promise<Media> } {
  return {
    async get(key) {
      const res = await call(cfg, `/accounts/${cfg.accountId}/r2/buckets/${cfg.bucket}/objects/${encodeURIComponent(key)}`, {}, cfg.r2Token ?? cfg.token);
      return { data: new Uint8Array(await res.arrayBuffer()), mimeType: (res.headers.get("content-type") ?? "").split(";")[0].trim() };
    },
  };
}
