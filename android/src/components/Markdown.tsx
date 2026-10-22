import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { Dimensions, Image, Text, View, type LayoutChangeEvent } from 'react-native'
import { useTheme, type AppTheme } from '../theme'
import {
  blockImage,
  fitImage,
  isAudio,
  resolveImage,
  splitImages,
  vaultFileUri,
  type ImageToken
} from '../lib/mdimages'
import { listAttachments, vaultRootUri } from '../lib/vault'

/**
 * Tiny markdown renderer — headings, bold, bullets, code fences, images. No deps.
 * Images (`![alt|300](src)`, `![[x.png]]`) render as real images, block or
 * inline, resolved against the vault the same way the Mac does.
 */
export function Markdown({ text, notePath }: { text: string; notePath?: string | null }): React.JSX.Element {
  const blocks = useMemo(() => parse(text), [text])
  const t = useTheme()
  const hasImages = useMemo(() => /!\[/.test(text), [text])
  const [files, setFiles] = useState<readonly string[]>([])
  const [width, setWidth] = useState(() => Dimensions.get('window').width - 40)
  useEffect(() => {
    if (!hasImages) return
    let live = true
    void listAttachments().then((f) => {
      if (live) setFiles(f)
    })
    return () => {
      live = false
    }
  }, [hasImages, text])
  const ctx = useMemo<ImgCtx>(() => ({ notePath: notePath ?? null, files, width }), [notePath, files, width])
  const onLayout = (e: LayoutChangeEvent): void => {
    const w = Math.floor(e.nativeEvent.layout.width)
    if (w > 0 && w !== width) setWidth(w)
  }
  return (
    <ImageContext.Provider value={ctx}>
      <View onLayout={onLayout}>
        {blocks.map((b, i) => (
          <Block key={i} block={b} md={t.md} />
        ))}
      </View>
    </ImageContext.Provider>
  )
}

interface ImgCtx {
  notePath: string | null
  files: readonly string[]
  /** Column width images are capped to. */
  width: number
}
const ImageContext = createContext<ImgCtx>({ notePath: null, files: [], width: 320 })

type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'li'; text: string }
  | { t: 'code'; text: string }
  | { t: 'img'; img: ImageToken }
  | { t: 'task'; done: boolean; text: string }
  | { t: 'quote'; text: string }
  | { t: 'hr' }
  | { t: 'gap' }

function parse(text: string): Block[] {
  const out: Block[] = []
  const lines = text.split('\n')
  let code: string[] | null = null
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (code) {
        out.push({ t: 'code', text: code.join('\n') })
        code = null
      } else code = []
      continue
    }
    if (code) {
      code.push(line)
      continue
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push({ t: 'hr' })
      continue
    }
    const task = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line)
    if (task) {
      out.push({ t: 'task', done: task[1] !== ' ', text: task[2] ?? '' })
      continue
    }
    const q = /^\s*>\s?(.*)$/.exec(line)
    if (q) {
      out.push({ t: 'quote', text: q[1] ?? '' })
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      out.push({ t: 'h', level: h[1]?.length ?? 1, text: h[2] ?? '' })
      continue
    }
    const img = line.includes('![') ? blockImage(line) : null
    if (img) {
      out.push({ t: 'img', img })
      continue
    }
    if (/^\s*-\s+/.test(line) || /^\s*\*\s+/.test(line)) {
      out.push({ t: 'li', text: line.replace(/^\s*[-*]\s+/, '') })
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      out.push({ t: 'li', text: line.replace(/^\s*\d+\.\s+/, '• ') })
      continue
    }
    if (!line.trim()) {
      out.push({ t: 'gap' })
      continue
    }
    out.push({ t: 'p', text: line })
  }
  if (code) out.push({ t: 'code', text: code.join('\n') })
  return out
}

/** Image refs inside a line split out first, then inline styles on the text between them. */
function runs(text: string, base: object, md: AppTheme['md']): React.ReactNode[] {
  if (!text.includes('![')) return styled(text, base, md, '')
  return splitImages(text).flatMap((tok, i): React.ReactNode[] =>
    tok.t === 'text' ? styled(tok.text, base, md, `${i}-`) : [<MdImage key={`i${i}`} img={tok} inline md={md} />]
  )
}

