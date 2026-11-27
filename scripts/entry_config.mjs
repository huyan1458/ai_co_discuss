import { writeFileSync } from 'node:fs';
import { experimental_readRawConfig as read } from 'wrangler';

// Run from the checkout root. Copy only DB, never other private Pages settings.
const pages = read({ config: '.wrangler/deploy/wrangler.jsonc' }).rawConfig;
const binding = pages.d1_databases?.find(item => item.binding === 'DB');
if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(binding?.database_id || '')) {
  throw new Error('Missing DB database_id in .wrangler/deploy/wrangler.jsonc');
}
const entry = read({ config: 'deploy/entry.wrangler.jsonc' }).rawConfig;
// deploy/ and .wrangler/ are siblings, so relative paths in the template stay valid.
writeFileSync('.wrangler/entry.json', JSON.stringify({ ...entry, d1_databases: [binding] }, null, 2));
