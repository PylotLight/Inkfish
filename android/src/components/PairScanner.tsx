import React, { useRef, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { X } from 'lucide-react-native'
import { useTheme } from '../theme'
import { Icon } from './Icon'
import type { DiscoveryUpdate } from '../lib/sync'

/**
 * Full-screen QR scanner for pairing with the Mac (Mac › Settings › Sync ›
 * Show pairing code). Calls `onCode` once per scan; stays open on failure so
 * the user can try again.
 */
export function PairScanner({
  visible,
  onClose,
  onCode
}: {
  visible: boolean
  onClose: () => void
  onCode: (
    data: string,
    onStage: (stage: string) => void,
    onDiscovery: (update: DiscoveryUpdate) => void
  ) => Promise<void>
}): React.JSX.Element {
  const { ui } = useTheme()
  const [perm, requestPerm] = useCameraPermissions()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [cameraKey, setCameraKey] = useState(0)
  const [scanDetails, setScanDetails] = useState<string[]>([])
  const [showScanDetails, setShowScanDetails] = useState(false)
  const lock = useRef(false)

  const handle = (data: string): void => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setMsg(null)
    setScanDetails(['QR code read; checking its addresses on the local network.'])
    setShowScanDetails(false)
    setStage('QR read. Checking pairing code…')
    onCode(data, setStage, (update) => {
      const message =
        update.type === 'phase'
          ? update.phase === 'qr-addresses'
            ? `Checking ${update.total} address${update.total === 1 ? '' : 'es'} from the QR code.`
            : `QR addresses did not find this Mac; scanning ${update.total} addresses across ${update.subnets.join(', ')}.`
          : update.type === 'sweep-progress'
            ? `Fallback scan checked ${update.checked} of ${update.total} addresses.`
            : update.probe.phase === 'qr-addresses'
              ? `${update.probe.host}: ${update.probe.outcome}${update.probe.status ? ` (HTTP ${update.probe.status})` : ''} · ${update.probe.ms} ms${update.probe.error ? ` · ${update.probe.error}` : ''}`
              : update.probe.outcome === 'found' ||
                  update.probe.outcome === 'other-device' ||
                  update.probe.outcome === 'http-error' ||
                  update.probe.outcome === 'invalid-response'
                ? `${update.probe.host}: ${update.probe.outcome}${update.probe.status ? ` (HTTP ${update.probe.status})` : ''} · ${update.probe.ms} ms`
                : null
      if (!message) return
      if (update.type === 'phase') {
        setStage(
          update.phase === 'qr-addresses'
            ? `Checking ${update.total} QR address${update.total === 1 ? '' : 'es'}…`
            : `Scanning ${update.total} same-subnet addresses…`
        )
      } else if (update.type === 'sweep-progress') {
        setStage(`Local scan checked ${update.checked} of ${update.total} addresses…`)
      }
      setScanDetails((current) => {
        const lines =
          update.type === 'sweep-progress'
            ? current.filter((line) => !line.startsWith('Fallback scan checked '))
            : current
        return [...lines, message].slice(-8)
      })
    })
      .catch((e: unknown) => {
        setStage(null)
        setMsg(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setBusy(false)
        // brief pause so one bad code doesn't spin
        setTimeout(() => (lock.current = false), 1200)
      })
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]}>
        {visible && perm?.granted ? (
          <CameraView
            key={cameraKey}
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={busy ? undefined : ({ data }) => handle(data)}
            onCameraReady={() => {
              setCameraReady(true)
              setCameraError(null)
            }}
            onMountError={({ message }) => {
              setCameraReady(false)
              setCameraError(message)
            }}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
            <Text style={[ui.title, { color: '#fff', textAlign: 'center' }]}>Camera access to scan the code</Text>
            <Pressable onPress={() => void requestPerm()} style={[ui.quiet, { marginTop: 12 }]}>
              <Text style={ui.quietText}>Allow camera</Text>
            </Pressable>
          </View>
        )}

        <View style={{ position: 'absolute', top: 48, left: 12 }}>
          <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close scanner" style={{ padding: 8 }}>
            <Icon as={X} size={24} color="#fff" />
          </Pressable>
        </View>

        {visible && perm?.granted && (
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

        {visible && perm?.granted && (
          <View style={{ position: 'absolute', bottom: 56, left: 24, right: 24, alignItems: 'center' }}>
            {busy ? (
              <View style={{ alignItems: 'center', gap: 10 }}>
                <ActivityIndicator color="#fff" />
                <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 14, textAlign: 'center' }}>
                  {stage ?? 'Pairing…'}
                </Text>
              </View>
            ) : cameraError ? (
              <>
                <Text style={{ color: '#ffb4a8', fontSize: 14, textAlign: 'center', lineHeight: 20 }}>
                  Camera couldn’t start: {cameraError}
                </Text>
                <Pressable
                  onPress={() => {
                    setCameraReady(false)
                    setCameraError(null)
                    setCameraKey((key) => key + 1)
                  }}
                  style={[ui.quiet, { marginTop: 12 }]}
                >
                  <Text style={[ui.quietText, { color: '#fff' }]}>Retry camera</Text>
                </Pressable>
              </>
            ) : (
              <View style={{ alignItems: 'center', gap: 8 }}>
                <Text
                  style={{
                    color: msg ? '#ffb4a8' : 'rgba(255,255,255,0.85)',
                    fontSize: 14,
                    textAlign: 'center',
                    lineHeight: 20
                  }}
                >
                  {msg ??
                    (cameraReady
                      ? 'Point your camera at the QR code on your Mac. Both devices need a network path that allows local connections.'
                      : 'Starting camera…')}
                </Text>
                {msg && (
                  <>
                    <Text
                      style={{ color: 'rgba(255,255,255,0.72)', fontSize: 12, textAlign: 'center', lineHeight: 17 }}
                    >
                      A VPN, Android proxy, guest Wi-Fi isolation, or Mac firewall can block local pairing.
                    </Text>
                    <Pressable onPress={() => setShowScanDetails((value) => !value)} hitSlop={8}>
                      <Text style={{ color: '#fff', fontSize: 13, textDecorationLine: 'underline' }}>
                        {showScanDetails ? 'Hide scan details' : 'Show scan details'}
                      </Text>
                    </Pressable>
                    {showScanDetails && (
                      <Text
                        selectable
                        style={{ color: 'rgba(255,255,255,0.8)', fontSize: 11, textAlign: 'left', lineHeight: 16 }}
                      >
                        {scanDetails.join('\n')}
                      </Text>
                    )}
                  </>
                )}
              </View>
            )}
          </View>
        )}
      </View>
    </Modal>
  )
}
