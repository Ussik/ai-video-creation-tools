export const SKILLS_LIBRARY_CHANGED = 'skills-library-changed'

export function notifySkillsLibraryChanged() {
  window.dispatchEvent(new Event(SKILLS_LIBRARY_CHANGED))
}
