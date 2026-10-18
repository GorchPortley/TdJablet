// Uncompressed audio parsers (WAV, AIFF, AIFF-C).
//
// Browsers decode WAV themselves, but Chrome/Android cannot decode AIFF,
// which is very common in DJ libraries, so we do it here. Output is the same
// shape everywhere in the app: { sampleRate, length, channels: Float32Array[] }.

export function parsePcm(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  if (v.byteLength < 12) return null;
  const id = fourcc(v, 0);
  const form = fourcc(v, 8);
  if ((id === 'RIFF' || id === 'RF64') && form === 'WAVE') return parseWav(v);
  if (id === 'FORM' && (form === 'AIFF' || form === 'AIFC')) return parseAiff(v, form === 'AIFC');
  return null;
}

function parseWav(v) {
  let off = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= v.byteLength) {
    const cid = fourcc(v, off);
    let size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (cid === 'fmt ') {
      let format = v.getUint16(body, true);
      const channels = v.getUint16(body + 2, true);
      const sampleRate = v.getUint32(body + 4, true);
      const blockAlign = v.getUint16(body + 12, true);
      const bits = v.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 40) format = v.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels, sampleRate, blockAlign, bits };
    } else if (cid === 'data') {
      dataOff = body;
      if (size === 0xffffffff || body + size > v.byteLength) size = v.byteLength - body; // RF64 / truncated
      dataLen = size;
    }
    off = body + size + (size & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('WAV file without fmt or data chunk');
  let kind;
  if (fmt.format === 1) kind = 'int';
  else if (fmt.format === 3) kind = 'float';
  else throw new Error(`Unsupported WAV encoding ${fmt.format}`);
  return readFrames(v, dataOff, dataLen, fmt.channels, fmt.bits, kind, true, fmt.sampleRate, fmt.blockAlign);
}

function parseAiff(v, isAifc) {
  let off = 12;
  let comm = null;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= v.byteLength) {
    const cid = fourcc(v, off);
    let size = v.getUint32(off + 4, false);
    const body = off + 8;
    if (cid === 'COMM') {
      const channels = v.getUint16(body, false);
      const frames = v.getUint32(body + 2, false);
      const bits = v.getUint16(body + 6, false);
      const sampleRate = readExtended(v, body + 8);
      let compression = 'NONE';
      if (isAifc && size >= 22) compression = fourcc(v, body + 18);
      comm = { channels, frames, bits, sampleRate, compression };
    } else if (cid === 'SSND') {
      const offset = v.getUint32(body, false);
      dataOff = body + 8 + offset;
      if (body + size > v.byteLength) size = v.byteLength - body;
      dataLen = size - 8 - offset;
    }
    off = body + size + (size & 1);
  }
  if (!comm || dataOff < 0) throw new Error('AIFF file without COMM or SSND chunk');
  let kind = 'int';
  let little = false;
  let bits = comm.bits;
  switch (comm.compression) {
    case 'NONE':
    case 'twos':
      break;
    case 'sowt':
      little = true;
      break;
    case 'fl32':
    case 'FL32':
      kind = 'float';
      bits = 32;
      break;
    case 'fl64':
    case 'FL64':
      kind = 'float';
      bits = 64;
      break;
    default:
      throw new Error(`Unsupported AIFF-C compression ${comm.compression}`);
  }
  const blockAlign = comm.channels * Math.ceil(bits / 8);
  dataLen = Math.min(dataLen, comm.frames * blockAlign);
  return readFrames(v, dataOff, dataLen, comm.channels, bits, kind, little, comm.sampleRate, blockAlign);
}

function readFrames(v, off, len, nch, bits, kind, little, sampleRate, blockAlign) {
  const bytes = Math.ceil(bits / 8);
  blockAlign = blockAlign || nch * bytes;
  const frames = Math.floor(len / blockAlign);
  const channels = [];
  for (let c = 0; c < nch; c++) channels.push(new Float32Array(frames));
  for (let c = 0; c < nch; c++) {
    const ch = channels[c];
    let p = off + c * bytes;
    if (kind === 'float' && bits === 32) {
      for (let i = 0; i < frames; i++, p += blockAlign) ch[i] = v.getFloat32(p, little);
    } else if (kind === 'float' && bits === 64) {
      for (let i = 0; i < frames; i++, p += blockAlign) ch[i] = v.getFloat64(p, little);
    } else if (bytes === 1) {
      // WAV 8-bit is unsigned, AIFF 8-bit is signed.
      if (little) for (let i = 0; i < frames; i++, p += blockAlign) ch[i] = (v.getUint8(p) - 128) / 128;
      else for (let i = 0; i < frames; i++, p += blockAlign) ch[i] = v.getInt8(p) / 128;
    } else if (bytes === 2) {
      for (let i = 0; i < frames; i++, p += blockAlign) ch[i] = v.getInt16(p, little) / 32768;
    } else if (bytes === 3) {
      for (let i = 0; i < frames; i++, p += blockAlign) {
        let s;
        if (little) s = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16);
        else s = (v.getInt8(p) << 16) | (v.getUint8(p + 1) << 8) | v.getUint8(p + 2);
        ch[i] = s / 8388608;
      }
    } else if (bytes === 4) {
      for (let i = 0; i < frames; i++, p += blockAlign) ch[i] = v.getInt32(p, little) / 2147483648;
    } else {
      throw new Error(`Unsupported sample size ${bits} bits`);
    }
  }
  return { sampleRate, length: frames, channels };
}

/** 80-bit IEEE 754 extended precision float (AIFF sample rate). */
function readExtended(v, off) {
  const se = v.getUint16(off, false);
  const sign = se & 0x8000 ? -1 : 1;
  const exp = se & 0x7fff;
  const hi = v.getUint32(off + 2, false);
  const lo = v.getUint32(off + 6, false);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  const mant = hi * 4294967296 + lo;
  return sign * mant * Math.pow(2, exp - 16383 - 63);
}

export function fourcc(v, off) {
  return String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
}
