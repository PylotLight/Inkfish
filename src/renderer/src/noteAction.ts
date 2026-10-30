/**
 * Commands aimed at the open NoteEditor: the ⋯ menu in the note header (and any other
 * renderer-side sender) dispatches these; the NoteEditor on screen subscribes and runs them.
 * Mirror of the main→renderer `inkfish:find` IPC for renderer-originated triggers.
 */
export type NoteAction = 'find' | 'history'
export const NOTE_ACTION_EVENT = 'inkfish:note-action'
export function sendNoteAction(action: NoteAction): void {
  window.dispatchEvent(new CustomEvent<NoteAction>(NOTE_ACTION_EVENT, { detail: action }))
}
