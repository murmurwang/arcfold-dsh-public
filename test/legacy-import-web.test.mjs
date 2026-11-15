// Real native receipt/attachment services, fixture live Agents and owner context.
// The installed browser proof separately exercises HTTP authentication and UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import { FileUploads } from '@deepseek-ai/dsh-client-file-upload';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import { BusinessStore } from '../src/business.mjs';
import { ImportService } from '../src/importer.mjs';
import { createImportHandler,importInvocations } from '../packages/method-ui/src/import-host.mjs';

const live=()=>new AbortController().signal;
const original=JSON.stringify({readOnly:true,snapshot:{runs:{r:{id:'r',request:'  测试原话\n  ',answer:'保存回答',status:'complete',createdAt:'2026-01-01T00:00:00Z'}},states:{}}});
async function setup(t){
  const ctx=new Context(),agents=new Map(),owner={id:'owner',principal:{kind:'owner'},interactions:'answer',signal:live()};
  let prompts=0;const routes=[];
  const connection={browserPeer:owner,fetch:{register(route){routes.push(route);return()=>{};}}};
  ctx.provide('agents',agents);ctx.provide('connection',connection);
  ctx.provide('commands',{registerFileReceiptResolver(){return()=>{};},prompt(){prompts++;throw new Error('must not prompt');}});
  const attachments=new LocalAttachmentStore(ctx,{dshHome:mkdtempSync(join(tmpdir(),'legacy-import-native-'))}),uploads=new FileUploads(ctx);
  const agent={id:'main',ctx:{preset:'arcfold-main'},session:{header:{origin:'main'}}};agents.set(agent.id,agent);
  const presets={composedPreset:agentContext=>agentContext.preset};
  const business=new BusinessStore({filename:':memory:'}),imports=new ImportService({business});
  const f={ctx,agents,owner,connection,attachments,uploads,agent,presets,business,imports,get prompts(){return prompts;}};
  f.handler=(override={})=>createImportHandler({imports,connection,agents,agentPresets:presets,fileUploads:uploads,attachments,...override});
  f.upload=async(sessionId='main')=>uploads.uploadStream({sessionId,name:'synthetic.json',signal:live(),data:(async function*(){yield Buffer.from(original);})()});
  t.after(async()=>{await imports.close();business.close();await ctx.fiber.dispose();});return f;
}
const request=(receiptId,extra={})=>({sessionId:'main',receiptId,requestId:'prepare-one',scopeMap:[],...extra});

test('native stream upload receipt leads to bounded owner preview before any chat; no prompt or binding required',async t=>{
  const f=await setup(t),uploaded=await f.upload();
  assert.equal(typeof uploaded.receiptId,'string');assert.match(uploaded.file.attachmentId,/^sha256:/);
  const handle=f.handler(),batch=await handle('prepare',request(uploaded.receiptId),live(),f.owner);
  assert.equal(batch.status,'ready');assert.equal(batch.counts.sources,2);assert.equal(f.prompts,0);assert.equal(f.business.listAll('host_bindings').length,0);
  const sources=await handle('details',{sessionId:'main',batchId:batch.id,view:'sources'},live(),f.owner);
  assert.equal(sources.items[0].textPreview,'  测试原话\n  ');
  assert.equal(importInvocations.length,5);assert.equal(importInvocations.every(row=>row.invocation.kind==='direct'),true);
  await handle('confirm',{sessionId:'main',batchId:batch.id,expectedRevision:batch.revision,previewHash:batch.previewHash,requestId:'confirm'},live(),f.owner);
  assert.equal(f.prompts,0);assert.equal(f.business.listAll('learning_pending').length,0);
});
test('nonowner, cancelled, cold/nonmain sessions, foreign receipts and client path/reference spoofing are rejected',async t=>{
  const f=await setup(t),uploaded=await f.upload(),handle=f.handler();
  for(const peer of [{...f.owner},{...f.owner,principal:{kind:'agent'}},{...f.owner,signal:AbortSignal.abort()}])
    await assert.rejects(handle('prepare',request(uploaded.receiptId),live(),peer),e=>e.code==='trusted_browser_required');
  await assert.rejects(handle('prepare',request(uploaded.receiptId),AbortSignal.abort(),f.owner),e=>e.code==='trusted_browser_required');
  await assert.rejects(handle('prepare',request(uploaded.receiptId,{sessionId:'cold'}),live(),f.owner),e=>e.code==='import_session_denied');
  for(const extra of [{path:'/private'},{file:uploaded.file},{attachment:uploaded.file},{userIdentity:'owner'}])
    await assert.rejects(handle('prepare',request(uploaded.receiptId,extra),live(),f.owner),e=>e.code==='invalid_import_request');
  const foreign={id:'foreign',ctx:{preset:'arcfold-main'},session:{header:{origin:'main'}}};f.agents.set(foreign.id,foreign);
  const other=await f.upload('foreign');await assert.rejects(handle('prepare',request(other.receiptId),live(),f.owner),e=>e.code==='import_receipt_denied');
  f.agent.ctx.preset='arcfold-learner';await assert.rejects(handle('prepare',request(uploaded.receiptId),live(),f.owner),e=>e.code==='import_session_denied');
  assert.equal(f.business.listAll('import_batches').length,0);assert.equal(f.prompts,0);
});
test('native EOF digest corruption and Agent replacement after final bytes cannot become confirmable',async t=>{
  const f=await setup(t),uploaded=await f.upload();
  const bad=Buffer.from(original);bad[bad.length-2]=bad[bad.length-2]===32?9:32;
  chmodSync(f.attachments.fileHostPath(uploaded.file),0o600); // only this new synthetic attachment
  writeFileSync(f.attachments.fileHostPath(uploaded.file),bad);
  const failed=await f.handler()('prepare',request(uploaded.receiptId),live(),f.owner);assert.equal(failed.status,'failed');assert.equal(failed.previewHash,null);
  // Fresh store content is restored only for this synthetic fixture.
  writeFileSync(f.attachments.fileHostPath(uploaded.file),Buffer.from(original));
  const attachments={async *readFileStream(ref,signal){for await(const chunk of f.attachments.readFileStream(ref,signal))yield chunk;
    f.agents.set('main',{id:'main',ctx:{preset:'arcfold-main'},session:{header:{origin:'main'}}});}};
  const stale=await f.handler({attachments})('prepare',request(uploaded.receiptId,{requestId:'replacement'}),live(),f.owner);
  assert.equal(stale.status,'failed');assert.equal(stale.previewHash,null);assert.equal(f.business.listAll('events').length,0);
});

test('read-only importer admission never resolves an Agent or attachment and ignores stale bindings',async t=>{
  const f=await setup(t);let resolutions=0;
  f.agents.resolveAgent=()=>{resolutions++;throw new Error('must not wake cold session');};
  const handle=f.handler({fileUploads:{resolve(){throw new Error('browse must not resolve receipt');}}});
  const empty=await handle('list',{sessionId:'main'},live(),f.owner);assert.equal(empty.total,0);
  f.business.storage.save('host_bindings',{id:'cold',role:'main'});
  await assert.rejects(handle('list',{sessionId:'cold'},live(),f.owner),e=>e.code==='import_session_denied');
  const spoof=f.handler({agents:{get:()=>({id:'other',ctx:{preset:'arcfold-main'}})}});
  await assert.rejects(spoof('list',{sessionId:'main'},live(),f.owner),e=>e.code==='import_session_denied');
  assert.equal(resolutions,0);assert.equal(f.prompts,0);
});
