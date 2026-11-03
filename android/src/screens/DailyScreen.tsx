import React, { useEffect, useState } from 'react'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { ArrowUp, ImagePlus } from 'lucide-react-native'
import { useTheme } from '../theme'
import { ScreenHead } from '../components/ScreenHead'
import { Icon } from '../components/Icon'
import { useStore } from '../lib/store'
import { Markdown } from '../components/Markdown'
import { longDate } from '../lib/when'
import { appendMarkdownImageRefs, imageExtension } from '../lib/imageAttachments'
import { pickImageAttachments } from '../lib/imagePicker'
import type { PendingImageAttachment } from '../lib/imageAttachments'
import { saveAssetCopy } from '../lib/vault'

/**
 * Today's note — appends compact plain bullets to `daily/YYYY-MM-DD.md`, like Mac.
 * Reads like a journal: date, the log, then a single add-line with an inline
 * send arrow (no block Append button).
 */
export function DailyScreen({ onMenu }: { onMenu: () => void }): React.JSX.Element {
  const { ui, c } = useTheme()
  const { readDaily, appendDaily } = useStore()
  const [body, setBody] = useState('')
  const [rel, setRel] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [pendingImages, setPendingImages] = useState<PendingImageAttachment[]>([])
  const [msg, setMsg] = useState<string | null>(null)

  async function load(): Promise<void> {
    const d = await readDaily()
    setRel(d.rel)
    // readDaily already drops the old `# YYYY-MM-DD` heading (it repeated the page title).
    setBody(d.body)
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function addImages(): Promise<void> {
    try {
      const selected = await pickImageAttachments()
      if (selected.length) {
        setPendingImages((previous) => [
          ...previous,
          ...selected.filter((image) => !previous.some((pending) => pending.uri === image.uri))
        ])
        setMsg(null)
      }
    } catch (e) {
      setMsg(`Couldn't pick images: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function append(): Promise<void> {
    if (!draft.trim() && !pendingImages.length) return
    try {
      const rels: string[] = []
      const failed: PendingImageAttachment[] = []
      for (const image of pendingImages) {
        try {
          rels.push(await saveAssetCopy(image.uri, imageExtension(image)))
        } catch {
          failed.push(image)
        }
      }
      const entry = appendMarkdownImageRefs(draft, rels)
      if (!entry) {
        setPendingImages(failed)
        setMsg("Couldn't copy the selected images. Try adding them again.")
        return
      }
      await appendDaily(entry, rels.length ? 'image' : 'text')
      setDraft('')
      setPendingImages(failed)
      await load()
      setMsg(
        failed.length
          ? `${failed.length} image${failed.length === 1 ? '' : 's'} couldn't be copied. Tap Add to retry.`
          : null
      )
    } catch (e) {
      setMsg(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const canAppend = !!draft.trim() || pendingImages.length > 0

  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.scrollPad} keyboardShouldPersistTaps="handled">
      <ScreenHead title="Today" onMenu={onMenu} />
      <Text style={ui.display}>{longDate()}</Text>

      <View style={[ui.inputLine, { marginTop: 16, marginBottom: 8 }]}>
        <TextInput
          style={ui.inputText}
          value={draft}
          onChangeText={setDraft}
          placeholder="Add a line to today…"
          placeholderTextColor={c.faint}
          multiline
          onSubmitEditing={() => void append()}
        />
        <Pressable
          onPress={() => void addImages()}
          style={ui.iconBtn}
          accessibilityLabel={pendingImages.length ? `Add images, ${pendingImages.length} selected` : 'Add images'}
        >
          <Icon as={ImagePlus} size={20} color={pendingImages.length ? c.accent : c.faint} strokeWidth={2.1} />
        </Pressable>
        <Pressable onPress={() => void append()} disabled={!canAppend} style={ui.iconBtn} accessibilityLabel="Add">
          <Icon as={ArrowUp} size={20} color={canAppend ? c.accent : c.faint} strokeWidth={2.25} />
        </Pressable>
      </View>
      {pendingImages.length > 0 && (
        <View style={[ui.row, { justifyContent: 'space-between', marginBottom: 8 }]}>
          <Text style={ui.meta}>
            {pendingImages.length} image{pendingImages.length === 1 ? '' : 's'} attached
          </Text>
          <Pressable onPress={() => setPendingImages([])} accessibilityLabel="Remove selected images">
            <Text style={ui.quietMuted}>Clear</Text>
          </Pressable>
        </View>
      )}
      {msg && <Text style={ui.err}>{msg}</Text>}

      {body.trim() ? (
        <Markdown text={body} notePath={rel} />
      ) : (
        <Text style={[ui.meta, { marginTop: 12 }]}>Nothing logged yet today.</Text>
      )}
    </ScrollView>
  )
}
