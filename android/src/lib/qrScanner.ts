export interface NativeQrScanner {
  subscribe: (onData: (data: string) => void) => { remove: () => void }
  launch: () => Promise<void>
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
