import { readFileSync, realpathSync, mkdtempSync, writeFileSync, openSync, closeSync, unlinkSync, rmdirSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeepSeekAdapter, registerDeepSeekProvider } from '@deepseek-ai/dsh-llm-deepseek';
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { canonicalJson, digest, fail } from './contracts.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const projection = options => ({ provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort,
  maxTokens: options.maxTokens, messages: options.messages, tools: options.tools ?? [], toolHistory: options.toolHistory ?? null });

/** Runs the actual patched serializer with a capture-only sender, then the
 * official offline converter. The final authority guard consumes only an exact
 * cached measurement for those same native bytes; no network fallback exists. */
export class TreeTokenCounter {
  constructor({ python, moduleDirectory, adapter = { DeepSeekAdapter, registerDeepSeekProvider } }) {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('TOKENIZER_PLATFORM', 'This frozen dependency has only been validated on macOS arm64');
    if (!isAbsolute(python ?? '') || !isAbsolute(moduleDirectory ?? '')) fail('TOKENIZER_CONFIG', 'Explicit interpreter and private dependency directory required');
    if (adapter.registerDeepSeekProvider?.transportSeam !== 'deepseek-messages-create-transport-v1' || typeof adapter.DeepSeekAdapter !== 'function') fail('TOKENIZER_ADAPTER', 'Exact capture transport patch required');
    this.DeepSeekAdapter = adapter.DeepSeekAdapter;
    this.python = realpathSync(python); this.moduleDirectory = moduleDirectory; this.cache = new Map();
    const manifest = JSON.parse(readFileSync(join(directory, 'tokenizer-resources/manifest.json'), 'utf8'));
    this.identity = digest({ manifest, interpreter: digest(readFileSync(this.python).toString('base64')), protocol: 'official-messages-v4-v41-text-only' });
    this.invoke('initialize');
    this.connection = resolveAdapterOptions({ baseURL: 'https://api.deepseek.com/anthropic', apiKeyEnv: 'OFFLINE_NO_CREDENTIAL',
      maxTokens: 8192, reasoningEffort: 'off', models: Object.keys(manifest.modelMappings).map(id => ({ id, contextWindow: 1000000, maxTokens: 131072, inputModalities: ['text'] })),
      retryPolicy: { mode: 'normal', maxRetries: 0 } }, createLaunchEnvironmentSnapshot([]));
  }
  invoke(mode, body) {
    // macOS spawnSync's large stdin pipe intermittently stalled on identical
    // frozen requests. An unlinked private regular file avoids that feed pipe;
    // Python still reads the exact canonical bytes from fd0. No longer deadline
    // or estimate fallback: failed measurements remain known-unsent failures.
    let inputDirectory, inputPath, inputFd, result;
    try {
      if (body !== undefined) {
        inputDirectory = mkdtempSync(join(this.moduleDirectory, '.counter-input-'));
        inputPath = join(inputDirectory, 'request.json');
        writeFileSync(inputPath, canonicalJson(body), { mode: 0o600, flag: 'wx' });
        inputFd = openSync(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        unlinkSync(inputPath); inputPath = undefined;
      }
      result = spawnSync(this.python, ['-I', '-B', join(directory, 'token-counter.py'), mode, this.moduleDirectory], {
        stdio: [inputFd ?? 'ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
        env: { PATH: dirname(this.python), TOKENIZERS_PARALLELISM: 'false' },
      });
    } finally {
      if (inputFd !== undefined) closeSync(inputFd);
      if (inputPath) { try { unlinkSync(inputPath); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      if (inputDirectory) rmdirSync(inputDirectory);
    }
    if (result.error || result.status !== 0) fail('TOKENIZER_UNAVAILABLE', result.error?.message ?? result.stderr.slice(-3000));
    return JSON.parse(result.stdout);
  }
  async prepare(options) {
    const key = digest(projection(options)), old = this.cache.get(key); if (old) return old;
    if (options.messages.some(m => m.content.some(b => !['text', 'reasoning', 'tool-call', 'tool-addition', 'tool-removal'].includes(b.type)))) fail('TOKENIZER_CONTENT', 'Text-only counter refuses images and unknown content');
    let wire; const captured = new Error('OFFLINE_SERIALIZATION_CAPTURED');
    const adapter = new this.DeepSeekAdapter({ options: () => this.connection, resolveFiles: () => ({}), resolveAuth: async () => ({ headers: {} }), resolveUserId: () => 'offline-counter',
      prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
      createTransport: () => ({ send: async (_url, init) => { wire = JSON.parse(init.body); throw captured; } }) });
    try { for await (const _ of adapter.request(options, this.connection, options.signal ?? new AbortController().signal, () => {})) fail('TOKENIZER_ADAPTER', 'Capture must not produce model chunks'); }
    catch (error) { if (error !== captured) throw error; }
    if (!wire) fail('TOKENIZER_ADAPTER', 'Actual adapter did not produce a wire request');
    const result = this.invoke('count', wire);
    if (!Number.isSafeInteger(result.tokens) || result.tokens < 0) fail('TOKENIZER_RESULT', 'Exact counter returned an invalid count');
    const reading = { kind: 'exact', tokens: result.tokens, inputHash: key, wireHash: digest(wire), tokenizerIdentity: this.identity };
    if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, reading); return reading;
  }
  count(options) { const reading = this.cache.get(digest(projection(options))); if (!reading) fail('EXACT_TOKEN_COUNT_REQUIRED', 'Current native input has no exact offline measurement'); return reading.tokens; }
  request(options) { return projection(options); }
}
