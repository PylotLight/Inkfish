export interface NativeQrScanner {
  subscribe: (onData: (data: string) => void) => { remove: () => void }
  launch: () => Promise<void>
}

export interface NativeQrScannerDiagnostic {
  kind: 'cancelled' | 'unavailable' | 'failed'
  userMessage: string
  logMessage: string
}

/** Subscribe before launch: Android emits the scanned payload through a native event. */
export async function launchQrScanner(scanner: NativeQrScanner, onData: (data: string) => void): Promise<void> {
  let delivered = false
  const subscription = scanner.subscribe((data) => {
    if (delivered || !data) return
    delivered = true
    onData(data)
  })

  try {
    await scanner.launch()
  } finally {
    subscription.remove()
  }
}

/**
 * Keep Expo's native error code and message visible instead of treating a user
 * cancellation, a missing Play Services install, and a scanner failure alike.
 */
export function describeNativeQrScannerError(error: unknown): NativeQrScannerDiagnostic {
  const details =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown; message?: unknown; name?: unknown })
      : undefined
  const code = typeof details?.code === 'string' ? details.code.trim() : ''
  const name = typeof details?.name === 'string' ? details.name.trim() : ''
  const message =
    typeof details?.message === 'string'
      ? details.message.replace(/\s+/g, ' ').trim().slice(0, 240)
      : typeof error === 'string'
        ? error.replace(/\s+/g, ' ').trim().slice(0, 240)
        : ''
  const identity = code || name || 'UNKNOWN_NATIVE_ERROR'
  const logMessage = `System QR scanner error · ${identity}${message ? ` · ${message}` : ''}`
  const fingerprint = `${code} ${name} ${message}`.toLowerCase()

  if (fingerprint.includes('barcode_scanning_cancelled') || /\b(cancelled|canceled)\b/.test(fingerprint)) {
    return {
      kind: 'cancelled',
      userMessage:
        'The system QR scanner was cancelled. The live camera is ready; scan there, or try the system scanner again.',
      logMessage: `System QR scanner cancelled · ${identity}${message ? ` · ${message}` : ''}`
    }
  }

  if (fingerprint.includes('google_play_services_unavailable')) {
    return {
      kind: 'unavailable',
      userMessage:
        'Google Play services is missing or unavailable, so the system scanner cannot start. Enable or update Google Play services, then retry; the live camera is ready.',
      logMessage
    }
  }

  if (fingerprint.includes('ml_kit_unavailable')) {
    return {
      kind: 'unavailable',
      userMessage:
        'This app build cannot access the Google Code Scanner module. Use the live camera, or install a build with Expo Camera barcode scanning enabled.',
      logMessage
    }
  }

  const nativeDetail = message ? ` Android reported: “${message}”.` : ''
  return {
    kind: 'failed',
    userMessage: `Google’s system QR scanner failed (${identity}).${nativeDetail} Check your internet connection and update Google Play services, then retry; the live camera is ready.`,
    logMessage
  }
}
