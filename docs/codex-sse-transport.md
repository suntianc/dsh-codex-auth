# Codex SSE request encoding

The Codex adapter sends uncompressed JSON over SSE. Pi-ai 1.3.0 compresses outgoing SSE request bodies with zstd when Node provides that codec. A Codex backend can reject those bodies with HTTP 400 and `{"detail":"Bad Request"}` even when the same JSON succeeds without compression.

`codexJsonFetch` wraps only the adapter's request-owned fetch implementation. It decodes the zstd bytes, removes the compressed encoding and length headers, and forwards the same JSON with the original method, credentials and abort signal. It returns the HTTP response unchanged and does not retry rejections. Ordinary JSON passes through unchanged; WebSocket frames do not use this HTTP wrapper. Reasoning and tool history remain intact.

## Verification on 2026-11-12

A locally reconstructed failed Astra continuation was submitted without executing any returned tools or changing its saved Session:

| Request | Result |
|---|---|
| Original JSON with encrypted reasoning | HTTP 200; SSE `response.completed` |
| Same JSON without the reasoning `content` field | HTTP 200; SSE `response.completed` |
| Original JSON encoded as zstd | HTTP 400; `{"detail":"Bad Request"}` |
| Original conversation through the corrected Codex adapter | Uncompressed JSON; HTTP 200; successful tool-call finish |

The initial suspicion of damaged reasoning was not supported. No reasoning removal or Session rewrite is part of the fix. Private request bodies, account data and Session identifiers are excluded from this report.

Both direct and prepared adapter calls are covered by regression tests that failed before the fix. Transport tests preserve exact JSON bytes, credentials, cancellation and response identity, reject invalid compressed input, and check that HTTP rejections are not retried. The complete offline suite passed: 497 tests in 31 files. Three older client-registration tests were updated to include the existing image gallery and composer actions; product UI behavior was unchanged by that test repair.
