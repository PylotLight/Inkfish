/** Inkfish sync core — pure TS shared by the Mac app and the Android app. See docs/sync.md. */
export { sha256 } from './hash'
export { merge3, mergeText, lcsPairs } from './diff3'
export { mergeNote, mergeDaily, conflictPath, splitFrontmatter } from './note'
export { plan, mergeKind, ignored, neededFromRemote, resolveMerge } from './plan'
export type { Entry, Manifest, Base, Op, MergeKind, Write } from './plan'
