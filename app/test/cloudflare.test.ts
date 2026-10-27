// Cloudflare REST client: D1 and R2 can use separate tokens (CLOUDFLARE_R2_TOKEN), falling back to one token.
import { describe, expect, it } from "vitest";
import { CloudflareTransientError, cloudflareFromEnv, d1Http, r2Http, RETRY } from "../src/batch/cloudflare.js";
import { Store } from "../src/store.js";

const base = { CLOUDFLARE_API_TOKEN: "d1-tok", CLOUDFLARE_ACCOUNT_ID: "acc", D1_DATABASE_ID: "db", R2_BUCKET: "b" };

function recorder() {
  const auth: Record<string, string> = {};
  const fetchFn = (async (url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    auth[url.includes("/d1/") ? "d1" : "r2"] = h.authorization;
    const body = url.includes("/d1/") ? JSON.stringify({ success: true, result: [{ results: [], meta: { changes: 0 } }] }) : "x";
    return new Response(body, { headers: { "content-type": "image/jpeg" } });
  }) as unknown as typeof fetch;
  return { auth, fetchFn };
}

async function hit(env: Record<string, string>) {
  const { auth, fetchFn } = recorder();
  const cfg = { ...cloudflareFromEnv(env), fetchFn };
  await d1Http(cfg).prepare("SELECT 1").all();
  await r2Http(cfg).get("k");
  return auth;
}

describe("cloudflare tokens", () => {
  it("uses CLOUDFLARE_R2_TOKEN for R2 and CLOUDFLARE_API_TOKEN for D1", async () => {
    expect(await hit({ ...base, CLOUDFLARE_R2_TOKEN: "r2-tok" })).toEqual({ d1: "Bearer d1-tok", r2: "Bearer r2-tok" });
  });
  it("falls back to CLOUDFLARE_API_TOKEN for R2 when CLOUDFLARE_R2_TOKEN is unset or empty", async () => {
    expect(await hit(base)).toEqual({ d1: "Bearer d1-tok", r2: "Bearer d1-tok" });
    expect(await hit({ ...base, CLOUDFLARE_R2_TOKEN: "" })).toEqual({ d1: "Bearer d1-tok", r2: "Bearer d1-tok" });
  });
  it("prefers CLOUDFLARE_D1_TOKEN over CLOUDFLARE_API_TOKEN (the deploy token) for D1", async () => {
    expect(await hit({ ...base, CLOUDFLARE_D1_TOKEN: "batch-d1", CLOUDFLARE_R2_TOKEN: "r2-tok" })).toEqual({ d1: "Bearer batch-d1", r2: "Bearer r2-tok" });
    const { CLOUDFLARE_API_TOKEN: _, ...noApi } = base;
    expect(await hit({ ...noApi, CLOUDFLARE_D1_TOKEN: "batch-d1" })).toEqual({ d1: "Bearer batch-d1", r2: "Bearer batch-d1" });
  });
  it("names the missing D1 token", () => {
    const { CLOUDFLARE_API_TOKEN: _, ...noApi } = base;
    expect(() => cloudflareFromEnv(noApi)).toThrow("missing env: CLOUDFLARE_D1_TOKEN");
  });
});

// ---- rate limits (Cloudflare API: 1,200 requests / 5 min per user; 429 + retry-after) ----

const ok = (result: unknown[]) => new Response(JSON.stringify({ success: true, result }), { headers: { "content-type": "application/json" } });
const limited = (retryAfter?: string) =>
  new Response(JSON.stringify({ success: false, errors: [{ code: 971, message: "Please wait and consider throttling your request speed" }] }), {
    status: 429, headers: { "content-type": "application/json", ...(retryAfter ? { "retry-after": retryAfter } : {}), ratelimit: '"default";r=0;t=30' },
  });

