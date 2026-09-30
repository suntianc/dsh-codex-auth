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
descriptor. The long-context opt-in changes only contextWindow: GPT-6/6.1 uses
872K, while the pre-existing GPT-5.6 1M policy remains unchanged. Turning the
setting off returns the original provider capacity; source objects are never
mutated. The setting is a local compaction budget, not a backend entitlement.

Fallback reasoning maps explicitly mark Off unsupported with null. DSH minimal
is a compatibility alias for low. Omitting an effort is not equivalent to none;
the adapter explicitly supplies low for an unspecified GPT-6.1 Sol request.
Explicit efforts remain unchanged. Ultra is a Codex orchestration mode and is
not sent as a raw wire effort. Installed provider descriptors retain their own
reasoning metadata. Temperature is rejected for the known GPT-6/6.1 models
before authentication, regardless of direct or prepared call entry point.

## Verification boundary

Tests cover missing and installed descriptors, immutable defaults and toggling,
model-specific budgets, UI wording, direct/prepared calls, exact request efforts,
unsupported Off/Ultra and temperature, and successful scripted SSE decoding
through the installed DSH/pi-ai provider. They use synthetic credentials and
an offline transport, not a live account. This does not prove backend model
availability, actual long-context acceptance, subscription quota, or live OAuth
behavior. No release or package publication is part of this change.
