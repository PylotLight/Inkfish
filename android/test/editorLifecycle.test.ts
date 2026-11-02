import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

const storeSource = readFileSync(new URL('../src/lib/store.tsx', import.meta.url), 'utf8')
const editorSource = readFileSync(new URL('../src/screens/EditorScreen.tsx', import.meta.url), 'utf8')

describe('Android editor note loading lifecycle', () => {
  test('autosave note-list updates do not replace the loader and remount the focused editor', () => {
    // EditorScreen's initial load effect depends on openNote. A new inline
    // function whenever StoreProvider rebuilds its value would rerun that
    // effect, set loading=true, and unmount CodeMirror after autosave.
    expect(storeSource).toMatch(/const openNote = useCallback\(\s*\(id: string\) => vault\.getNote\(id\),\s*\[\]\s*\)/)
    expect(storeSource).toMatch(/openNote,\s*\n\s*saveNote: async/)
    expect(storeSource).toMatch(/days,\s*\n\s*openNote,\s*\n\s*refresh,/)
    expect(editorSource).toMatch(
      /setLoading\(true\)[\s\S]*?void openNote\(noteId\)\.then\([\s\S]*?\}, \[noteId, openNote\]\)/
    )
  })
})
