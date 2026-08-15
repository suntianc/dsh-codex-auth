/** Codex Image Creation tools, Durable Media Asset catalog, and Image row. */
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  AttachmentStore, ImageAttachmentRef, ImageMediaType, SaveImageAttachment, StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmCallConfig, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CodexAuthService, CodexCredential } from './codex-auth-service.ts'
import { CODEX_ROUTE } from './codex-auth-adapter.ts'
import { readBoundedResponseText } from './bounded-response.ts'

export const GENERATE_IMAGE_TOOL_NAME = 'generate_image'
export const LIST_IMAGES_TOOL_NAME = 'list_images'
export const CODEX_IMAGE_GENERATION_ENDPOINT = 'https://chatgpt.com/backend-api/codex/images/generations'
export const CODEX_IMAGE_EDIT_ENDPOINT = 'https://chatgpt.com/backend-api/codex/images/edits'
export const CODEX_IMAGE_SETTINGS_NAMESPACE = settingsNamespace('codex-image')

const IMAGE_ORIGINS = ['all', 'generated', 'reference', 'user'] as const
const IMAGE_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'] as const
const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high'] as const
const IMAGE_BACKGROUNDS = ['auto', 'opaque', 'transparent'] as const
const MAX_REFERENCES = 5
const MAX_GENERATED_IMAGES = 10

export type ImageOriginFilter = (typeof IMAGE_ORIGINS)[number]
export type ImageSize = (typeof IMAGE_SIZES)[number]
export type ImageQuality = (typeof IMAGE_QUALITIES)[number]
export type ImageBackground = (typeof IMAGE_BACKGROUNDS)[number]

/** Independently live Image Creation settings. */
export interface CodexImageSettings {
  enabled: boolean
  model: string
  n: number
  size: ImageSize
  quality: ImageQuality
  background: ImageBackground
}

export interface Config extends CodexImageSettings {}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  model: z.string().default('gpt-image-2'),
  n: z.number().step(1).min(1).max(MAX_GENERATED_IMAGES).default(1),
  size: z.union(IMAGE_SIZES.map(value => z.const(value))).default('auto'),
  quality: z.union(IMAGE_QUALITIES.map(value => z.const(value))).default('auto'),
  background: z.union(IMAGE_BACKGROUNDS.map(value => z.const(value))).default('auto'),
}) as z<Config>

/** Narrow dependency surface used by both public Tool definitions. */
export interface CodexImageToolOptions {
  auth: Pick<CodexAuthService, 'credential'>
  settings: () => CodexImageSettings
  attachments: Pick<AttachmentStore, 'imageLimits' | 'validateImage' | 'saveImage' | 'readImage'>
  fs: Pick<FileSystem, 'resolve' | 'contains' | 'processPath' | 'readBytes'>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<Pick<LlmResolvedModelInfo, 'inputModalities'>>
  fetchImpl: typeof fetch
}

type ImageHandle = `image:${string}`

interface SessionReference {
  kind: 'session'
  handle: ImageHandle
}

interface WorkspaceReference {
  kind: 'workspace'
  path: string
}

type ImageReference = SessionReference | WorkspaceReference

interface GenerateImageArgs {
  prompt: string
  references: ImageReference[]
  model: string
  n: number
  size: ImageSize
  quality: ImageQuality
  background: ImageBackground
}

interface ImageWarning {
  index: number
  code: string
  message: string
}

interface CanonicalImageItem {
  handle: ImageHandle
  attachment: ImageAttachmentRef
  origin: 'generated' | 'reference' | 'user'
}

interface GenerateImageResult {
  operation: 'generate' | 'edit'
  created: number
  images: CanonicalImageItem[]
  references: CanonicalImageItem[]
  warnings: ImageWarning[]
}

interface CatalogItem extends CanonicalImageItem {
  name?: string
  width: number
  height: number
  creationSeq: number
  createdAt: number
}

interface ListImagesResult {
  items: CatalogItem[]
  nextCursor?: string
}

/** Build registry-ready public Capability Tools around one dependency set. */
export function createCodexImageTools(options: CodexImageToolOptions): readonly ToolDefinition[] {
  return [createGenerateImageTool(options), createListImagesTool(options)]
}

