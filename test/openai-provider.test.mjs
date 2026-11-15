import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai';
import * as Provider from '../src/openai-provider.mjs';
import { OpenAITransport } from '../src/openai-transport.mjs';
import { OpenAIUsageLedger } from '../src/openai-usage.mjs';
const model='gpt-6-astra', provider='openai', maxTokens=32;
const policy={contextWindow:100000,maxOutputTokens:64,requestMaxTokens:maxTokens,reasoningEfforts:['high']};
const webAuthorization={authorizationRef:'provider-fixture-web',authorizedAt:'2026-11-07T00:00:00Z',authorizationEvidence:'Explicit synthetic web fixture.'};
const options=id=>({provider,model,reasoningEffort:'high',maxTokens,sessionId:id,
  messages:[{id:'user-'+id,source:{kind:'user'},role:'user',content:[{type:'text',text:id}]}],tools:[]});
const event=value=>'event: '+value.type+'\ndata: '+JSON.stringify(value)+'\n\n';
function response(id='resp_fixture', model='gpt-6-astra') {
  const item={type:'message',id:'msg_fixture',role:'assistant',status:'completed',content:[{type:'output_text',text:'fixture response',annotations:[]}]};
  return event({type:'response.created',response:{id,model}})+
    event({type:'response.output_item.added',output_index:0,item})+
    event({type:'response.output_item.done',output_index:0,item})+
    event({type:'response.completed',response:{id,model,status:'completed',output:[item],
      usage:{input_tokens:11,output_tokens:5,total_tokens:16,input_tokens_details:{cached_tokens:3},output_tokens_details:{reasoning_tokens:2}}}});
}
async function active(fiber){const until=Date.now()+3000;for(;;){await fiber.await();if(fiber.state===2)return fiber;assert.ok([0,1].includes(fiber.state));assert.ok(Date.now()<until);await delay(1);}}
const collect=async stream=>{const chunks=[];for await(const chunk of stream)chunks.push(chunk);return chunks;};
async function fixture(t,{status=200,selected,finalCheck=()=>{},modelPolicies={[model]:policy}}={}) {
  const directory=await mkdtemp(join(tmpdir(),'arcfold-openai-provider-'));t.diagnostic('Retained official adapter fixture: '+directory);
  const requests=[],reads=[];let hooks=0;
  const server=createServer((req,res)=>{const parts=[];req.on('data',p=>parts.push(p));req.on('end',()=>{
    requests.push({path:req.url,body:Buffer.concat(parts).toString()});
    res.writeHead(status,{'content-type':status===200?'text/event-stream':'application/json',location:'/v1/responses'});
    res.end(status===200?response('resp_fixture',JSON.parse(requests.at(-1).body).model):JSON.stringify({error:{message:'fixture failure',type:'fixture_error'}}));});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const endpoint='http://127.0.0.1:'+server.address().port+'/v1/responses';
  const ledger=new OpenAIUsageLedger(join(directory,'usage.sqlite'),{create:true,scope:'web-openai',webAuthorization});
  const transport=new OpenAITransport({ledger,artifactDirectory:join(directory,'receipts'),provider,modelPolicies,
    endpoint,allowLocalTestEndpoint:true,timeoutMs:3000,requestIdentity:o=>({requestId:o.sessionId,metadata:{role:'main'}}),beforeDispatch:finalCheck});
  const wireFailures=[], validate=transport.validateWire.bind(transport);
  transport.validateWire=(fixed,url,init)=>{try{return validate(fixed,url,init);}catch(error){
    wireFailures.push({code:error.code,urlType:typeof url,endpointMatches:url===endpoint,method:init?.method,redirect:init?.redirect,
      body:typeof init?.body==='string'?JSON.parse(init.body):typeof init?.body});
    throw error;}};
  const ctx=new Context();
  new LocalAttachmentStore(ctx,{dshHome:directory});
  t.after(async()=>{await writeFile(join(directory,'safe-fixture-diagnostics.json'),JSON.stringify({hooks,reads:reads.length,received:requests.length,wireFailures},null,2));t.diagnostic(JSON.stringify({hooks,reads:reads.length,received:requests.length,wireFailures}));await ctx.fiber.dispose();await transport.close();ledger.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  await ctx.plugin({name:'explicit-fixture-services',apply(child){
    child.provide('credentials',{resolve:async ref=>{reads.push(ref);return{value:'sk-fixture-only-not-real'};}});
    child.provide('launchEnvironment',createLaunchEnvironmentSnapshot([{source:'process',values:{}}]));
    child.provide('arcfoldMeteredTransport',{configuration:{routes:{openai:{provider,endpoint,modelPolicies}}},
      createTransport:o=>{hooks++;return selected?selected(o):transport.createTransport(o);}});
  }});
  await ctx.plugin(LlmRuntime);await active(await ctx.plugin(Provider,{apiKeyRef:'EXPLICIT_FIXTURE_REF',maxTokens,reasoningEffort:'high'}));
  const call=async(id,changes={})=>{const prepared=await ctx.llm.prepareCall({provider,model,maxTokens,reasoningEffort:'high',...changes});
    return collect(prepared.stream({...options(id),...changes}));};
  return{ctx,transport,ledger,requests,reads,call,hooks:()=>hooks};
}
test('actual official native plugin and SDK send once through owned fetch and preserve original accounting',async t=>{
  const f=await fixture(t), chunks=await f.call('official');
  const assembly=new BlockAssembler();for(const chunk of chunks)assembly.push(chunk);
  assert.equal(assembly.finish.kind,'stop');assert.equal(assembly.usage.inputTokens,8);
  assert.equal(f.requests.length,1);assert.equal(f.hooks(),1);assert.deepEqual(f.reads,['EXPLICIT_FIXTURE_REF']);
  const body=JSON.parse(f.requests[0].body);assert.equal(body.store,false);assert.equal(body.max_output_tokens,32);
  assert.equal(body.reasoning.effort,'medium');assert.equal(body.input.at(-1).reasoning.effort,'high');
  assert.deepEqual(f.ledger.get('official').usage,{promptTokens:11,completionTokens:5,cachedTokens:3});
});
test('simultaneous official calls retain separate call-local identities and receipts',async t=>{
  const f=await fixture(t);await Promise.all([f.call('parallel-one'),f.call('parallel-two')]);
  assert.equal(f.requests.length,2);for(const id of ['parallel-one','parallel-two'])assert.equal(f.ledger.get(id).status,'settled');
  assert.notEqual(f.ledger.get('parallel-one').metadata.transport.ownerId,f.ledger.get('parallel-two').metadata.transport.ownerId);
});
for(const status of [307,421,429,500])test('actual SDK/native HTTP '+status+' has one received request and unknown usage',async t=>{
  const f=await fixture(t,{status});const chunks=await f.call('status-'+status);
  assert.equal(f.requests.length,1);assert.equal(f.hooks(),1);assert.equal(f.ledger.get('status-'+status).status,'unknown');
  assert.ok(chunks.some(chunk=>chunk.type==='finish'&&chunk.reason.kind==='error'));
});
test('mandatory factory absent/invalid/rejected prevents credential resolution and every send',async t=>{
  for(const selected of [()=>undefined,()=>null,()=>({}),()=>Promise.reject(new Error('synthetic rejected transport')),async()=>{throw new Error('synthetic async transport');},()=>({then(){throw new Error('must not call custom then');},fetch:()=>{throw new Error('must not fetch');}})]) {
    const f=await fixture(t,{selected});
    const chunks=await f.call('invalid-hook');assert.ok(chunks.some(chunk=>chunk.type==='finish'&&chunk.reason.kind==='error'));
    await delay(0);assert.equal(f.reads.length,0);assert.equal(f.requests.length,0);assert.equal(f.ledger.list().length,0);
  }
});
test('actual credential await precedes final business revocation check without sending',async t=>{
  const f=await fixture(t,{finalCheck:()=>{throw new Error('synthetic authorization revoked');}});
  const chunks=await f.call('late-revoked');assert.equal(f.reads.length,1);assert.equal(f.requests.length,0);
  assert.equal(f.ledger.get('late-revoked').status,'released');
  assert.ok(chunks.some(chunk=>chunk.type==='finish'&&chunk.reason.kind==='error'));
});
test('provider installation requires a mandatory owned service and explicit credential reference',async()=>{
  const fake={arcfoldMeteredTransport:{configuration:{routes:{}}}};
  await assert.rejects(Provider.apply(fake,{apiKeyRef:'fixture',maxTokens,reasoningEffort:'high'}),/mandatory/);
});

test('actual native profile updates cannot remove the explicit credential reference or add another route',async t=>{
  const f=await fixture(t), native=[...f.ctx.registry.get(piAi).fibers][0];
  const original=structuredClone(native.rawConfig);
  const missing=structuredClone(original);delete missing.providers.openai.apiKeyEnv;
  assert.throws(()=>native.update(missing),/profile is frozen/);
  const other=structuredClone(original);other.providers.other={apiKeyEnv:'UNAUTHORIZED'};
  assert.throws(()=>native.update(other),/profile is frozen/);
  assert.deepEqual(native.rawConfig,original);assert.equal(f.reads.length,0);assert.equal(f.requests.length,0);
  const chunks=await f.call('after-rejected-update');
  assert.ok(chunks.some(chunk=>chunk.type==='finish'&&chunk.reason.kind==='stop'));
  assert.equal(f.requests.length,1);assert.deepEqual(f.reads,['EXPLICIT_FIXTURE_REF']);
});

test('both owned GPT models expose exact controls and Sol xhigh/max reaches the official wire and ledger', async t => {
  const initial=JSON.parse(await readFile(new URL('../runtime/initial-policy.json',import.meta.url),'utf8'));
  const f=await fixture(t,{modelPolicies:initial.routes.openai.modelPolicies});
  assert.deepEqual((await f.ctx.llm.listModels(provider)).map(row=>row.id),['gpt-6-astra','gpt-6.1-sol']);
  for(const chosen of ['gpt-6-astra','gpt-6.1-sol']) {
    const info=await f.ctx.llm.resolveModelInfo(provider,chosen);
    assert.deepEqual(info.inputModalities,['text','image']);
    assert.equal(info.context.contextWindow,272000);
    assert.deepEqual(info.reasoning.efforts.map(row=>row.id),['low','medium','high','xhigh','max']);
  }
  for(const [chosen,effort] of [['gpt-6.1-sol','xhigh'],['gpt-6.1-sol','max'],['gpt-6-astra','max']]) {
    const id=chosen+'-'+effort, chunks=await f.call(id,{model:chosen,reasoningEffort:effort});
    const assembly=new BlockAssembler();for(const chunk of chunks)assembly.push(chunk);
    assert.equal(assembly.finish.kind,'stop');
    const body=JSON.parse(f.requests.at(-1).body);
    assert.equal(body.model,chosen);assert.equal(body.reasoning.effort,'medium');
    assert.deepEqual(body.input.at(-1),{type:'configuration_update',reasoning:{effort}});
    assert.equal(f.ledger.get(id).model,chosen);assert.equal(f.ledger.get(id).status,'settled');
    assert.deepEqual(f.ledger.get(id).usage,{promptTokens:11,completionTokens:5,cachedTokens:3});
  }
  const before=f.requests.length;
  await assert.rejects(f.call('bad-effort',{model:'gpt-6.1-sol',reasoningEffort:'off'}));
  await assert.rejects(f.call('bad-model',{model:'gpt-unowned',reasoningEffort:'high'}));
  assert.equal(f.requests.length,before);assert.equal(f.ledger.list().length,3);
  assert.equal(Object.hasOwn(f.ledger.summary(),'spentCny'),false);
});

test('offloaded native image history remains readable without loading unavailable image bytes', async t => {
  const f=await fixture(t), attachment={attachmentId:'sha256:'+'a'.repeat(64),mediaType:'image/png',bytes:100,width:1,height:1,name:'old.png'};
  // The real attachment service has no bytes for this old reference. Native
  // history must project the offloaded image to text without loading its file.
  const chunks=await f.call('offloaded-image',{messages:[{role:'user',content:[
    {type:'text',text:'Continue from the old screenshot.'},{type:'image',attachment,offloaded:true},
  ]}]});
  const assembly=new BlockAssembler();for(const chunk of chunks)assembly.push(chunk);
  assert.equal(assembly.finish.kind,'stop',JSON.stringify(assembly.finish));assert.equal(f.requests.length,1);
  const body=JSON.parse(f.requests[0].body);
  assert.equal(JSON.stringify(body).includes('input_image'),false);
  assert.ok(JSON.stringify(body).includes(attachment.attachmentId));
  assert.equal(f.ledger.get('offloaded-image').status,'settled');
});
