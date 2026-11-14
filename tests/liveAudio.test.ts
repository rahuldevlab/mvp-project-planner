import assert from 'node:assert/strict';
import test from 'node:test';
import { float32ToPcm16Base64, resampleFloat32 } from '../src/utils/liveAudio';

test('float32ToPcm16Base64 encodes clamped 16-bit little-endian PCM accurately', () => {
  const samples = new Float32Array([-1.5, -1.0, 0.0, 1.0, 1.5]);
  const b64 = float32ToPcm16Base64(samples);
  const buf = Buffer.from(b64, 'base64');
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);

  assert.equal(pcm.length, 5);
  assert.equal(pcm[0], -32768);
  assert.equal(pcm[1], -32768);
  assert.equal(pcm[2], 0);
  assert.equal(pcm[3], 32767);
  assert.equal(pcm[4], 32767);
});

test('resampleFloat32 passes through matching sample rate and downsamples 48kHz to 16kHz cleanly', () => {
  const input16k = new Float32Array([0.1, 0.2, 0.3, 0.4]);
  const same = resampleFloat32(input16k, 16000, 16000);
  assert.deepEqual(Array.from(same), Array.from(input16k));

  const input48k = new Float32Array(480);
  for (let i = 0; i < input48k.length; i++) {
    input48k[i] = Math.sin((i / 480) * Math.PI * 2);
  }
  const downsampled = resampleFloat32(input48k, 48000, 16000);
  assert.equal(downsampled.length, 160);
});