function createGenerateImageTool(options: CodexImageToolOptions): ToolDefinition {
  return {
    name: GENERATE_IMAGE_TOOL_NAME,
    description: 'Create images with Codex, optionally editing explicit session Image Handles or workspace image files. Generated images become durable conversation media.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'A complete description of the image or requested edit.' },
        references: {
          type: 'array',
          maxItems: MAX_REFERENCES,
          description: 'Explicit reference images. HTTP(S) URLs are not accepted.',
          items: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  kind: { const: 'session' },
                  handle: { type: 'string', description: 'A session-authorized Image Handle such as image:abc.' },
                },
                required: ['kind', 'handle'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  kind: { const: 'workspace' },
                  path: { type: 'string', description: 'A path inside the active workspace.' },
                },
                required: ['kind', 'path'],
                additionalProperties: false,
              },
            ],
          },
        },
        model: { type: 'string', description: 'Optional image-model override.' },
        n: { type: 'integer', minimum: 1, maximum: MAX_GENERATED_IMAGES },
        size: { type: 'string', enum: [...IMAGE_SIZES] },
        quality: { type: 'string', enum: [...IMAGE_QUALITIES] },
        background: { type: 'string', enum: [...IMAGE_BACKGROUNDS] },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: generateOutputSchema,
      render: (_args, value) => renderGenerateResult(value as unknown as GenerateImageResult),
      presentationMeta: (_args, value) => value,
    },
    execute: async (rawArgs, exec) => executeGenerateImage(options, rawArgs, exec),
    isConcurrencySafe: () => true,
  }
}

function createListImagesTool(options: CodexImageToolOptions): ToolDefinition {
  return {
    name: LIST_IMAGES_TOOL_NAME,
    description: 'List durable images authorized by this session, newest first, and return their Image Handles plus visual ImageBlocks.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Page size; defaults to 5.' },
        cursor: { type: 'string', description: 'Opaque cursor returned by a previous page.' },
        origin: { type: 'string', enum: [...IMAGE_ORIGINS], description: 'Optional origin filter.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: listOutputSchema,
      render: (_args, value) => renderCatalog(value as unknown as ListImagesResult),
      presentationMeta: (_args, value) => value,
    },
    execute: async (rawArgs, exec) => executeListImages(options, rawArgs, exec),
    isConcurrencySafe: () => true,
  }
}

async function executeGenerateImage(
  options: CodexImageToolOptions,
  rawArgs: unknown,
  exec: ToolRunContext,
): Promise<GenerateImageResult> {
  const settings = options.settings()
  const args = parseGenerateArgs(rawArgs, settings)
  const credential = await assertImageCapability(options, exec, settings)
  const references = await resolveReferences(options, args.references, exec)
  const endpoint = references.length === 0 ? CODEX_IMAGE_GENERATION_ENDPOINT : CODEX_IMAGE_EDIT_ENDPOINT
  const body = {
    ...(references.length === 0
      ? {}
      : { images: references.map(reference => ({ image_url: dataUrl(reference.stored) })) }),
    prompt: args.prompt,
    background: args.background,
    model: args.model,
    n: args.n,
    quality: args.quality,
    size: args.size,
  }
  const envelope = await dispatchImageRequest(options, endpoint, body, credential, exec)
  const { created, candidates, warnings } = await validateImageEnvelope(
    options,
    envelope,
    args.n,
    references.length,
    references.reduce((total, reference) => total + reference.stored.ref.bytes, 0),
  )
  const images: CanonicalImageItem[] = []
  for (const candidate of candidates) {
    try {
      const attachment = await options.attachments.saveImage(candidate.input)
      images.push({ handle: imageHandle(attachment), attachment, origin: 'generated' })
    } catch {
      warnings.push({ index: candidate.index, code: 'IMAGE_STORAGE_FAILED', message: 'The validated image could not be stored durably.' })
    }
  }
  if (images.length === 0) {
    throw new ImageCapabilityError('No valid generated image remained after validation', 'IMAGE_RESPONSE_EMPTY')
  }
  return {
    operation: references.length === 0 ? 'generate' : 'edit',
    created,
    images,
    references: references.map(reference => ({
      handle: imageHandle(reference.stored.ref),
      attachment: reference.stored.ref,
      origin: 'reference',
    })),
    warnings,
  }
}

async function executeListImages(
  options: CodexImageToolOptions,
  rawArgs: unknown,
  exec: ToolRunContext,
): Promise<ListImagesResult> {
  const settings = options.settings()
  await assertImageCapability(options, exec, settings)
  const args = parseListArgs(rawArgs)
  const agent = requireAgent(exec)
  const catalog = collectSessionImages(agent)
    .filter(item => args.origin === 'all' || item.origin === args.origin)
  const after = args.cursor === undefined ? catalog : catalogAfterCursor(catalog, args.cursor, args.origin)
  const items = after.slice(0, args.limit)
  const hasMore = after.length > items.length
  return {
    items,
    ...(hasMore && items.length > 0
      ? { nextCursor: encodeCursor(items[items.length - 1] as CatalogItem, args.origin) }
      : {}),
  }
}

