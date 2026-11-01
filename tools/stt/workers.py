"""Heavy engines for tools/stt, run inside the setup venv (CACHE/venv/bin/python -I workers.py ...).

  workers.py mms WAV --model DIR --out JSON            Meta MMS-1b-all + Hindi adapter (CTC), word timestamps
  workers.py diarize WAV --model DIR --out JSON [--speakers N] [--min-speakers N] [--max-speakers N]
                                                       pyannote/speaker-diarization-community-1 (local, pinned copy)

Output JSON only (numbers, words, speaker turns); nothing is printed except a one-line status without content.
Exit codes: 0 ok, 2 engine unavailable (missing model/token/package), 1 error.
"""
import argparse, json, os, sys, time, wave

MMS_REV = "3d33597edbdaaba14a8e858e2c8caa76e3cec0cd"
DIAR_MODEL = "pyannote/speaker-diarization-community-1"
DIAR_REV = "3533c8cf8e369892e6b79ff1bf80f7b0286a54ee"
CHUNK_SEC = 20.0
UNSURE = "S?"
# Second-voice check (README "Diarization"). Measured on real clips: one-voice clips stay at or under 0.63 spread and
# 0.16 forced-split distance; clips with a second voice reach 0.87+ and 0.64+. Few clips: thresholds lean to a check.
SPREAD_WIN_SEC, SPREAD_HOP_SEC, SPREAD_MIN_SEC = 1.0, 0.25, 5.0
SPREAD_DIST, SPREAD_Z = 0.7, 3.5
RETRY_ACCEPT_DIST = 0.4


def read_wav(path):
    import numpy as np
    with wave.open(path, "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise SystemExit("worker: expected 16 kHz mono 16-bit WAV")
        data = w.readframes(w.getnframes())
    return np.frombuffer(data, dtype=np.int16).astype("float32") / 32768.0


def device():
    import torch
    return "mps" if torch.backends.mps.is_available() else "cpu"


def cmd_mms(a):
    import torch
    from transformers import AutoProcessor, Wav2Vec2ForCTC
    t0 = time.time()
    if not os.path.isfile(os.path.join(a.model, "adapter.hin.safetensors")):
        print("worker: mms model missing", file=sys.stderr)
        return 2
    proc = AutoProcessor.from_pretrained(a.model, target_lang="hin")
    model = Wav2Vec2ForCTC.from_pretrained(a.model, target_lang="hin", ignore_mismatched_sizes=True)
    dev = device()
    model.to(dev).eval()
    audio = read_wav(a.wav)
    sr = 16000
    frame = model.config.inputs_to_logits_ratio / sr  # seconds per CTC frame (0.02)
    words, chunks = [], []
    step = int(CHUNK_SEC * sr)
    for off in range(0, len(audio), step):
        seg = audio[off:off + step]
        if len(seg) < sr * 0.3:
            continue
        inp = proc(seg, sampling_rate=sr, return_tensors="pt")
        with torch.inference_mode():
            logits = model(inp.input_values.to(dev)).logits
        ids = torch.argmax(logits, dim=-1)[0].cpu()
        dec = proc.tokenizer.decode(ids, output_word_offsets=True)
        base = off / sr
        for w in dec.word_offsets:
            words.append({"w": w["word"], "start": round(base + w["start_offset"] * frame, 2), "end": round(base + w["end_offset"] * frame, 2)})
        chunks.append({"start": round(base, 2), "end": round(base + len(seg) / sr, 2), "text": dec.text})
    out = {"engine": "facebook/mms-1b-all (adapter hin)", "revision": MMS_REV, "device": dev, "chunk_sec": CHUNK_SEC,
           "words": words, "chunks": chunks, "elapsed_sec": round(time.time() - t0, 1)}
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"worker: mms ok ({len(words)} words, {out['elapsed_sec']} s, {dev})", file=sys.stderr)
    return 0


