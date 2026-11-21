import { Mp3Encoder } from '@breezystack/lamejs'

function pcm16(channel: Float32Array, start: number) {
  return Int16Array.from(channel.subarray(start, start + 1152), value => {
    const sample = Math.max(-1, Math.min(1, value))
    return Math.round(sample * (sample < 0 ? 32768 : 32767))
  })
}
self.onmessage = ({ data }: MessageEvent<{channels: Float32Array[]; rate: number; kbps: number}>) => {
  const { channels, rate, kbps } = data
  const encoder = new Mp3Encoder(channels.length, rate, kbps)
  const frames: ArrayBuffer[] = []
  for (let offset = 0; offset < channels[0].length; offset += 1152) {
    const packet = encoder.encodeBuffer(pcm16(channels[0], offset), channels[1] && pcm16(channels[1], offset))
    if (packet.length) frames.push(new Uint8Array(packet).buffer)
  }
  frames.push(new Uint8Array(encoder.flush()).buffer)
  self.postMessage(new Blob(frames, { type: 'audio/mpeg' }))
}