async function assertImageCapability(
  options: CodexImageToolOptions,
  exec: ToolRunContext,
  settings: CodexImageSettings,
): Promise<CodexCredential> {
  if (!settings.enabled) throw new ImageCapabilityError('Image Creation is disabled in GPT Auth settings', 'IMAGE_DISABLED')
  const agent = requireAgent(exec)
  const request = agent.session.requestHeader()?.config
  const provider = request?.provider ?? agent.options.provider
  const model = request?.model ?? agent.options.model
  if (provider !== CODEX_ROUTE || typeof model !== 'string' || model.length === 0) {
    throw new ImageCapabilityError('Image tools require an Agent on the openai-codex route', 'IMAGE_MODEL_UNAVAILABLE')
  }
  const info = await options.resolveModelInfo(provider, model, exec.signal)
  if (info.inputModalities?.includes('image') !== true) {
    throw new ImageCapabilityError(`The selected model "${model}" does not declare image input`, 'IMAGE_MODEL_UNAVAILABLE')
  }
  const credential = await options.auth.credential(exec.signal)
  if (credential === undefined) {
    throw new ImageCapabilityError('Image Creation requires a usable Codex Login State; run `codex login`', 'CODEX_AUTH_REQUIRED')
  }
  if (credential.planType?.toLowerCase() === 'free') {
    throw new ImageCapabilityError('Image Creation is unavailable for the locally identified Free plan', 'IMAGE_PLAN_UNAVAILABLE')
  }
  return credential
}

async function resolveReferences(
  options: CodexImageToolOptions,
  references: readonly ImageReference[],
  exec: ToolRunContext,
): Promise<Array<{ stored: StoredImageAttachment }>> {
  if (references.length === 0) return []
  const limits = options.attachments.imageLimits
  if (references.length > limits.maxImagesPerMessage) {
    throw new ImageCapabilityError('Reference Images exceed the deployment image-count limit', 'IMAGE_REFERENCE_LIMIT')
  }
  const agent = requireAgent(exec)
  const authorized = new Map(collectSessionImages(agent).map(item => [item.handle, item.attachment]))
  const resolved: Array<{ stored: StoredImageAttachment }> = []
  let totalBytes = 0
  const accept = (stored: StoredImageAttachment): void => {
    if (totalBytes + stored.ref.bytes > limits.maxMessageImageBytes) {
      throw new ImageCapabilityError('Reference Images exceed the deployment total-byte limit', 'IMAGE_REFERENCE_LIMIT')
    }
    totalBytes += stored.ref.bytes
    resolved.push({ stored })
  }
  for (const reference of references) {
    if (reference.kind === 'session') {
      const attachment = authorized.get(reference.handle)
      if (attachment === undefined) {
        throw new ImageCapabilityError(
          `Image Handle ${JSON.stringify(reference.handle)} is not authorized by this session`,
          'IMAGE_REFERENCE_NOT_AUTHORIZED',
        )
      }
      const stored = await options.attachments.readImage(attachment, exec.signal)
      accept(stored)
      continue
    }
    if (/^https?:\/\//iu.test(reference.path)) {
      throw new ImageCapabilityError('HTTP(S) reference images are not supported; use a session handle or workspace path', 'IMAGE_REFERENCE_INVALID')
    }
    const cwd = agent.session.header.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new ImageCapabilityError('A workspace reference requires an active workspace', 'IMAGE_WORKSPACE_REQUIRED')
    }
    const root = await options.fs.resolve(cwd, { cwd, signal: exec.signal })
    const target = await options.fs.resolve(reference.path, { cwd, signal: exec.signal })
    if (!options.fs.contains(root, target)) {
      throw new ImageCapabilityError('The reference image must stay inside the active workspace', 'IMAGE_REFERENCE_OUTSIDE_WORKSPACE')
    }
    const data = await options.fs.readBytes(target, exec.signal, options.attachments.imageLimits.maxImageBytes)
    const mediaType = detectImageMediaType(data)
    if (mediaType === undefined || !options.attachments.imageLimits.mediaTypes.includes(mediaType)) {
      throw new ImageCapabilityError('The workspace reference is not a supported raster image', 'IMAGE_REFERENCE_INVALID')
    }
    const input: SaveImageAttachment = { data, mediaType, name: basename(reference.path) }
    await options.attachments.validateImage(input)
    if (totalBytes + data.byteLength > limits.maxMessageImageBytes) {
      throw new ImageCapabilityError('Reference Images exceed the deployment total-byte limit', 'IMAGE_REFERENCE_LIMIT')
    }
    const ref = await options.attachments.saveImage(input)
    accept({ ref, data })
  }
  return resolved
}

