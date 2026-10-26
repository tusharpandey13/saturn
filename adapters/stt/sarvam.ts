// Sarvam speech-to-text. Checked against docs.sarvam.ai and the official sarvamai JS SDK (v1.1.12), 2026-10-24:
//
// REST (clips < 30 s):  POST {base}/speech-to-text   multipart/form-data, header api-subscription-key
//   fields: file, model, language_code, keyterms (JSON array, saaras:v4 only)
//   200: { request_id, transcript, language_code, language_probability? }
// Batch (up to 2 h):
//   POST {base}/speech-to-text/job/v1                 { job_parameters: { model, language_code, keyterms } } -> { job_id }
//   POST {base}/speech-to-text/job/v1/upload-files    { job_id, files: [name] } -> { upload_urls: { name: { file_url } } }
//   PUT  file_url  (Azure blob: header x-ms-blob-type: BlockBlob)
//   POST {base}/speech-to-text/job/v1/{job_id}/start
//   GET  {base}/speech-to-text/job/v1/{job_id}/status -> { job_state: Accepted|Pending|Running|Completed|Failed, job_details[].outputs[].file_name }
//   POST {base}/speech-to-text/job/v1/download-files  { job_id, files: [out] } -> { download_urls: { out: { file_url } } }
//   GET  file_url -> { transcript, language_code, ... }
//
// Model: saaras:v4 (default, recommended; transcription in the spoken language). Translation to English is a
// separate mode (saaras:v3 mode=translate) and is NOT what we want: we store the Hindi transcript.
// OGG/Opus is accepted as-is, so Telegram voice notes need no conversion (no ffmpeg in Workers).
// Privacy: opt out of Sarvam model training in the dashboard before sending real audio.
// Never put response bodies in errors or logs: they can echo the transcript.

import type { Media, SpeechToText, Transcript } from "../../app/src/types.js";

export const SARVAM_REST_MAX_SEC = 30;
export const SARVAM_BASE = "https://api.sarvam.ai";
export const SARVAM_MODEL = "saaras:v4";
export const SARVAM_LANGUAGE = "hi-IN";
/** Generic device and vital words (biases recognition; saaras:v4 keyterms, max 50). Medicine names are per records:
 *  pass them as `extraKeyterms` (read from the records repo's meta/stt-vocab.txt by the batch). */
export const KEYTERMS = ["BP", "pulse", "SpO2", "oximeter", "glucometer", "sugar", "weight"];
export const MAX_KEYTERMS = 50;

/** Generic terms first, then the records vocabulary; deduplicated (case-insensitive), capped at MAX_KEYTERMS. */
export function keytermsWith(extra: readonly string[] = []): string[] {
  const seen = new Set<string>();
  return [...KEYTERMS, ...extra].map((t) => t.trim()).filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())).slice(0, MAX_KEYTERMS);
}

/** Parse a vocabulary file: one term per line; blank lines and # comments ignored. */
export const parseVocab = (text: string): string[] => text.split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean);

export class SarvamError extends Error {
  override name = "SarvamError";
  constructor(readonly step: string, readonly status: number, readonly code?: string) {
    super(`sarvam ${step} failed: ${status}${code ? ` ${code}` : ""}`);
  }
}
/** A batch job reached the Failed state; retrying will not help. */
export class SttJobFailedError extends Error {
  override name = "SttJobFailedError";
}

const ext = (mime: string) => (mime.includes("ogg") || mime.includes("opus") ? "ogg" : mime.split("/")[1]?.split(";")[0] || "bin");

export class SarvamSpeechToText implements SpeechToText {
  constructor(
    private apiKey: string,
    private fetchFn: typeof fetch = (...a) => fetch(...a),
    private base = SARVAM_BASE,
    extraKeyterms: readonly string[] = [],
  ) {
    this.keyterms = keytermsWith(extraKeyterms);
  }

  private readonly keyterms: string[];