def spread_groups(times, dists, win=SPREAD_WIN_SEC):
    """Sliding-window voice distances (to the file's median voice) -> [(start, end)] stretches that do not sound like
    the rest: consecutive windows at SPREAD_DIST or more, whose peak is also a robust outlier (SPREAD_Z)."""
    if len(dists) < 8:
        return []
    srt = sorted(dists)
    med = srt[len(srt) // 2]
    mad = sorted(abs(d - med) for d in dists)[len(dists) // 2]
    out, cur = [], []
    for t, d in list(zip(times, dists)) + [(None, -1.0)]:
        if d >= SPREAD_DIST and (not cur or t - cur[-1][0] <= win / 2):
            cur.append((t, d))
            continue
        if cur and (max(x[1] for x in cur) - med) / (1.4826 * mad + 1e-6) >= SPREAD_Z:
            out.append((cur[0][0], cur[-1][0] + win))
        cur = [(t, d)] if t is not None and d >= SPREAD_DIST else []
    return out


def cosine_distance(a, b):
    na, nb = sum(x * x for x in a) ** 0.5, sum(x * x for x in b) ** 0.5
    return 1 - sum(x * y for x, y in zip(a, b)) / (na * nb) if na and nb else 0.0


def centroid_distance(embeddings):
    """Smallest pairwise distance between speakers' voices; 0 when it cannot be measured."""
    pairs = [cosine_distance(embeddings[i], embeddings[j]) for i in range(len(embeddings)) for j in range(i)]
    return round(min(pairs), 3) if pairs else 0.0


def carve_uncertain(turns, groups):
    """Replace the parts of `turns` inside `groups` with speaker "S?"; turns stay exclusive and in time order."""
    out = []
    for t in turns:
        cuts = sorted((max(t["start"], a), min(t["end"], b)) for a, b in groups if min(t["end"], b) > max(t["start"], a))
        pos = t["start"]
        for a, b in cuts:
            if a > pos:
                out.append({**t, "start": pos, "end": a})
            out.append({**t, "start": a, "end": b, "speaker": UNSURE})
            pos = b
        if pos < t["end"]:
            out.append({**t, "start": pos, "end": t["end"]})
    return out


def wants_second_voice_check(hints, duration):
    """Only a free first pass on a clip long enough to measure: an explicit speaker count is the owner's word."""
    return duration >= SPREAD_MIN_SEC and not hints.get("num_speakers") and (hints.get("min_speakers") or 1) < 2 \
        and hints.get("max_speakers") != 1


def choose_pass(first, retry, groups):
    """First pass found one voice, the second-voice check asked for a forced two-speaker pass. Keep that pass only if
    its voices really differ; otherwise keep one speaker and mark the odd-sounding stretches S? for a listener."""
    dist = centroid_distance(retry["embeddings"]) if retry and len(retry["embeddings"]) >= 2 else 0.0
    if retry and retry["speakers"] >= 2 and dist >= RETRY_ACCEPT_DIST:
        return retry["turns"], retry["speakers"], {"centroid_distance": dist, "accepted": True, "uncertain_stretches": 0}
    return carve_uncertain(first["turns"], groups), first["speakers"], {"centroid_distance": dist, "accepted": False, "uncertain_stretches": len(groups)}


def diarize_pass(pipe, waveform, hints):
    """One pipeline run -> exclusive turns (one speaker at a time, labels by first appearance; a speaker heard only
    under another voice gets no turn) and each kept speaker's voice embedding."""
    res = pipe(waveform, **{k: v for k, v in hints.items() if v})
    labels, turns = {}, []
    for seg, _, spk in res.exclusive_speaker_diarization.itertracks(yield_label=True):
        if seg.end - seg.start > 0.01:
            lab = labels.setdefault(spk, f"S{len(labels) + 1}")
            turns.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "speaker": lab})
    order = res.speaker_diarization.labels()
    emb = res.speaker_embeddings
    embeddings = [[float(x) for x in emb[order.index(spk)]] for spk in labels if emb is not None and spk in order]
    regular = sorted((round(s.start, 2), round(s.end, 2)) for s in res.speaker_diarization.itersegments())
    return {"turns": turns, "speakers": len(labels), "embeddings": embeddings, "heard": len(order), "speech": regular}