async function dispatchImageRequest(
  options: CodexImageToolOptions,
  endpoint: string,
  body: object,
  credential: CodexCredential,
  exec: ToolRunContext,
): Promise<unknown> {
  let response: Response
  try {
    response = await options.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        ...(credential.accountId === undefined ? {} : { 'chatgpt-account-id': credential.accountId }),
        'content-type': 'application/json',
        originator: 'dsh-codex-auth',
        'user-agent': 'dsh-codex-auth/0.1.0',
        'x-codex-image-turn-id': String(exec.rootCallId),
      },
      body: JSON.stringify(body),
      signal: exec.signal,
    })
  } catch {
    if (exec.signal.aborted) {
      throw new ImageCapabilityError(
        'Image Creation was cancelled locally; server-side cancellation is not guaranteed',
        'IMAGE_CANCELLED',
      )
    }
    throw new ImageCapabilityError('The image request failed before a response was received', 'IMAGE_NETWORK')
  }
  if (!response.ok) {
    try { await response.body?.cancel() } catch { /* best effort */ }
    throw new ImageCapabilityError(`Image Creation returned HTTP ${response.status}; the request was not retried`, 'IMAGE_UPSTREAM')
  }
  const maxBytes = imageEnvelopeLimit(options.attachments.imageLimits.maxImageBytes)
  const text = await readBoundedResponseText(response, maxBytes, exec.signal, {
    tooLarge: () => new ImageCapabilityError('Image Creation response exceeded the encoded size limit', 'IMAGE_RESPONSE_TOO_LARGE'),
    cancelled: () => new ImageCapabilityError(
      'Image Creation was cancelled locally; server-side cancellation is not guaranteed',
      'IMAGE_CANCELLED',
    ),
  })
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ImageCapabilityError('Image Creation returned an invalid JSON envelope', 'IMAGE_RESPONSE_INVALID')
  }
}

async function validateImageEnvelope(
  options: CodexImageToolOptions,
  value: unknown,
  expectedCount: number,
  referenceCount: number,
  referenceBytes: number,
): Promise<{
  created: number
  candidates: Array<{ index: number; input: SaveImageAttachment }>
  warnings: ImageWarning[]
}> {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.created)
    || (value.created as number) < 0
    || !Array.isArray(value.data)
    || value.data.length > MAX_GENERATED_IMAGES) {
    throw new ImageCapabilityError('Image Creation returned an unusable response envelope', 'IMAGE_RESPONSE_INVALID')
  }
  const warnings: ImageWarning[] = []
  const decoded: Array<{ index: number; input: SaveImageAttachment }> = []
  const limits = options.attachments.imageLimits
  const maxBytes = limits.maxImageBytes
  const maxEncoded = Math.ceil(maxBytes / 3) * 4 + 4
  const maxGeneratedCount = Math.max(0, limits.maxImagesPerMessage - referenceCount)
  let acceptedBytes = referenceBytes
  for (const [index, item] of value.data.entries()) {
    if (decoded.length >= maxGeneratedCount) {
      warnings.push({ index, code: 'IMAGE_POLICY_REJECTED', message: 'The item exceeded the deployment image-count limit.' })
      continue
    }
    if (!isRecord(item) || typeof item.b64_json !== 'string' || item.b64_json.length === 0) {
      warnings.push({ index, code: 'IMAGE_DATA_MISSING', message: 'The response item contained no image data.' })
      continue
    }
    if (item.b64_json.length > maxEncoded) {
      warnings.push({ index, code: 'IMAGE_DATA_TOO_LARGE', message: 'The encoded image exceeded the deployment byte limit.' })
      continue
    }
    const data = decodeBase64(item.b64_json)
    if (data === undefined || data.byteLength > maxBytes) {
      warnings.push({ index, code: 'IMAGE_DATA_INVALID', message: 'The response item was not valid bounded base64 image data.' })
      continue
    }
    if (acceptedBytes + data.byteLength > limits.maxMessageImageBytes) {
      warnings.push({ index, code: 'IMAGE_POLICY_REJECTED', message: 'The item exceeded the deployment total image-byte limit.' })
      continue
    }
    const mediaType = detectImageMediaType(data)
    if (mediaType === undefined || !options.attachments.imageLimits.mediaTypes.includes(mediaType)) {
      warnings.push({ index, code: 'IMAGE_MEDIA_INVALID', message: 'The decoded item was not a supported raster image.' })
      continue
    }
    const input: SaveImageAttachment = {
      data,
      mediaType,
      name: `generated-${String(value.created)}-${String(index + 1)}.${extensionFor(mediaType)}`,
    }
    try {
      await options.attachments.validateImage(input)
      acceptedBytes += data.byteLength
      decoded.push({ index, input })
    } catch {
      warnings.push({ index, code: 'IMAGE_POLICY_REJECTED', message: 'The decoded image failed the deployment media policy.' })
    }
  }
  for (let index = value.data.length; index < expectedCount; index += 1) {
    warnings.push({ index, code: 'IMAGE_DATA_MISSING', message: 'The backend returned no item for this requested image.' })
  }
  return { created: value.created as number, candidates: decoded, warnings }
}

