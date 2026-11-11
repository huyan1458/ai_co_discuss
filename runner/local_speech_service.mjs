/**
 * Supervisor of a local speech service (read-aloud's yovoice, voice input's CrispASR): runs it and stops it once its
 * lease has not been renewed for a minute, or was released. The runner renews the lease (touches `<service dir>/lease`)
 * on every request, so the service lives while it is used and ends after, also when the runner that started it exited
 * or crashed. Started detached by `runner/tts_providers.mjs`:
 *   node local_speech_service.mjs <service dir> <executable> [arguments...]
 * The service's token comes in the environment and passes on to it; its output is appended to `<service dir>/serve.log`.
 * The runner records the port it chose in `<service dir>/port` before starting this; once the service ends the record is
 * removed, unless a later start has recorded another port meanwhile.
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LEASE_MS = 60_000;
const CHECK_MS = 5_000;

const [directory, executable, ...service_arguments] = process.argv.slice(2);
const port_path = join(directory, 'port');
let recorded_port = '';
try { recorded_port = readFileSync(port_path, 'utf8'); } catch { /* Started without a record. */ }
const log = openSync(join(directory, 'serve.log'), 'a');
const service = spawn(executable, service_arguments, { windowsHide: true, stdio: ['ignore', log, log] });
closeSync(log);
// The service exiting (stopped here, failed to start, port taken) ends the supervisor; its inference process exits with it.
service.on('exit', () => process.exit(0));
service.on('error', () => process.exit(1));
const stop = () => service.kill();
const forget_port = () => {
  try { if (readFileSync(port_path, 'utf8') === recorded_port) rmSync(port_path); } catch { /* Already gone. */ }
};
process.on('exit', () => { stop(); forget_port(); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);

setInterval(() => {
  let renewed = 0;
  try { renewed = statSync(join(directory, 'lease')).mtimeMs; } catch { /* No lease: expired. */ }
  if (Date.now() - renewed > LEASE_MS) stop();
}, CHECK_MS);
