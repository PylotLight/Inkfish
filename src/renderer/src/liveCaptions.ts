/**
 * Moonshine streaming captions while dictating. Purely a preview: the saved
 * transcript still comes from the chosen engine once recording stops.
 */
import { loadAudioPrefs } from './audio'
import { moonshineModule } from './webStt'

export interface LiveCaptions {
  stop: () => Promise<void>
}

export async function startLiveCaptions(onText: (text: string) => void): Promise<LiveCaptions> {
  const { MicTranscriber, Transcriber, ModelArch } = await import('@moonshine-ai/moonshine-wasm')
  const transcriber = await Transcriber.load({
    language: 'en',
    modelArch: ModelArch.SmallStreaming,
    moduleOptions: await moonshineModule()
  })
  const done: string[] = []
  const { inputId } = loadAudioPrefs()
  const mic = new MicTranscriber()
    .useTranscriber(transcriber)
    .audioConstraints(inputId ? { deviceId: { exact: inputId } } : true)
    .onText((t) => onText([...done, t].join(' ').trim()))
    .onLine((l) => {
      done.push(l.text.trim())
      onText(done.join(' '))
    })
  await mic.start()
  return {
    stop: async () => {
      await mic.stop().catch(() => undefined)
      mic.close()
      transcriber.close()
    }
  }
}
