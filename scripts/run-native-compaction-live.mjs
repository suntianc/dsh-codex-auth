#!/usr/bin/env node
/** Explicitly authorized launcher for quota-consuming Native compaction checks. */
import { spawnSync } from 'node:child_process'

const CONFIRMATION = 'I_UNDERSTAND_CODEX_LIVE_QUOTA'

if (process.env.CI) {
  throw new Error('native compaction live test refuses to run when CI is set')
}
if (process.env.DSH_CODEX_NATIVE_LIVE !== '1'
  || process.env.DSH_CODEX_NATIVE_LIVE_CONFIRM !== CONFIRMATION) {
  throw new Error(
    `native compaction live test requires DSH_CODEX_NATIVE_LIVE=1 and DSH_CODEX_NATIVE_LIVE_CONFIRM=${CONFIRMATION}`,
  )
}

const result = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', '--config', 'vitest.live.config.ts'],
  { cwd: process.cwd(), env: process.env, stdio: 'inherit' },
)
if (result.error !== undefined) throw result.error
process.exitCode = result.status ?? 1