function scripted(responses: (() => Response)[]) {
  const calls: { url: string; body: any }[] = [];
  const waits: number[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body ?? "null")) });
    return (responses[calls.length - 1] ?? responses[responses.length - 1])();
  }) as unknown as typeof fetch;
  const cfg = { ...cloudflareFromEnv(base), fetchFn, sleep: async (ms: number) => void waits.push(ms) };
  return { calls, waits, cfg };
}

describe("cloudflare 429 handling", () => {
  it("honours Retry-After, then succeeds", async () => {
    const { calls, waits, cfg } = scripted([() => limited("7"), () => ok([{ results: [{ n: 1 }], meta: {} }])]);
    expect((await d1Http(cfg).prepare("SELECT 1 AS n").all()).results).toEqual([{ n: 1 }]);
    expect(calls).toHaveLength(2);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(7000);
    expect(waits[0]).toBeLessThan(7500);
  });
  it("backs off exponentially (with jitter) without Retry-After, at most 5 attempts, then a transient error", async () => {
    const { calls, waits, cfg } = scripted([() => limited()]);
    const err = await d1Http(cfg).prepare("SELECT 1").all().catch((e) => e);
    expect(err).toBeInstanceOf(CloudflareTransientError);
    expect(err.status).toBe(429);
    expect(calls).toHaveLength(RETRY.attempts);
    expect(waits).toHaveLength(RETRY.attempts - 1);
    waits.forEach((w, i) => expect(w).toBeGreaterThanOrEqual(RETRY.baseMs * 2 ** i));
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThan(RETRY.budgetMs);
  });
  it("gives up at once when Retry-After does not fit the ~3 minute budget (the global limit blocks for 5 minutes)", async () => {
    const { calls, waits, cfg } = scripted([() => limited("300")]);
    const err = await d1Http(cfg).prepare("SELECT 1").all().catch((e) => e);
    expect(err).toBeInstanceOf(CloudflareTransientError);
    expect(err.retryAfter).toBe(300);
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });
  it("does not retry a 4xx other than 429, and never puts the token in the error", async () => {
    const { calls, cfg } = scripted([() => new Response("{}", { status: 403 })]);
    const err = await d1Http(cfg).prepare("SELECT 1").all().catch((e) => e);
    expect(err).not.toBeInstanceOf(CloudflareTransientError);
    expect(err.message).toBe("cloudflare d1 failed: 403");
    expect(calls).toHaveLength(1);
    expect(String(err.message)).not.toContain("d1-tok");
  });
});

describe("one D1 call per batch step", () => {
  it("pullSnapshot sends the alias sync and all four reads as ONE /query batch", async () => {
    const r = (results: unknown[] = []) => ({ results, meta: { changes: 0 } });
    const { calls, cfg } = scripted([() => ok([r(), r(), r([{ update_id: 1 }]), r([{ id: "p1", name: "A", role: "admin", sender_id: "9" }]), r([{ chat_id: "c", channel: "telegram", label: "members-silent" }]), r()])]);
    const snap = await new Store(d1Http(cfg)).pullSnapshot([{ alias: "Maa", personId: "p1", display: "Maa" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.batch).toHaveLength(6);
    expect(snap.inbox).toEqual([{ update_id: 1 }]);
    expect(snap.persons[0]).toEqual({ id: "p1", name: "A", role: "admin", senderId: "9" });
    expect(snap.chats).toHaveLength(1);
  });
  it("finishSnapshot marks, prunes and reads in ONE call", async () => {
    const { calls, cfg } = scripted([() => ok([{ results: [], meta: { changes: 3 } }, { results: [], meta: { changes: 1 } }, { results: [], meta: {} }])]);
    const snap = await new Store(d1Http(cfg)).finishSnapshot([1, 2, 3], "2026-10-27T00:00:00Z", "2026-10-13T00:00:00Z");
    expect(calls).toHaveLength(1);
    expect(snap).toEqual({ done: 3, pruned: 1, persons: [] });
    expect(calls[0].body.batch.map((q: { sql: string }) => q.sql).join(" ")).not.toMatch(/FROM chats/); // no group to post to
  });
});
