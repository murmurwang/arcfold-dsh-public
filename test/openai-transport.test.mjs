import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { ProxyAgent } from 'undici';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { OpenAIUsageLedger } from '../src/openai-usage.mjs';
import { OpenAITransport } from '../src/openai-transport.mjs';
import { ResponsesReceipt, responsesUsage } from '../src/openai-receipt.mjs';
import { DeepSeekTransport } from '../src/deepseek-transport.mjs';
import { BudgetLedger } from '../src/budget.mjs';
import { DomainError } from '../src/store.mjs';
const model = 'gpt-6-astra', provider = 'openai';
const policy = { contextWindow: 1024, maxOutputTokens: 64, requestMaxTokens: 32, reasoningEfforts: ['high'] };
const authorization = { scope:'web-openai', webAuthorization:{ authorizationRef:'fixture-web-only',
  authorizedAt:'2026-11-07T00:00:00Z', authorizationEvidence:'Synthetic explicit web authorization, independent of DeepSeek 150.' } };
const raw = { input_tokens:11, output_tokens:5, total_tokens:16,
  input_tokens_details:{cached_tokens:3}, output_tokens_details:{reasoning_tokens:2} };
const options = id => ({ provider, model, reasoningEffort:'high', maxTokens:32, sessionId:id,
  messages:[{role:'user',content:[{type:'text',text:id}]}] });
const body = (extra={}) => JSON.stringify({ model, stream:true, store:false, max_output_tokens:32,
  reasoning:{effort:'medium',summary:'auto'}, include:['reasoning.encrypted_content'],
  input:[{role:'user',content:[{type:'input_text',text:'fixture'}]},
    {type:'configuration_update',reasoning:{effort:'high'}}], ...extra });
const init = (value=body()) => ({method:'POST',headers:{authorization:'Bearer sk-fixture-not-real','content-type':'application/json'},body:value});
const ev = value => 'event: '+value.type+'\ndata: '+JSON.stringify(value)+'\n\n';
const payload = (usage=raw, extra={}) => ev({type:'response.created',response:{id:'resp_fixture',model}})+
  ev({type:extra.type??'response.completed',response:{id:'resp_fixture',model,status:'completed',usage,...extra.response}});
