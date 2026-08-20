/** Self-contained browser bundle preset for a DeepSeek Harness client plugin. */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Module-table entries supplied by the DeepSeek Harness Web shell. */
export const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
] as const

/** Build one loader-compatible browser bundle with inline CSS Modules. */
export function clientBundle(id: string, entry = 'src/client/index.ts'): UserConfig {
  return {
    name: `${id}/client`,
    entry: { client: entry },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    tsconfig: 'tsconfig.client.json',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: [...CLIENT_EXTERNALS],
      alwaysBundle: (source: string) => CLIENT_EXTERNALS.includes(source as (typeof CLIENT_EXTERNALS)[number])
        ? undefined
        : true,
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [
      {
        name: 'dsh-client-bundle-purity',
        resolveId(source: string) {
          if (!source.startsWith('@deepseek-ai/')) return null
          if (CLIENT_EXTERNALS.includes(source as (typeof CLIENT_EXTERNALS)[number])) return null
          throw new Error(
            `client bundle purity: ${JSON.stringify(source)} is not supplied by the Web shell; `
            + 'use a type-only import or a Cordis service instead',
          )
        },
      },
      {
        name: 'dsh-css-modules-inline',
        resolveId(source: string, importer: string | undefined) {
          if (!source.endsWith('.module.css')) return null
          const absolutePath = importer === undefined ? source : sourcePath(source, importer)
          const repositoryPath = relative(process.cwd(), absolutePath).split('\\').join('/')
          return CSS_VIRTUAL_PREFIX + repositoryPath + CSS_VIRTUAL_SUFFIX
        },
        async load(virtualId: string) {
          if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
          const repositoryPath = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
          const fileId = resolve(repositoryPath)
          this.addWatchFile(fileId)
          const source = await readFile(fileId)
          const { code, exports: cssExports } = transform({
            filename: fileId,
            code: source,
            cssModules: { pattern: '[hash]_[local]' },
            minify: true,
          })
          const classMap: Record<string, string> = {}
          for (const [local, value] of Object.entries(cssExports ?? {})) classMap[local] = value.name
          const tagId = `${id}/${basename(fileId)}`
          return [
            `const css = ${JSON.stringify(code.toString())};`,
            `const tagId = ${JSON.stringify(tagId)};`,
            'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
            '  const tag = document.createElement(\'style\');',
            `  tag.dataset.plugin = ${JSON.stringify(id)};`,
            '  tag.dataset.pluginCss = tagId;',
            '  tag.textContent = css;',
            '  document.head.appendChild(tag);',
            '}',
            `export default ${JSON.stringify(classMap)};`,
          ].join('\n')
        },
      },
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

function sourcePath(source: string, importer: string): string {
  const emitted = resolve(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${resolve('lib', 'types')}/`
  if (!emitted.includes(marker)) return emitted
  return emitted.replace(marker, `${resolve('src')}/`)
}
