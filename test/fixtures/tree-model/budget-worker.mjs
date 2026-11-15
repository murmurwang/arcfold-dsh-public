import { TreeTestLedger } from '../../../src/tree/experiment-budget.mjs';
import { authorizationRef, reservation } from './budget.mjs';
const [filename, serialized, id] = process.argv.slice(2), manifest = JSON.parse(serialized);
const ledger = new TreeTestLedger({ filename, authorizationRef, manifest });
process.send({ ready: true });
process.once('message', () => {
  try { ledger.reserve(reservation(id, 'roles', manifest)); process.send({ ok: true }); }
  catch (error) { process.send({ ok: false, code: error.code }); }
  finally { ledger.close(); process.disconnect(); }
});
