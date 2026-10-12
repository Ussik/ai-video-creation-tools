import { ActionIcon, Tooltip, useComputedColorScheme, useMantineColorScheme } from '@mantine/core'
import { Moon, Sun } from 'lucide-react'
import type { MouseEvent } from 'react'
import { flushSync } from 'react-dom'

export default function ThemeToggle() {
  const colorScheme = useComputedColorScheme('dark')
  const { setColorScheme } = useMantineColorScheme()
  const nextScheme = colorScheme === 'dark' ? 'light' : 'dark'
  const label = nextScheme === 'light' ? '切换到浅色模式' : '切换到深色模式'
  const icon = nextScheme === 'light' ? <Sun size={18} /> : <Moon size={18} />

  function switchTheme(event: MouseEvent<HTMLButtonElement>) {
    const root = document.documentElement
    // All theme controls share this guard, including controls rendered in portals.
    if (root.hasAttribute('data-theme-transition')) return
    if (typeof document.startViewTransition !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setColorScheme(nextScheme)
      return
    }

    const bounds = event.currentTarget.getBoundingClientRect()
    const x = bounds.left + bounds.width / 2
    const y = bounds.top + bounds.height / 2
    const radius = Math.ceil(Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)))
    root.style.setProperty('--theme-reveal-x', `${x}px`)
    root.style.setProperty('--theme-reveal-y', `${y}px`)
    root.style.setProperty('--theme-reveal-radius', `${radius}px`)
    root.setAttribute('data-theme-transition', nextScheme === 'light' ? 'expand' : 'contract')
    const cleanup = () => {
      root.removeAttribute('data-theme-transition')
      for (const property of ['--theme-reveal-x', '--theme-reveal-y', '--theme-reveal-radius']) root.style.removeProperty(property)
    }

    try {
      const transition = document.startViewTransition(() => {
        // Capture the new palette and icons together without remounting the workspace.
        flushSync(() => setColorScheme(nextScheme))
      })
      void transition.ready.catch(() => {})
      void transition.finished.then(cleanup, cleanup)
    } catch {
      cleanup()
      setColorScheme(nextScheme)
    }
  }

  return <Tooltip label={label} position="bottom-end">
    <ActionIcon className="theme-toggle" variant="subtle" aria-label={label} onClick={switchTheme}>{icon}</ActionIcon>
  </Tooltip>
}
