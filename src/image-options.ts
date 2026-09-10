/** Credential-free image parameter contract shared by Host and settings UI. */
export const IMAGE_MODELS = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2'] as const
export const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ImageQuality = (typeof IMAGE_QUALITIES)[number]
export const IMAGE_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'] as const
export type ImageSize = 'auto' | `${number}x${number}`

export function isImageSize(value: unknown): value is ImageSize {
  if (value === 'auto') return true
  if (typeof value !== 'string' || !/^[1-9]\d{0,3}x[1-9]\d{0,3}$/u.test(value)) return false
  const [width = 0, height = 0] = value.split('x').map(Number)
  return width % 16 === 0 && height % 16 === 0
    && width <= 3840 && height <= 3840
    && width <= height * 3 && height <= width * 3
    && width * height >= 655_360 && width * height <= 8_294_400
}

export function supportsImageSize(model: string, size: ImageSize): boolean {
  return IMAGE_SIZES.some(preset => preset === size) || supportsImage25Options(model)
}

export function supportsImage25Options(model: string): boolean {
  return model === 'gpt-image-2.5-sunburst' || model === 'gpt-image-2.5-flare'
}

export function supportsImageQuality(model: string, quality: ImageQuality): boolean {
  return (quality !== 'xhigh' && quality !== 'max') || supportsImage25Options(model)
}
