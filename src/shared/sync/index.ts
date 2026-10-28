/** Inkfish sync core — pure TS shared by the Mac app and the Android app. See docs/sync.md. */
export { sha256 } from './hash'
export { utf8Encode, utf8Decode, toBase64, fromBase64, toHex } from './bytes'
export { merge3, mergeText, lcsPairs } from './diff3'
export { mergeNote, mergeDaily, conflictPath, splitFrontmatter } from './note'
export { plan, mergeKind, ignored, neededFromRemote, resolveMerge } from './plan'
export { renameCandidates, renameScore, matchRenames, applyRenames } from './renames'
export type { Gone, Added, RenamePair } from './renames'
export type { Entry, Manifest, Base, Op, MergeKind, Write } from './plan'
export * from './protocol'
export {
  runSync,
  encodeFiles,
  decodeFiles,
  bigDeletion,
  SyncHeld,
  SyncCancelled,
  GUARD_MIN,
  GUARD_SHARE,
  PROGRESS_THROTTLE_MS,
  CHUNK_MIN,
  CHUNK_SIZE,
  transferOrder
} from './engine'
export type { PartialStore, ApplyWrite } from './engine'
export type { SyncProgress, SyncStage, SyncStageTimings } from './engine'
export type { BigDelete, GuardChoice } from './engine'
export type { SyncFs, Remote, SyncState, SyncReport } from './engine'
export { createHandler, parseHello, memPartials } from './server'
export type { ServerHost, PeerRecord, PendingPair, HttpResult, PeerMeta } from './server'
export {
  compat,
  outdatedApp,
  peerVersion,
  updateLabel,
  incompatibleBody,
  parseIncompatible,
  versionHeaders,
  SyncIncompatible,
  SELF_VERSION,
  PROTOCOL_HEADER,
  MIN_PEER_HEADER,
  INCOMPATIBLE_STATUS
} from './compat'
export type { Compat, PeerVersion, Side } from './compat'
export {
  findMac,
  findMacHello,
  assertCompatible,
  hello,
  pairWithMac,
  httpRemote,
  markDone,
  supportsProgress,
  progressPoster,
  withRetry,
  retryable,
  HttpError
} from './client'
export type { RemoteOpts, RetryOpts } from './client'
export type { Fetch, MacPeer } from './client'
export { appendCapped, appendCollapsed, summarize, shortError, SYNC_LOG_CAP, COLLAPSE_MS } from './log'
export {
  foldPath,
  caseAdoptions,
  rebaseCase,
  redundantCopies,
  conflictOriginal,
  bumpOriginal,
  copyExists
} from './paths'
export type { SyncLogEntry, SyncLogKind } from './log'
export { walkManifest, mapLimit, MAX_SYNC_FILE } from './walk'
export type { WalkIo, WalkRoot, WalkResult, HashCache } from './walk'
export {
  percent,
  etaMs,
  progressLine,
  progressShort,
  runFromReport,
  runLine,
  cleanRun,
  cleanProgress,
  pushRun,
  mb,
  secs,
  STAGE_LABEL,
  RUNS_CAP
} from './progress'
export type { PeerRun, LiveProgress } from './progress'
