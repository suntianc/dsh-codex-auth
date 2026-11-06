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

## Validation and limits

The package gate covers peer consistency, lint, Host/client type checks,
offline tests, build, isolated archive imports, and publint. New admission tests
reproduce the released manifest's failure and admit the adapted bundle without
rewriting synthetic settings or credentials. The retained-system shrink case
fails with `ManualCompactionError` before the fix and passes with Portable fallback.

An equivalent local build was also installed through the shipped CLI in an
isolated profile and loaded against the installed Desktop's actual modules:
the auth coordinator, model catalog, strict compaction gate, and teardown worked.
One ordinary subscription-backed text turn completed in the Desktop UI.
These observations do not establish live OAuth re-login, Native compaction,
Search, Image Creation, or every saved custom preset's compatibility.

The complete tagged-source artifact gate has a separate reproducible recipe in
[source verification](dsh-source-verification.md). Registry tests and the
packaged Desktop smoke are not a claim that this optional rebuild was run.