  private async call<T>(step: string, path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, { ...init, headers: { "api-subscription-key": this.apiKey, ...(init.headers ?? {}) } });
    } catch {
      throw new SarvamError(step, 0, "network_error");
    }
    if (!res.ok) {
      const code = await res.json().then((j: any) => j?.error?.code as string | undefined).catch(() => undefined);
      throw new SarvamError(step, res.status, code);
    }
    return (await res.json()) as T;
  }

  private static toTranscript(r: any): Transcript {
    if (typeof r?.transcript !== "string") throw new SarvamError("parse", 200, "no_transcript");
    return { text: r.transcript, languageCode: r.language_code ?? null, languageProbability: typeof r.language_probability === "number" ? r.language_probability : null };
  }

  async transcribe(audio: Media): Promise<Transcript> {
    const form = new FormData();
    form.append("file", new Blob([audio.data], { type: audio.mimeType }), `voice.${ext(audio.mimeType)}`);
    form.append("model", SARVAM_MODEL);
    form.append("language_code", SARVAM_LANGUAGE);
    form.append("keyterms", JSON.stringify(this.keyterms));
    return SarvamSpeechToText.toTranscript(await this.call("transcribe", "/speech-to-text", { method: "POST", body: form }));
  }

  async startBatch(audio: Media): Promise<string> {
    const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const { job_id } = await this.call<{ job_id: string }>("create", "/speech-to-text/job/v1", json({
      job_parameters: { model: SARVAM_MODEL, language_code: SARVAM_LANGUAGE, keyterms: this.keyterms },
    }));
    const name = `voice.${ext(audio.mimeType)}`;
    const up = await this.call<{ upload_urls: Record<string, { file_url: string }> }>("upload-links", "/speech-to-text/job/v1/upload-files", json({ job_id, files: [name] }));
    const url = up.upload_urls?.[name]?.file_url;
    if (!url) throw new SarvamError("upload-links", 200, "no_upload_url");
    let put: Response;
    try {
      put = await this.fetchFn(url, { method: "PUT", body: audio.data, headers: { "x-ms-blob-type": "BlockBlob", "content-type": audio.mimeType } });
    } catch {
      throw new SarvamError("upload", 0, "network_error"); // presigned URL must not reach logs
    }
    if (!put.ok) throw new SarvamError("upload", put.status);
    await this.call("start", `/speech-to-text/job/v1/${encodeURIComponent(job_id)}/start`, json({}));
    return job_id;
  }

  async pollBatch(jobId: string): Promise<Transcript | null> {
    const st = await this.call<any>("status", `/speech-to-text/job/v1/${encodeURIComponent(jobId)}/status`);
    if (st.job_state === "Failed") throw new SttJobFailedError(`stt job ${jobId} failed`);
    if (st.job_state !== "Completed") return null;
    const out: string | undefined = st.job_details?.find((d: any) => d.outputs?.length)?.outputs[0].file_name;
    if (!out) throw new SttJobFailedError(`stt job ${jobId} completed without output`);
    const dl = await this.call<{ download_urls: Record<string, { file_url: string }> }>("download-links", "/speech-to-text/job/v1/download-files", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job_id: jobId, files: [out] }),
    });
    const url = dl.download_urls?.[out]?.file_url;
    if (!url) throw new SarvamError("download-links", 200, "no_download_url");
    let res: Response;
    try {
      res = await this.fetchFn(url);
    } catch {
      throw new SarvamError("download", 0, "network_error");
    }
    if (!res.ok) throw new SarvamError("download", res.status);
    return SarvamSpeechToText.toTranscript(await res.json());
  }
}

/** Offline stub. Returns a fixed transcript, or the audio bytes decoded as UTF-8 (tests/CLI). */
export class StubSpeechToText implements SpeechToText {
  private jobs = new Map<string, string>();
  constructor(private fixed?: string) {}
  async transcribe(audio: Media): Promise<Transcript> {
    return { text: this.fixed ?? new TextDecoder().decode(audio.data), languageCode: "hi-IN" };
  }
  async startBatch(audio: Media): Promise<string> {
    const id = `stub-${this.jobs.size + 1}`;
    this.jobs.set(id, (await this.transcribe(audio)).text);
    return id;
  }
  async pollBatch(jobId: string): Promise<Transcript | null> {
    const text = this.jobs.get(jobId);
    return text === undefined ? null : { text, languageCode: "hi-IN" };
  }
}