function parseGenerateArgs(value: unknown, defaults: CodexImageSettings): GenerateImageArgs {
  if (!isRecord(value) || hasExtraKeys(value, ['prompt', 'references', 'model', 'n', 'size', 'quality', 'background'])) {
    throw new ImageCapabilityError('generate_image expects a closed object argument', 'INVALID_ARGS')
  }
  if (typeof value.prompt !== 'string' || value.prompt.trim().length === 0) {
    throw new ImageCapabilityError('generate_image requires a non-blank prompt', 'INVALID_ARGS')
  }
  const references = value.references === undefined ? [] : parseReferences(value.references)
  const model = value.model === undefined ? defaults.model : nonBlankString(value.model, 'model')
  const n = value.n === undefined ? defaults.n : boundedInteger(value.n, 1, MAX_GENERATED_IMAGES, 'n')
  const size = value.size === undefined ? defaults.size : enumValue(value.size, IMAGE_SIZES, 'size')
  const quality = value.quality === undefined ? defaults.quality : enumValue(value.quality, IMAGE_QUALITIES, 'quality')
  const background = value.background === undefined ? defaults.background : enumValue(value.background, IMAGE_BACKGROUNDS, 'background')
  return { prompt: value.prompt.trim(), references, model, n, size, quality, background }
}

function parseReferences(value: unknown): ImageReference[] {
  if (!Array.isArray(value) || value.length > MAX_REFERENCES) {
    throw new ImageCapabilityError(`references must be an array of at most ${String(MAX_REFERENCES)} items`, 'INVALID_ARGS')
  }
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.kind !== 'string') {
      throw new ImageCapabilityError(`references[${String(index)}] must be a discriminated object`, 'INVALID_ARGS')
    }
    if (item.kind === 'session' && !hasExtraKeys(item, ['kind', 'handle']) && typeof item.handle === 'string' && /^image:.+/u.test(item.handle)) {
      return { kind: 'session', handle: item.handle as ImageHandle }
    }
    if (item.kind === 'workspace' && !hasExtraKeys(item, ['kind', 'path']) && typeof item.path === 'string' && item.path.length > 0) {
      return { kind: 'workspace', path: item.path }
    }
    throw new ImageCapabilityError(`references[${String(index)}] is invalid`, 'INVALID_ARGS')
  })
}

function parseListArgs(value: unknown): { limit: number; cursor?: string; origin: ImageOriginFilter } {
  if (!isRecord(value) || hasExtraKeys(value, ['limit', 'cursor', 'origin'])) {
    throw new ImageCapabilityError('list_images expects a closed object argument', 'INVALID_ARGS')
  }
  const limit = value.limit === undefined ? 5 : boundedInteger(value.limit, 1, 10, 'limit')
  const cursor = value.cursor === undefined ? undefined : nonBlankString(value.cursor, 'cursor')
  const origin = value.origin === undefined ? 'all' : enumValue(value.origin, IMAGE_ORIGINS, 'origin')
  return { limit, ...(cursor === undefined ? {} : { cursor }), origin }
}

