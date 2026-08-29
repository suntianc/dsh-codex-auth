# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Added an experimental, Portable-first `dsh-codex-auth/compaction` Host Adapter and a packaged custom-preset example that retains the stock compact command and tool-result pruner.
- Documented the Portable, Codex Native, and Dual Checkpoint vocabulary plus the custom-preset/Basic-subclass architecture decision.
- Added the versioned `dsh-codex-auth/native-checkpoint` Host codec for lossless, bounded text-retention history ending in one opaque Responses compaction item.
- Added Portable-first Codex Native Checkpoint creation for Basic pressure and provider-confirmed context-overflow operations, plus a 60-second one-shot Codex Turn Continuation for the next matching Agent-loop request.

### Changed

- Pinned the experimental compatibility set to DSH `0.1.1-rc.2` and pi-ai `0.82.1`; the custom compaction Adapter fails loud, Native replay falls back to Portable text, and shipped presets keep using stock Basic unless a custom preset opts in.
- Restored compatible durable Codex Native Checkpoints during ordinary `openai-codex` inference while preserving one exact-position Portable fallback for every incompatible or malformed candidate.
- Kept Basic authoritative for automatic trigger timing, pruning, balanced selection, retry caps, durable markers, strict shrink, surface mutation, and cancellation while the custom Adapter adds only native generation and one-shot continuity.
- Preserved immutable Dual Checkpoints across JSON restore, public forks, stock-Basic rollback, and round trips through the shipped foreign Adapters; final payload callbacks and Adapter generation changes now reselect Native or Portable without rewriting Session state.
- Made Native v2 failure degradation predictable: unsupported final Portable shapes now open the protocol breaker, half-open remains single-probe, active direct requests abort on Adapter disposal, ordinary inference stays independent, and logs expose usage availability without provider token values or merging Native usage into rc.2 aggregate accounting.
- Completed repeated compaction semantics with ordered expansion of compatible earlier checkpoints, Portable contribution from incompatible checkpoints, later-tail preservation, Basic-owned bounded pressure behavior, and the versioned retained-JSON plus opaque-base64 replay estimator under the 64,000-token retained-prefix policy.
- Completed experimental delivery verification with custom-preset manual/pressure/overflow coverage, stock client non-copyability checks, packed design/ADR documentation, strengthened tarball smoke checks, and a CI-refusing double-confirmed live v2/continuation/restart/repetition harness that remains outside normal `test` and `check`.

### Security

- Kept generated replay markers and Codex Turn Continuations process-local; credentials, namespaced/wrapped token and auth fields, sensitive headers, raw turn state, and raw account/routing identifiers never enter durable checkpoint state, logs, errors, or diagnostics.
- Added an empty presentation sentinel so stock conversation and Trajectory views do not stringify opaque Native state, and documented that the credential-free block remains sensitive ordinary Session/RPC/export data in rc.2.

## [0.3.1] - 2026-08-27

### Fixed

- Preserved valid tool-result images in Codex requests on newer DSH releases by supplying the adapter's per-image pixel and byte limits.
- Kept the manually constructed Codex profile source-compatible with the DSH `0.1.1-rc.1` minimum while allowing newer adapters to consume those limits.

## [0.3.0] - 2026-08-22

### Added

- Added a live, default-off 1M context policy for GPT-5.6 Luna, Sol, and Terra through the new `codex-llm` Settings namespace.
- Added accessible collapse/expand controls for the detailed Web Search and Image Creation settings.

### Changed

- Reordered GPT Auth Settings to place LLM Context immediately below Login and matched login-action sizing to the Antigravity settings panel.

## [0.2.3] - 2026-08-21

### Changed

- Raised the minimum DeepSeek Harness baseline to `0.1.1-rc.1` across peer dependencies, development dependencies, documentation, and reproducible workspace resolution.
- Adapted the Codex LLM route to the required `PiAiAdapterOptions.auth` contract while preserving the plugin-owned Host credential coordinator as the only token source.
- Added the rc.1 request image payload default and attachment dimension limit to the adapter and test fixtures.
- Updated packaged-artifact validation to verify declared rc.1 resolutions without rejecting legitimate older transitive snapshots embedded by upstream packages.

### Security

- Kept pi-ai credential persistence and ambient discovery fail-closed so Codex tokens cannot enter a second credential path, client state, or RPC payloads.

## [0.2.2] - 2026-08-20

### Fixed

- Restored generated-image rendering on DSH rc.7+ by owning the gallery in this client bundle instead of importing React values from the attachment plugin browser face, which does not expose presentation components.

## [0.2.1] - 2026-08-20

### Changed

- Refined the GPT Auth settings UI with compact cards, header status indication, native-style capability toggles, quota progress feedback, and stable skeleton/refresh states.
- Raised the minimum DeepSeek Harness baseline to `0.1.0-rc.7` across peer dependencies, development dependencies, and reproducible workspace resolution.
- Documented that rc.7 exposes the plugin-owned `codex-search` and `codex-image` settings namespaces while the existing top-level `settings.section` registration remains compatible.
- Documented rc.7 ACP image admission: persisted user images participate in the Image Catalog and reference flow, while generated tool-result images are not projected directly over ACP.
- Hardened packaged-artifact smoke checks so manifest ranges semantically enforce the rc.7 floor and the lockfile rejects every pre-rc.7 DSH resolution.

### Fixed

- Made auth work lifecycle-safe across overlapping Host coordinators with per-instance singleflight, disposal-abortable network/probe work, bounded caller detachment, and coordinated atomic commits.
- Restored the visible Host-only token privacy disclosure and made settings loading/reduced-motion behavior accessible.

## [0.2.0] - 2026-08-14

### Added

- Codex-backed Web Search through the stock DSH `web_search` tool, with deployment-global provider selection, bounded responses, cancellation, and conservative retry behavior.
- Durable `generate_image` and model-facing `list_images` tools with image references, deployment limits, partial-success handling, session-authorized attachments, and paginated catalogs.
- A unified bilingual GPT Auth settings section for Login, Web Search, and Image Creation.
- Resilient weekly Codex usage status with bounded Host requests and value-free browser projections.
- Independent Host composition rows for Auth/LLM, Search, and Image, including coordinator-only operation through `llmEnabled: false`.

### Changed

- Centralized Codex Login State behind a shared lock-coordinated Host service with locked re-reads and conservative same-account recovery.
- Successful image generation now displays only the standard image gallery; `list_images` has no user-facing result card.
- Expanded packed-artifact validation to import published Host exports and verify the browser bundle and composition patch.
- Updated English and Chinese documentation for the complete Codex capability bundle.

### Security

- Token values remain Host-only and are excluded from browser state, settings, logs, events, diagnostics, and tool metadata.
- Workspace image reads stay bounded and policy-aware, while durable image reads require authorization from the owning session log.

### Known limitation

- DSH `0.1.0-rc.6` does not expose a policy-aware binary workspace-write API, so generated images remain durable conversation attachments and workspace export is not offered.

[Unreleased]: https://github.com/suntianc/dsh-codex-auth/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/suntianc/dsh-codex-auth/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/suntianc/dsh-codex-auth/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/suntianc/dsh-codex-auth/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/suntianc/dsh-codex-auth/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/suntianc/dsh-codex-auth/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/suntianc/dsh-codex-auth/compare/v0.1.0...v0.2.0
