import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FlatList,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from 'react-native'
import { ChevronLeft, ChevronRight, SquarePen, X } from 'lucide-react-native'
import { useTheme } from '../theme'
import { useStore } from '../lib/store'
import type { DayInfo } from '../lib/vault'
import { ScreenHead } from '../components/ScreenHead'
import { Icon } from '../components/Icon'
import { Markdown } from '../components/Markdown'
import { dailyTitle, localDay, parseDay } from '../../../src/shared/daily'
import {
  entryCountLabel,
  filterDays,
  groupByMonth,
  monthCounts,
  streak,
  type JournalRow
} from '../../../src/shared/journal'

interface Props {
  onMenu: () => void
  /** Open a day note in the editor. */
  onEdit: (id: string) => void
  /** Day shown in the pager (null = the timeline). Lives in the shell so it survives a trip to the editor. */
  day: string | null
  onDay: (day: string | null) => void
}

/**
 * Journal — every daily note in one reverse-chronological timeline, grouped by month (sticky
 * headers), each day's first entries readable inline. Drawn from the summaries in the saved
 * index (no vault scan, no file reads for the list). Tap a day to page through days full-size
 * (swipe or the arrows; each page reads its file when it comes near), long-press to edit.
 */
export function JournalScreen({ onMenu, onEdit, day, onDay }: Props): React.JSX.Element {
  const { days } = useStore()
  // Android back from a day page is handled by the shell (it owns `day`).
  if (day && days.some((d) => d.day === day)) {
    return <DayPager days={days} day={day} onDay={onDay} onClose={() => onDay(null)} onEdit={onEdit} />
  }
  return <Timeline days={days} onMenu={onMenu} onOpenDay={onDay} onEdit={onEdit} />
}

// --- timeline -------------------------------------------------------------------------

function Timeline({
  days,
  onMenu,
  onOpenDay,
  onEdit
}: {
  days: DayInfo[]
  onMenu: () => void
  onOpenDay: (day: string) => void
  onEdit: (id: string) => void
}): React.JSX.Element {
  const { ui, c } = useTheme()
  const [q, setQ] = useState('')
  const list = useRef<FlatList<JournalRow<DayInfo>>>(null)
  const today = localDay()
  const filtered = useMemo(() => filterDays(days, q, (d) => d.snippet), [days, q])
  const rows = useMemo(() => groupByMonth(filtered), [filtered])
  const sticky = useMemo(() => rows.flatMap((r, i) => (r.kind === 'month' ? [i] : [])), [rows])
  const months = useMemo(() => monthCounts(filtered.map((d) => d.day)), [filtered])
  const run = useMemo(
    () =>
      streak(
        days.map((d) => d.day),
        today
      ),
    [days, today]
  )

  const jump = useCallback(
    (key: string) => {
      const index = rows.findIndex((r) => r.kind === 'month' && r.key === key)
      if (index >= 0) list.current?.scrollToIndex({ index, animated: true, viewPosition: 0 })
    },
    [rows]
  )

  const renderItem = useCallback(
    ({ item }: { item: JournalRow<DayInfo> }) =>
      item.kind === 'month' ? (
        <View
          style={{
            backgroundColor: c.bg,
            paddingTop: 14,
            paddingBottom: 6,
            flexDirection: 'row',
            justifyContent: 'space-between'
          }}
        >
          <Text style={[ui.label, { marginTop: 0, marginBottom: 0 }]}>{item.label}</Text>
          <Text style={[ui.label, { marginTop: 0, marginBottom: 0 }]}>{String(item.count)}</Text>
        </View>
      ) : (
        <DayRow info={item.item} today={item.day === today} onOpen={onOpenDay} onEdit={onEdit} />
      ),
    [ui, c.bg, today, onOpenDay, onEdit]
  )

  return (
    <View style={ui.screen}>
      <ScreenHead title="Journal" onMenu={onMenu} />
      <View style={[ui.inputLine, { marginBottom: 6 }]}>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder={
            days.length
              ? `Filter ${days.length} day${days.length === 1 ? '' : 's'}${run > 1 ? ` · ${run}-day streak` : ''}`
              : 'Filter days'
          }
          placeholderTextColor={c.faint}
          style={ui.inputText}
          returnKeyType="search"
        />
        {!!q && (
          <Pressable onPress={() => setQ('')} style={ui.iconBtn} accessibilityLabel="Clear filter">
            <Icon as={X} size={18} />
          </Pressable>
        )}
      </View>
      {months.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, marginHorizontal: -20 }}
          contentContainerStyle={{ paddingHorizontal: 16, gap: 4 }}
        >
          {months.map((m) => (
            <Pressable
              key={m.key}
              onPress={() => jump(m.key)}
              style={ui.chip}
              accessibilityLabel={`Jump to ${m.label}`}
            >
              <Text style={ui.chipText}>
                {shortMonth(m.key)} <Text style={{ color: c.faint }}>{String(m.count)}</Text>
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <FlatList
        ref={list}
        data={rows}
        keyExtractor={(r) => (r.kind === 'month' ? `m:${r.key}` : r.day)}
        renderItem={renderItem}
        stickyHeaderIndices={sticky}
        initialNumToRender={14}
        maxToRenderPerBatch={12}
        windowSize={7}
        removeClippedSubviews
        keyboardShouldPersistTaps="handled"
        onScrollToIndexFailed={(info) => {
          list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false })
          setTimeout(() => list.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0 }), 60)
        }}
        ListEmptyComponent={
          <Text style={[ui.meta, { marginTop: 16 }]}>
            {days.length ? `No days match “${q}”.` : 'Days you log on Today show up here.'}
          </Text>
        }
        contentContainerStyle={ui.scrollPad}
      />
    </View>
  )
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function shortMonth(key: string): string {
  const [y, m] = key.split('-')
  const label = MONTHS_SHORT[Number(m) - 1] ?? key
  return y === String(new Date().getFullYear()) ? label : `${label} ${y?.slice(2)}`
}

