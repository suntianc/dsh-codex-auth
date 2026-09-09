# Fail closed for account RPC on the alpha.5 Connection surface

Status: **accepted** for DSH `0.1.2-alpha.5`.

DSH alpha.5 exposes `HostConnectionRpc.handle(channel, handler)` without the earlier per-channel authority option, and its public handler context carries no unforgeable request-origin or owner-contained-carrier fact. The plugin must not infer account authority from browser-controlled Host/Origin headers, and client `ConnectionHandle.isLoopback` is only a presentation hint. Account status, usage, login, logout, and revoke therefore share one activation-time guard: the real dispatcher is selected only when the public WebServer host is exactly `127.0.0.1`. A missing WebServer, `0.0.0.0`, or any unknown bind registers the same channel with an inert handler that returns only a fixed `loopback-required` error and never calls the auth service.

This is a conservative static deployment policy, not proof of each request's peer address. In an all-interface deployment opened through a localhost browser URL, the client may classify itself as loopback and show GPT Auth settings while the Host correctly denies every account action. Conversely, a custom owner-contained transport without a public Host-side authority fact is denied even if its client reports `ownsHost`. Hiding the Settings section off loopback improves UX but is not an authorization boundary; non-privileged image result views remain registered.

Treating an absent WebServer as implicitly trusted, inspecting Host/Origin headers inside the plugin, restoring a private overload, monkey-patching Connection, or editing DSH core were rejected because each invents an authority fact outside the public plugin contract. If DSH later adds a carrier-asserted `operatorLocal`/`privileged` policy or an unforgeable request authority in the public handler context, the plugin should declare that policy and remove this static bind guard. That upstream API would be a separate DSH task; this adaptation does not patch core.

## DSH 0.1.5 transport adaptation

The static deployment policy continues on `0.1.5-alpha.1`. Account status, usage,
and login now use exact `/api/codex-auth/*` routes registered through the public
`ctx.connection.fetch` service, with the public Connection request schema and
response envelope. The client calls `/api` with `codex-auth/<endpoint>`. This
uses Connection's already authenticated shared transport because the dedicated
`rpc.handle` path in this release tries to access WebServer from a service owner
that does not declare it. The plugin does not replace the shared RPC interceptor
or edit Connection internals. Route disposal removes every account endpoint.

Real HTTP regression tests verify successful authenticated dispatch, 401 without
a session cookie, 403 for an untrusted Origin, method/envelope checks, removal on
disposal, and the same inert denial for an all-interface deployment.
