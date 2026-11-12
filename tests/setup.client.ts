import { createElement } from 'react'
import { createPortal } from 'react-dom'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { vi } from 'vitest'

interface MockButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode
  variant?: string
  size?: string
}

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Modal: ({ open, onClose, title, closeLabel, description, children, footer }: { open: boolean; onClose: () => void; title: string; closeLabel: string; description?: string; children?: ReactNode; footer?: ReactNode }) => open
    ? createPortal(createElement('section', { role: 'dialog', 'aria-label': title },
        createElement('h2', null, title), createElement('p', null, description),
        createElement('button', { onClick: onClose, 'aria-label': closeLabel }, closeLabel), children, footer), document.body)
    : null,
  Button: ({ children, icon, variant: _variant, size: _size, ...props }: MockButtonProps) =>
    createElement('button', props, icon, children),
  IconChevronDownOutlineMedium: ({ className }: { className?: string }) =>
    createElement('span', { 'aria-hidden': true, className }),
  IconRefreshOutlineMedium: ({ className }: { className?: string }) =>
    createElement('span', { 'aria-hidden': true, className }),
  IconWarningOutlineMedium: ({ className }: { className?: string }) =>
    createElement('span', { 'aria-hidden': true, className }),
  StateDot: ({ state }: { state: string }) =>
    createElement('span', { 'aria-label': state }),
}))
