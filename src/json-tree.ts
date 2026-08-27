/** Shared structural validation for detached JSON-shaped Host state. */

export interface PlainJsonTreeOptions {
  /** pi-ai leaves optional object properties undefined until JSON.stringify. */
  readonly allowUndefinedObjectProperties?: boolean
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
