import { TreeRepository } from '../../../src/tree/repository.mjs';
import { TreeService } from '../../../src/tree/tree.mjs';
const repo = new TreeRepository({ treeFilename: process.argv[2], userId: 'fixture-user' });
const tree = new TreeService({ repository: repo, context: () => ({ actor: { kind: 'user', id: 'fixture-user' } }), resolveSource: () => null });
process.send({ ready: true });
process.once('message', command => {
  try { process.send({ ok: true, result: tree.setStatus(command).result }); }
  catch (e) { process.send({ ok: false, code: e.code, status: e.status }); }
  finally { repo.close(); process.disconnect(); }
});