/** Scan only durable events belonging to the calling session; handles are not bearer capabilities. */
function collectSessionImages(agent: Agent): CatalogItem[] {
  const calls = new Map<string, string>()
  const catalog = new Map<string, CatalogItem>()
  for (const event of agent.session.events) {
    if (event.type === 'tool/call' && isRecord(event.data)) {
      if (typeof event.data.callId === 'string' && typeof event.data.name === 'string') calls.set(event.data.callId, event.data.name)
      continue
    }
    if (!Number.isSafeInteger(event.seq) || !Number.isFinite(event.time) || !isRecord(event.data)) continue
    let content: unknown
    let origin: CatalogItem['origin'] = 'reference'
    let generatedIds = new Set<string>()
    let referenceIds = new Set<string>()
    if (event.type === 'user/message') {
      content = event.data.content
      origin = 'user'
    } else if (event.type === 'assistant/message' && isRecord(event.data.message)) {
      content = event.data.message.content
    } else if (event.type === 'tool/result' && isRecord(event.data.message)) {
      content = event.data.message.content
      const callId = toolResultCallId(content)
      const toolName = callId === undefined ? undefined : calls.get(callId)
      if (toolName === LIST_IMAGES_TOOL_NAME) continue
      if (toolName === GENERATE_IMAGE_TOOL_NAME && isRecord(event.data.meta)) {
        generatedIds = idsFromMeta(event.data.meta.images)
        referenceIds = idsFromMeta(event.data.meta.references)
      }
      origin = toolName === GENERATE_IMAGE_TOOL_NAME ? 'generated' : 'reference'
    } else {
      continue
    }
    for (const attachment of imageAttachmentsIn(content)) {
      const id = String(attachment.attachmentId)
      if (catalog.has(id)) continue
      const itemOrigin: CatalogItem['origin'] = generatedIds.has(id)
        ? 'generated'
        : referenceIds.has(id)
          ? 'reference'
          : origin
      catalog.set(id, {
        handle: imageHandle(attachment),
        attachment,
        origin: itemOrigin,
        ...(attachment.name === undefined ? {} : { name: attachment.name }),
        width: attachment.width,
        height: attachment.height,
        creationSeq: event.seq,
        createdAt: event.time,
      })
    }
  }
  return [...catalog.values()].sort((left, right) => right.creationSeq - left.creationSeq
    || String(right.attachment.attachmentId).localeCompare(String(left.attachment.attachmentId)))
}

function idsFromMeta(value: unknown): Set<string> {
  const ids = new Set<string>()
  if (!Array.isArray(value)) return ids
  for (const item of value) {
    if (!isRecord(item) || !isRecord(item.attachment) || typeof item.attachment.attachmentId !== 'string') continue
    ids.add(item.attachment.attachmentId)
  }
  return ids
}

function toolResultCallId(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  for (const block of value) {
    if (isRecord(block) && block.type === 'tool-result' && typeof block.toolCallId === 'string') return block.toolCallId
  }
  return undefined
}

function imageAttachmentsIn(value: unknown): ImageAttachmentRef[] {
  const images: ImageAttachmentRef[] = []
  if (!Array.isArray(value)) return images
  const visit = (block: unknown): void => {
    if (!isRecord(block)) return
    if (block.type === 'image' && isImageAttachmentRef(block.attachment)) images.push(block.attachment)
    if (block.type === 'tool-result' && Array.isArray(block.content)) for (const nested of block.content) visit(nested)
  }
  for (const block of value) visit(block)
  return images
}

function isImageAttachmentRef(value: unknown): value is ImageAttachmentRef {
  return isRecord(value)
    && typeof value.attachmentId === 'string'
    && typeof value.mediaType === 'string'
    && typeof value.bytes === 'number'
    && typeof value.width === 'number'
    && typeof value.height === 'number'
}

function catalogAfterCursor(catalog: CatalogItem[], cursor: string, origin: ImageOriginFilter): CatalogItem[] {
  let decoded: unknown
  try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown } catch {
    throw new ImageCapabilityError('The image catalog cursor is invalid', 'IMAGE_CURSOR_INVALID')
  }
  if (!isRecord(decoded)
    || !Number.isSafeInteger(decoded.seq)
    || typeof decoded.id !== 'string'
    || decoded.origin !== origin) {
    throw new ImageCapabilityError('The image catalog cursor is invalid for this filter', 'IMAGE_CURSOR_INVALID')
  }
  const index = catalog.findIndex(item => item.creationSeq === decoded.seq && String(item.attachment.attachmentId) === decoded.id)
  if (index < 0) throw new ImageCapabilityError('The image catalog cursor no longer resolves in this session', 'IMAGE_CURSOR_INVALID')
  return catalog.slice(index + 1)
}

