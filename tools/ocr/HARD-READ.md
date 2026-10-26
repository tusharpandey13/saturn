# Brief: resolving the hard-read queue

You resolve the items in `<records-dir>/docs/log/hard-reads/hard-read-queue.md`. Crops are in `<media-dir>/hard-read-crops/<id>.png` (outside git). Record and flag only. Do not diagnose or interpret clinically, and never suggest medication changes.

For each open item:

1. **Enhance the crop.** Work on copies in `/tmp`, never in the crops folder or `sources/`. Upscale 2–4×, raise the contrast or apply CLAHE, sharpen (unsharp mask), try an adaptive threshold, and deskew. Separate the blue ink channel for pen on print. Look at every variant yourself. Re-render from the source PDF at 400–600 dpi if the crop is too small.
2. **Cross-reference.** Look for the same value elsewhere: the printed pages of the same report, other documents in `<records-dir>/sources/` (their `.ocr.md` sidecars first), the per-person profile notes in `<records-dir>/docs/log/extraction/`, and any exported family chat under `<media-dir>/` (outside git).
3. **Check plausibility, not clinical sense.** Use only the form of the text: is it a real drug brand or generic, is that strength sold, does the dose form fit (tab/cap/inj), does the lab unit and order of magnitude match the test, do the letter shapes and counts match. Never pick a reading because it would make more medical sense.
4. **Rank the candidates** with a confidence each (e.g. `"Exampla 50" 0.6, "Exampla 5.0" 0.3`) and the evidence for each.
5. **Never resolve silently.** Update the queue row: status, ranked candidates and evidence. Update the sidecar marker in place (e.g. `[uncertain #A12: "Exampla 50" 0.6 / "Exampla 5.0" 0.3]`). Change a profile fact only when one candidate is ≥0.9 and an independent source backs it, and cite both.
6. **What stays unresolved** gets status `ask-user`, with one plain question the user or the family can answer (e.g. "Can you photograph page 10 of the example-hospital discharge file again, in daylight?").

Report: counts of resolved and ask-user items, and every profile line you changed.
