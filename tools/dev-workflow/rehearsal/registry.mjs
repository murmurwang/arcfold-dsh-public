import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { bundle, hash, registryOrigin, newer } from './fixture.mjs';

const [control] = process.argv.slice(2);
assert.ok(control);
const records = new Map(), blobs = new Map();
for (const row of bundle.packages) {
  const file = new URL(row.file, import.meta.url);
  const data = readFileSync(file);
  assert.equal(hash(data), row.sha256, 'Archive differs from the rehearsal receipt');
  const key = Buffer.from(row.name + '@' + row.version).toString('base64url');
  const app = row.name.startsWith('@arcfold/');
  const dist = { integrity: row.integrity, shasum: createHash('sha1').update(data).digest('hex'),
    tarball: registryOrigin + '/tar/' + key };
  const record = { file, manifest: { ...row.manifest, dist }, app };
  if (!records.has(row.name)) records.set(row.name, []);
  records.get(row.name).push(record);
  blobs.set(key, record);
}
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const server = createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, { error: 'read-only source' });
    const path = decodeURIComponent(new URL(req.url, registryOrigin).pathname.slice(1));
    if (path === '-/ping') return send(res, 200, {});
    const { latest, failDownload } = JSON.parse(readFileSync(control, 'utf8'));
    const visible = row => !row.app || row.manifest.version !== newer || latest === newer;
    if (path.startsWith('tar/')) {
      const row = blobs.get(path.slice(4));
      if (!row || !visible(row)) return send(res, 404, { error: 'archive unavailable' });
      const selected = row.manifest.name + '@' + row.manifest.version;
      if (failDownload === selected) {
        console.log(JSON.stringify({ event: 'download-failed', package: selected }));
        return send(res, 503, { error: 'synthetic registry failure' });
      }
      if (row.app && req.method === 'GET') console.log(JSON.stringify({ event: 'download', package: selected }));
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      if (req.method === 'HEAD') return res.end();
      await pipeline(createReadStream(row.file), res);
      return;
    }
    const versions = Object.fromEntries((records.get(path) ?? []).filter(visible).map(row => [row.manifest.version, row.manifest]));
    const names = Object.keys(versions);
    if (!names.length) return send(res, 404, { error: 'no locked package' });
    const picked = path.startsWith('@arcfold/') ? latest : names.at(-1);
    const time = Object.fromEntries(names.map(name => [name, '2026-10-20T00:00:00.000Z']));
    send(res, 200, { name: path, versions, time, 'dist-tags': { latest: picked } });
  } catch (error) {
    if (res.headersSent) res.destroy(error);
    else send(res, 500, { error: 'local source error' });
  }
});
server.listen(Number(new URL(registryOrigin).port), '127.0.0.1');
