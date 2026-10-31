# tools/search — semantic search over a records repo

Stdlib Python + SQLite, talking HTTP to a **local** embedding server (llama.cpp `llama-server --embeddings`, OpenAI
`/v1/embeddings`). Nothing leaves the machine: the records, the chunk text and the vectors stay where the records are
allowed to live. The index is a SQLite file **outside any repo** (it holds record text): `--db`, else
`$SATURN_SEARCH_DB`, else `~/.cache/saturn-search/index.sqlite` (created 0600).

```sh
tools/search/search index --records <records-dir>          # incremental; --full re-embeds all; --dry-run: exit 1 if changes
tools/search/search query "चक्कर आना" [--ns alice] [--kind fact|ocr|...] [-k 10] [--json]
tools/search/search stats [--prom] [--probe "blood pressure"]   # size and freshness; --prom = Prometheus text
python3 -I tools/search/test_search.py                       # synthetic records + mock embedding server
```
Endpoint: `--endpoint`, else `$SATURN_EMBED_URL`, else `http://127.0.0.1:8095`. Exit codes: 0 ok, 1 error (or
`--dry-run` found changes), 2 embedding server unreachable, 3 usage.

## What is indexed

| kind | files (relative to the records root) | one chunk = |
|---|---|---|
| `fact` | `data/<ns>/**/*.ndjson` (not `data/ref`, `meta`, `telegram`, `queue`) | one active fact: kind, code/drug (ref names from `data/ref/`), value/unit/flag or dose/schedule, date, the verbatim `quote`; `id` = fact id, `path` + `page` = its source |
| `ocr` | `sources/**/*.ocr.md` | a heading section, packed to ~900 chars (`page` from a "Page N" heading) |
| `transcript` | `sources/**/*.transcript.md` | as above |
| `source-text` | other `sources/**/*.md` (typed or relayed source text) | as above |
| `analysis` | `docs/log/analysis/**/*.md` | as above |
| `extraction` | `docs/log/extraction/**/*.md` | as above |
| `hard-read` | `docs/log/hard-reads/**/*.md` | as above |
| `questions` | `docs/health/<ns>/questions.md` | as above; `id` = the first `<ns>:q|ans|act:NNNN` in the chunk |

`ns` comes from the path (`data/<ns>/`, `sources/<ns>/`, `docs/health/<ns>/`, else a namespace token in the file
name) or the fact row; `--ns X` returns chunks of X plus chunks without a namespace. Curated pages and generated views
are not indexed: they repeat the KB.

**Incremental.** Each file's sha256 is stored; only changed files are re-chunked and re-embedded, deleted files drop
out, and each file is committed on its own (an interrupted run keeps its progress). Fact files also re-embed when
`data/ref/` changes. A different model (the server's `/v1/models` id) or prompt style re-embeds everything; a query
against an index built by another model is refused.

**Prompts.** With `--prompt-style auto` (default) a server whose model id contains `gemma` gets the EmbeddingGemma
retrieval prompts (`task: search result | query: …` / `title: … | text: …`); other models get plain text.

**Scores** are cosine similarities (vectors are L2-normalised at write); compare them within one query only. A hit
is a pointer: open the cited fact or file and quote it. The search ranks text by meaning, it does not interpret it.

## Using it in a review

Search finds candidate evidence across languages (Hindi, English, Hinglish) and wording ("सांस फूलना" finds
"breathlessness"). For each hit, read the cited fact (`id`) in the KB or the file at `path` (+ `page`) and quote the
source, as the records guide requires; never cite a search snippet or score as evidence. Absence of hits is not
absence of evidence: check the KB views too.
