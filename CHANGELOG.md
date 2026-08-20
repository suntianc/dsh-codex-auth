# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

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

[Unreleased]: https://github.com/suntianc/dsh-codex-auth/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/suntianc/dsh-codex-auth/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/suntianc/dsh-codex-auth/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/suntianc/dsh-codex-auth/compare/v0.1.0...v0.2.0
