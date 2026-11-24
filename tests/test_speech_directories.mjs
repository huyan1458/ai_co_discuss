import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { speech_directory, speech_model_directories } from '../runner/speech_directories.mjs';
import { local_services, local_transcribe, provider_speak } from '../runner/tts_providers.mjs';

test('separate model roots serve both speech providers and retain legacy inventory paths', async t => {
  const home = mkdtempSync(join(tmpdir(), 'speech-paths-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const [id, program, port] of [['tts', 'yovoice', 11111], ['stt', 'crispasr', 22222]]) {
    assert.equal(speech_directory(home, id), join(home, program));
    const root = join(home, id + ' models');
    writeFileSync(join(home, program + '-root.txt'), root);
    const directory = join(root, program);
    mkdirSync(join(directory, 'cli'), { recursive: true });
    writeFileSync(join(directory, 'cli', program + (process.platform === 'win32' ? '.exe' : '')), '');
    writeFileSync(join(directory, 'port'), String(port));
    const paths = speech_model_directories(home).filter(item => item.id === id).map(item => item.path);
    assert.deepEqual(paths, [directory, join(home, program)]);
  }
  const state = await local_services(home, { find: async () => null, probe: async () => false });
  assert.ok(state.tts.installed && state.stt.installed);
  const spoken = await provider_speak('local', { home, key: 'test', text: 'hello', speaker: 'Vivian' }, {
    request: async url => { assert.equal(new URL(url).port, '11111'); return new Response('sound'); },
    convert: async (_, buffer) => buffer,
  });
  assert.equal(Buffer.from(spoken.audio, 'base64').toString(), 'sound');
  const recognized = await local_transcribe({ home, key: 'test', wav: Buffer.from('sound') }, {
    request: async url => { assert.equal(new URL(url).port, '22222'); return Response.json({ text: 'hello' }); },
  });
  assert.equal(recognized, 'hello');
});
