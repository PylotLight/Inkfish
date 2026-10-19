import { describe, expect, test } from 'bun:test';
import { plan, type Base, type Manifest } from '../../src/shared/sync';

/**
 * The phone runs the shared planner against the Mac. These pin how recent Mac
 * file operations (#70 sidebar rename/delete/undo, #72 filename follows title,
 * #68 Move to…) land on the phone: as moves/deletes/pulls, never duplicates.
 */
const e = (hash: string): Manifest[string] => ({ hash, size: 1, mtime: 1 });

describe('Mac file operations as seen by the phone', () => {
  test('#70 sidebar rename / #68 move (content unchanged) → one moveLocal', () => {
    const base: Base = { 'work/Untitled.md': 'h1' };
    const local: Manifest = { 'work/Untitled.md': e('h1') };
    const remote: Manifest = { 'personal/Groceries.md': e('h1') };
    expect(plan(local, remote, base)).toEqual([{ op: 'moveLocal', from: 'work/Untitled.md', to: 'personal/Groceries.md' }]);
  });

  test('#72 title edit renames + changes content → delete old + pull new, no duplicate', () => {
    const base: Base = { 'work/Untitled.md': 'h1' };
    const local: Manifest = { 'work/Untitled.md': e('h1') };
    const remote: Manifest = { 'work/Groceries.md': e('h2') };
    const ops = plan(local, remote, base);
    expect(ops).toContainEqual({ op: 'deleteLocal', path: 'work/Untitled.md' });
    expect(ops).toContainEqual({ op: 'pull', path: 'work/Groceries.md', hash: 'h2' });
    expect(ops).toHaveLength(2);
  });

  test('#70 delete (Mac app trash is outside the vault) → deleteLocal; undo before sync → nothing', () => {
    const base: Base = { 'a.md': 'h1' };
    expect(plan({ 'a.md': e('h1') }, {}, base)).toEqual([{ op: 'deleteLocal', path: 'a.md' }]);
    expect(plan({ 'a.md': e('h1') }, { 'a.md': e('h1') }, base)).toEqual([]);
  });

  test('#70 restore after the delete synced → pulled back once (incl. a "(restored)" name)', () => {
    expect(plan({}, { 'a (restored).md': e('h1') }, {})).toEqual([{ op: 'pull', path: 'a (restored).md', hash: 'h1' }]);
  });

  test('case-only title rename (autoRenameTarget allows it) → moveLocal', () => {
    const base: Base = { 'groceries.md': 'h1' };
    expect(plan({ 'groceries.md': e('h1') }, { 'Groceries.md': e('h1') }, base)).toEqual([
      { op: 'moveLocal', from: 'groceries.md', to: 'Groceries.md' }
    ]);
  });
});
