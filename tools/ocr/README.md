# tools/ocr: local OCR for scanned medical documents

Apple Vision OCR (macOS built-ins only: Swift, Vision, PDFKit). Nothing leaves the machine.

```sh
tools/ocr/ocr.sh path/to/file.pdf            # writes path/to/file.pdf.ocr.md
tools/ocr/ocr.sh file.pdf --out file.ocr.md  # choose the output (repo convention: <name>.ocr.md beside <name>.pdf)
tools/ocr/ocr.sh p1.jpg p2.jpg --out doc.ocr.md --name "doc"
```

- PDFs are rendered at 300 dpi with PDFKit; images are read as-is. Recognition: accurate, language correction on, en-US (+ hi-IN where supported).
- Output: a per-page table of average confidence and whether a text layer exists, then the text per page. Any embedded text layer is printed under the OCR text for cross-checking.
- The header says `agent-verified: no`. After checking key values against the page images, change it to `partial` or `yes` and add an "Agent verification" table (a records-repo convention; see the [records guide](../../docs/records-guide.md)).
- OCR does not read handwriting usefully and can drop decimals or a leading "N" (e.g. "N 7.2" became "7.2"). Always verify clinical values against the image.
- Anything you cannot read goes to the records repo's `docs/log/hard-reads/hard-read-queue.md` with an ID (`[uncertain #A12: "Exampla 50?"]` or `[illegible #A13]`); see `HARD-READ.md`.
- The binary is compiled once to `$TMPDIR/saturn-ocr` and rebuilt when `ocr.swift` changes.
