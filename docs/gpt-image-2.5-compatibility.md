# GPT Image 2.5 compatibility

Verified on 2026-09-09 against the Codex ChatGPT-login image endpoints and the
DSH `0.1.5-alpha.1` plugin baseline. Scope: `dsh-codex-auth` only.

Development root: `/Users/suntc/project/dsh-plugins/dsh-codex-auth`.
Canonical origin: `git@github.com:suntianc/dsh-codex-auth.git`.
Branch: `main`, based on `990bf27c3d1853496c27d40191fb2462b7d436ba`.
This is a direct user-requested adaptation, with no linked issue. No commit,
push, npm publication, tag, or live DSH profile installation was performed.

Changed files:

- `src/image.ts`, `src/image-options.ts`
- `src/client/CodexCapabilitySettings.tsx`, `src/client/CodexCapabilitySettings.module.css`
- `src/client/index.ts`, `src/client/locales.ts`
- `tests/image.spec.ts`, `tests/client-settings.spec.tsx`
- `package.json`, `scripts/package-smoke.mjs`
- `README.md`, `README.zh.md`, `CHANGELOG.md`, `docs/gpt-image-2.5-compatibility.md`

## Official contract

- [Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)
  and [Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare)
  have explicit model IDs, text/image input, and image output.
- Both add `xhigh` and `max` quality. Earlier models retain quality through `high`.
- [Custom dimensions](https://developers.openai.com/api/docs/guides/image-generation#size-and-quality-options)
  use multiples of 16, aspect ratios between 1:3 and 3:1, edges up to 3840,
  and 655,360–8,294,400 pixels. Above 2560×1440 is experimental.
- These public API docs alone do not establish Codex-login endpoint availability.

## Live endpoint evidence

Four sequential, non-retried requests reused the existing, unexpired local
Codex access token. No login/refresh or user-profile edit was needed. Credentials
were held in memory and sent only to the existing `chatgpt.com` endpoints.
The probe used the plugin's existing JSON request contract and header names.

| Model | Operation | Requested quality | Requested size | HTTP | Time | Actual PNG size |
| --- | --- | --- | --- | --- | --- | --- |
| Sunburst | generation | low | 1024×1024 | 200 | 19.7 s | 1254×1254 |
| Flare | generation | low | 1024×1024 | 200 | 20.4 s | 1254×1254 |
| Sunburst | edit | xhigh | 1536×864 | 200 | 23.9 s | 1254×1254 |
| Flare | edit | max | 1536×864 | 200 | 20.4 s | 1254×1254 |

Generation requested a blue circle on white; edits sent the corresponding
generated image as `images[].image_url` and requested a green circle. All
responses contained a numeric `created` and one base64 image. PNG headers were
checked; the Sunburst edited image was visually inspected and showed the green
circle. This establishes request acceptance and usable output for this account,
not universal entitlement or independent confirmation of effective model/quality.
The actual dimensions did not match either requested size.

## Implementation decisions

- New configurations default to `gpt-image-2.5-sunburst`. Explicit old model
  settings are preserved; the UI also suggests Flare and GPT Image 2.
- Host/tool schema, settings decoder, and controls share credential-free
  parameter definitions. Advanced quality and custom sizes require either
  explicit 2.5 ID; arbitrary model IDs still accept the pre-existing options.
- Invalid dimensions are rejected before credentials or a network request.
  Size editing saves on blur/Enter so incomplete input does not become a setting.
- Valid images remain durable even when dimensions differ; the result then
  contains `IMAGE_SIZE_MISMATCH` with requested and actual dimensions. Existing
  attachment policy, reference authorization, and no-retry behavior remain in force.
- Production requests continue using the existing generation/edit endpoints.
  No API-key transport, core change, or new dependency is introduced.

## Verification boundaries

Automated regression tests exercise public ToolRuntime execution, configuration
resolution, client registration/decoding, and settings interactions. They cover
both model IDs and advanced qualities, generation/edit dispatch, valid and invalid
dimension boundaries, defaults, legacy rejection, and mismatched output sizes.
Live endpoint probes are separate from the offline tool and browser fixtures;
they are not a complete live Agent-loop-to-browser generation run.

The real DSH Host and Chromium browser check installed the built plugin in an
isolated profile, saved `max` and `1536x864` through the settings UI, confirmed
the Host's resolved settings, and reloaded the page to verify persistence.
The actual Sunburst edit bytes were validated by the real attachment store and
seeded into a conversation through the public Session/JSONL APIs. The plugin
gallery decoded the 1254×1254 image before and after reload; no page errors were
recorded. Browser authentication/usage used a fixture so this check made no
additional image or account network requests.

The complete `pnpm run check` gate covers peers, lint, both typechecks, 323 tests,
production builds, packed-artifact smoke checks, and publint. The compatibility
report is included in the packed file list so the README link remains usable.
