import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions
} from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { X } from 'lucide-react-native'
import { useTheme } from '../theme'
import { Icon } from './Icon'
import { decodePairUri, type DiscoveryUpdate } from '../lib/sync'
import { describeNativeQrScannerError, launchQrScanner } from '../lib/qrScanner'

/**
 * Full-screen QR scanner for pairing with the Mac (Mac › Settings › Sync ›
 * Show pairing code). Calls `onCode` once per scan; stays open on failure so
 * the user can try again. Pairing diagnostics stay visible in the scanner.
 */
export function PairScanner({
  visible,
  onClose,
  onCode,
  initialCode,
  onInitialCodeConsumed
}: {
  visible: boolean
  onClose: () => void
  initialCode: string | null
  onInitialCodeConsumed: () => void
  onCode: (
    data: string,
    onStage: (stage: string) => void,
    onDiscovery: (update: DiscoveryUpdate) => void
  ) => Promise<void>
}): React.JSX.Element {
  const { ui } = useTheme()
  const { height: windowHeight } = useWindowDimensions()
  const [perm, requestPerm] = useCameraPermissions()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [cameraKey, setCameraKey] = useState(0)
  const [externalPairing, setExternalPairing] = useState(false)
  const [useLiveCamera, setUseLiveCamera] = useState(false)
  const [nativeScannerActive, setNativeScannerActive] = useState(false)
  const [nativeScannerUsed, setNativeScannerUsed] = useState(false)
  const [scannerNotice, setScannerNotice] = useState<string | null>(null)
  const [scanHint, setScanHint] = useState(false)
  const [qrSummary, setQrSummary] = useState<string | null>(null)
  const [scanDetails, setScanDetails] = useState<string[]>([])
  const lock = useRef(false)
  const nativeScannerAttempted = useRef(false)
  const logRef = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const handleRef = useRef<(data: string) => void>(() => undefined)

  useEffect(() => {
    if (!visible) return
    lock.current = false
    setBusy(false)
    setMsg(null)
    setStage(null)
    setQrSummary(null)
    setScanDetails([])
    setCameraReady(false)
    setCameraError(null)
    setExternalPairing(false)
    setUseLiveCamera(false)
    setNativeScannerActive(false)
    setNativeScannerUsed(false)
    setScannerNotice(null)
    setScanHint(false)
  }, [visible])

  const handle = (data: string): void => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setMsg(null)
    const callbackLog = `Barcode callback received (${data.length} characters).`

    // Show useful QR metadata, but never show the pairing key or raw QR string.
    const payload = decodePairUri(data)
    if (payload) {
      const name = typeof payload.name === 'string' ? payload.name.replace(/\s+/g, ' ').trim() : ''
      const hosts = Array.isArray(payload.hosts) ? payload.hosts.map((host) => String(host)) : []
      const endpoints = hosts.length ? hosts.map((host) => `${host}:${payload.port}`).join(', ') : 'none'
      const expires = Number.isFinite(payload.exp) ? new Date(payload.exp).toLocaleTimeString() : 'unknown'
      setQrSummary(`Decoded ${name || 'Mac pairing code'} · port ${payload.port} · expires ${expires}`)
      setScanDetails([callbackLog, `QR decoded: ${name || 'Mac pairing code'}`, `QR addresses: ${endpoints}`])
      setStage(`QR decoded. Checking ${hosts.length} address${hosts.length === 1 ? '' : 'es'}…`)
    } else {
      setQrSummary('QR detected, but it is not a valid Inkfish pairing code.')
      setScanDetails([callbackLog, 'QR detected, but it does not match the Inkfish pairing format.'])
      setStage('QR decoded. Validating pairing code…')
    }

    onCode(data, setStage, (update) => {
      let message: string
      if (update.type === 'phase') {
        message =
          update.phase === 'qr-addresses'
            ? `Checking ${update.total} address${update.total === 1 ? '' : 'es'} from the QR code.`
            : `QR addresses did not find this Mac; scanning ${update.total} addresses across ${update.subnets.join(', ')}.`
        setStage(
          update.phase === 'qr-addresses'
            ? `Checking ${update.total} QR address${update.total === 1 ? '' : 'es'}…`
            : `Scanning ${update.total} same-subnet addresses…`
        )
      } else if (update.type === 'sweep-progress') {
        message = `Fallback scan checked ${update.checked} of ${update.total} addresses.`
        setStage(`Local scan checked ${update.checked} of ${update.total} addresses…`)
      } else {
        const prefix = update.probe.phase === 'qr-addresses' ? 'QR' : 'Fallback'
        const status = update.probe.status ? ` (HTTP ${update.probe.status})` : ''
        const error = update.probe.error ? ` · ${update.probe.error.replace(/\s+/g, ' ')}` : ''
        message = `${prefix} ${update.probe.host}: ${update.probe.outcome}${status} · ${update.probe.ms} ms${error}`
      }

      setScanDetails((current) => {
        const lines =
          update.type === 'sweep-progress'
            ? current.filter((line) => !line.startsWith('Fallback scan checked '))
            : current
        return [...lines, message]
      })
    })
      .catch((e: unknown) => {
        const error = e instanceof Error ? e.message : String(e)
        setStage(null)
        setMsg(error)
        setScanDetails((current) => [...current, `Pairing failed: ${error}`])
      })
      .finally(() => {
        setBusy(false)
        // brief pause so one bad code doesn't spin
        setTimeout(() => (lock.current = false), 1200)
      })
  }

  handleRef.current = handle

  const preferNativeScanner = Platform.OS === 'android' && CameraView.isModernBarcodeScannerAvailable

  const launchNativeScanner = useCallback((): void => {
    if (!preferNativeScanner || nativeScannerActive) return
    nativeScannerAttempted.current = true
    setNativeScannerActive(true)
    setNativeScannerUsed(true)
    setScannerNotice(null)
    setStage('Opening Google Play services QR scanner…')
    setScanDetails((current) => [...current, 'Requested Google Code Scanner via Expo Camera.'])
    void launchQrScanner(
      {
        subscribe: (onData) => CameraView.onModernBarcodeScanned(({ data }) => onData(data)),
        launch: () => CameraView.launchScanner({ barcodeTypes: ['qr'] })
      },
      (data) => handleRef.current(data)
    )
      .catch((error: unknown) => {
        const diagnostic = describeNativeQrScannerError(error)
        setStage(null)
        setUseLiveCamera(true)
        setScannerNotice(diagnostic.userMessage)
        setScanDetails((current) => [...current, diagnostic.logMessage])
      })
      .finally(() => setNativeScannerActive(false))
  }, [preferNativeScanner, nativeScannerActive])

  useEffect(() => {
    if (!visible) {
      nativeScannerAttempted.current = false
      return
    }
    if (!preferNativeScanner || nativeScannerAttempted.current || initialCode || externalPairing) return
    launchNativeScanner()
  }, [visible, preferNativeScanner, initialCode, externalPairing, launchNativeScanner])

  useEffect(() => {
    if (!visible || Platform.OS !== 'android' || CameraView.isModernBarcodeScannerAvailable) return
    setScannerNotice(
      'Google’s system QR scanner is unavailable because Google Play services or its barcode module was not detected. The live camera is available; enable or update Google Play services and retry if needed.'
    )
    setScanDetails((current) =>
      current.some((line) => line.startsWith('System scanner unavailable'))
        ? current
        : [...current, 'System scanner unavailable: Expo Camera reported isModernBarcodeScannerAvailable=false.']
    )
  }, [visible])

  useEffect(() => {
    if (!visible || !initialCode) return
    setExternalPairing(true)
    handleRef.current(initialCode)
    onInitialCodeConsumed()
  }, [visible, initialCode, onInitialCodeConsumed])

  useEffect(() => {
    if (!visible || !perm?.granted || !cameraReady || busy || qrSummary || initialCode || externalPairing) return
    const timer = setTimeout(() => {
      setScanHint(true)
      setScanDetails((current) =>
        current.includes('Live camera: no QR result after 8 seconds.')
          ? current
          : [...current, 'Live camera: no QR result after 8 seconds.']
      )
    }, 8000)
    return () => clearTimeout(timer)
  }, [visible, perm?.granted, cameraReady, busy, qrSummary, initialCode, externalPairing])

  const showCamera =
    visible && !!perm?.granted && !initialCode && !externalPairing && (!preferNativeScanner || useLiveCamera)

  const status = cameraError
    ? 'Camera problem'
    : msg
      ? 'Pairing failed'
      : busy
        ? 'Pairing in progress'
        : nativeScannerActive
          ? 'QR scanner open'
          : qrSummary
            ? 'QR code read'
            : cameraReady
              ? 'Ready to scan'
              : 'Starting camera…'
  const statusMessage = cameraError
    ? `Camera couldn’t start: ${cameraError}`
    : (msg ??
      stage ??
      scannerNotice ??
      (nativeScannerActive
        ? 'Point at the QR code shown on your Mac in Settings › Sync.'
        : preferNativeScanner && !useLiveCamera
          ? 'Opening the QR scanner…'
          : cameraReady
            ? 'Point at the QR code shown on your Mac in Settings › Sync.'
            : 'Starting camera…'))
  const logHeight = Math.max(96, Math.min(170, windowHeight * 0.22))
  const panelMaxHeight = Math.max(230, Math.min(390, windowHeight * 0.5))

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]}>
        {showCamera ? (
          <CameraView
            key={cameraKey}
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={busy ? undefined : ({ data }) => handle(data)}
            onCameraReady={() => {
              setCameraReady(true)
              setCameraError(null)
              setScanDetails((current) =>
                current.includes('Live camera ready; waiting for a QR analyzer result.')
                  ? current
                  : [...current, 'Live camera ready; waiting for a QR analyzer result.']
              )
            }}
            onMountError={({ message }) => {
              setCameraReady(false)
              setCameraError(message)
            }}
          />
        ) : visible && !perm?.granted && (!preferNativeScanner || useLiveCamera) && !initialCode && !externalPairing ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
            <Text style={[ui.title, { color: '#fff', textAlign: 'center' }]}>Camera access to scan the code</Text>
            <Pressable onPress={() => void requestPerm()} style={[ui.quiet, { marginTop: 12 }]}>
              <Text style={ui.quietText}>Allow camera</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={{ position: 'absolute', top: 48, left: 12 }}>
          <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close scanner" style={{ padding: 8 }}>
            <Icon as={X} size={24} color="#fff" />
          </Pressable>
        </View>

        {showCamera && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: '28%',
              alignSelf: 'center',
              width: 240,
              height: 240,
              borderRadius: 20,
              borderWidth: 2,
              borderColor: 'rgba(255,255,255,0.85)'
            }}
          />
        )}

        {visible && (perm?.granted || preferNativeScanner || initialCode || externalPairing) && (
          <View
            style={{
              position: 'absolute',
              bottom: 28,
              left: 16,
              right: 16,
              maxHeight: panelMaxHeight,
              alignItems: 'center'
            }}
          >
            <View
              accessibilityLabel="Pairing scanner status and diagnostics"
              style={{
                width: '100%',
                maxHeight: panelMaxHeight,
                borderRadius: 16,
                padding: 14,
                backgroundColor: 'rgba(0,0,0,0.86)',
                borderWidth: 1,
                borderColor: 'rgba(255,255,255,0.2)'
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                {busy && <ActivityIndicator color="#fff" size="small" />}
                <Text style={{ color: msg || cameraError ? '#ffb4a8' : '#fff', fontSize: 14, fontWeight: '700' }}>
                  {status}
                </Text>
              </View>
              <Text
                style={{
                  color: msg || cameraError ? '#ffb4a8' : 'rgba(255,255,255,0.86)',
                  fontSize: 13,
                  lineHeight: 19
                }}
              >
                {statusMessage}
              </Text>
              {preferNativeScanner && nativeScannerUsed && !nativeScannerActive && !busy && (
                <Pressable onPress={launchNativeScanner} style={[ui.quiet, { alignSelf: 'flex-start', marginTop: 8 }]}>
                  <Text style={[ui.quietText, { color: '#fff' }]}>Scan again with QR scanner</Text>
                </Pressable>
              )}
              {scanHint && !externalPairing && (
                <Text style={{ color: 'rgba(255,255,255,0.72)', fontSize: 12, lineHeight: 17, marginTop: 6 }}>
                  No QR detected yet? Move closer and hold steady, or use your phone’s Camera app and tap its Inkfish
                  link.
                </Text>
              )}
              {qrSummary && (
                <Text style={{ color: 'rgba(255,255,255,0.72)', fontSize: 12, lineHeight: 17, marginTop: 6 }}>
                  {qrSummary}
                </Text>
              )}

              {cameraError && (
                <Pressable
                  onPress={() => {
                    setCameraReady(false)
                    setCameraError(null)
                    setCameraKey((key) => key + 1)
                  }}
                  style={[ui.quiet, { alignSelf: 'flex-start', marginTop: 10 }]}
                >
                  <Text style={[ui.quietText, { color: '#fff' }]}>Retry camera</Text>
                </Pressable>
              )}

              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600', marginTop: 10, marginBottom: 5 }}>
                {scanDetails.length ? `Scan log · ${scanDetails.length} entries` : 'Scan log · waiting for QR code'}
              </Text>
              {scanDetails.length ? (
                <ScrollView
                  ref={logRef}
                  style={{ height: logHeight, flexGrow: 0 }}
                  onContentSizeChange={() => logRef.current?.scrollToEnd({ animated: true })}
                  accessibilityLabel="Pairing scan log"
                >
                  <Text
                    selectable
                    style={{ color: 'rgba(255,255,255,0.82)', fontSize: 11, textAlign: 'left', lineHeight: 16 }}
                  >
                    {scanDetails.join('\n')}
                  </Text>
                </ScrollView>
              ) : (
                <Text style={{ color: 'rgba(255,255,255,0.68)', fontSize: 11, lineHeight: 16 }}>
                  QR detection, each address attempt, its result, and any final error will appear here.
                </Text>
              )}
            </View>
          </View>
        )}
      </View>
    </Modal>
  )
}
