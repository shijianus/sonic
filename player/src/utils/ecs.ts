import { CompactEncrypt, compactDecrypt, base64url } from 'jose'
import { readEcsPlaybackKey, writeEcsPlaybackKey } from './indexedDB'

export type EcsTier = 1 | 2 | 3
export type EcsTarget = 'original' | 'high' | 'standard'
export interface EcsMetadata {
  title: string
  artist: string
  album?: string
  source: string
  trackId: string
  tier: EcsTier
}
const TYPE = 'application/vnd.epocanvas.sonic+jwe'
const MAX_AUDIO = 64 * 1024 * 1024
const MAX_FILE = Math.ceil(((MAX_AUDIO + 8192) * 4) / 3) + 4096
const utf8 = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function ecsFilename(title: string, artist: string, tier: EcsTier): string {
  const clean = (s: string) =>
    Array.from(s)
      .map(c => (c.charCodeAt(0) < 32 || '/\\:*?"<>|'.includes(c) ? '_' : c))
      .join('')
      .trim()
      .slice(0, 80)
  return [clean(artist), clean(title)]
    .filter(Boolean)
    .join(' - ')
    .concat('.ecs', String(tier), '.ecs')
}

function validMeta(m: EcsMetadata): boolean {
  return Boolean(
    m &&
    typeof m.title === 'string' &&
    m.title.length <= 512 &&
    typeof m.artist === 'string' &&
    m.artist.length <= 512 &&
    (!m.album || (typeof m.album === 'string' && m.album.length <= 512)) &&
    typeof m.source === 'string' &&
    /^[a-z0-9_-]{1,30}$/.test(m.source) &&
    typeof m.trackId === 'string' &&
    m.trackId.length > 0 &&
    m.trackId.length <= 256 &&
    [1, 2, 3].includes(m.tier)
  )
}

export async function identifyEcsAudio(blob: Blob): Promise<{ mime: string; extension: string }> {
  const b = new Uint8Array(await blob.slice(0, 48).arrayBuffer())
  const text = String.fromCharCode(...b)
  if (text.startsWith('fLaC')) return { mime: 'audio/flac', extension: 'flac' }
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WAVE')
    return { mime: 'audio/wav', extension: 'wav' }
  if (text.startsWith('OggS')) return { mime: 'audio/ogg', extension: 'ogg' }
  if (text.slice(4, 8) === 'ftyp') return { mime: 'audio/mp4', extension: 'm4a' }
  if (text.startsWith('ID3') || (b[0] === 255 && (b[1] & 224) === 224 && (b[1] & 6) !== 0))
    return { mime: 'audio/mpeg', extension: 'mp3' }
  if (b[0] === 255 && (b[1] & 246) === 240) return { mime: 'audio/aac', extension: 'aac' }
  if (text.startsWith('FORM') && ['AIFF', 'AIFC'].includes(text.slice(8, 12)))
    return { mime: 'audio/aiff', extension: 'aiff' }
  if (b[0] === 26 && b[1] === 69 && b[2] === 223 && b[3] === 163)
    return { mime: 'audio/webm', extension: 'webm' }
  throw new Error('ECS_UNSUPPORTED_AUDIO')
}

async function headerTicket(file: Blob): Promise<string> {
  const prefix = await file.slice(0, 2048).text()
  const dot = prefix.indexOf('.')
  if (dot <= 0 || dot > 1800) throw new Error('INVALID_ECS_HEADER')
  const h = JSON.parse(decoder.decode(base64url.decode(prefix.slice(0, dot))))
  if (
    h.alg !== 'dir' ||
    h.enc !== 'A256GCM' ||
    h.typ !== TYPE ||
    h.ecs !== 1 ||
    typeof h.kid !== 'string' ||
    !/^[\w-]{16}\.[\w-]{50,400}$/.test(h.kid)
  )
    throw new Error('INVALID_ECS_HEADER')
  return h.kid
}
export async function isEcsFile(file: Blob): Promise<boolean> {
  try {
    await headerTicket(file)
    return true
  } catch {
    return false
  }
}

