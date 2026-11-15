import { mkdirSync, writeFileSync } from 'node:fs';
import { OUTPUT_SCHEMAS, compilePrompt } from '../../../src/tree/prompts.mjs';
const target = new URL('./schemas/', import.meta.url); mkdirSync(target, { recursive: true });
for (const [role, schema] of Object.entries(OUTPUT_SCHEMAS)) writeFileSync(new URL(`${role}.json`, target), JSON.stringify(schema, null, 2) + '\n');
writeFileSync(new URL('./prompt-manifest.json', import.meta.url), JSON.stringify(['main', ...Object.keys(OUTPUT_SCHEMAS)].map(role => {
  const { text, ...record } = compilePrompt(role); return record;
}), null, 2) + '\n');