/** Inline `**bold**`, `_italic_`, `~~strike~~`, `` `code` ``, [links](…), [[wikilinks]]. */
function styled(text: string, base: object, md: AppTheme['md'], key: string): React.ReactNode[] {
  const parts = text.split(
    /(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\[\[[^\]]+\]\]|\[.+?\]\(.+?\)|(?<![\w*])\*[^*\s][^*]*\*(?!\w)|(?<!\w)_[^_\s][^_]*_(?!\w))/g
  )
  return parts.map((p, j) => {
    const i = `${key}${j}`
    if (!p) return null
    const b = /^\*\*(.+)\*\*$/.exec(p)
    if (b)
      return (
        <Text key={i} style={[base, md.bold]}>
          {b[1]}
        </Text>
      )
    const st = /^~~(.+)~~$/.exec(p)
    if (st)
      return (
        <Text key={i} style={[base, md.strike]}>
          {st[1]}
        </Text>
      )
    const it = /^(?:\*([^*].*)\*|_(.+)_)$/.exec(p)
    if (it)
      return (
        <Text key={i} style={[base, md.italic]}>
          {it[1] ?? it[2]}
        </Text>
      )
    const w = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(p)
    if (w)
      return (
        <Text key={i} style={[base, md.link]}>
          {w[2] ?? w[1]}
        </Text>
      )
    const c = /^`([^`]+)`$/.exec(p)
    if (c)
      return (
        <Text key={i} style={[base, md.mono]}>
          {c[1]}
        </Text>
      )
    const l = /^\[(.+?)\]\(.+?\)$/.exec(p)
    if (l)
      return (
        <Text key={i} style={[base, md.link]}>
          {l[1]}
        </Text>
      )
    return (
      <Text key={i} style={base}>
        {p}
      </Text>
    )
  })
}

const sizeCache = new Map<string, { w: number; h: number }>()

/** A note image: resolved against the vault, sized like the Mac (`|300` = width), capped to the column. */
function MdImage({ img, inline, md }: { img: ImageToken; inline?: boolean; md: AppTheme['md'] }): React.JSX.Element {
  const { notePath, files, width: column } = useContext(ImageContext)
  const { c } = useTheme()
  const target = useMemo(() => resolveImage(img, notePath, files), [img, notePath, files])
  const uri = target ? (target.kind === 'remote' ? target.uri : vaultFileUri(vaultRootUri(), target.rel)) : null
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(() =>
    uri ? (sizeCache.get(uri) ?? null) : null
  )
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
    if (!uri || isAudio(img.src)) return
    const hit = sizeCache.get(uri)
    if (hit) {
      setNatural(hit)
      return
    }
    let live = true
    Image.getSize(
      uri,
      (w, h) => {
        sizeCache.set(uri, { w, h })
        if (live) setNatural({ w, h })
      },
      () => {
        if (live) setFailed(true)
      }
    )
    return () => {
      live = false
    }
  }, [uri, img.src])

  const label = img.alt || img.src.split('/').pop() || 'image'
  if (isAudio(img.src)) return <Text style={md.imgRef}>Voice memo · {label}</Text>
  if (!uri || failed) return <Text style={md.imgRef}>Image · {label}</Text>
  // Inline images without a size stay small so they sit in the line; block ones fill the column.
  const want = inline && !img.width ? { width: Math.min(natural?.w ?? 160, 160) } : img
  const size = fitImage(natural, { width: want.width, height: img.height }, column)
  const image = (
    <Image
      source={{ uri }}
      style={{ width: size.width, height: size.height, borderRadius: 6, backgroundColor: inline ? undefined : c.inset }}
      resizeMode="contain"
      accessibilityLabel={label}
      onError={() => setFailed(true)}
    />
  )
  return inline ? image : <View style={{ marginVertical: 6 }}>{image}</View>
}

function Block({ block, md }: { block: Block; md: AppTheme['md'] }): React.JSX.Element | null {
  switch (block.t) {
    case 'gap':
      return <View style={{ height: 8 }} />
    case 'h':
      return (
        <Text style={[md.h, block.level === 1 ? md.h1 : block.level === 2 ? md.h2 : md.h3]}>
          {runs(block.text, {}, md)}
        </Text>
      )
    case 'li':
      return (
        <Text style={md.p}>
          <Text style={md.bullet}>• </Text>
          {runs(block.text.replace(/^• /, ''), {}, md)}
        </Text>
      )
    case 'code':
      return (
        <View style={md.codeBox}>
          <Text style={md.code}>{block.text}</Text>
        </View>
      )
    case 'img':
      return <MdImage img={block.img} md={md} />
    case 'task':
      return (
        <Text style={md.p}>
          <Text style={md.check}>{block.done ? '☑  ' : '☐  '}</Text>
          <Text style={block.done ? md.strike : undefined}>{runs(block.text, {}, md)}</Text>
        </Text>
      )
    case 'quote':
      return (
        <View style={md.quote}>
          <Text style={[md.p, md.italic]}>{runs(block.text, {}, md)}</Text>
        </View>
      )
    case 'hr':
      return <View style={md.rule} />
    case 'p':
      return <Text style={md.p}>{runs(block.text, {}, md)}</Text>
  }
}
