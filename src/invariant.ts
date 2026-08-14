/**
 * Package-owned invariant companion for `dsh-codex-auth`.
 * @module dsh-codex-auth/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-codex-auth'

/** Cordis companion plugin name. */
export const name = 'llm-codex-auth-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: adapter/RPC registrations are fiber-owned and tested
 * through their real registries; token secrecy is a structural wire contract.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
