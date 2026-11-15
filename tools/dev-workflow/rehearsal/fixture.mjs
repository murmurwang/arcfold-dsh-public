import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const bundle = JSON.parse(readFileSync(new URL('./bundle.json', import.meta.url), 'utf8'));
export const { candidate, older, newer } = bundle;
export const hostVersion = '0.2.2-rc.1';
export const registryOrigin = 'http://127.0.0.1:48619';
export const modelOrigin = 'http://127.0.0.1:48620';
export const modelEndpoint = modelOrigin + '/anthropic/v1/messages';
export const goal = '核对 Arcfold 更新是否保留测试目标';
export const message = '请建立测试目标「' + goal + '」，我们更新插件后再回来核对。';
export const answer = '这是本机合成回复。我们会更新 Arcfold 后再核对这段会话和目标。';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const dummyKey = hash('Arcfold loopback demonstration ' + bundle.id).slice(0, 48);
