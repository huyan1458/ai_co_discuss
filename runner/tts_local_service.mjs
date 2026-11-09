/**
 * Supervisor of the local speech service: runs `yovoice serve` and stops it once its lease has not been renewed for a
 * minute, or was released. The runner renews the lease (touches `<yovoice dir>/lease`) on every read-aloud request, so the service
 * lives while reading goes on and ends after reading stops, also when the runner that started it exited or crashed.
 * Started detached by `runner/tts_providers.mjs`:
 *   node tts_local_service.mjs <yovoice executable> <yovoice dir> <host:port>
 * The token comes in YOVOICE_API_TOKEN and passes on to the service; its output is appended to `<yovoice dir>/serve.log`.
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LEASE_MS = 60_000;
const CHECK_MS = 5_000;

const [executable, directory, host] = process.argv.slice(2);
const log = openSync(join(directory, 'serve.log'), 'a');
const service = spawn(executable, ['serve', '--listen', host, '--data-dir', join(directory, 'data')], { windowsHide: true, stdio: ['ignore', log, log] });
closeSync(log);
// The service exiting (stopped here, failed to start, port taken) ends the supervisor; its inference process exits with it.
service.on('exit', () => process.exit(0));
service.on('error', () => process.exit(1));
const stop = () => service.kill();
process.on('exit', stop);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);

setInterval(() => {
  let renewed = 0;
  try { renewed = statSync(join(directory, 'lease')).mtimeMs; } catch { /* No lease: expired. */ }
  if (Date.now() - renewed > LEASE_MS) stop();
}, CHECK_MS);
