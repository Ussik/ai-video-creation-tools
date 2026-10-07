import { useEffect, useRef, useState } from 'react'

export function useScriptDocumentNavigation<Section extends string>({
  documentId, initialSection, defaultSection,
}: { documentId: string; initialSection?: Section; defaultSection: Section }) {
  const [activeSection, setActiveSection] = useState<Section>(initialSection || defaultSection)
  const editorRef = useRef<HTMLElement | null>(null)
  const navigationFrameRef = useRef<number | null>(null)
  const pendingScrollRef = useRef<{ top: number | null } | null>(null)

  function selectSection(section: Section, resetDocument = false) {
    if (navigationFrameRef.current !== null) window.cancelAnimationFrame(navigationFrameRef.current)
    pendingScrollRef.current = { top: null }
    setActiveSection(section)
    navigationFrameRef.current = window.requestAnimationFrame(() => {
      navigationFrameRef.current = null
      const editor = editorRef.current
      const sections = Array.from(editor?.querySelectorAll<HTMLElement>('[data-script-section]') || [])
      const target = sections.find(element => element.dataset.scriptSection === section)
      if (!editor || !target) {
        pendingScrollRef.current = null
        return
      }
      const requestedTop = resetDocument || sections.length === 1 ? 0
        : editor.scrollTop + target.getBoundingClientRect().top - editor.getBoundingClientRect().top - 16
      const top = Math.min(Math.max(0, requestedTop), Math.max(0, editor.scrollHeight - editor.clientHeight))
      pendingScrollRef.current = Math.abs(editor.scrollTop - top) <= 1 ? null : { top }
      // Scroll only the document, preserving the fixed toolbar and directory.
      editor.scrollTo({ top, behavior: 'smooth' })
    })
  }

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    let scrollFrame: number | null = null
    const onScroll = () => {
      const pending = pendingScrollRef.current
      if (pending) {
        // Keep a clicked item selected while smooth scrolling passes other headings.
        if (pending.top !== null && Math.abs(editor.scrollTop - pending.top) <= 1) pendingScrollRef.current = null
        return
      }
      if (scrollFrame !== null) return
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = null
        if (pendingScrollRef.current) return
        const sections = Array.from(editor.querySelectorAll<HTMLElement>('[data-script-section]'))
        const readingTop = editor.getBoundingClientRect().top + 18
        let section: HTMLElement | undefined = sections[0]
        for (const candidate of sections) {
          if (candidate.getBoundingClientRect().top > readingTop) break
          section = candidate
        }
        if (editor.scrollTop > 0 && editor.scrollTop + editor.clientHeight >= editor.scrollHeight - 1) section = sections.at(-1)
        if (section?.dataset.scriptSection) setActiveSection(section.dataset.scriptSection as Section)
      })
    }
    const interruptNavigation = () => {
      if (!pendingScrollRef.current) return
      pendingScrollRef.current = null
      if (navigationFrameRef.current !== null) {
        window.cancelAnimationFrame(navigationFrameRef.current)
        navigationFrameRef.current = null
      }
      editor.scrollTo({ top: editor.scrollTop, behavior: 'instant' })
      onScroll()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) interruptNavigation()
    }
    editor.addEventListener('scroll', onScroll, { passive: true })
    editor.addEventListener('wheel', interruptNavigation, { passive: true })
    editor.addEventListener('touchstart', interruptNavigation, { passive: true })
    editor.addEventListener('pointerdown', interruptNavigation)
    editor.addEventListener('keydown', onKeyDown)
    return () => {
      editor.removeEventListener('scroll', onScroll)
      editor.removeEventListener('wheel', interruptNavigation)
      editor.removeEventListener('touchstart', interruptNavigation)
      editor.removeEventListener('pointerdown', interruptNavigation)
      editor.removeEventListener('keydown', onKeyDown)
      if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame)
      if (navigationFrameRef.current !== null) window.cancelAnimationFrame(navigationFrameRef.current)
      navigationFrameRef.current = null
      pendingScrollRef.current = null
    }
  }, [documentId])

  useEffect(() => {
    if (initialSection) selectSection(initialSection)
  }, [initialSection, documentId])

  return { activeSection, editorRef, selectSection }
}