function encodeCursor(item: CatalogItem, origin: ImageOriginFilter): string {
  return Buffer.from(JSON.stringify({
    seq: item.creationSeq,
    id: String(item.attachment.attachmentId),
    origin,
  })).toString('base64url')
}

function renderGenerateResult(value: GenerateImageResult): ContentBlock[] {
  const handles = value.images.map(image => image.handle).join(', ')
  const warning = value.warnings.length === 0 ? '' : ` Warnings: ${String(value.warnings.length)}.`
  return [
    { type: 'text', text: `Created ${String(value.images.length)} durable image(s): ${handles}.${warning}` },
    ...value.references.map(reference => ({ type: 'image' as const, attachment: reference.attachment })),
    ...value.images.map(image => ({ type: 'image' as const, attachment: image.attachment })),
  ]
}

function renderCatalog(value: ListImagesResult): ContentBlock[] {
  const summary = value.items.length === 0
    ? 'No durable images matched this catalog page.'
    : `Session images: ${value.items.map(item => `${item.handle} (${item.origin})`).join(', ')}.`
  return [
    { type: 'text', text: summary },
    ...value.items.map(item => ({ type: 'image' as const, attachment: item.attachment })),
  ]
}

function dataUrl(stored: StoredImageAttachment): string {
  return `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
}

function imageHandle(ref: ImageAttachmentRef): ImageHandle {
  return `image:${String(ref.attachmentId)}`
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return undefined
  try { return new Uint8Array(Buffer.from(value, 'base64')) } catch { return undefined }
}

function detectImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 12 && ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP') return 'image/webp'
  if (data.length >= 6 && (ascii(data, 0, 6) === 'GIF87a' || ascii(data, 0, 6) === 'GIF89a')) return 'image/gif'
  return undefined
}

function ascii(data: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...data.slice(start, end))
}

function extensionFor(mediaType: ImageMediaType): string {
  return mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice('image/'.length)
}

function imageEnvelopeLimit(maxImageBytes: number): number {
  return Math.ceil(maxImageBytes / 3) * 4 * MAX_GENERATED_IMAGES + 128 * 1024
}

function requireAgent(exec: ToolRunContext): Agent {
  if (exec.agent === undefined) throw new ImageCapabilityError('Image tools require a calling Agent session', 'IMAGE_AGENT_REQUIRED')
  return exec.agent
}

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ImageCapabilityError(`${field} must be an integer from ${String(min)} through ${String(max)}`, 'INVALID_ARGS')
  }
  return value as number
}

function nonBlankString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ImageCapabilityError(`${field} must be a non-blank string`, 'INVALID_ARGS')
  }
  return value.trim()
}

function enumValue<const T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) {
    throw new ImageCapabilityError(`${field} must be one of ${choices.join(', ')}`, 'INVALID_ARGS')
  }
  return value as T
}

function hasExtraKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).some(key => !allowed.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class ImageCapabilityError extends HarnessError {}

const attachmentSchema = {
  type: 'object' as const,
  properties: {
    attachmentId: { type: 'string' as const },
    mediaType: { type: 'string' as const, enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' as const },
    width: { type: 'integer' as const },
    height: { type: 'integer' as const },
    name: { type: 'string' as const },
  },
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  additionalProperties: false,
}

const canonicalItemSchema = {
  type: 'object' as const,
  properties: {
    handle: { type: 'string' as const },
    attachment: attachmentSchema,
    origin: { type: 'string' as const, enum: ['generated', 'reference', 'user'] },
  },
  required: ['handle', 'attachment', 'origin'],
  additionalProperties: false,
}

const warningSchema = {
  type: 'object' as const,
  properties: {
    index: { type: 'integer' as const },
    code: { type: 'string' as const },
    message: { type: 'string' as const },
  },
  required: ['index', 'code', 'message'],
  additionalProperties: false,
}

const generateOutputSchema = {
  type: 'object' as const,
  properties: {
    operation: { type: 'string' as const, enum: ['generate', 'edit'] },
    created: { type: 'integer' as const },
    images: { type: 'array' as const, items: canonicalItemSchema },
    references: { type: 'array' as const, items: canonicalItemSchema },
    warnings: { type: 'array' as const, items: warningSchema },
  },
  required: ['operation', 'created', 'images', 'references', 'warnings'],
  additionalProperties: false,
}

const catalogItemSchema = {
  type: 'object' as const,
  properties: {
    ...canonicalItemSchema.properties,
    name: { type: 'string' as const },
    width: { type: 'integer' as const },
    height: { type: 'integer' as const },
    creationSeq: { type: 'integer' as const },
    createdAt: { type: 'number' as const },
  },
  required: [...canonicalItemSchema.required, 'width', 'height', 'creationSeq', 'createdAt'],
  additionalProperties: false,
}

const listOutputSchema = {
  type: 'object' as const,
  properties: {
    items: { type: 'array' as const, items: catalogItemSchema },
    nextCursor: { type: 'string' as const },
  },
  required: ['items'],
  additionalProperties: false,
}

/** Cordis plugin name for the independent Image row. */
export const name = 'codex-image'
export const inject = ['tools', 'llm', 'agents', 'attachments', 'fs', 'codexAuth']

/**
 * Register image tools only in currently eligible Agent scopes. Eligibility is
 * re-evaluated for live settings, auth facts, adapter changes, and request-route
 * snapshots; every Tool body repeats the exact guard as the authorization edge.
 */
export function apply(ctx: Context, config: Config): void {
  const auth = ctx.get('codexAuth') as CodexAuthService | undefined
  if (auth === undefined) throw new Error('codex-image: shared codexAuth service is unavailable')
  let current = (): CodexImageSettings => config
  const registrations = new Map<Agent, () => void>()
  const generations = new Map<Agent, number>()
  let disposed = false
  const options: CodexImageToolOptions = {
    auth,
    settings: () => current(),
    attachments: ctx.attachments,
    fs: ctx.fs,
    resolveModelInfo: async (provider, model, signal) => ctx.llm.resolveModelInfo(provider, model, signal),
    fetchImpl: fetch,
  }
  const definitions = createCodexImageTools(options)

  const refreshAgent = async (agent: Agent, route?: LlmCallConfig): Promise<void> => {
    if (disposed) return
    const generation = (generations.get(agent) ?? 0) + 1
    generations.set(agent, generation)
    const eligible = await isAgentEligible(ctx, auth, current(), agent, route)
    if (disposed || generations.get(agent) !== generation) return
    const registered = registrations.get(agent)
    if (!eligible) {
      registered?.()
      registrations.delete(agent)
      return
    }
    if (registered !== undefined) return
    const disposers = definitions.map(definition => agent.ctx.tools.register(definition))
    registrations.set(agent, () => { for (const dispose of disposers.reverse()) dispose() })
  }
  const refreshAll = (): void => {
    for (const agent of ctx.agents.list()) void refreshAgent(agent)
  }

  ctx.effect(() => () => {
    disposed = true
    for (const dispose of registrations.values()) dispose()
    registrations.clear()
    generations.clear()
  }, 'codex-image: scoped tool cleanup')

  installSettingsSection(ctx, CODEX_IMAGE_SETTINGS_NAMESPACE, Config, config, {
    setSource: source => { current = source },
    onChange: refreshAll,
  })
  ctx.on('agent/created', ({ agent }) => { void refreshAgent(agent) })
  ctx.on('agent/request', async ({ agent }, next) => {
    const route = await next()
    await refreshAgent(agent, route)
    return route
  })
  ctx.on('agent/disposed', ({ agent }) => {
    generations.delete(agent)
    registrations.get(agent)?.()
    registrations.delete(agent)
  })
  ctx.on('llm/adapters-updated', refreshAll)
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'request/header') return
    const agent = ctx.agents.get(session.id)
    if (agent !== undefined) void refreshAgent(agent)
  })
  ctx.effect(() => auth.watchStatus(refreshAll), 'codex-image: auth eligibility')
  void auth.status().finally(refreshAll)
  refreshAll()
}

async function isAgentEligible(
  ctx: Context,
  auth: CodexAuthService,
  settings: CodexImageSettings,
  agent: Agent,
  route?: LlmCallConfig,
): Promise<boolean> {
  if (!settings.enabled) return false
  const request = route ?? agent.session.requestHeader()?.config
  const provider = request?.provider ?? agent.options.provider
  const model = request?.model ?? agent.options.model
  if (provider !== CODEX_ROUTE || typeof model !== 'string' || model.length === 0) return false
  const status = await auth.status()
  if (!status.configured || status.planType?.toLowerCase() === 'free') return false
  try {
    const info = await ctx.llm.resolveModelInfo(provider, model)
    return info.inputModalities?.includes('image') === true
  } catch {
    return false
  }
}
