/**
 * Environment HTTP proxy installation for the running host process.
 *
 * Node's built-in fetch (undici) does not honour `HTTP_PROXY`/`HTTPS_PROXY`
 * environment variables, while this machine's other tools (curl, python,
 * the codex CLI) all route through the local proxy — so on such a network
 * every LLM request from this plugin would fail with a connect timeout.
 * Installing an `EnvHttpProxyAgent` as the global dispatcher makes the host
 * behave like the rest of the system: proxy variables are honoured (with
 * `NO_PROXY` bypassing for localhost and friends), and on a machine with no
 * proxy variables set this is a no-op.
 *
 * @module dsh-codex-auth/env-proxy
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

let installed = false

/**
 * Install the env-proxy dispatcher once, when the process environment names
 * a proxy. Safe to call at any plugin load; repeated calls are no-ops.
 * @param log - diagnostic sink (never receives proxy credentials).
 */
export function installEnvHttpProxy(log: (message: unknown) => void): void {
  if (installed) return
  installed = true
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
    ?? process.env.HTTP_PROXY ?? process.env.http_proxy
  if (proxy === undefined || proxy.length === 0) return
  try {
    // EnvHttpProxyAgent reads the proxy and NO_PROXY variables per request,
    // so a change takes effect without re-installing.
    setGlobalDispatcher(new EnvHttpProxyAgent())
    log('llm-codex-auth: routing outbound requests through the environment HTTP proxy')
  } catch (error) {
    log(error)
  }
}
