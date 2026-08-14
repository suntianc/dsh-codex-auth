# Compose Codex capabilities through native DSH seams

Status: **accepted**

One `dsh-codex-auth` npm bundle will install independently enabled Auth/LLM, Search, and Image runtime plugins that share the Host-only Codex auth service. Search extends `ctx.web` and keeps DSH's stock `web_search` tool and citation UI; image creation extends `ctx.tools`, `ctx.attachments`, `ctx.fs`, and a keyed client tool renderer. Direct standalone Codex endpoints are used because the installed pi-ai adapter cannot represent hosted search or image-generation items.

A monolithic plugin was rejected because Search and Image must be disabled and configured independently; three npm packages were rejected because they share one login authority, client surface, and compatibility boundary. Contributing the feature set to the separately published `dsh-codex` package was rejected in favor of preserving this project's Codex-CLI-login design, so the two route-owning bundles are explicitly mutually exclusive.
