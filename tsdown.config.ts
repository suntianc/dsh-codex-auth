import { defineConfig } from 'tsdown'
import { clientBundle } from './build/client-bundle.ts'

const packageName = 'dsh-codex-auth'

/** Build the Host, invariant, and browser faces directly from source. */
export default defineConfig([
  {
    name: packageName,
    entry: ['src/index.ts', 'src/search.ts', 'src/image.ts', 'src/invariant.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    tsconfig: 'tsconfig.host.json',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      neverBundle: [/^@deepseek-ai\//, /^@earendil-works\//, 'undici', 'react'],
    },
  },
  clientBundle(packageName),
])
