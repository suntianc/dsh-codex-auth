# Upgrade to DSH 0.2.2-rc.1

This candidate targets the coherent DSH `0.2.2-rc.1` graph, Cordis `4.1.0`,
Schemastery `3.19.0`, and pi-ai `1.3.0`. The official Harness source tag is
[`dsh-v0.2.2-rc.1`](https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db).
The proposed plugin version is `0.3.4-rc.3`; opening or merging this change does
not itself publish an npm release or move a dist-tag.

## Why the released plugin stops loading

`dsh-codex-auth@0.3.4-rc.2` declares exact optional peers for DSH compaction,
Basic compaction, and token meter at `0.2.1-rc.1 || 0.2.1-rc.2`.
The Host checks those peers before importing a bundle, so upgrading Harness
alone disables all three Codex bundle rows. Repeating login cannot repair this
admission failure.

This candidate moves the complete development graph, peers, package smoke,
and Native/compaction runtime guards together. It accepts only the new exact
experimental graph with pi-ai `1.3.0`, rejects mixed or future versions, and
does not add an exemption. Older Harness installations should retain a plugin
release tested against their runtime.

## Runtime and fixture changes

- Supply the new required `ResolvedPiAiProviderProfile` image-count policy:
  `maxRequestImages: 50` and `imageOffloadCountQuantum: 10`, matching DSH defaults.
- Exercise image tools through `NativeToolExecutor` and complete tool batches.
  Ordinary tool definitions continue to use the public registration seam.
- Include captured `modelSelection` in automatic compaction test events.
  Session title generation no longer declares the old auxiliary request purpose;
  the continuation test uses the still-declared compaction purpose instead.
- Supply the browser module loader's new `asset` method in its test bootstrap.
- Preserve signed reasoning using a valid pi-ai replay envelope v2. Plain
  unsigned reasoning is no longer treated as native same-model replay.
- Preserve installed model descriptors, including the new GPT-6.1 Sol catalog
  context window of 500,000 tokens. Long Context remains an explicit setting.
- Measure Native summary shrink against the replaced region only. Basic retains
  the leading system head; counting it as removable history can admit an
  oversized Native summary and make an otherwise valid Portable transaction fail.

Session headers remain V4 and the plugin checkpoint codec remains v1. Frozen
older synthetic sessions are restored, forked, and replayed without rewriting
their durable Native blocks. Incompatible request digests continue through the
Portable representation.

## Profile upgrade

