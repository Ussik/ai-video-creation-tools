import assert from 'node:assert/strict'
import { act } from 'react'

/** Exercise the real combobox option path instead of mutating a native select. */
export async function chooseCombobox(field: HTMLInputElement, label: string) {
  await act(() => field.click())
  const list = document.getElementById(field.getAttribute('aria-controls') || '')
  assert.ok(list, 'opened combobox controls its own listbox')
  const option = [...list.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent === label)
  assert.ok(option, `combobox option: ${label}`)
  await act(() => option.click())
}
