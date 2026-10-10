import { useEffect, useRef, useState, useMemo } from 'react'
import { searchScriptDocuments, type ScriptSearchDocument, type ScriptSearchMatch } from './script-document-search'

export function useScriptDocumentSearch(documents: ScriptSearchDocument[], onNavigate: (match: ScriptSearchMatch) => void) {
  const [opened, setOpened] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [navigation, setNavigation] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const navigateRef = useRef(onNavigate)
  navigateRef.current = onNavigate
  const matches = useMemo(() => opened ? searchScriptDocuments(documents, query) : [], [documents, query, opened])
  const activeIndex = Math.min(index, Math.max(0, matches.length - 1))
  const activeMatch = matches[activeIndex] || null

  useEffect(() => {
    if (activeMatch) navigateRef.current(activeMatch)
  }, [opened, query, activeMatch?.documentId, activeMatch?.from, activeMatch?.to, navigation])

  useEffect(() => {
    if (opened) { inputRef.current?.focus(); inputRef.current?.select() }
  }, [opened])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Leave browser find and Escape to any dialog currently above the editor.
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !event.altKey) {
        event.preventDefault()
        open()
      } else if (event.key === 'Escape' && opened && !event.isComposing) {
        event.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [opened])

  function open() {
    if (!opened) previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setOpened(true)
    inputRef.current?.focus()
    inputRef.current?.select()
  }

  function close() {
    const previous = previousFocusRef.current
    const target = previous?.isConnected ? previous
      : document.querySelector<HTMLElement>('[data-script-search-active]')?.closest<HTMLElement>('[contenteditable]')
    setOpened(false)
    target?.focus({ preventScroll: true })
  }

  function changeQuery(value: string) {
    setQuery(value)
    setIndex(0)
  }

  function move(direction: 1 | -1) {
    if (!matches.length) return
    setIndex((activeIndex + direction + matches.length) % matches.length)
    // A single result can still be located again after manual navigation.
    setNavigation(value => value + 1)
  }

  return {
    opened, query, matches, activeIndex, activeMatch, inputRef,
    open, close, changeQuery, move,
  }
}
