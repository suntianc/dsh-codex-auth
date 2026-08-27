/** Shared structural validation for detached JSON-shaped Host state. */

const TEXT_ENCODER = new TextEncoder()

export interface PlainJsonTreeOptions {
  /** pi-ai leaves optional object properties undefined until JSON.stringify. */
  readonly allowUndefinedObjectProperties?: boolean
}

/** Narrow one value to the plain string-keyed record shape used by JSON trees. */
export function isPlainRecord<Value>(
  value: Value,
): value is Value & Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/** Measure UTF-8 bytes without relying on JavaScript code-unit length. */
export function utf8ByteLength(value: string): number {
  return TEXT_ENCODER.encode(value).byteLength
}

/** Measure the UTF-8 bytes of the JSON wire representation. */
export function serializedJsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? 0 : utf8ByteLength(serialized)
}

/**
 * Whether a value is a cycle-free tree of plain data properties that JSON can
 * serialize without invoking accessors or rewriting numbers/array holes.
 */
export function isPlainJsonTree(
  value: unknown,
  options: PlainJsonTreeOptions = {},
): boolean {
  return visit(value, options.allowUndefinedObjectProperties === true, new WeakSet())
}

function visit(
  value: unknown,
  allowUndefinedObjectProperties: boolean,
  ancestors: WeakSet<object>,
): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (typeof value !== 'object' || ancestors.has(value)) return false
  ancestors.add(value)
  const valid = Array.isArray(value)
    ? validArray(value, allowUndefinedObjectProperties, ancestors)
    : validRecord(value, allowUndefinedObjectProperties, ancestors)
  ancestors.delete(value)
  return valid
}

function validArray(
  value: unknown[],
  allowUndefinedObjectProperties: boolean,
  ancestors: WeakSet<object>,
): boolean {
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) return false
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index]
    if (descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
      || !visit(descriptor.value, allowUndefinedObjectProperties, ancestors)) return false
  }
  return true
}

function validRecord(
  value: object,
  allowUndefinedObjectProperties: boolean,
  ancestors: WeakSet<object>,
): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') return false
    const descriptor = descriptors[key]
    if (descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')) return false
    if (descriptor.value === undefined && allowUndefinedObjectProperties) continue
    if (!visit(descriptor.value, allowUndefinedObjectProperties, ancestors)) return false
  }
  return true
}
