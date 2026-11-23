/** Embed the shared module in the classic app, which must also run standalone in offline HTML and worker QA. */
import { readFileSync, writeFileSync } from 'node:fs';

const web = new URL('../web/app.js', import.meta.url);
const app = readFileSync(web, 'utf8');
const source = readFileSync(new URL('../runner/share_shared.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');
const eol = app.includes('\r\n') ? '\r\n' : '\n';
const pattern = /(\/\/ BEGIN generated share core \(runner\/share_shared\.mjs\)\r?\n)[\s\S]*?(\/\/ END generated share core)/;
if (!pattern.test(app)) throw new Error('Missing share-core markers');
const built = app.replace(pattern, (_, start, end) => start + source.replace(/\r?\n/g, eol) + end);
if (built !== app) writeFileSync(web, built);
