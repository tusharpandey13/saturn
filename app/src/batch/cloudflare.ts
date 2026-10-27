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
  /** Back-off sleep; overridable for tests. */
  sleep?: (ms: number) => Promise<void>;
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

/** A Cloudflare API failure worth retrying later (429 rate limit, 5xx, network): the batch ends "delayed", rows stay new. */
export class CloudflareTransientError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryAfter: number | null) {
    super(message);
    this.name = "CloudflareTransientError";
  }
}

/** Retry policy: at most 5 attempts, Retry-After honoured, exponential back-off + jitter, all waits within ~3 minutes.
 *  A Retry-After that does not fit the budget (Cloudflare's global limit blocks for 5 minutes) gives up at once. */
export const RETRY = { attempts: 5, baseMs: 2_000, maxWaitMs: 60_000, budgetMs: 170_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Safe diagnostics for a failed call: status, Cloudflare error codes, rate-limit headers. Never the body text or the token. */
async function describeFailure(res: Response): Promise<string> {
  let codes = "";
  try {
    const j: any = await res.clone().json();
    codes = (j?.errors ?? []).map((e: any) => Number(e?.code)).filter((n: number) => Number.isFinite(n)).join(",");
  } catch {
    /* not JSON */
  }
  const h = (k: string) => (res.headers.get(k) ?? "-").replace(/[^\w;=,.\- "]/g, "").slice(0, 120);
  return `status ${res.status}; codes ${codes || "-"}; retry-after ${h("retry-after")}; ratelimit ${h("ratelimit")}; ratelimit-policy ${h("ratelimit-policy")}`;
}

async function call(cfg: CloudflareConfig, path: string, init: RequestInit = {}, token = cfg.token): Promise<Response> {
  const f = cfg.fetchFn ?? fetch;
  const wait = cfg.sleep ?? sleep;
  const what = path.includes("/d1/") ? "d1" : "r2";
  const started = Date.now();
  let spent = 0; // waited so far (tracked explicitly so a mocked sleep is accounted for too)
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null;
    let retryAfter: number | null = null;
    try {
      res = await f(`${cfg.apiBase ?? API}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
    } catch {
      /* network error: transient */
    }
    if (res?.ok) return res;
    if (res && res.status !== 429 && res.status < 500) throw new Error(`cloudflare ${what} failed: ${res.status}`);
    if (res) {
      const ra = res.headers.get("retry-after");
      retryAfter = ra !== null && /^\d+$/.test(ra.trim()) ? Number(ra) : null; // seconds form (Cloudflare's)
      console.error(`cloudflare ${what} attempt ${attempt}/${RETRY.attempts}: ${await describeFailure(res)}`);
    } else console.error(`cloudflare ${what} attempt ${attempt}/${RETRY.attempts}: network error`);
    const backoff = Math.min(RETRY.maxWaitMs, RETRY.baseMs * 2 ** (attempt - 1)) + Math.floor(Math.random() * 1000);
    const ms = retryAfter !== null ? retryAfter * 1000 + Math.floor(Math.random() * 500) : backoff;
    const elapsed = Math.max(spent, Date.now() - started);
    if (attempt >= RETRY.attempts || elapsed + ms > RETRY.budgetMs) {
      const status = res?.status ?? null;
      throw new CloudflareTransientError(
        `cloudflare ${what} ${status ?? "network error"} after ${attempt} attempt(s)${retryAfter !== null ? `; retry-after ${retryAfter}s` : ""}`,
        status, retryAfter);
    }
    await wait(ms);
    spent += ms;
  }
}

export interface D1Query { sql: string; params?: unknown[] }
type D1Result = { results: any[]; meta: { changes?: number } };

/** D1 over the REST /query endpoint. `prepare` is one HTTP call per statement; `batch` sends many statements in one call. */
export function d1Http(cfg: CloudflareConfig): Db {
  const post = async (body: unknown): Promise<D1Result[]> => {
    const res = await call(cfg, `/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`, { method: "POST", body: JSON.stringify(body) });
    const json: any = await res.json();
    if (!json.success) throw new Error(`d1 query failed: ${(json.errors ?? []).map((e: any) => e.code).join(",")}`);
    return json.result as D1Result[];
  };
  const norm = (params: unknown[] = []) => params.map((x) => (x === undefined ? null : x));
  const query = async (sql: string, params: unknown[]) => (await post({ sql, params }))[0];
  return {
    prepare(sql: string): Stmt {
      let params: unknown[] = [];
      const stmt: Stmt = {
        bind: (...v) => ((params = norm(v)), stmt),
        run: async () => ({ meta: { changes: (await query(sql, params)).meta?.changes ?? 0 } }),
        all: async <T>() => ({ results: (await query(sql, params)).results as T[] }),
        first: async <T>() => (((await query(sql, params)).results[0] as T) ?? null),
      };
      return stmt;
    },
    async batch(qs) {
      if (!qs.length) return [];
      const out = await post({ batch: qs.map((q) => ({ sql: q.sql, params: norm(q.params) })) });
      if (out.length !== qs.length) throw new Error(`d1 batch: ${out.length} results for ${qs.length} statements`);
      return out.map((r) => ({ results: r.results ?? [], meta: { changes: r.meta?.changes ?? 0 } }));
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
