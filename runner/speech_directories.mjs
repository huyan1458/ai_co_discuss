import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const programs = { tts: 'yovoice', stt: 'crispasr' };

/** Resolve the installation used by this computer. Installers record each chosen parent independently. */
export function speech_directory(home, id) {
  const program = programs[id];
  let parent;
  try { parent = readFileSync(join(home, program + '-root.txt'), 'utf8').trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (parent && !isAbsolute(parent)) throw new Error('Invalid absolute path in ' + program + '-root.txt');
  return resolve(parent || home, program);
}

/** Return unique active and legacy installation paths for on-disk usage accounting. */
export function speech_model_directories(home) {
  return Object.entries(programs).flatMap(([id, program]) =>
    [...new Set([speech_directory(home, id), resolve(home, program)])].map(path => ({ id, program, path })));
}