const respond = value => (req,res) => {req.resume();req.on('end',()=>res.writeHead(200,{'content-type':'text/event-stream'}).end(value));};
async function fixture(t, handler=respond(payload()), extra={}) {
  const directory=await mkdtemp(join(tmpdir(),'arcfold-responses-evidence-')); t.diagnostic('Retained Responses evidence: '+directory);
  let count=0; const server=createServer((req,res)=>{count++;handler(req,res);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const endpoint='http://127.0.0.1:'+server.address().port+'/v1/responses';
  const filename=join(directory,'usage.sqlite'), ledger=new OpenAIUsageLedger(filename,{...authorization,create:true});
  const config={ledger,artifactDirectory:join(directory,'receipts'),provider,modelPolicies:{[model]:policy},
    endpoint,allowLocalTestEndpoint:true,timeoutMs:2000,requestIdentity:o=>({requestId:o.sessionId,metadata:{role:'main',sessionId:o.sessionId}}),...extra};
  const transport=new OpenAITransport(config);
  t.after(async()=>{await transport.close(); ledger.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  return {directory,filename,endpoint,ledger,config,transport,calls:()=>count};
}
const key=id=>createHash('sha256').update(id).digest('hex');
test('raw input includes cached tokens; fragmented original bytes settle before terminal exposure and cold recover', async t=>{
  const bytes=Buffer.from(payload()), f=await fixture(t,(req,res)=>{req.resume();req.on('end',()=>{
    res.writeHead(200,{'content-type':'text/event-stream'});res.write(bytes.subarray(0,17));setImmediate(()=>res.end(bytes.subarray(17)));});});
  const response=await f.transport.createTransport(options('settled')).fetch(f.endpoint,init());
  const received=await response.text();assert.equal(received,bytes.toString());assert.equal(f.calls(),1);
  assert.deepEqual(f.ledger.get('settled').usage,{promptTokens:11,completionTokens:5,cachedTokens:3});
  const dir=join(f.directory,'receipts',key('settled'));
  assert.deepEqual(await readFile(join(dir,'response-body.bin')),bytes);
  const receipt=JSON.parse(await readFile(join(dir,'receipt.json'),'utf8'));
  assert.deepEqual(receipt.rawUsage,raw);assert.equal(receipt.responseHash,createHash('sha256').update(bytes).digest('hex'));
  await f.transport.close(); const reopened=new OpenAITransport(f.config);
  try { assert.deepEqual((await reopened.recover({exclusive:true})).settled,['settled']);assert.equal(f.calls(),1); }
  finally {await reopened.close();}
});
test('length-limited complete usage can settle; unsupported incomplete/failed/missing/contradictory receipts cannot', async t=>{
  const good=payload(raw,{type:'response.incomplete',response:{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}});
  const p=new ResponsesReceipt();p.push(Buffer.from(good));assert.equal(p.finish().stopReason,'max_output_tokens');
  for(const data of [
    payload({...raw,input_tokens_details:undefined}),
    payload({...raw,total_tokens:99}),
    payload(raw,{type:'response.incomplete',response:{status:'incomplete',incomplete_details:{reason:'content_filter'}}}),
    payload(raw,{type:'response.failed',response:{status:'failed'}}),
    payload()+ev({type:'response.completed',response:{id:'resp_fixture',model,status:'completed',usage:raw}}),
    payload()+'not a receipt',
  ]) {
    const f=await fixture(t,respond(data));await assert.rejects(async()=>{const r=await f.transport.createTransport(options('invalid')).fetch(f.endpoint,init());await r.text();});
    assert.equal(f.ledger.get('invalid').status,'unknown');assert.equal(f.calls(),1);
  }
  assert.throws(()=>responsesUsage({input_tokens:8,output_tokens:5}),{code:'invalid_provider_receipt'});
});
for(const status of [307,401,421,429,500]) test('HTTP '+status+' preserves unknown and makes one actual request without redirect or retry',async t=>{
  const f=await fixture(t,(req,res)=>{req.resume();req.on('end',()=>res.writeHead(status,{location:'/v1/responses'}).end('original failure '+status));});
  const local=f.transport.createTransport(options('http-'+status));
  const r=await local.fetch(f.endpoint,init());assert.equal(r.status,status);assert.equal(await r.text(),'original failure '+status);
  assert.equal(f.calls(),1);assert.equal(f.ledger.get('http-'+status).status,'unknown');
  await assert.rejects(local.fetch(f.endpoint,init()),{code:'request_already_dispatched'});assert.equal(f.calls(),1);
});
test('frozen endpoint/config/server tools and implicit redirect overrides are rejected before reservation',async t=>{
  const f=await fixture(t);
  for(const extra of [{store:true},{service_tier:'priority'},{max_output_tokens:16},{tools:[{type:'web_search'}]}])
    await assert.rejects(f.transport.createTransport(options('wire-'+JSON.stringify(extra))).fetch(f.endpoint,init(body(extra))));
  await assert.rejects(f.transport.createTransport(options('redirect')).fetch(f.endpoint,{...init(),redirect:'follow'}));
  await assert.rejects(f.transport.createTransport(options('host')).fetch(f.endpoint,{...init(),headers:{authorization:'fixture',host:'other.invalid'}}));
  await assert.rejects(f.transport.createTransport(options('url')).fetch('https://example.invalid/v1/responses',init()));
  assert.equal(f.calls(),0);assert.equal(f.ledger.list().length,0);
});
test('image validation rejects remote/file inputs, malformed embedded bytes and non-user image messages before reservation',async t=>{
  const f=await fixture(t), image={type:'input_image',detail:'auto',image_url:'data:image/png;base64,AQID'};
  const config={type:'configuration_update',reasoning:{effort:'high'}};
  const invalid=[
    {...image,image_url:'https://example.invalid/a.png'},
    {...image,image_url:'file:///private/a.png'},
    {...image,image_url:'data:image/svg+xml;base64,AQID'},
    {...image,image_url:'data:image/png;base64,not base64'},
    {...image,image_url:'data:image/png;base64,'},
    {...image,file_id:'file_unowned'}, {...image,detail:'high'},
  ].map(block=>({role:'user',content:[block]}));
  for(const role of ['system','developer','assistant'])invalid.push({role,content:[image]});
  for(const [i,item] of invalid.entries())
    await assert.rejects(f.transport.createTransport(options('image-wire-'+i)).fetch(f.endpoint,
      init(body({input:[item,config]}))),{code:'unsupported_model_content'});
  assert.equal(f.calls(),0);assert.equal(f.ledger.list().length,0);
});
test('native images require durable references and user/tool roles; other content stays rejected',async t=>{
  const f=await fixture(t), attachment={attachmentId:'sha256:'+'a'.repeat(64),mediaType:'image/png',bytes:100,width:1,height:1};
  const image={type:'image',attachment};
  const invalid=[
    {...image,data:'AQID'}, {...image,offloaded:false},
    ...[{attachmentId:'/private/a.png'},{mediaType:'application/pdf'},{bytes:0},{width:0},{height:1.2},
      {name:123},{originalDimensions:{width:0,height:1}},{originalDimensions:{width:1,height:1,path:'/private'}}]
      .map(extra=>({...image,attachment:{...attachment,...extra}})),
    {type:'file',attachment},
  ].map(block=>({role:'user',content:[block]}));
  for(const role of ['system','developer','assistant'])invalid.push({role,content:[image]});
  for(const [i,message] of invalid.entries())assert.throws(()=>f.transport.createTransport({
    ...options('image-native-'+i),messages:[message],
  }),{code:'unsupported_model_content'});
  assert.equal(f.calls(),0);assert.equal(f.ledger.list().length,0);
});
test('late native/business and ledger authorization revocations remain unsent; auth check has no async permission',async t=>{
  for(const kind of ['business','authorization','async']) {
    const f=await fixture(t,respond(payload()),{beforeDispatch:()=>{if(kind==='business') throw new DomainError('source_withdrawn','Revoked');if(kind==='async') return Promise.reject(new Error('fixture async failure'));}});
    const original=f.transport.persistJson.bind(f.transport);
    f.transport.persistJson=async(path,value)=>{await original(path,value);if(kind==='authorization'&&path.endsWith('/request.json')){
      const current=f.ledger.store.get('openai_authorizations',f.ledger.authorizationId);
      f.ledger.store.save('openai_authorizations',{...current,specification:{...current.specification,authorizationEvidence:'revoked'}},{expectedRevision:current.revision});}};
    await assert.rejects(f.transport.createTransport(options('late-'+kind)).fetch(f.endpoint,init()));
    assert.equal(f.calls(),0);assert.equal(f.ledger.get('late-'+kind).status,'released');
  }
});
test('cancellation and connection interruption preserve unknown and never permit a repeat',async t=>{
  const f=await fixture(t,(req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(ev({type:'response.created',response:{id:'resp_fixture',model}}));});});
  const controller=new AbortController();const local=f.transport.createTransport({...options('cancel'),signal:controller.signal});
  const r=await local.fetch(f.endpoint,init());const reading=r.text();controller.abort();await assert.rejects(reading);await f.transport.close();
  assert.equal(f.ledger.get('cancel').status,'unknown');assert.equal(f.calls(),1);
  const cut=await fixture(t,(req,res)=>{req.resume();req.on('end',()=>res.destroy());});
  await assert.rejects(cut.transport.createTransport(options('cut')).fetch(cut.endpoint,init()));
  assert.equal(cut.calls(),1);assert.equal(cut.ledger.get('cut').status,'unknown');
});
test('complete original receipt survives a settlement interruption and reconciles without sending',async t=>{
  const f=await fixture(t), settle=f.ledger.settle.bind(f.ledger);
  f.ledger.settle=()=>{throw new Error('simulated settlement interruption');};
  await assert.rejects(async()=>{const r=await f.transport.createTransport(options('recover')).fetch(f.endpoint,init());await r.text();});
  assert.equal(f.ledger.get('recover').status,'unknown');f.ledger.settle=settle;await f.transport.close();
  const fresh=new OpenAITransport(f.config);try {assert.deepEqual((await fresh.recover({exclusive:true})).settled,['recover']);assert.equal(f.ledger.get('recover').status,'settled');assert.equal(f.calls(),1);}
  finally {await fresh.close();}
});
test('same provider-independent step cannot acquire another ledger by switching provider',async t=>{
  const f=await fixture(t);await (await f.transport.createTransport(options('shared-step')).fetch(f.endpoint,init())).text();
  const ledger=new BudgetLedger(join(f.directory,'deepseek.sqlite'),{create:true,ceilingCny:150,authorizationRef:'fixture-dev-150'});
  const dsPolicy={contextWindow:1024,maxOutputTokens:32,prices:{input:9,output:27,cachedInput:0.3},priceVersion:'fixture',reasoningEfforts:['off']};
  const ds=new DeepSeekTransport({ledger,artifactDirectory:f.config.artifactDirectory,provider:'deepseek-official',
    modelPolicies:{'deepseek-v4-pro':dsPolicy},requestIdentity:()=>({requestId:'shared-step',metadata:{}})});
  try {await assert.rejects(ds.createTransport({...options('shared-step'),provider:'deepseek-official',model:'deepseek-v4-pro',reasoningEffort:'off'}).send(ds.endpoint,
    {method:'POST',redirect:'error',headers:{'x-api-key':'fixture'},body:JSON.stringify({model:'deepseek-v4-pro',stream:true,max_tokens:32,thinking:{type:'disabled'},messages:[{role:'user',content:[{type:'text',text:'fixture'}]}]})}),{code:'request_already_dispatched'});
    assert.equal(ledger.get('shared-step'),null);assert.equal(f.calls(),1);
  }finally{await ds.close();ledger.close();}
});
test('fixed CONNECT proxy carries one POST; failed proxy has no direct fallback',async t=>{
  let connects=0;const sockets=new Set(), proxy=createServer();
  proxy.on('connect',(req,client,head)=>{connects++;sockets.add(client);
    const [host,port]=req.url.split(':');const upstream=connect(Number(port),host,()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);upstream.pipe(client);client.pipe(upstream);});
    sockets.add(upstream);upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());});
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  const agent=new ProxyAgent('http://127.0.0.1:'+proxy.address().port);
  const f=await fixture(t,respond(payload()),{dispatcher:agent,ownsDispatcher:true});
  await (await f.transport.createTransport(options('proxy')).fetch(f.endpoint,init())).text();assert.equal(connects,1);assert.equal(f.calls(),1);
  await f.transport.close();for(const socket of sockets)socket.destroy();await new Promise(r=>proxy.close(r));
  const unused=createServer();await new Promise(r=>unused.listen(0,'127.0.0.1',r));const port=unused.address().port;await new Promise(r=>unused.close(r));
  const down=await fixture(t,respond(payload()),{dispatcher:new ProxyAgent('http://127.0.0.1:'+port),ownsDispatcher:true,timeoutMs:1000});
  await assert.rejects(down.transport.createTransport(options('proxy-down')).fetch(down.endpoint,init()));
  assert.equal(down.calls(),0);assert.equal(down.ledger.get('proxy-down').status,'unknown');
});

