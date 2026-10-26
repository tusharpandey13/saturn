// Cloudflare REST client: D1 and R2 can use separate tokens (CLOUDFLARE_R2_TOKEN), falling back to one token.
import { describe, expect, it } from "vitest";
import { cloudflareFromEnv, d1Http, r2Http } from "../src/batch/cloudflare.js";

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
