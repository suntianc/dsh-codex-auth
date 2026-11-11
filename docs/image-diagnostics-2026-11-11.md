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