const DayRow = memo(function DayRow({
  info,
  today,
  onOpen,
  onEdit
}: {
  info: DayInfo
  today: boolean
  onOpen: (day: string) => void
  onEdit: (id: string) => void
}): React.JSX.Element {
  const { ui, c } = useTheme()
  const d = parseDay(info.day)
  const title = dailyTitle(info.day)
  const more = info.count - info.entries.length
  return (
    <Pressable
      onPress={() => onOpen(info.day)}
      onLongPress={() => onEdit(info.id)}
      delayLongPress={450}
      style={{ flexDirection: 'row', gap: 14, paddingVertical: 11, borderTopWidth: 0.5, borderTopColor: c.border }}
      accessibilityLabel={`${title}, ${entryCountLabel(info.count)}`}
    >
      <View style={{ width: 36, alignItems: 'center' }}>
        <Text
          style={{ color: today ? c.accent : c.text, fontSize: 21, fontWeight: '700', fontVariant: ['tabular-nums'] }}
        >
          {String(d?.getDate() ?? '')}
        </Text>
        <Text style={{ color: c.faint, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6 }}>
          {title.slice(0, 3).toUpperCase()}
        </Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={[ui.row, { justifyContent: 'space-between', marginBottom: 3 }]}>
          <Text style={[ui.title, { fontSize: 14.5 }]} numberOfLines={1}>
            {title}
            {today ? <Text style={{ color: c.accent, fontSize: 11, fontWeight: '700' }}>{'  TODAY'}</Text> : null}
          </Text>
          {info.count > 0 && <Text style={[ui.meta, { marginTop: 0 }]}>{entryCountLabel(info.count)}</Text>}
        </View>
        {info.entries.length > 0 ? (
          info.entries.map((e, i) => (
            <View key={`${e.time}-${i}`} style={{ flexDirection: 'row', gap: 8, paddingVertical: 1 }}>
              <Text style={[ui.meta, { marginTop: 0, width: 40, fontVariant: ['tabular-nums'] }]}>{e.time}</Text>
              <Text style={{ flex: 1, color: c.text, fontSize: 14, lineHeight: 19, opacity: 0.86 }} numberOfLines={2}>
                {e.kind ? <Text style={{ color: c.faint }}>{`${e.kind} · `}</Text> : null}
                {e.text || '…'}
              </Text>
            </View>
          ))
        ) : (
          <Text style={[ui.meta, { marginTop: 0 }]} numberOfLines={3}>
            {info.snippet || 'Empty'}
          </Text>
        )}
        {more > 0 && <Text style={[ui.meta, { marginTop: 2, marginLeft: 48 }]}>+{more} more</Text>}
      </View>
    </Pressable>
  )
})

// --- pager ----------------------------------------------------------------------------

