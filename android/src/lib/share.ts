/**
 * Share-target plumbing (Android SEND intents via `expo-share-intent`).
 *
 * A share becomes a pending capture: text (+ link if the sender split them)
 * prefilled in Capture, images staged as attachments. Nothing is written
 * until the user hits Save — dismissing drops it. Consuming calls
 * `resetShareIntent()` so the same share isn't offered twice.
 */

export interface PendingShare {
  key: string;
  text: string;
  /** Remote/local image uris to copy into assets/ at save time. */
  imageUris: string[];
  label: string;
}

interface RawShare {
  text?: string | null;
  webUrl?: string | null;
  meta?: { title?: string } | null;
  files?: Array<{ path?: string; mimeType?: string }> | null;
}

/** Compose the capture body from a raw share value. */
export function toPendingShare(share: RawShare, key: string): PendingShare | null {
  const text = (share.text ?? '').trim();
  const url = (share.webUrl ?? '').trim();
  const title = share.meta?.title?.trim() ?? '';
  const images = (share.files ?? [])
    .filter((f) => (f.mimeType ?? '').startsWith('image/') && f.path)
    .map((f) => f.path as string);

  let body = text;
  if (url && !body.includes(url)) body = body ? `${body}\n${url}` : url;
  if (!body && title) body = title;
  if (!body && images.length === 0) return null;

  const bits: string[] = [];
  if (title && !body.startsWith(title)) bits.push(`from “${title}”`);
  if (images.length > 0) bits.push(`${images.length} image${images.length > 1 ? 's' : ''}`);
  return { key, text: body, imageUris: images, label: bits.join(' · ') || 'shared text' };
}
