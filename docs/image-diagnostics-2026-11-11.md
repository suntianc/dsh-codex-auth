# Image diagnostics and settings verification

The image transport previously discarded every failed HTTP response and reported IMAGE_UPSTREAM. An image-edit reproduction returned HTTP 400 with moderation_blocked; separate Sunburst and Flare generation requests succeeded with the same current Codex login. This establishes the reproduced rejection and account access for those requests, not universal acceptance or historical response contents.

Error handling now reads at most 16 KiB of diagnostics, recognizes moderation_blocked without copying upstream text, and classifies HTTP 400, 401, 403, 404 and 429. Other HTTP failures retain IMAGE_UPSTREAM. Requests are never automatically retried.

The Desktop settings check exposed another failure: the serialized size transform could not be evaluated by the assembled settings client, leaving the image form loading indefinitely. The editable schema now uses a declarative string pattern. Full arithmetic dimension validation remains at plugin activation, settings reads and tool argument parsing. The regression checks JSON rehydration and the absence of executable callbacks.

The existing model suggestions are now a dropdown with Sunburst, Flare and GPT Image 2. Configured custom IDs remain selectable; new custom IDs can be configured through cordis.yml. Custom dimensions and quality controls are retained.

## Evidence

- 49 focused tests across image transport, settings and image-card rendering passed; Host and client typechecks, lint and production build passed.
- Installed a uniquely named local archive, checked installed image.js against the built file, and restarted the signed Desktop application.
- Through the actual Desktop UI selected Flare, Maximum quality and 1536x1024; confirmed all three in persisted profile configuration. Restored the original defaults after the check. Login remained Active.
- A separate live Flare request at low quality returned HTTP 200 and a PNG with actual dimensions 1536x1024. Sunburst also returned one image with HTTP 200.
- No new model round through the Desktop conversation UI was run during the settings check. The installed application, direct endpoint probes and offline tests are separate evidence. No GUI recording is included because the inspected Desktop window contained unrelated private conversation content.

## Generated-image preview repair

A subsequent real generation succeeded and persisted a PNG, but its tool card showed Retry image. The plugin passed only attachmentId to the current Session readAttachment method, which requires the complete ImageAttachmentRef. Updated the loader and its regression mock to use the complete reference. Existing session authorization, response-ID checks and Blob URL ownership remain intact.

After installing the repaired client bundle and restarting Desktop, reopened the existing completed generation, expanded Called tools and observed its image thumbnail. Open original image displayed the stored full-size PNG. No regeneration was performed. The focused loader, image view and settings tests passed (15 tests), as did typecheck, lint and the packaged production build.

## Chat artifacts and edit action

Generated outputs are folded from successful generate_image results into the public conversation.chat.turnTail extension. Reference inputs are excluded. The gallery remains visible with process details collapsed; successful tool details no longer duplicate the image. Existing stored generations are projected on replay without changing the durable event format.

Edit image appends an explicit handle to the current Session draft through the conversation input service, preserves previous draft content and focuses the composer. It does not send a request. A blocked draft initialization reports a localized error.

Desktop verification showed the stored image below the assistant reply with the process collapsed. The edit action preserved existing draft text and prepared the exact image handle. Offline checks passed: 54 tests across the image transport, turn artifacts, settings, image view and attachment URL loader; Host/client typecheck, lint, packaged-artifact smoke and publint. The existing signed Desktop dark-theme layout was inspected; a separate narrow/light-theme inspection is not claimed.

A subsequent real Desktop edit changed a cup to blue while retaining the selected cat image as a session reference. The durable tool result reported operation edit, isError false, and one generated image. The completed assistant turn displayed the new image directly in the chat and its original preview opened. The stored PNG was visually inspected and the cup was blue. This verifies one complete conversation edit round, in addition to the earlier direct endpoint probes.

## Per-request controls

Edit image now opens model, resolution and quality controls beside the selected image. Create image opens the same controls from New Session and the active composer, with a creation description instead of edit instructions. Add to message preserves existing draft content and includes the chosen parameters in the logged user request. Profile defaults are not written. Presets and custom sizes use the existing Host parameter validators; incompatible quality/size choices disable preparation. Each generated image displays its actual dimensions.

Verified the editing controls in Desktop: selected 1536x1024 and high quality, described a change, and confirmed the prepared draft included both parameters and the selected image handle. Cleared this test draft without sending. From the blank-session Create image control selected Flare, 1024x1536 and low quality, prepared and explicitly sent the message. The real model called generate_image with those three arguments and no references; generation succeeded with an actual 1024x1536 PNG and no size warning. The image appeared directly in the chat with its actual dimensions.