def window_spread(pipe, audio, speech):
    """Cosine distance of each 1 s window of speech to the median voice of the file. (times, distances)."""
    import numpy as np
    import torch
    sr, win, hop = 16000, int(SPREAD_WIN_SEC * 16000), int(SPREAD_HOP_SEC * 16000)
    mask = np.zeros(len(audio), dtype=bool)
    for a, b in speech:
        mask[int(a * sr):int(b * sr)] = True
    starts = [s for s in range(0, len(audio) - win, hop) if mask[s:s + win].mean() > 0.7]
    if not starts:
        return [], []
    batch = torch.from_numpy(np.stack([audio[s:s + win] for s in starts])).unsqueeze(1).to(pipe.device)
    emb = np.concatenate([pipe._embedding(batch[i:i + 64]) for i in range(0, len(batch), 64)])
    emb = emb / np.linalg.norm(emb, axis=1, keepdims=True)
    mid = np.median(emb, axis=0)
    dist = 1 - emb @ (mid / np.linalg.norm(mid))
    return [s / sr for s in starts], [float(d) for d in dist]


def cmd_diarize(a):
    t0 = time.time()
    if not os.path.isfile(os.path.join(a.model, "config.yaml")):
        print("worker: diarization model missing", file=sys.stderr)
        return 2
    try:
        import torch
        from pyannote.audio import Pipeline
        pipe = Pipeline.from_pretrained(a.model)
    except Exception as e:  # never print content
        print(f"worker: diarization model unavailable ({type(e).__name__})", file=sys.stderr)
        return 2
    dev = device()
    try:
        pipe.to(torch.device(dev))
    except Exception:
        dev = "cpu"
    audio = read_wav(a.wav)
    wav = {"waveform": torch.from_numpy(audio).unsqueeze(0), "sample_rate": 16000}
    hints = {"num_speakers": a.speakers, "min_speakers": a.min_speakers, "max_speakers": a.max_speakers}
    first = diarize_pass(pipe, wav, hints)
    turns, speakers, check = first["turns"], first["speakers"], None
    if first["speakers"] == 1 and wants_second_voice_check(hints, len(audio) / 16000):
        times, dists = window_spread(pipe, audio, first["speech"])
        groups = spread_groups(times, dists)
        if groups or first["heard"] >= 2:
            turns, speakers, check = choose_pass(first, diarize_pass(pipe, wav, {**hints, "min_speakers": 2}), groups)
        check = {"spread_max": round(max(dists), 3) if dists else None, "retried": check is not None, **(check or {})}
    out = {"engine": DIAR_MODEL, "revision": DIAR_REV, "device": dev, "speakers": speakers, "turns": turns, "hints": {k: v for k, v in hints.items() if v},
           "second_voice_check": check, "elapsed_sec": round(time.time() - t0, 1)}
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f)
    print(f"worker: diarize ok ({speakers} speakers, {out['elapsed_sec']} s)", file=sys.stderr)
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="workers.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("mms")
    m.add_argument("wav")
    m.add_argument("--model", required=True)
    m.add_argument("--out", required=True)
    d = sub.add_parser("diarize")
    d.add_argument("wav")
    d.add_argument("--model", required=True)
    d.add_argument("--out", required=True)
    d.add_argument("--speakers", type=int)
    d.add_argument("--min-speakers", type=int)
    d.add_argument("--max-speakers", type=int)
    a = ap.parse_args(argv)
    return {"mms": cmd_mms, "diarize": cmd_diarize}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
