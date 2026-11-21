/**
 * Run a test command without the variables the local service hands to the AI members it starts.
 *
 * A member that runs the tests from a room task inherits them: the entry key file switches every test server into
 * entry-protected mode (nearly all requests then answer 403), and the service home and access file point the tests at
 * the real service. Usage: node scripts/test_env.mjs COMMAND [ARGS...]
 */
import { spawnSync } from 'node:child_process';

const INHERITED = ['DISCUSS_ENTRY_KEY_FILE', 'DISCUSS_SERVICE_HOME', 'DISCUSS_ACCESS_FILE', 'CODISCUSS_GATEWAY_HOME'];

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: node scripts/test_env.mjs COMMAND [ARGS...]');
  process.exit(2);
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !INHERITED.includes(key.toUpperCase())));
const result = spawnSync(command, args, { stdio: 'inherit', env });
process.exit(result.status ?? 1);
