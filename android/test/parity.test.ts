import { describe, expect, test } from 'bun:test';
import { entryFromFile, parseFrontmatter } from '../src/lib/format';
import { blockImage, fitImage, imageRelCandidates, resolveImage, splitImages, vaultFileUri } from '../src/lib/mdimages';
import { relinkAfterRename } from '../src/lib/relink';

const stat = { size: 1, mtime: 1 };

describe('front matter: titles + tags (Mac parity)', () => {
  test('front matter `title:` is the display title, then # H1, then first line', () => {
    expect(entryFromFile('a.md', '---\ntitle: "Trip: Japan"\n---\n# Draft\n\nbody\n', stat).title).toBe('Trip: Japan');
    expect(entryFromFile('a.md', "---\ntitle: 'It''s here'\n---\nbody\n", stat).title).toBe("It's here");
    expect(entryFromFile('a.md', '---\nid: n1\n---\n# Heading\n\nbody\n', stat).title).toBe('Heading');
    expect(entryFromFile('a.md', 'just text\nmore\n', stat).title).toBe('just text');
  });

  test('tags: inline, YAML block list, scalar', () => {
    expect(entryFromFile('a.md', '---\ntags: [a, b]\n---\nx\n', stat).tags).toEqual(['a', 'b']);
    expect(entryFromFile('a.md', '---\ntags:\n  - work\n  - "trip plans"\n- top\n---\nx\n', stat).tags).toEqual(['work', 'trip-plans', 'top']);
    expect(entryFromFile('a.md', '---\ntags: a, b\n---\nx\n', stat).tags).toEqual(['a', 'b']);
    expect(entryFromFile('a.md', 'no front matter\n', stat).tags).toEqual([]);
  });

  test('block lists parse as arrays; nested lines are never read as keys', () => {
    const [fm, body] = parseFrontmatter('---\nid: n1\nassets:\n  - assets/a.png\n  - assets/b.m4a\nmeta:\n  url: http://x\nstatus: ready\n---\nbody\n');
    expect(fm).toEqual({ id: 'n1', assets: ['assets/a.png', 'assets/b.m4a'], meta: '', status: 'ready' });
    expect(body).toBe('body\n');
  });

  test('list snippet drops image refs', () => {
    expect(entryFromFile('a.md', '# T\n\n![cat|300](assets/c.png)\nhello ![[x.png]] world\n', stat).snippet).toBe('hello  world');
  });
});

