import { describe, expect, it } from "vitest";
import { SarvamError, SarvamSpeechToText, SttJobFailedError } from "../../adapters/stt/sarvam.js";
import type { Media } from "../src/types.js";

const OGG: Media = { data: new Uint8Array([0x4f, 0x67, 0x67, 0x53]), mimeType: "audio/ogg" };
const BASE = "https://sarvam.test";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function mockFetch(routes: [RegExp, Handler][]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const r = routes.find(([re]) => re.test(url));
    if (!r) return new Response("no route", { status: 599 });
    return r[1](url, init);
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("SarvamSpeechToText REST", () => {
  it("posts OGG as-is with saaras:v4 / hi-IN and returns transcript + language", async () => {
    const { calls, fetchFn } = mockFetch([[/\/speech-to-text$/, () => Response.json({ request_id: "r1", transcript: "आज बीपी 120 बटा 80", language_code: "hi-IN", language_probability: 0.97 })]]);
    const t = await new SarvamSpeechToText("KEY", fetchFn, BASE, ["Examplezole"]).transcribe(OGG);
    expect(t).toEqual({ text: "आज बीपी 120 बटा 80", languageCode: "hi-IN", languageProbability: 0.97 });
    const { url, init } = calls[0];
    expect(url).toBe(`${BASE}/speech-to-text`);
    expect((init.headers as Record<string, string>)["api-subscription-key"]).toBe("KEY");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("saaras:v4");
    expect(form.get("language_code")).toBe("hi-IN");
    const file = form.get("file") as File;
    expect(file.name).toBe("voice.ogg");
    expect(file.type).toBe("audio/ogg");
    expect(JSON.parse(String(form.get("keyterms")))).toEqual(expect.arrayContaining(["BP", "Examplezole"]));
  });

  it("errors carry status and code but never the response message", async () => {
    const { fetchFn } = mockFetch([[/\/speech-to-text$/, () => Response.json({ error: { message: "secret transcript echo", code: "rate_limit_exceeded_error" } }, { status: 429 })]]);
    const err = await new SarvamSpeechToText("KEY", fetchFn, BASE).transcribe(OGG).catch((e) => e);
    expect(err).toBeInstanceOf(SarvamError);
    expect(err).toMatchObject({ status: 429, code: "rate_limit_exceeded_error" });
    expect(err.message).not.toContain("secret");
  });

  it("network failures do not leak URLs", async () => {
    const fetchFn = (async () => { throw new TypeError("fetch failed https://upload.blob/sig=abc"); }) as typeof fetch;
    const err = await new SarvamSpeechToText("KEY", fetchFn, BASE).transcribe(OGG).catch((e) => e);
    expect(err.message).toBe("sarvam transcribe failed: 0 network_error");
  });
});

function batchRoutes(state: { job_state: string }) {
  return mockFetch([
    [/\/job\/v1$/, () => Response.json({ job_id: "job-1", job_state: "Accepted", storage_container_type: "Azure" })],
    [/\/job\/v1\/upload-files$/, () => Response.json({ job_id: "job-1", upload_urls: { "voice.ogg": { file_url: "https://blob.test/up?sig=1" } } })],
    [/blob\.test\/up/, () => new Response(null, { status: 201 })],
    [/\/job-1\/start$/, () => Response.json({ job_id: "job-1", job_state: "Pending" })],
    [/\/job-1\/status$/, () => Response.json({ job_id: "job-1", job_state: state.job_state, job_details: [{ inputs: [{ file_name: "voice.ogg" }], outputs: [{ file_name: "0.json" }], state: state.job_state }] })],
    [/\/job\/v1\/download-files$/, () => Response.json({ job_id: "job-1", download_urls: { "0.json": { file_url: "https://blob.test/down/0.json?sig=2" } } })],
    [/blob\.test\/down/, () => Response.json({ request_id: "r2", transcript: "wajan 61", language_code: "hi-IN" })],
  ]);
}

describe("SarvamSpeechToText batch", () => {
  it("create -> upload (Azure BlockBlob PUT) -> start -> poll -> download", async () => {
    const state = { job_state: "Running" };
    const { calls, fetchFn } = batchRoutes(state);
    const stt = new SarvamSpeechToText("KEY", fetchFn, BASE);
    expect(await stt.startBatch(OGG)).toBe("job-1");
    const create = JSON.parse(String(calls[0].init.body));
    expect(create.job_parameters).toMatchObject({ model: "saaras:v4", language_code: "hi-IN" });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ job_id: "job-1", files: ["voice.ogg"] });
    expect(calls[2].init).toMatchObject({ method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "content-type": "audio/ogg" } });
    expect(calls[3].url).toBe(`${BASE}/speech-to-text/job/v1/job-1/start`);

    expect(await stt.pollBatch("job-1")).toBeNull();
    state.job_state = "Completed";
    expect(await stt.pollBatch("job-1")).toEqual({ text: "wajan 61", languageCode: "hi-IN", languageProbability: null });
    expect(JSON.parse(String(calls.at(-2)!.init.body))).toEqual({ job_id: "job-1", files: ["0.json"] });
  });

  it("a Failed job throws SttJobFailedError", async () => {
    const { fetchFn } = batchRoutes({ job_state: "Failed" });
    await expect(new SarvamSpeechToText("KEY", fetchFn, BASE).pollBatch("job-1")).rejects.toBeInstanceOf(SttJobFailedError);
  });
});
