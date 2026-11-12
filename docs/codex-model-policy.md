# Codex model policy

## Sources and scope

The route uses ChatGPT OAuth through the installed pi-ai Codex provider. Its
capacity must not be inferred from a public API model's total-context number.

- [Official Codex model catalog, pinned revision bcd6d9a](https://github.com/openai/codex/blob/bcd6d9ab6b9f26f85d76d0c680b3f88b367bffa0/codex-rs/models-manager/models.json):
  GPT-6 Astra, Sol, Luna and GPT-6.1 Sol list a 272,000 default context and an
  872,000 maximum. GPT-6.1 Sol's Codex default effort is low; Sol/Luna use medium.
  All list low through max; none lists a non-reasoning effort.
- [GPT-6.1 Sol public API metadata](https://developers.openai.com/api/docs/models/gpt-6.1-sol):
  the fallback output limit is 128,000. Standard token-price estimates per
  million are input $2, output $10, cache read $0.10 and cache write $2.50;
  above 272K input, input/cache prices double and output increases by 50%.
  These are accounting estimates, not subscription quota or OAuth billing guarantees.
- [GPT-6 parameter guidance](https://developers.openai.com/api/docs/guides/latest-model#update-api-and-model-parameters):
  temperature is unsupported with active reasoning. Public API none support
  for Sol/Luna is not evidence of a working Codex OAuth Off option.

## Policy

Missing GPT-6 descriptors use the matching GPT-5.6 transport template. The
plugin changes explicit model fields only and keeps every existing provider
descriptor. The long-context opt-in changes only contextWindow to 872K for every
supported GPT-5.6/6/6.1 model, matching the current Codex OAuth catalog maximum. Turning the
setting off returns the original provider capacity; source objects are never
mutated. The setting is a local compaction budget, not a backend entitlement.

The optional per-profile `excludedModelIds` string array defaults to empty.
Exact, case-sensitive ID filtering runs last, after descriptor completion and
long-context policy. Unknown and duplicate IDs do not change any other model;
no model is hard-coded as excluded. Remaining descriptors retain their fields
and order and the source catalog is not mutated. The volatile field uses the
existing `llm-codex-auth` Config Form and profile patch persistence, including
the usual route update notification. GPT Auth offers a comma-separated editor
that saves on blur or Enter and trims/deduplicates its input.

The plugin does not change the selected model or old sessions when their model
is excluded. Later resolution follows the host's `UNKNOWN_MODEL` behavior;
excluding all models produces an empty catalog. Prepared calls resolve catalog
visibility again on dispatch; already running requests are not cancelled.
Visibility filtering is not a request
permission check and does not alter authentication, Search or Image settings.

Fallback reasoning maps explicitly mark Off unsupported with null. DSH minimal
is a compatibility alias for low. Omitting an effort is not equivalent to none;
the adapter explicitly supplies low for an unspecified GPT-6.1 Sol request.
Explicit efforts remain unchanged. Ultra is a Codex orchestration mode and is
not sent as a raw wire effort. Installed provider descriptors retain their own
reasoning metadata. The pinned pi-ai 1.1.0 catalog supplies GPT-6 Sol/Luna
with `off: "none"`; those installed descriptors therefore advertise Off and
send explicit none. Only missing-model fallback descriptors reject Off. Temperature is rejected for the known GPT-6/6.1 models
before authentication, regardless of direct or prepared call entry point.

## Verification boundary

Tests cover missing and installed descriptors, immutable defaults and toggling,
model-specific budgets, UI wording, direct/prepared calls, exact request efforts,
unsupported fallback Off/Ultra, provider-owned Off, and temperature, and successful scripted SSE decoding
through the installed DSH/pi-ai provider. They use synthetic credentials and
an offline transport, not a live account. This does not prove backend model
availability, actual long-context acceptance, subscription quota, or live OAuth
behavior. No release or package publication is part of this change.

Exclusion regressions cover empty/omitted settings, exact matching, unknown and
duplicate IDs, completed descriptors, long-context compatibility, source
immutability, empty catalogs and missing-model failures before credentials or
transport. Two synthetic profiles exercise the real Settings Forms, Config
Editor and Loader path: edits remain isolated, persist, restore on restart and
notify the live model catalog without remounting the plugin. Client tests cover
save/clear, profile switching and write failure. Real user profiles and live
requests are outside this verification boundary.

## Context capacity and automatic compaction

The local Codex model catalog fetched on 2026-11-12 reports `max_context_window: 872000` and `effective_context_window_percent: 95` for all seven enabled GPT-5.6/6/6.1 models. The default window is 272000 except GPT-6.1 Sol, whose catalog default is 500000. The plugin preserves provider capacities when Long Context is disabled and uses the 872000 maximum when enabled; it does not copy the Codex CLI's separate compaction percentage into DSH.

The stock DSH Basic engine owns automatic compaction. Its default pressure threshold is the smaller of 80% of the advertised context and context minus the request's reserved output and 65536 tokens of headroom. The default retained tail is 16% of context minus reserved output. For an 872000 window with no explicit output reservation, this gives a 697600-token threshold and 139520-token retained tail. Exact model policies or an explicit request output cap can change those numbers. The earlier GPT-5.6 1000000 declaration allowed an 800000-token threshold and overstated the observed Codex maximum; the corrected budget triggers compaction earlier. No persisted Session or user profile threshold is rewritten.

The live [model and compaction matrix](codex-transport-verification-2026-11-12.json) covers both settings for all seven enabled Codex models. With Long Context disabled, the installed catalog reports 272000 for six models and 500000 for GPT-6.1 Sol; their stock Basic thresholds with no explicit output reservation are 206464 and 400000 respectively. All enabled models use 872000 and a 697600 threshold with Long Context enabled. Live summaries used an isolated reduced pressure threshold; production-window saturation is not claimed.
