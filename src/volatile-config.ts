import type { Volatile } from '@deepseek-ai/cordis'

/** Accept direct fixture values and live values supplied by the DSH Loader. */
export type LiveValue<T> = T | Volatile<T>

export function liveValue<T>(value: LiveValue<T>): T {
  return typeof value === 'object' && value !== null && 'get' in value
    ? (value as Volatile<T>).get() as T
    : value as T
}
