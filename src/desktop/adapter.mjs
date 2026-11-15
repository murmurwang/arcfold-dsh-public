import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// An exact copy of the audited upstream package with the existing transport
// seam applied. This is owned by Arcfold; it never patches Desktop's packages.
const url = new URL('./vendor/deepseek-0.2.2-rc.1.mjs', import.meta.url);
const expected = 'fc27ceacbed59c8d32100f3aa41cf79e1acab403ac0bc12b0e7f807a6274c752';
export async function loadDesktopDeepSeekAdapter() {
  const actual = createHash('sha256').update(readFileSync(url)).digest('hex');
  if (actual !== expected) throw new Error('The private Desktop DeepSeek adapter does not match its audited source');
  const adapter = await import(url.href);
  if (adapter.registerDeepSeekProvider?.transportSeam !== 'deepseek-messages-create-transport-v1' ||
      typeof adapter.DeepSeekAdapter !== 'function' || typeof adapter.catalogModelInfo !== 'function')
    throw new Error('The private Desktop DeepSeek adapter lacks the required transport interface');
  return adapter;
}
