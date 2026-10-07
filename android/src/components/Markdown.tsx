import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import { useTheme, type AppTheme } from '../theme';

/** Tiny markdown renderer — headings, bold, bullets, code fences, images. No deps. */
export function Markdown({ text }: { text: string }): React.JSX.Element {
  const blocks = useMemo(() => parse(text), [text]);
  const t = useTheme();
  return (
    <View>
      {blocks.map((b, i) => (
        <Block key={i} block={b} md={t.md} />
      ))}
    </View>
  );
}

type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'li'; text: string }
  | { t: 'code'; text: string }
  | { t: 'img'; alt: string; src: string }
  | { t: 'task'; done: boolean; text: string }
  | { t: 'quote'; text: string }
  | { t: 'hr' }
  | { t: 'gap' };

function parse(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.split('\n');
  let code: string[] | null = null;
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (code) {
        out.push({ t: 'code', text: code.join('\n') });
        code = null;
      } else code = [];
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push({ t: 'hr' });
      continue;
    }
    const task = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    if (task) {
      out.push({ t: 'task', done: task[1] !== ' ', text: task[2] ?? '' });
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      out.push({ t: 'quote', text: q[1] ?? '' });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ t: 'h', level: h[1]?.length ?? 1, text: h[2] ?? '' });
      continue;
    }
    const img = /^!\[(.*?)\]\((.*?)\)\s*$/.exec(line.trim());
    if (img) {
      out.push({ t: 'img', alt: img[1] ?? '', src: img[2] ?? '' });
      continue;
    }
    if (/^\s*-\s+/.test(line) || /^\s*\*\s+/.test(line)) {
      out.push({ t: 'li', text: line.replace(/^\s*[-*]\s+/, '') });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      out.push({ t: 'li', text: line.replace(/^\s*\d+\.\s+/, '• ') });
      continue;
    }
    if (!line.trim()) {
      out.push({ t: 'gap' });
      continue;
    }
    out.push({ t: 'p', text: line });
  }
  if (code) out.push({ t: 'code', text: code.join('\n') });
  return out;
}

/** Inline `**bold**`, `_italic_`, `~~strike~~`, `` `code` ``, [links](…), [[wikilinks]]. */
function runs(text: string, base: object, md: AppTheme['md']): React.ReactNode[] {
  const parts = text.split(
    /(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\[\[[^\]]+\]\]|\[.+?\]\(.+?\)|(?<![\w*])\*[^*\s][^*]*\*(?!\w)|(?<!\w)_[^_\s][^_]*_(?!\w))/g
  );
  return parts.map((p, i) => {
    if (!p) return null;
    const b = /^\*\*(.+)\*\*$/.exec(p);
    if (b) return <Text key={i} style={[base, md.bold]}>{b[1]}</Text>;
    const st = /^~~(.+)~~$/.exec(p);
    if (st) return <Text key={i} style={[base, md.strike]}>{st[1]}</Text>;
    const it = /^(?:\*([^*].*)\*|_(.+)_)$/.exec(p);
    if (it) return <Text key={i} style={[base, md.italic]}>{it[1] ?? it[2]}</Text>;
    const w = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(p);
    if (w) return <Text key={i} style={[base, md.link]}>{w[2] ?? w[1]}</Text>;
    const c = /^`([^`]+)`$/.exec(p);
    if (c) return <Text key={i} style={[base, md.mono]}>{c[1]}</Text>;
    const l = /^\[(.+?)\]\(.+?\)$/.exec(p);
    if (l) return <Text key={i} style={[base, md.link]}>{l[1]}</Text>;
    return <Text key={i} style={base}>{p}</Text>;
  });
}

function Block({ block, md }: { block: Block; md: AppTheme['md'] }): React.JSX.Element | null {
  switch (block.t) {
    case 'gap':
      return <View style={{ height: 8 }} />;
    case 'h':
      return (
        <Text style={[md.h, block.level === 1 ? md.h1 : block.level === 2 ? md.h2 : md.h3]}>
          {runs(block.text, {}, md)}
        </Text>
      );
    case 'li':
      return (
        <Text style={md.p}>
          <Text style={md.bullet}>•  </Text>
          {runs(block.text.replace(/^• /, ''), {}, md)}
        </Text>
      );
    case 'code':
      return (
        <View style={md.codeBox}>
          <Text style={md.code}>{block.text}</Text>
        </View>
      );
    case 'img':
      return <Text style={md.imgRef}>{/\.(m4a|wav|mp3|ogg)$/i.test(block.src) ? 'Voice memo' : 'Image'} · {block.alt || block.src.split('/').pop()}</Text>;
    case 'task':
      return (
        <Text style={md.p}>
          <Text style={md.check}>{block.done ? '☑  ' : '☐  '}</Text>
          <Text style={block.done ? md.strike : undefined}>{runs(block.text, {}, md)}</Text>
        </Text>
      );
    case 'quote':
      return (
        <View style={md.quote}>
          <Text style={[md.p, md.italic]}>{runs(block.text, {}, md)}</Text>
        </View>
      );
    case 'hr':
      return <View style={md.rule} />;
    case 'p':
      return <Text style={md.p}>{runs(block.text, {}, md)}</Text>;
  }
}
