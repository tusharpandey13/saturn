"""Heavy engines for tools/stt, run inside the setup venv (CACHE/venv/bin/python -I workers.py ...).

  workers.py mms WAV --model DIR --out JSON            Meta MMS-1b-all + Hindi adapter (CTC), word timestamps
  workers.py diarize WAV --token-file F --out JSON     pyannote/speaker-diarization-3.1 (gated; token required)

Output JSON only (numbers, words, speaker turns); nothing is printed except a one-line status without content.
Exit codes: 0 ok, 2 engine unavailable (missing model/token/package), 1 error.
"""
import argparse, json, os, sys, time, wave

MMS_REV = "3d33597edbdaaba14a8e858e2c8caa76e3cec0cd"
DIAR_MODEL = "pyannote/speaker-diarization-3.1"
DIAR_REV = "84fd25912480287da0247647c3d2b4853cb3ee5d"
CHUNK_SEC = 20.0


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


def cmd_diarize(a):
    t0 = time.time()
    try:
        token = open(a.token_file, encoding="utf-8").read().strip()
    except OSError:
        print("worker: no token file", file=sys.stderr)
        return 2
    try:
        import torch
        from pyannote.audio import Pipeline
    except ImportError:
        print("worker: pyannote.audio not installed", file=sys.stderr)
        return 2
    try:
        try:
            pipe = Pipeline.from_pretrained(DIAR_MODEL, revision=DIAR_REV, token=token)
        except TypeError:  # pyannote.audio 3.x
            pipe = Pipeline.from_pretrained(DIAR_MODEL, revision=DIAR_REV, use_auth_token=token)
    except Exception as e:  # gated terms not accepted, bad token, offline: never print the token
        print(f"worker: diarization model unavailable ({type(e).__name__})", file=sys.stderr)
        return 2
    if pipe is None:
        print("worker: diarization model unavailable (terms not accepted?)", file=sys.stderr)
        return 2
    dev = device()
    try:
        pipe.to(torch.device(dev))
    except Exception:
        dev = "cpu"
    audio = read_wav(a.wav)
    res = pipe({"waveform": torch.from_numpy(audio).unsqueeze(0), "sample_rate": 16000})
    ann = getattr(res, "speaker_diarization", res)
    labels, turns = {}, []
    for seg, _, spk in ann.itertracks(yield_label=True):
        lab = labels.setdefault(spk, f"S{len(labels) + 1}")
        turns.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "speaker": lab})
    out = {"engine": DIAR_MODEL, "revision": DIAR_REV, "device": dev, "speakers": len(labels), "turns": turns,
           "elapsed_sec": round(time.time() - t0, 1)}
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f)
    print(f"worker: diarize ok ({len(labels)} speakers, {out['elapsed_sec']} s)", file=sys.stderr)
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
    d.add_argument("--token-file", required=True)
    d.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    return {"mms": cmd_mms, "diarize": cmd_diarize}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
