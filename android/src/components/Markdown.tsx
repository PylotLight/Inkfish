import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { dark } from '../theme';

/** Tiny markdown renderer — headings, bold, bullets, code fences, images. No deps. */
export function Markdown({ text }: { text: string }): React.JSX.Element {
  const blocks = useMemo(() => parse(text), [text]);
  return (
    <View>
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
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
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
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

/** Inline `**bold**`, `` `code` ``, [links](…) — rendered as plain runs. */
function runs(text: string, base: object): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[.+?\]\(.+?\))/g);
  return parts.map((p, i) => {
    const b = /^\*\*(.+)\*\*$/.exec(p);
    if (b) return <Text key={i} style={[base, styles.bold]}>{b[1]}</Text>;
    const c = /^`([^`]+)`$/.exec(p);
    if (c) return <Text key={i} style={[base, styles.mono]}>{c[1]}</Text>;
    const l = /^\[(.+?)\]\(.+?\)$/.exec(p);
    if (l) return <Text key={i} style={[base, styles.link]}>{l[1]}</Text>;
    return <Text key={i} style={base}>{p}</Text>;
  });
}

function Block({ block }: { block: Block }): React.JSX.Element | null {
  switch (block.t) {
    case 'gap':
      return <View style={{ height: 8 }} />;
    case 'h':
      return (
        <Text style={[styles.h, block.level === 1 ? styles.h1 : block.level === 2 ? styles.h2 : styles.h3]}>
          {runs(block.text, {})}
        </Text>
      );
    case 'li':
      return <Text style={styles.p}>  {'•  '}{runs(block.text.replace(/^• /, ''), {})}</Text>;
    case 'code':
      return (
        <View style={styles.codeBox}>
          <Text style={styles.code}>{block.text}</Text>
        </View>
      );
    case 'img':
      return <Text style={styles.imgRef}>🖼 {block.alt || block.src}</Text>;
    case 'p':
      return <Text style={styles.p}>{runs(block.text, {})}</Text>;
  }
}

const styles = StyleSheet.create({
  h: { color: dark.text, fontWeight: '700', marginTop: 12, marginBottom: 4 },
  h1: { fontSize: 22 },
  h2: { fontSize: 18 },
  h3: { fontSize: 15 },
  p: { color: dark.text, fontSize: 15, lineHeight: 22, marginVertical: 2 },
  bold: { fontWeight: '700' },
  mono: { fontFamily: 'monospace', backgroundColor: dark.card, borderRadius: 4 },
  link: { color: dark.accent, textDecorationLine: 'underline' },
  codeBox: { backgroundColor: dark.card, borderRadius: 8, padding: 10, marginVertical: 6 },
  code: { color: dark.text, fontFamily: 'monospace', fontSize: 13 },
  imgRef: { color: dark.muted, fontSize: 13, marginVertical: 4 }
});