describe('images', () => {
  test('block vs inline refs, sizes, embeds', () => {
    expect(blockImage('![cat|300](assets/2026/10/c.png)')).toEqual({ t: 'img', alt: 'cat', src: 'assets/2026/10/c.png', embed: false, width: 300 });
    expect(blockImage('  ![[photo.jpg|200x100]] ')).toEqual({ t: 'img', alt: 'photo', src: 'photo.jpg', embed: true, width: 200, height: 100 });
    expect(blockImage('![[photo.jpg|my cat|250]]')).toEqual({ t: 'img', alt: 'my cat', src: 'photo.jpg', embed: true, width: 250 });
    expect(blockImage('see ![](a.png)')).toBeNull();
    expect(splitImages('a ![x|50](p.png) b ![[q.png]]')).toEqual([
      { t: 'text', text: 'a ' },
      { t: 'img', alt: 'x', src: 'p.png', embed: false, width: 50 },
      { t: 'text', text: ' b ' },
      { t: 'img', alt: 'q', src: 'q.png', embed: true }
    ]);
    expect(splitImages('no images [link](x.md)')).toEqual([{ t: 'text', text: 'no images [link](x.md)' }]);
  });

  test('markdown refs resolve like the Mac: vault-rooted, note-relative, ../', () => {
    expect(imageRelCandidates('assets/a.png', 'work/n.md')).toEqual(['assets/a.png', 'work/assets/a.png']);
    expect(imageRelCandidates('./pic%20one.png', 'work/sub/n.md')).toEqual(['work/sub/pic one.png', 'pic one.png']);
    expect(imageRelCandidates('../assets/x.png', 'work/n.md')).toEqual(['assets/x.png']);
    const files = ['work/assets/a.png', 'assets/b.png'];
    expect(resolveImage({ src: 'assets/a.png', embed: false }, 'work/n.md', files)).toEqual({ kind: 'vault', rel: 'work/assets/a.png' });
    expect(resolveImage({ src: 'assets/b.png', embed: false }, 'work/n.md', files)).toEqual({ kind: 'vault', rel: 'assets/b.png' });
    expect(resolveImage({ src: 'https://x.y/z.png', embed: false }, 'a.md', files)).toEqual({ kind: 'remote', uri: 'https://x.y/z.png' });
    // Not synced yet: the Mac's first choice.
    expect(resolveImage({ src: 'assets/new.png', embed: false }, 'a.md', [])).toEqual({ kind: 'vault', rel: 'assets/new.png' });
  });

  test('![[embeds]] resolve by name: same folder first, then shortest path', () => {
    const files = ['assets/2026/10/photo.png', 'work/photo.png', 'z/deep/er/photo.png', 'Pics/Cat.PNG'];
    expect(resolveImage({ src: 'photo.png', embed: true }, 'work/n.md', files)).toEqual({ kind: 'vault', rel: 'work/photo.png' });
    expect(resolveImage({ src: 'photo.png', embed: true }, 'personal/n.md', files)).toEqual({ kind: 'vault', rel: 'work/photo.png' });
    expect(resolveImage({ src: 'cat.png', embed: true }, 'a.md', files)).toEqual({ kind: 'vault', rel: 'Pics/Cat.PNG' });
    expect(resolveImage({ src: 'assets/2026/10/photo.png', embed: true }, 'a.md', files)).toEqual({ kind: 'vault', rel: 'assets/2026/10/photo.png' });
    expect(resolveImage({ src: 'missing.png', embed: true }, 'a.md', files)).toBeNull();
  });

  test('file uri + sizing', () => {
    expect(vaultFileUri('file:///data/files/inkfish/vault/', 'assets/a b#1.png')).toBe('file:///data/files/inkfish/vault/assets/a%20b%231.png');
    expect(fitImage({ w: 1000, h: 500 }, {}, 340)).toEqual({ width: 340, height: 170 });
    expect(fitImage({ w: 1000, h: 500 }, { width: 300 }, 340)).toEqual({ width: 300, height: 150 });
    expect(fitImage({ w: 100, h: 50 }, {}, 340)).toEqual({ width: 100, height: 50 });
    expect(fitImage(null, { width: 300, height: 100 }, 340)).toEqual({ width: 300, height: 100 });
    expect(fitImage(null, { width: 600, height: 200 }, 300)).toEqual({ width: 300, height: 100 });
  });
});

describe('phone rename relinks other notes (shared Mac logic)', () => {
  const notes = [
    { path: 'work/Groceries.md', text: '# Groceries\n' },
    { path: 'work/Plan.md', text: 'see [[Untitled]] and [[Untitled|the list]] and [[work/Untitled#Top]]\n' },
    { path: 'personal/Links.md', text: 'md link [list](../work/Untitled.md)\n```\n[[Untitled]] in code\n```\n' },
    { path: 'other.md', text: 'nothing here\n' }
  ];
  const exists = (rel: string): boolean => notes.some((n) => n.path === rel);

  test('wikilinks (bare, alias, heading, path) + relative markdown links, not in code', () => {
    const out = relinkAfterRename(notes, 'work/Untitled.md', 'work/Groceries.md', exists);
    expect(out).toEqual([
      { path: 'work/Plan.md', text: 'see [[Groceries]] and [[Groceries|the list]] and [[work/Groceries#Top]]\n' },
      { path: 'personal/Links.md', text: 'md link [list](../work/Groceries.md)\n```\n[[Untitled]] in code\n```\n' }
    ]);
  });

  test('bare [[Old]] is left alone when another note still has that name', () => {
    const withTwin = [...notes, { path: 'personal/Untitled.md', text: '' }];
    const out = relinkAfterRename(withTwin, 'work/Untitled.md', 'work/Groceries.md', (r) => withTwin.some((n) => n.path === r));
    expect(out.find((n) => n.path === 'work/Plan.md')?.text).toBe('see [[Untitled]] and [[Untitled|the list]] and [[work/Groceries#Top]]\n');
  });
});