test('official additional_tools history is retained; server tools and role changes are rejected',async t=>{
  let received;const f=await fixture(t,(req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
    received=JSON.parse(Buffer.concat(chunks));res.writeHead(200,{'content-type':'text/event-stream'}).end(payload());});});
  const entry={type:'additional_tools',role:'developer',tools:[{type:'function',name:'fixture',description:'Local fixture',parameters:{type:'object',properties:{}},strict:false}]};
  const config={type:'configuration_update',reasoning:{effort:'high'}};
  for(const bad of [{...entry,role:'user'},{...entry,tools:[{type:'web_search'}]},{...entry,extra:'unapproved'}])
    await assert.rejects(f.transport.createTransport(options('bad-'+JSON.stringify(bad))).fetch(f.endpoint,init(body({input:[bad,config]}))),{code:'unsupported_model_content'});
  await (await f.transport.createTransport(options('local-declarations')).fetch(f.endpoint,init(body({input:[entry,config]})))).text();
  assert.deepEqual(received.input[0],entry);assert.equal(f.calls(),1);
});

test('mixed protocol cold recovery selects each original ledger and rejects conflicting or unregistered evidence',async t=>{
  const lifecycle={stopping:new AbortController(),inflight:new Map(),
    evidenceVersions:new Set(['arcfold-responses-transport-v1','arcfold-messages-transport-v1'])};
  const messages=ev({type:'message_start',message:{id:'ds_fixture',model:'deepseek-v4-pro'}})+
    ev({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{input_tokens:8,output_tokens:3,cache_read_input_tokens:2,cache_creation_input_tokens:0}})+
    ev({type:'message_stop'});
  const f=await fixture(t,(req,res)=>{req.resume();req.on('end',()=>res.writeHead(200,{'content-type':'text/event-stream'}).end(
    req.url==='/v1/responses'?payload():messages));},{lifecycle});
  const ledger=new BudgetLedger(join(f.directory,'mixed-budget.sqlite'),{create:true,ceilingCny:150,authorizationRef:'mixed-fixture-150'});
  const config={ledger,artifactDirectory:f.config.artifactDirectory,provider:'deepseek-official',lifecycle,
    modelPolicies:{'deepseek-v4-pro':{contextWindow:1024,maxOutputTokens:32,prices:{input:9,output:27,cachedInput:0.3},priceVersion:'fixture',reasoningEfforts:['off']}},
    endpoint:f.endpoint.replace('/v1/responses','/anthropic/v1/messages'),allowLocalTestEndpoint:true,
    requestIdentity:()=>({requestId:'mixed-deepseek',metadata:{role:'learning'}})};
  const ds=new DeepSeekTransport(config);
  try {
    assert.throws(()=>ds.createTransport({...options('deepseek-image'),provider:'deepseek-official',model:'deepseek-v4-pro',reasoningEffort:'off',
      messages:[{role:'user',content:[{type:'image',attachment:{attachmentId:'sha256:'+'a'.repeat(64),mediaType:'image/png',bytes:100,width:1,height:1}}]}]}),
      {code:'unsupported_model_content'});
    assert.equal(f.calls(),0);assert.equal(ledger.get('mixed-deepseek'),null);
    await (await f.transport.createTransport(options('mixed-openai')).fetch(f.endpoint,init())).text();
    await (await ds.createTransport({...options('mixed-deepseek'),provider:'deepseek-official',model:'deepseek-v4-pro',reasoningEffort:'off'}).send(ds.endpoint,
      {method:'POST',redirect:'error',headers:{'x-api-key':'fixture'},body:JSON.stringify({model:'deepseek-v4-pro',stream:true,max_tokens:32,thinking:{type:'disabled'},
        messages:[{role:'user',content:[{type:'text',text:'fixture'}]}]})})).text();
    assert.deepEqual((await f.transport.recover({exclusive:true})).settled,['mixed-openai']);
    assert.deepEqual((await ds.recover({exclusive:true})).settled,['mixed-deepseek']);
    assert.equal(f.calls(),2);assert.equal(f.ledger.get('mixed-deepseek'),null);assert.equal(ledger.get('mixed-openai'),null);
    const identityPath=join(f.directory,'receipts',key('mixed-openai'),'identity.json');
    const original=await readFile(identityPath,'utf8');await writeFile(identityPath+'.before-tamper',original);
    await writeFile(identityPath,JSON.stringify({...JSON.parse(original),version:'arcfold-messages-transport-v1'}));
    await assert.rejects(f.transport.recover({exclusive:true}),{code:'receipt_identity_conflict'});
    await writeFile(identityPath,original);
    const requestPath=join(f.directory,'receipts',key('mixed-openai'),'request.json');
    const request=JSON.parse(await readFile(requestPath,'utf8'));request.version='unregistered-protocol';
    await writeFile(requestPath,JSON.stringify(request));await writeFile(identityPath,JSON.stringify({...JSON.parse(original),version:request.version}));
    await assert.rejects(f.transport.recover({exclusive:true}),{code:'receipt_identity_conflict'});assert.equal(f.calls(),2);
  }finally{await ds.close();ledger.close();}
});
