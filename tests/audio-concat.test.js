// Assemblage de la capsule en un seul WAV
import test from 'node:test';
import assert from 'node:assert/strict';
import { concatWav, parseWav } from '../src/audio.js';
import { fixtureWav, fixtureMp3 } from './helpers.js';

test('assemblage WAV : durées additionnées, silence inséré entre les segments', () => {
  const a = fixtureWav(1);
  const b = fixtureWav(2);
  const sans = concatWav([a, b]);
  assert.equal(parseWav(sans.wav).durationSec, 3);
  const avec = concatWav([a, b, a], 0.5);
  const info = parseWav(avec.wav);
  assert.equal(info.durationSec, 5);
  assert.equal(info.sampleRate, 16000);
  assert.equal(avec.wav.readUInt32LE(4), avec.wav.length - 8);
});

test('assemblage WAV : un MP3 ou un format différent est refusé avec sa position', () => {
  assert.deepEqual(concatWav([fixtureWav(1), fixtureMp3()]), { error: 'not_pcm_wav', index: 1 });
  const autre = fixtureWav(1);
  autre.writeUInt32LE(44100, 24);
  assert.deepEqual(concatWav([fixtureWav(1), autre]), { error: 'format_mismatch', index: 1 });
});
