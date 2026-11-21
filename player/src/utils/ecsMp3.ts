import { parseBlob } from 'music-metadata'

/** Decode only locally and encode in a dedicated worker so the interface stays responsive. */
export async function encodeMp3(input: Blob, kbps: 128 | 320): Promise<Blob> {
  const { format } = await parseBlob(input, { duration: true, skipCovers: true })
  if (
    !format.duration ||
    !Number.isFinite(format.duration) ||
    format.duration > 600 ||
    !format.numberOfChannels ||
    format.numberOfChannels > 2
  )
    throw new Error('ECS_TRANSCODE_LIMIT')
  if (kbps === 320 && !format.lossless && (!format.bitrate || format.bitrate < 300000))
    throw new Error('ECS_HIGHER_QUALITY_UNAVAILABLE')
  const sourceRate = format.sampleRate || 0
  const rate = [48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].find(
    r => r <= sourceRate
  )
  if (!rate || (kbps === 320 && rate < 32000)) throw new Error('ECS_HIGHER_QUALITY_UNAVAILABLE')
  const ctx = new OfflineAudioContext(format.numberOfChannels, 1, rate)
  const pcm = await ctx.decodeAudioData(await input.arrayBuffer())
  if (pcm.duration > 600 || pcm.numberOfChannels > 2) throw new Error('ECS_TRANSCODE_LIMIT')
  const channels = Array.from({ length: pcm.numberOfChannels }, (_, i) =>
    pcm.getChannelData(i).slice()
  )
  const worker = new Worker(new URL('./ecsEncoder.worker.ts', import.meta.url), { type: 'module' })
  try {
    return await new Promise<Blob>((resolve, reject) => {
      worker.onmessage = e =>
        e.data instanceof Blob ? resolve(e.data) : reject(new Error('ECS_ENCODING_FAILED'))
      worker.onerror = () => reject(new Error('ECS_ENCODING_FAILED'))
      worker.postMessage(
        { channels, rate, kbps },
        channels.map(ch => ch.buffer)
      )
    })
  } finally {
    worker.terminate()
  }
}
