/**
 * Приведение аудиофайла к формату IVR (WAV PCM 16 бит, моно, 8 кГц) в браузере: декодирование любого
 * поддерживаемого браузером формата (mp3, wav, ogg, m4a…) и передискретизация через OfflineAudioContext.
 * Так на сервере не нужен ffmpeg/sox (офлайн-комплект, M-NFR-10), а Asterisk играет файл без перекодирования.
 */
export async function toIvrWav(file: Blob): Promise<Blob> {
  const data = await file.arrayBuffer();
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(data);
  } finally {
    void ctx.close();
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * 8000));
  const off = new OfflineAudioContext(1, frames, 8000);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return new Blob([wavPcm16(out.getChannelData(0), 8000)], { type: 'audio/wav' });
}

export function wavPcm16(samples: Float32Array, rate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
