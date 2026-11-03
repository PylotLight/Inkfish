import * as ImagePicker from 'expo-image-picker'
import { imageAttachmentsFromPickerResult } from './imageAttachments'
import type { PendingImageAttachment } from './imageAttachments'

export async function pickImageAttachments(): Promise<PendingImageAttachment[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: 10,
    quality: 1
  })
  return imageAttachmentsFromPickerResult(result)
}
