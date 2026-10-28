import React, { useRef, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { X } from 'lucide-react-native'
import { useTheme } from '../theme'
import { Icon } from './Icon'

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
  onCode: (data: string) => Promise<void>
}): React.JSX.Element {
  const { ui } = useTheme()
  const [perm, requestPerm] = useCameraPermissions()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [cameraKey, setCameraKey] = useState(0)
  const lock = useRef(false)

  const handle = (data: string): void => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setMsg(null)
    onCode(data)
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : String(e)))
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
              <ActivityIndicator color="#fff" />
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
                    ? 'Point your camera at the QR code on your Mac. Both devices should be on the same Wi-Fi.'
                    : 'Starting camera…')}
              </Text>
            )}
          </View>
        )}
      </View>
    </Modal>
  )
}