interface Grant {
  ticket?: string
  key: string
  source: string
  tier: EcsTier
}
async function grant(body: object, signal?: AbortSignal): Promise<Grant> {
  const response = await fetch('/api/music/ecs', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const result = await response.json()
  if (!response.ok) throw new Error(String(result?.error?.code || 'ECS_SERVICE_UNAVAILABLE'))
  if (
    !/^[\w-]{43}$/.test(result.key) ||
    ![1, 2, 3].includes(result.tier) ||
    typeof result.source !== 'string'
  )
    throw new Error('INVALID_ECS_RESPONSE')
  return result
}
async function importKey(raw: string) {
  return crypto.subtle.importKey(
    'raw',
    base64url.decode(raw) as Uint8Array<ArrayBuffer>,
    'AES-GCM',
    false,
    ['encrypt', 'decrypt']
  )
}
export async function encodeEcs(
  audio: Blob,
  meta: EcsMetadata,
  signal?: AbortSignal
): Promise<Blob> {
  if (!validMeta(meta) || !audio.size || audio.size > MAX_AUDIO)
    throw new Error('ECS_INVALID_INPUT_OR_SIZE')
  await identifyEcsAudio(audio)
  const license = await grant({ action: 'issue', source: meta.source, tier: meta.tier }, signal)
  if (!license.ticket || license.tier !== meta.tier) throw new Error('INVALID_ECS_RESPONSE')
  const info = utf8.encode(
    JSON.stringify({
      title: meta.title,
      artist: meta.artist,
      album: meta.album || '',
      source: license.source,
      trackId: meta.trackId,
      tier: license.tier,
    })
  )
  if (info.length > 8192) throw new Error('ECS_METADATA_TOO_LARGE')
  const payload = new Uint8Array(4 + info.length + audio.size)
  new DataView(payload.buffer).setUint32(0, info.length)
  payload.set(info, 4)
  payload.set(new Uint8Array(await audio.arrayBuffer()), 4 + info.length)
  signal?.throwIfAborted()
  const key = await importKey(license.key)
  const compact = await new CompactEncrypt(payload)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: TYPE, ecs: 1, kid: license.ticket })
    .encrypt(key)
  signal?.throwIfAborted()
  await writeEcsPlaybackKey(license.ticket, key)
  return new Blob([compact], { type: TYPE })
}

async function openAudio(file: Blob, key: CryptoKey, ticket: string) {
  if (file.size > MAX_FILE) throw new Error('ECS_FILE_TOO_LARGE')
  const { plaintext, protectedHeader } = await compactDecrypt(await file.text(), key, {
    keyManagementAlgorithms: ['dir'],
    contentEncryptionAlgorithms: ['A256GCM'],
  })
  if (
    protectedHeader.kid !== ticket ||
    protectedHeader.typ !== TYPE ||
    protectedHeader.ecs !== 1 ||
    plaintext.length < 5
  )
    throw new Error('INVALID_ECS_FILE')
  const size = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).getUint32(
    0
  )
  if (
    !size ||
    size > 8192 ||
    size + 4 >= plaintext.length ||
    plaintext.length - size - 4 > MAX_AUDIO
  )
    throw new Error('INVALID_ECS_PAYLOAD')
  const meta = JSON.parse(decoder.decode(plaintext.subarray(4, size + 4))) as EcsMetadata
  if (!validMeta(meta)) throw new Error('INVALID_ECS_METADATA')
  const bytes = new Blob([plaintext.subarray(size + 4) as Uint8Array<ArrayBuffer>])
  const { mime, extension } = await identifyEcsAudio(bytes)
  return { audio: bytes.slice(0, bytes.size, mime), meta, extension }
}
export async function decodeEcs(file: Blob): Promise<{ audio: Blob; meta: EcsMetadata }> {
  if (file.size > MAX_FILE) throw new Error('ECS_FILE_TOO_LARGE')
  const ticket = await headerTicket(file)
  const cached = await readEcsPlaybackKey(ticket)
  if (cached) return openAudio(file, cached, ticket)
  const g = await grant({ action: 'play', ticket })
  const key = await importKey(g.key)
  const decoded = await openAudio(file, key, ticket)
  if (decoded.meta.tier !== g.tier || decoded.meta.source !== g.source)
    throw new Error('INVALID_ECS_METADATA')
  await writeEcsPlaybackKey(ticket, key)
  return decoded
}
export async function exportEcs(
  file: Blob,
  target: EcsTarget
): Promise<{ audio: Blob; extension: string }> {
  if (file.size > MAX_FILE) throw new Error('ECS_FILE_TOO_LARGE')
  const ticket = await headerTicket(file)
  // The ordinary export path always verifies the current server session and export policy.
  const g = await grant({ action: 'export', ticket, target })
  const result = await openAudio(file, await importKey(g.key), ticket)
  if (result.meta.tier !== g.tier || result.meta.source !== g.source)
    throw new Error('INVALID_ECS_METADATA')
  if (target === 'original') return { audio: result.audio, extension: result.extension }
  const { encodeMp3 } = await import('./ecsMp3')
  return { audio: await encodeMp3(result.audio, target === 'high' ? 320 : 128), extension: 'mp3' }
}