/** Bodies read this session, by path@mtime (a page re-read only when the day changed). */
const bodyCache = new Map<string, string>()

function DayPager({
  days,
  day,
  onDay,
  onClose,
  onEdit
}: {
  days: DayInfo[]
  day: string
  onDay: (day: string) => void
  onClose: () => void
  onEdit: (id: string) => void
}): React.JSX.Element {
  const { ui, c } = useTheme()
  const { width } = useWindowDimensions()
  // Oldest → newest, so a swipe left goes forward in time (like turning a page).
  const ordered = useMemo(() => [...days].reverse(), [days])
  const index = Math.max(
    0,
    ordered.findIndex((d) => d.day === day)
  )
  const pager = useRef<FlatList<DayInfo>>(null)
  const current = ordered[index]

  const go = useCallback(
    (to: number) => {
      const next = ordered[to]
      if (!next) return
      pager.current?.scrollToIndex({ index: to, animated: true })
      onDay(next.day)
    },
    [ordered, onDay]
  )

  const onSettle = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const i = Math.round(e.nativeEvent.contentOffset.x / Math.max(1, width))
      const next = ordered[i]
      if (next && next.day !== day) onDay(next.day)
    },
    [ordered, width, day, onDay]
  )

  const renderItem = useCallback(({ item }: { item: DayInfo }) => <DayPage info={item} width={width} />, [width])

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={[ui.topBar, { marginHorizontal: 10 }]}>
        <Pressable onPress={onClose} style={ui.iconBtn} accessibilityLabel="Back to journal">
          <Icon as={X} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[ui.topTitle, { marginLeft: 0 }]} numberOfLines={1}>
            {current ? dailyTitle(current.day) : ''}
          </Text>
          <Text style={[ui.meta, { marginTop: 0 }]}>
            {current && current.count > 0 ? `${entryCountLabel(current.count)} · ` : ''}
            {`${index + 1} of ${ordered.length}`}
          </Text>
        </View>
        <Pressable
          onPress={() => go(index - 1)}
          disabled={index <= 0}
          style={ui.iconBtn}
          accessibilityLabel="Previous day"
        >
          <Icon as={ChevronLeft} color={index <= 0 ? c.faint : undefined} />
        </Pressable>
        <Pressable
          onPress={() => go(index + 1)}
          disabled={index >= ordered.length - 1}
          style={ui.iconBtn}
          accessibilityLabel="Next day"
        >
          <Icon as={ChevronRight} color={index >= ordered.length - 1 ? c.faint : undefined} />
        </Pressable>
        <Pressable onPress={() => current && onEdit(current.id)} style={ui.iconBtn} accessibilityLabel="Edit this day">
          <Icon as={SquarePen} size={20} />
        </Pressable>
      </View>
      <FlatList
        ref={pager}
        data={ordered}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(d) => d.path}
        renderItem={renderItem}
        initialScrollIndex={index}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        // Only the visible page and its neighbours exist; each reads its own file on mount.
        initialNumToRender={1}
        maxToRenderPerBatch={2}
        windowSize={3}
        onMomentumScrollEnd={onSettle}
      />
    </View>
  )
}

const DayPage = memo(function DayPage({ info, width }: { info: DayInfo; width: number }): React.JSX.Element {
  const { ui } = useTheme()
  const { readDay } = useStore()
  const key = `${info.path}@${info.updatedAt}`
  const [body, setBody] = useState<string | null>(() => bodyCache.get(key) ?? null)
  useEffect(() => {
    const have = bodyCache.get(key)
    if (have !== undefined) {
      setBody(have)
      return
    }
    let live = true
    void readDay(info.day).then((b) => {
      bodyCache.set(key, b)
      if (bodyCache.size > 60) bodyCache.delete(bodyCache.keys().next().value as string)
      if (live) setBody(b)
    })
    return () => {
      live = false
    }
  }, [key, info.day, readDay])
  return (
    <ScrollView style={{ width }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 60, paddingTop: 4 }}>
      {body === null ? (
        // Index preview until the file is read (a few ms).
        info.entries.map((e, i) => <Text key={i} style={[ui.meta, { fontSize: 15 }]}>{`${e.time}  ${e.text}`}</Text>)
      ) : body.trim() ? (
        <Markdown text={body} notePath={info.path} />
      ) : (
        <Text style={[ui.meta, { marginTop: 12 }]}>Nothing logged this day.</Text>
      )}
    </ScrollView>
  )
})
