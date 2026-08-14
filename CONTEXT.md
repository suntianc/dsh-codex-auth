# Codex-backed Agent Capabilities

This context describes the language used when a Codex-managed ChatGPT login gives agents access to model, search, and generated-media capabilities. It separates authorization, agent tools, and durable conversation content.

## Language

**Codex Login State**:
The ChatGPT account authorization maintained by the official Codex CLI and reused by this project.
_Avoid_: Codex capability, Auth capability

**Codex Account Usage**:
The best-effort weekly remaining balance and reset time associated with the current Codex Login State; it describes account limits, not whether the login is valid.
_Avoid_: local quota, authentication status

**Capability Tool**:
A structured operation an agent may choose automatically or a user may invoke explicitly.
_Avoid_: Auth feature, hidden backend action

**Image Creation**:
A Capability Tool that produces new images from a prompt, optionally using reference images to revise or vary existing visual material.
_Avoid_: image response, Auth image generation, variation endpoint

**Durable Media Asset**:
Generated media owned by conversation history and expected to remain available after the originating backend URL or authorization expires.
_Avoid_: temporary image URL, hotlink

**Web Search**:
A Capability Tool that produces observable search evidence rather than only an opaque, already-synthesized answer.
_Avoid_: browsing, 联网回答

**Search Provider**:
A backend capability that supplies Search Evidence to Web Search without creating a second user-facing search tool.
_Avoid_: search tool, model-native browsing

**Search Evidence**:
A structured search result that identifies its source and preserves enough context for an agent or user to verify and cite it.
_Avoid_: model knowledge, uncited summary

**Codex Capability Bundle**:
One installable project containing independently enabled authorization, search, and image capabilities that share the Codex Login State.
_Avoid_: monolithic Auth plugin, three-package suite

**Global Codex Search Provider**:
The deployment-wide backend selected for DSH Web Search; because DSH provider selection is global, any model using the stock search tool may consume it.
_Avoid_: Codex-only search tool, per-model search provider

**Codex-scoped Image Tool**:
An Image Creation tool visible only to agents using an image-capable model on the `openai-codex` route.
_Avoid_: global image tool, text-only image tool

**Workspace Export**:
An explicit user-requested copy of a Durable Media Asset into the active workspace; the conversation attachment remains the primary copy.
_Avoid_: automatic workspace write

**Image Handle**:
A stable, model-visible identifier for one session-authorized image that lets an agent select reference material without asking the user to manage attachment IDs.
_Avoid_: image URL, filesystem path

**Image Catalog**:
The on-demand `list_images` tool, which pages through durable session images and returns their Image Handles plus image content when older conversation content is no longer active.
_Avoid_: per-turn image inventory

**Reference Image**:
A session image or workspace image promoted into durable attachment storage and selected by its Image Handle for an Image Creation operation.
_Avoid_: arbitrary remote image, implicit binary argument

**GPT Auth Settings**:
The existing settings surface for login plus controls for capabilities unlocked by that login; its name is a UI label, not a claim that search or image creation are authentication operations.
_Avoid_: Auth capability
