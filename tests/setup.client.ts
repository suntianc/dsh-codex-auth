import { createElement } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { vi } from 'vitest'

interface MockButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode
  variant?: string
}

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, icon, variant: _variant, ...props }: MockButtonProps) =>
    createElement('button', props, icon, children),
  IconRefreshOutline16: ({ className }: { className?: string }) =>
    createElement('span', { 'aria-hidden': true, className }),
  IconWarningOutline16: ({ className }: { className?: string }) =>
    createElement('span', { 'aria-hidden': true, className }),
  StateDot: ({ state }: { state: string }) =>
    createElement('span', { 'aria-label': state }),
}))