Stop the relevant Host, back up the profile and conversations, then install the
candidate archive into that profile using the CLI shipped with the target DSH.
For a development build:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm pack --pack-destination /absolute/path/to/artifacts
dsh plugin --profile desktop add /absolute/path/to/artifacts/dsh-codex-auth-0.3.4-rc.3.tgz
```

The `desktop` example targets the installed Electron application's profile;
use `web` or another profile name when appropriate. Installation from npm should
use the candidate version only after a maintainer publishes it.

Remove a user-added `llm-pi-ai.providers.openai-codex` entry if present. The
generic PiAiAdapter and this plugin must not both register the same route.
An old model-catalog-only override can now create this conflict. Keep unrelated
provider overrides and do not clear Login State or conversations. The plugin's
catalog already supplies Codex models without credential reads during listing.

Restart the Host, confirm that the plugin has no admission/component error,
check GPT Auth, and send a small request with the intended Codex model.
Keep authentication on the existing subscription route.

### Saved custom presets

A preset copied from an older Standard definition can fail with
`agent-preset/invalid` because
`@deepseek-ai/dsh-tool-subagent-control/list-agents` no longer starts on the new
runtime. Remove that retired `tool-subagent-list-agents` row when migrating the
copy; the current Standard uses `@deepseek-ai/dsh-tool-subagent-control`.

Also migrate `modelSelectionSettings` to the current `modelSelection` and
`modelDiscovery` flags. Preserve the intended policy: enable both for a generic
model-selectable role, and leave both false for a fixed-model role. Keep the
existing preset ID so saved conversations can still resolve it. Review custom
preset differences against DSH's shipped Standard rather than replacing user
settings wholesale.

This migration was verified with the actual Desktop modules: the previously
rejected saved preset admitted successfully, selected NativeToolExecutor,
completed a shell-marker turn, and an existing saved conversation opened in
Desktop. A fresh Standard session also completed a shell-marker turn. HTTP
fetch was tested with an explicit `fetchProvider: http`, as configured in the
live profile; an isolated default composition with multiple usable providers
requires a selection. The account-usage probe returned a valid weekly window.

## Validation and limits

The package gate covers peer consistency, lint, Host/client type checks,
offline tests, build, isolated archive imports, and publint. New admission tests
reproduce the released manifest's failure and admit the adapted bundle without
rewriting synthetic settings or credentials. The retained-system shrink case
fails with `ManualCompactionError` before the fix and passes with Portable fallback.

### Live verification (2026-11-06)

An equivalent local build with identical runtime sources was installed through
the shipped CLI in an isolated profile and loaded against Desktop's actual
bundled modules. Real service calls confirmed:

- Text inference, scoped `generate_image` / `list_images` registration, and Codex Search.
- Image generation with the configured default Sunburst model, followed by a
  session-handle edit. Both images decoded as 1536×1024, had no tool warnings,
  and matched the requested red-circle / blue-square content on visual inspection.
- Session persistence and a separate Host-process restart: both attachments
  retained identical hashes and the restored image catalog returned both handles.
- The image tool rejected a reference not present in the invoking session with
  `IMAGE_REFERENCE_NOT_AUTHORIZED`, before dispatching an image request.
- The explicitly authorized Native live harness, separately using the pinned
  registry dependency graph, passed with `gpt-6-astra`:
  Native creation, one-shot turn continuation, JSON restore in a fresh Host,
  repeated compaction, and redacted diagnostics.

All seven tested GPT-5.6 / GPT-6 / GPT-6.1 entries answered. The same subscription
rejected `gpt-5.3-codex-spark` and `gpt-5.5` as unsupported for a ChatGPT account.
This is account/backend evidence, not a global retirement claim. A profile may
hide those exact entries without altering saved sessions or the default catalog:

```yaml
- id: llm-codex-auth
  config:
    excludedModelIds:
      - gpt-5.3-codex-spark
      - gpt-5.5
```

These checks do not establish fresh browser OAuth login, every image model or
quality/size combination, or every user-authored saved preset's compatibility.

The complete tagged-source artifact gate has a separate reproducible recipe in
[source verification](dsh-source-verification.md). Registry tests and the
packaged Desktop smoke are not a claim that this optional rebuild was run.

## DSH 0.2.2-rc.2 qualification

The candidate admits coherent 0.2.2-rc.1 and 0.2.2-rc.2 graphs, each with pi-ai 1.3.0. Experimental peers use the exact union; mixed graphs, a future RC and stable releases remain rejected. Development dependencies and the source verification baseline now use rc.2 and pnpm 11.28.5, matching the signed Desktop toolchain.

DSH rc.2 limits `LlmError` to its declared failure codes. The plugin's disabled credential-persistence operation uses the shared `HarnessError` with its existing code. DSH rc.2 also rebuilds addition-only tool declarations after an empty initial set or removals; deferred-history tests use a nonempty initial tool set to keep testing genuine in-history additions. This does not loosen Native checkpoint eligibility or rewrite saved conversations.

The rc.2 qualification passed 508 unit tests, package smoke checks, both TypeScript programs and lint. The [rc.2 live report](codex-transport-verification-rc2-2026-11-12.json) repeats all seven enabled models with Long Context off and on: 14 cases and 70 successful HTTP requests, including tool-result replay, continuation and automatic Basic compaction. Compaction uses reduced isolated thresholds; this does not certify saturation at the advertised production window or rule out unrelated backend failures.
