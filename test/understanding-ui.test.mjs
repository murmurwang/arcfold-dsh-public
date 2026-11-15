// Official Gateway/SessionController, real Agent/Preset registry and React DOM.
// Imported-knowledge cases use real business services; command delivery is an
// explicit fixture. No browser delivery or semantic adoption claim is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BusinessStore } from '../src/business.mjs';
import { ImportService } from '../src/importer.mjs';
import { UnderstandingService } from '../src/understandings.mjs';
import { MethodService } from '../src/methods.mjs';
import { GoalService } from '../src/goals.mjs';
import { importDigest, textDigest } from '../src/legacy-import-source.mjs';
import * as OfficialConnection from '@deepseek-ai/dsh-client-connection';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import TypertGateway from '@deepseek-ai/dsh-api-gateway';
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access';
import { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import React, { act, useSyncExternalStore } from 'react';
import { JSDOM } from 'jsdom';
import * as Host from '../packages/method-ui/src/index.mjs';
import * as Client from '../packages/method-ui/src/client.mjs';
import { createUnderstandingHandler } from '../packages/method-ui/src/understanding-host.mjs';
import { createUnderstandingSource } from '../packages/method-ui/src/understanding-source.mjs';
import { UnderstandingDock } from '../packages/method-ui/src/UnderstandingDock.mjs';
import { zh } from '../packages/method-ui/src/locales.mjs';
import { understandingZh } from '../packages/method-ui/src/understanding-locales.mjs';

const live = () => new AbortController().signal;
const peer = () => ({id:'browser-owner',principal:{kind:'owner'},interactions:'answer',signal:live()});
const request = (extra={}) => ({sessionId:'main',understandingId:'u1',expectedRevision:2,requestId:'correction-one',
  text:'  完整替换原话。\n保留换行和尾空格。  ',...extra});
const later = () => { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
const detail = (id='u1',revision=2) => ({
  understanding:{id,revision,version:3,status:'active',claimType:'inference',
    content:'AI 保存的理解 <script>never execute</script>',sourceIds:['source-1']},
  availability:{allowed:true},controls:{stopAllowed:true,correctionAllowed:true},
  sources:[{id:'source-1',revision:4,expectedControlRevision:7,available:true,missing:false,role:'user',author:'原用户',
    content:'  来源原话\n<img src=x onerror=alert(1)>  ',occurredAt:'2026-11-07T00:00:00Z',
    provenance:{kind:'dsh/inbox',seq:9},control:{revision:7,status:'active'}}],
  history:[{understanding:{id:'u0',revision:1,version:2,content:'旧版本原文'}}],historyTotal:2,
  successors:[{id:'u2',revision:1,version:4,status:'active'}],commands:[],commandsTotal:0,
});
function businessFixture() {
  const commands=new Map(),calls=[]; let bound=true;
  const f={commands,calls,onBind:null};
  f.bridge={isBound:id=>bound&&id==='main'};f.setBound=value=>{bound=value;};
  const agent={id:'main',ctx:{}};
  f.agents={get:id=>bound&&id==='main'?agent:undefined};
  f.agentPresets={composedPreset:context=>context===agent.ctx?'arcfold-main':undefined};
  f.service={
    list(value) {calls.push({name:'list',value});return {items:[detail()],total:1,nextOffset:null};},
    details(value) {calls.push({name:'details',value});return detail(value.understandingId);},
    decide(value) {calls.push({name:'decide',value:structuredClone(value)});
      if(value.expectedRevision!==2) throw Object.assign(new Error('changed'),{code:'revision_conflict'});
      if(value.action==='withdraw-source'&&value.sourceRef.id!=='source-1')
        throw Object.assign(new Error('unrelated'),{code:'source_scope_denied'});
      return {created:true,command:{id:'decision',result:{state:'applied'}}};},
    bindCorrection(value) {
      calls.push({name:'bind',value:structuredClone(value)});
      const id=JSON.stringify([value.sessionId,value.requestId]),old=commands.get(id);
      if(old&&JSON.stringify(old.request)!==JSON.stringify(value))
        throw Object.assign(new Error('changed identity'),{code:'understanding_identity_conflict'});
      const command=old||{id,requestId:value.requestId,request:structuredClone(value),admission:null,result:null};
      commands.set(id,command);f.onBind?.(command);
      return {created:!old,command:structuredClone(command)};
    },
    recordCorrectionAdmission({commandId,state}) {
      const value=commands.get(commandId);value.admission={state};
      calls.push({name:'admission',value:{commandId,state}});return structuredClone(value);
    },
  };
  return f;
}
async function nativeRegistry(ctx,t) {
  ctx.baseUrl=import.meta.url;
  const active=async fiber=>{for(let n=0;n<100;n++){await fiber.await();if(fiber.state===2)return;
    assert.ok([0,1].includes(fiber.state));await new Promise(resolve=>setImmediate(resolve));}
    assert.fail('Native registry did not activate');};
  await active(ctx.plugin(Loader));ctx.loader.builtins.group=Group;
  for(const plugin of [LlmRuntime,SessionStore,SessionProjections])await active(ctx.plugin(plugin));
  await active(ctx.plugin(JsonlPersistence,{root:mkdtempSync(join(tmpdir(),'first-use-sessions-')),compression:'none'}));
  await active(ctx.plugin(SystemPrompt,{personaPrefix:'Offline first-use admission fixture; no model calls.'}));
  for(const plugin of [ToolRuntime,NativeToolExecutor,AgentRegistry])await active(ctx.plugin(plugin));
  await active(ctx.plugin(AgentLoop,{agents:[]}));await active(ctx.plugin(AgentPresets,{default:'arcfold-main'}));
  for(const id of ['arcfold-main','arcfold-learning','unrelated'])
    await active(ctx.plugin({inject:['agentPresets'],async *apply(owner){yield await owner.agentPresets.register({id,plugins:[]});}}));
  const handles=[];
  const create=async(id,preset='arcfold-main')=>{
    const handle=await ctx.agents.create({sessionId:id,agentOptions:{},
      setup:async owner=>{await ctx.agentPresets.mount(owner,preset);}});
    handles.push(handle);return handle;
  };
  t.after(async()=>{for(const handle of handles)await handle.dispose();});
  return {create,main:await create('main'),helper:await create('helper','arcfold-learning')};
}
async function gatewayFixture(t, {realBusiness=false}={}) {
  const ctx=new Context(),business=businessFixture(),native=[],routes=[];let credential;
  ctx.provide('credentials',{readRecord:async()=>credential,
    async modifyRecord(_key,mutate){credential=await mutate(credential);return credential;},async deleteRecord(){}});
  await ctx.plugin({name:'fixture-carrier',apply(owner){owner.provide('webServer',{
    host:'127.0.0.1',protocol:'http:',port:3080,register(route){routes.push(route);return ()=>routes.splice(routes.indexOf(route),1);},
    registerUpgrade:()=>()=>{},tapIndex:()=>()=>{}});}}).await();
  const registry=await nativeRegistry(ctx,t);
  let store,imports;
  if(realBusiness){
    const actual=new BusinessStore({filename:':memory:'});store=actual.storage;imports=new ImportService({business:actual});
    t.after(async()=>{await imports.close();actual.close();});
    business.service=new UnderstandingService({business:actual});
    ctx.provide('arcfoldMethods',new MethodService({business:actual}));
    ctx.provide('arcfoldGoals',new GoalService({business:actual}));
  }else ctx.provide('arcfoldMethods',{});
  ctx.provide('arcfoldUnderstandings',business.service);ctx.provide('arcfoldBridge',realBusiness?{isBound:id=>store.get('host_bindings',id)?.role==='main'}:business.bridge);
  const f={ctx,business,native,routes,registry,store,imports,prompt:async()=>({accepted:true})};
  class Controller extends Service {
    constructor(owner){super(owner,'sessionController');}
    get commands(){const invocation=this.ctx.invocation;return {prompt(input,source){
      native.push({input,source,message:createUserMessage({content:input.content,source}),peer:invocation?.peer,signal:invocation?.signal});return f.prompt(input,source);
    }};}
    prompt(input,signal){return SessionController.prototype.prompt.call(this,input,signal);}
  }
  new Controller(ctx);t.after(()=>ctx.fiber.dispose());
  for(const plugin of [OfficialConnection,TypertRegistry,RemoteAccessService,TypertGateway])await ctx.plugin(plugin).await();
  const fiber=ctx.plugin(Host);await fiber.await();f.fiber=fiber;f.peer=ctx.connection.browserPeer;
  f.invoke=(method,value,p=f.peer)=>ctx.typertGateway.invoke({namespace:'arcfoldUnderstandings',method,args:{request:value},peer:p});
  f.invokeGoal=(method,value,p=f.peer)=>ctx.typertGateway.invoke({namespace:'arcfoldGoals',method,args:{request:value},peer:p});
  f.invokeMethod=(method,value,p=f.peer)=>ctx.typertGateway.invoke({namespace:'arcfoldMethods',method,args:{request:value},peer:p});
  return f;
}

test('official Gateway keeps owner context, native user/rpcId and exact literal; acknowledgement is not adoption',async t=>{
  const f=await gatewayFixture(t);
  await f.invoke('list',{sessionId:'main'});await f.invoke('details',{sessionId:'main',understandingId:'u1'});
  assert.equal(f.native.length,0);
  const answer=await f.invoke('correct',request());
  assert.equal(answer.command.admission.state,'accepted');assert.equal(answer.command.result,null);
  assert.equal(f.native.length,1);assert.equal(f.native[0].peer,f.peer);
  assert.equal(f.native[0].signal.aborted,false);
  assert.deepEqual(f.native[0].source,{kind:'user',rpcId:'correction-one'});
  assert.equal(f.native[0].message.role,'user');assert.deepEqual(f.native[0].message.source,f.native[0].source);
  assert.deepEqual(f.native[0].input,{sessionId:'main',requestId:'correction-one',mode:'steer',
    content:[{type:'text',text:request().text}]});
  assert.equal(f.business.calls.find(x=>x.name==='bind').value.userIdentity,'browser:'+f.peer.id);
  assert.equal((await f.invoke('correct',request())).created,false);assert.equal(f.native.length,1);
});

test('Gateway rejects external peers, unbound sessions, forged authority and unrelated source controls',async t=>{
  const f=await gatewayFixture(t);
  for(const principal of [{kind:'owner'},{kind:'agent',id:'other'}]){
    const other=f.ctx.connection.createPeer({principal,interactions:'answer'});
    const code=principal.kind==='owner'?'trusted_browser_required':'remote-access/denied';
    await assert.rejects(f.invoke('correct',request(),other),e=>e.code===code);await other.dispose();
    assert.equal(f.business.calls.length,0);assert.equal(f.native.length,0);
  }
  for(const method of ['list','details','correct']){
    const value=method==='list'?{sessionId:'helper'}:method==='details'?{sessionId:'helper',understandingId:'u1'}:request({sessionId:'helper'});
    await assert.rejects(f.invoke(method,value),e=>e.code==='understanding_session_denied');
  }
  await assert.rejects(f.invoke('correct',request({userIdentity:'owner'})),e=>e.code==='invalid_understanding_request');
  await assert.rejects(f.invoke('correct',request({expectedRevision:0})),e=>e.code==='invalid_understanding_request');
  await assert.rejects(f.invoke('correct',request({text:' \n '})),e=>e.code==='invalid_correction_text');
  const control={sessionId:'main',understandingId:'u1',expectedRevision:2,requestId:'source',
    action:'withdraw-source',sourceRef:{id:'source-1',revision:4,expectedControlRevision:7}};
  await f.invoke('decide',control);
  assert.deepEqual(f.business.calls.find(x=>x.name==='decide').value,{...control,userIdentity:'browser:'+f.peer.id});
  await assert.rejects(f.invoke('decide',{...control,sourceRef:{...control.sourceRef,id:'unrelated'}}),e=>e.code==='source_scope_denied');
  await assert.rejects(f.invoke('decide',{...control,sourceRef:{...control.sourceRef,confirmed:true}}),e=>e.code==='invalid_understanding_request');
  await assert.rejects(f.invoke('decide',{...control,expectedRevision:1}),e=>e.code==='revision_conflict');
  assert.equal(f.native.length,0);assert.equal(f.business.commands.size,0);
});

test('concurrent correction and unknown native admission remain single send, including after a fresh handler',async t=>{
  const f=await gatewayFixture(t),gate=later();f.prompt=()=>gate.promise;
  const a=f.invoke('correct',request()),b=f.invoke('correct',request());
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.native.length,1);
  gate.reject(new Error('lost acknowledgement after native entry'));
  const [first,second]=await Promise.all([a,b]);
  assert.equal(first.command.admission.state,'unknown');assert.equal(second.command.admission.state,'unknown');
  await assert.rejects(f.invoke('correct',request({text:'changed'})),e=>e.code==='understanding_identity_conflict');
  const resumed=createUnderstandingHandler({understandings:f.business.service,agents:f.ctx.agents,agentPresets:f.ctx.agentPresets,
    connection:f.ctx.connection,prompt(){throw new Error('must not re-enter');}});
  const existing=await resumed('correct',request(),live(),f.peer);
  assert.equal(existing.created,false);assert.equal(existing.command.admission.state,'unknown');assert.equal(f.native.length,1);
  const routes=[...f.routes];await f.fiber.dispose();
  for(const name of ['list','details','decide','correct'])assert.equal(f.ctx.typert.local.get('arcfoldUnderstandings/'+name),undefined);
  assert.deepEqual(f.routes,routes);assert.equal(f.ctx.connection.browserPeer,f.peer);
  await assert.rejects(f.invoke('correct',request()));assert.equal(f.native.length,1);
});

test('disconnect between durable bind and native send records failed admission, with no automatic retry',async()=>{
  const f=businessFixture(),owner=peer(),abort=new AbortController();let sent=0;
  const handler=createUnderstandingHandler({understandings:f.service,agents:f.agents,agentPresets:f.agentPresets,connection:{browserPeer:owner},
    prompt:async()=>{sent++;return {accepted:true};}});
  f.onBind=()=>abort.abort();
  const result=await handler('correct',request(),abort.signal,owner);
  assert.equal(result.command.admission.state,'failed');assert.equal(sent,0);
  f.onBind=null;
  assert.equal((await handler('correct',request(),live(),owner)).created,false);assert.equal(sent,0);
  const already=live();await assert.rejects(handler('list',{sessionId:'main'},already,{...owner,signal:AbortSignal.abort()}),e=>e.code==='trusted_browser_required');
});

test('a result applied while acknowledgement returns is kept separate from admission',async()=>{
  const f=businessFixture(),owner=peer();
  const handler=createUnderstandingHandler({understandings:f.service,agents:f.agents,agentPresets:f.agentPresets,connection:{browserPeer:owner},
    prompt:async()=>{[...f.commands.values()][0].result={state:'applied',after:{id:'u-new',revision:1}};return {accepted:true};}});
  const result=await handler('correct',request(),live(),owner);
  assert.equal(result.command.result.state,'applied');assert.equal(result.command.admission.state,'accepted');
});

test('read cache uses exact dock session, drops stale list/details on reset and refuses all calls after dispose',async()=>{
  const calls=[],resets=new Set(),queue=[];
  const source=createUnderstandingSource({sessionId:'exact-session',intervalMs:60000,
    subscribeReset:fn=>{resets.add(fn);return ()=>resets.delete(fn);},
    rpc:{call(channel,method,payload,signal){const gate=later();calls.push({channel,method,payload,signal});queue.push(gate);return gate.promise;}}});
  const stop=source.subscribe(()=>{}),first=queue[0],newer=source.refresh(20);
  first.resolve({ok:true,value:{items:['stale'],total:1,nextOffset:null}});
  queue[1].resolve({ok:true,value:{items:['fresh'],total:21,nextOffset:null}});await newer;
  assert.deepEqual(source.getSnapshot().items,['fresh']);assert.equal(source.getSnapshot().offset,20);
  const reading=source.details('u1');void reading.catch(()=>{});
  [...resets][0]();assert.equal(calls[2].signal.aborted,true);
  assert.deepEqual(source.getSnapshot().items,[]);assert.equal(source.getSnapshot().readEpoch,1);
  queue[2].resolve({ok:true,value:detail()});await assert.rejects(reading,{code:'understanding_read_cancelled'});
  queue[3].resolve({ok:true,value:{items:[],total:0,nextOffset:null}});await Promise.resolve();
  assert.equal(calls.every(x=>x.channel==='/api'&&x.payload.args.request.sessionId==='exact-session'),true);
  assert.equal(calls.some(x=>/correct|decide/.test(x.method)),false);
  stop();source.dispose();const count=calls.length;assert.equal(resets.size,0);
  await source.refresh();
  for(const action of [()=>source.details('u1'),()=>source.decide({}),()=>source.correct({})])
    await assert.rejects(action(),{code:'understanding_read_cancelled'});
  assert.equal(calls.length,count);
});

async function domFixture(t,overrides={}){
  const dom=new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>',{url:'http://127.0.0.1/'});
  const keys=['window','document','IS_REACT_ACT_ENVIRONMENT'],prior=Object.fromEntries(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true}))
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  const {createRoot}=await import('react-dom/client'),root=createRoot(document.getElementById('root'));
  const listeners=new Set(),calls=[];let state={items:[detail()],total:1,offset:0,nextOffset:null,loading:false,readEpoch:0},unmounted=false;
  const useUnderstandings=selector=>selector(useSyncExternalStore(fn=>{listeners.add(fn);return ()=>listeners.delete(fn);},()=>state));
  const copy={...zh,...understandingZh},props={useUnderstandings,t:key=>copy[key],onUnderstandingDetails:async id=>detail(id),
    onUnderstandingCorrect:async value=>{calls.push({kind:'correct',value});return {command:{admission:{state:'accepted'},result:null}};},
    onUnderstandingDecide:async value=>{calls.push({kind:'decide',value});return {command:{result:{state:'applied'}}};},
    onUnderstandingRefresh:async()=>{},onUnderstandingPage:async()=>{},...overrides};
  const render=async()=>{await act(async()=>root.render(React.createElement(UnderstandingDock,props)));};await render();
  const unmount=async()=>{if(!unmounted){unmounted=true;await act(async()=>root.unmount());}};
  t.after(async()=>{await unmount();dom.window.close();for(const key of keys){if(prior[key])Object.defineProperty(globalThis,key,prior[key]);else delete globalThis[key];}});
  const buttons=label=>[...document.querySelectorAll('button')].filter(n=>n.textContent===label);
  const click=async(label,index=0)=>{await act(async()=>buttons(label)[index].click());};
  const type=async value=>{const n=document.querySelector('textarea');await act(async()=>{
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value').set.call(n,value);
    n.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});};
  return {calls,buttons,click,type,unmount,props,render,
    open:async()=>{await click(understandingZh.understandingOpen);await click(understandingZh.understandingOpen);},
    update:async next=>{await act(async()=>{state={...state,...next};for(const fn of listeners)fn();});}};
}

test('DOM shows escaped exact evidence/history and sends displayed understanding/source revisions only on click',async t=>{
  const f=await domFixture(t);await f.open();
  assert.equal(f.calls.length,0);assert.equal(document.querySelectorAll('script,img').length,0);
  assert.ok(document.body.textContent.includes(detail().sources[0].content));
  assert.ok(document.body.textContent.includes('旧版本原文'));
  assert.ok(document.body.textContent.includes(understandingZh.understandingBoundary));
  assert.ok(document.body.textContent.includes(understandingZh.understandingWithdrawalHelp));
  await f.update({items:[detail('u1',9)]});
  await f.click(understandingZh.understandingWithdraw);
  assert.deepEqual(f.calls[0].value.sourceRef,{id:'source-1',revision:4,expectedControlRevision:7});
  assert.equal(f.calls[0].value.expectedRevision,2);assert.equal(Object.hasOwn(f.calls[0].value,'userIdentity'),false);
  assert.equal(f.calls.some(x=>x.kind==='correct'),false);
});

test('DOM literal correction is exact and accepted does not announce adoption',async t=>{
  const f=await domFixture(t);await f.open();await f.click(understandingZh.understandingCorrect);
  await f.type(request().text);assert.equal(f.calls.length,0);
  await f.click(understandingZh.understandingSubmit);
  assert.equal(f.calls[0].value.text,request().text);assert.equal(f.calls[0].value.expectedRevision,2);
  assert.ok(document.body.textContent.includes(understandingZh.understandingPending));
  assert.equal(document.body.textContent.includes(understandingZh.understandingApplied),false);
});

test('unknown correction retains draft and request identity, without refresh-driven replay',async t=>{
  const sent=[],f=await domFixture(t,{onUnderstandingCorrect:async value=>{sent.push(value);return {command:{admission:{state:'unknown'},result:null}};}});
  await f.open();await f.click(understandingZh.understandingCorrect);await f.type(request().text);
  await f.click(understandingZh.understandingSubmit);assert.equal(sent.length,1);
  assert.equal(document.querySelector('textarea').value,request().text);assert.ok(document.body.textContent.includes(understandingZh.understandingUnknown));
  await f.click(understandingZh.understandingSubmit);assert.equal(sent.length,2);assert.equal(sent[1].requestId,sent[0].requestId);
  await f.click(zh.refresh);assert.equal(sent.length,2);
});

test('known version conflict refreshes detail without replay or an unknown-outcome claim',async t=>{
  const sent=[];let revision=2;
  const f=await domFixture(t,{
    onUnderstandingDetails:async()=>detail('u1',revision),
    onUnderstandingDecide:async value=>{
      sent.push(value);
      if(sent.length===1){revision=3;throw Object.assign(new Error('版本已变化，请核对当前内容'),{code:'revision_conflict'});}
      return {command:{result:{state:'applied'}}};
    },
  });
  await f.open();await f.click(understandingZh.understandingStop);
  assert.equal(sent.length,1);assert.equal(sent[0].expectedRevision,2);
  assert.ok(document.body.textContent.includes('版本已变化，请核对当前内容'));
  assert.equal(document.body.textContent.includes(understandingZh.understandingUnknown),false);
  assert.ok(document.querySelector('article').textContent.includes(zh.revision+' 3'));
  await f.click(understandingZh.understandingStop);
  assert.equal(sent.length,2);assert.equal(sent[1].expectedRevision,3);
  assert.notEqual(sent[0].requestId,sent[1].requestId);
});

test('late refresh cannot reopen a previous detail or transfer its draft to another understanding',async t=>{
  const gate=later(),f=await domFixture(t,{onUnderstandingRefresh:()=>gate.promise});
  await f.update({items:[detail(),detail('other')],total:2});await f.open();
  await f.click(understandingZh.understandingCorrect);await f.type('旧对象草稿');
  await f.click(zh.refresh); // Read remains pending; selecting another row is still deliberate.
  await f.click(understandingZh.understandingOpen,1);
  assert.ok(document.querySelector('article').getAttribute('aria-label').endsWith('other'));
  assert.equal(document.querySelector('textarea'),null);
  await act(async()=>gate.resolve());
  assert.ok(document.querySelector('article').getAttribute('aria-label').endsWith('other'));
  assert.equal(f.calls.length,0);
});

test('reset or unmount invalidates pending details and drafts instead of reviving obsolete controls',async t=>{
  const gate=later(),f=await domFixture(t,{onUnderstandingDetails:()=>gate.promise});
  await f.open();await f.update({readEpoch:1,items:[],total:0});
  await act(async()=>gate.resolve(detail()));
  assert.equal(document.querySelector('article'),null);assert.equal(document.querySelector('textarea'),null);
  assert.equal(f.calls.length,0);
  const pending=later();f.props.onUnderstandingDetails=()=>pending.promise;await f.render();
  await f.update({items:[detail()],total:1});await f.click(understandingZh.understandingOpen);
  await f.unmount();await act(async()=>pending.resolve(detail()));assert.equal(f.calls.length,0);
});

test('unavailable sources cannot be withdrawn and applied/failed command results remain distinct',async t=>{
  const value=detail();value.sources[0].available=false;value.controls={stopAllowed:false,correctionAllowed:false};
  value.commands=[
    {id:'c1',action:'correct',requestId:'accepted-only',admission:{state:'accepted'},result:null},
    {id:'c2',action:'correct',requestId:'failed-literal',request:{text:'原始失败纠正'},
      admission:{state:'unknown'},result:{state:'failed',error:{message:'版本冲突，原话保留'}}},
    {id:'c3',action:'withdraw-source',requestId:'applied-source',result:{state:'applied',
      changes:[{kind:'methods',id:'m1',revision:3}],goalImpacts:[{id:'g1',before:{status:'tracking'},after:{status:'tracking',definitionAvailable:false}}]}},
  ];value.commandsTotal=3;
  const f=await domFixture(t,{onUnderstandingDetails:async()=>value});await f.open();
  assert.equal(f.buttons(understandingZh.understandingWithdraw)[0].disabled,true);
  assert.equal(f.buttons(understandingZh.understandingStop)[0].disabled,true);
  await f.click(understandingZh.understandingWithdraw);assert.equal(f.calls.length,0);
  for(const text of [understandingZh.understandingAwaiting,understandingZh.understandingFailed,understandingZh.understandingApplied,
    understandingZh.understandingEffects,understandingZh.understandingGoalEffects,'原始失败纠正','版本冲突，原话保留'])assert.ok(document.body.textContent.includes(text),text);
});

test('collaboration view scopes understanding reads to native session; unload blocks retained callbacks',async t=>{
  await domFixture(t);const ctx=new Context(),entries=[],calls=[];
  class Slots extends Service{constructor(owner){super(owner,'slots');}inject(_name,install){return this.ctx.effect(install);}
    register(options,component){const entry={options,component};entries.push(entry);return ()=>entries.splice(entries.indexOf(entry),1);}}
  new Slots(ctx);ctx.provide('fileUpload', { upload() { throw new Error('No upload expected in this fixture'); } });
  ctx.provide('locale',{register:()=>()=>{}});
  ctx.provide('connection',{rpc:{async call(_channel,method,payload){
    if(method==='arcfoldDesktop/status')return {ok:true,value:{state:'not_desktop'}};
    if(method==='arcfoldMode/current')return {ok:true,value:{goalTreeV3:false}};
    calls.push({method,request:payload.args.request});return {ok:true,value:{items:[],total:0,nextOffset:null}};}}});
  t.after(()=>ctx.fiber.dispose());const fiber=ctx.plugin(Client);await fiber.await();
  assert.equal(entries.length,4);const entry=entries.find(e=>e.options.id==='arcfold'&&e.options.name==='conversation.view'),face=entry.options.inject('main-one');
  assert.equal(face.understandingSessionId,'main-one');assert.ok(face.hooks.understandings);
  const second=entry.options.inject('main-two');
  assert.equal(second.understandingSessionId,'main-two');
  assert.notEqual(face.hooks.understandings,second.hooks.understandings);
  assert.equal(entry.options.inject('main-one').hooks.understandings,face.hooks.understandings);
  await face.onUnderstandingRefresh();assert.equal(calls[0].request.sessionId,'main-one');
  await fiber.dispose();const count=calls.length;
  await face.onUnderstandingRefresh();
  await assert.rejects(face.onUnderstandingDetails('u1'),{code:'understanding_read_cancelled'});
  await assert.rejects(face.onUnderstandingCorrect(request()),{code:'understanding_read_cancelled'});
  assert.equal(calls.length,count);assert.equal(entries.length,0);
});

async function importedKnowledge(f) {
  const source={id:'old-original',revision:1,createdSequence:1,updatedSequence:1,role:'user',content:'  旧原话。\n完整来源  ',conversationId:'old'};
  const u={id:'old-understanding',revision:1,createdSequence:2,updatedSequence:2,version:1,status:'active',
    content:'需要可核对的来源。',claimType:'inference',scope:{},sourceIds:[source.id],dependencies:[{kind:'events',id:source.id,revision:1}]};
  const tables={events:[source],conversations:[],understandings:[u,{...u,id:'second-understanding'}],
    methods:[{id:'paused-method',revision:1,createdSequence:2,updatedSequence:2,version:1,status:'paused',scope:{},
      title:'保留来源',guidance:'先核对原件',appliesTo:'研究',doesNotApplyTo:'闲聊',trialUses:0,maxTrialUses:3,
      sourceIds:[source.id],dependencies:u.dependencies}],
    adoptions:[],goals:[{id:'old-goal',revision:1,createdSequence:2,updatedSequence:2,definitionVersion:1,
      title:'旧目标',outcome:'历史任务不能重启',status:'tracking',sourceIds:[source.id],dependencies:u.dependencies}],opportunities:[],feedback:[],deliveries:[],imports:[],source_controls:[],audit:[]};
  const rows=Object.entries(tables).flatMap(([kind,records])=>records.map(record=>({type:'record',kind,record})));
  const data=Buffer.from([{type:'header',format:'arcfold-legacy3-business-export-v1',exportId:'blank-main',schemaVersion:2,
    mutationSequence:2,collections:Object.keys(tables),excluded:['jobs','credentials','budget']},...rows,
    {type:'footer',complete:true,counts:Object.fromEntries(Object.entries(tables).map(([kind,records])=>[kind,records.length])),digest:importDigest(rows)}].map(row=>JSON.stringify(row)).join('\n')+'\n');
  const prepared=await f.imports.prepare({sessionId:'main',requestId:'import-blank',receiptId:'synthetic-receipt',scopeMap:[],
    userIdentity:'browser:'+f.peer.id,file:{name:'synthetic.jsonl',bytes:data.length,sha256:textDigest(data)},read:async function*(){yield data;}});
  assert.equal(prepared.status,'ready');
  f.imports.confirm({sessionId:'main',batchId:prepared.id,expectedRevision:prepared.revision,previewHash:prepared.previewHash,requestId:'confirm-blank',userIdentity:'browser:'+f.peer.id});
  const imported=f.store.listAll('understandings')[0];assert.ok(imported);
  return {source,u,imported};
}
// Regression first added against gen25 before changing the historical binding gate.
test('blank native main can inspect genuinely imported understanding through Gateway without chatting',async t=>{
  const f=await gatewayFixture(t,{realBusiness:true});
  const {source,u,imported}=await importedKnowledge(f);
  assert.equal(f.ctx.agents.get('main'),f.registry.main.agent);
  assert.equal(f.ctx.agentPresets.composedPreset(f.registry.main.agent.ctx),'arcfold-main');
  assert.equal(f.store.listAll('host_bindings').length,0);
  const before=f.store.currentSequence();
  const viewed=await f.invoke('details',{sessionId:'main',understandingId:imported.id});
  assert.equal(viewed.sources[0].content,source.content);assert.equal(viewed.understanding.content,u.content);
  assert.equal(f.store.currentSequence(),before);assert.equal(f.native.length,0);
  for(const kind of ['host_bindings','context_snapshots','deliveries','learning_pending','learning_runs','method_adoptions'])
    assert.equal(f.store.listAll(kind).length,0,kind);
  assert.equal(f.registry.main.agent.session.snapshotEvents().some(event=>['turn/start','user/message','tool/call'].includes(event.type)),false);
});

test('blank-main imported management and existing global Method/Goal controls create no execution',async t=>{
  const f=await gatewayFixture(t,{realBusiness:true}),{imported}=await importedKnowledge(f);
  const sources=(await f.invoke('details',{sessionId:'main',understandingId:imported.id})).sources;
  assert.equal(f.store.listAll('goals').length,0,'Old imported goals remain history');
  assert.equal(f.store.listAll('import_records').some(row=>row.originalId==='old-goal'&&row.eligibility==='history'),true);
  const method=(await f.invokeMethod('list',{})).items[0];assert.ok(method);
  await f.invokeMethod('decide',{methodId:method.method.id,expectedRevision:method.method.revision,contentHash:method.contentHash,
    action:'pause',requestId:'pause-imported-method'});
  const goal=f.store.save('goals',{id:'existing-goal',title:'既有目标',outcome:'保持方向',definitionVersion:1,status:'paused',
    sourceIds:[sources[0].id],dependencies:[{kind:'events',id:sources[0].id,revision:sources[0].revision}],
    progress:{content:'',sourceIds:[],dependencies:[]},relations:[]});
  const before=(await f.invokeGoal('list',{sessionId:'main'}));assert.equal(before.canDiscuss,true);
  await f.invokeGoal('decide',{goalId:goal.id,expectedRevision:goal.revision,definitionVersion:1,action:'close',requestId:'close-existing'});
  const other=f.store.listAll('understandings').find(row=>row.id!==imported.id);
  await f.invoke('decide',{sessionId:'main',understandingId:other.id,expectedRevision:other.revision,requestId:'stop-second',action:'stop-understanding'});
  await f.invoke('decide',{sessionId:'main',understandingId:imported.id,expectedRevision:imported.revision,requestId:'withdraw-original',
    action:'withdraw-source',sourceRef:{id:sources[0].id,revision:sources[0].revision,expectedControlRevision:sources[0].expectedControlRevision}});
  assert.equal(f.store.get('source_controls',sources[0].id).useProhibited,true);
  assert.equal(f.native.length,0);
  for(const kind of ['host_bindings','context_snapshots','deliveries','learning_pending','learning_runs','method_adoptions','goal_discussions'])
    assert.equal(f.store.listAll(kind).length,0,kind);
  assert.equal(f.registry.main.agent.session.snapshotEvents().some(row=>['turn/start','user/message','tool/call'].includes(row.type)),false);
  await f.registry.main.dispose();
  assert.equal((await f.invokeGoal('list',{sessionId:'main'})).canDiscuss,false);
  await f.invokeGoal('details',{sessionId:'main',goalId:goal.id});
  const current=f.store.get('goals',goal.id);
  await f.invokeGoal('decide',{goalId:goal.id,expectedRevision:current.revision,definitionVersion:1,action:'pause',requestId:'global-after-dispose'});
  await f.invokeMethod('details',{methodId:method.method.id});
  assert.equal(f.native.length,0);
});

test('actual main registry and preset reject helpers, foreign presets, cold or disposed sessions despite old binding',async t=>{
  const f=await gatewayFixture(t,{realBusiness:true}),{imported}=await importedKnowledge(f);
  const unrelated=await f.registry.create('other','unrelated');
  for(const id of ['helper','other','cold']){
    await assert.rejects(f.invoke('details',{sessionId:id,understandingId:imported.id}),e=>e.code==='understanding_session_denied');
    assert.equal((await f.invokeGoal('list',{sessionId:id})).canDiscuss,false);
  }
  f.store.save('host_bindings',{id:'main',role:'main'});
  await f.registry.main.dispose();
  await assert.rejects(f.invoke('details',{sessionId:'main',understandingId:imported.id}),e=>e.code==='understanding_session_denied');
  assert.equal(f.native.length,0);assert.equal(f.ctx.agents.get(unrelated.agent.id),unrelated.agent);
});

test('blank main exact correction and goal discussion use official steer/queue without applying either merely on admission',async t=>{
  const f=await gatewayFixture(t,{realBusiness:true}),{imported}=await importedKnowledge(f);
  const source=(await f.invoke('details',{sessionId:'main',understandingId:imported.id})).sources[0];
  const goal=f.store.save('goals',{id:'discussion-goal',title:'既有目标',outcome:'继续讨论',definitionVersion:1,status:'paused',
    sourceIds:[source.id],dependencies:[{kind:'events',id:source.id,revision:source.revision}],
    progress:{content:'',sourceIds:[],dependencies:[]},relations:[]});
  const correction=request({understandingId:imported.id,expectedRevision:imported.revision});
  assert.equal((await f.invoke('correct',correction)).command.admission.state,'accepted');
  assert.equal(f.store.get('understandings',imported.id).revision,imported.revision);
  const discussion={sessionId:'main',goalId:goal.id,expectedRevision:goal.revision,definitionVersion:1,
    requestId:'first-goal',mode:'discuss',text:'  请围绕这个目标\n先核对我的原话。  '};
  assert.equal((await f.invokeGoal('discuss',discussion)).binding.admission.state,'accepted');
  assert.deepEqual(f.native.map(row=>row.input.mode),['steer','queue']);
  assert.deepEqual(f.native.map(row=>row.source),[{kind:'user',rpcId:correction.requestId},{kind:'user',rpcId:discussion.requestId}]);
  assert.equal(f.native[0].input.content[0].text,correction.text);assert.equal(f.native[1].input.content[0].text,discussion.text);
  assert.equal(f.store.get('goals',goal.id).status,'paused');
  assert.equal(f.store.listAll('goal_links').length,0);assert.equal(f.store.listAll('host_bindings').length,0);
  assert.throws(()=>f.business.service.applyClaimedCorrections({sessionId:'main',claims:[],events:[]}),e=>e.code==='understanding_session_denied');
  f.prompt=async()=>{throw new Error('unknown after official prompt entry');};
  const uncertain={...correction,requestId:'unknown-correction'};
  assert.equal((await f.invoke('correct',uncertain)).command.admission.state,'unknown');
  const fresh=createUnderstandingHandler({understandings:f.business.service,agents:f.ctx.agents,agentPresets:f.ctx.agentPresets,
    connection:f.ctx.connection,prompt(){assert.fail('durable unknown must not resend');}});
  assert.equal((await fresh('correct',uncertain,live(),f.peer)).command.admission.state,'unknown');
  const uncertainGoal={...discussion,requestId:'unknown-goal'};
  assert.equal((await f.invokeGoal('discuss',uncertainGoal)).binding.admission.state,'unknown');
  assert.equal((await f.invokeGoal('discuss',uncertainGoal)).created,false);
  assert.equal(f.native.length,4);
});

test('same-id replacement between correction binding and prompt fails and cannot be retried into the replacement',async()=>{
  const f=businessFixture(),owner=peer();let current={id:'main',ctx:{}},sent=0;
  const agents={get:id=>id==='main'?current:undefined},agentPresets={composedPreset:()=> 'arcfold-main'};
  const handler=createUnderstandingHandler({understandings:f.service,agents,agentPresets,connection:{browserPeer:owner},
    prompt(){sent++;return {accepted:true};}});
  f.onBind=()=>{current={id:'main',ctx:{}};};
  const result=await handler('correct',request(),live(),owner);
  assert.equal(result.command.admission.state,'failed');assert.equal(sent,0);
  f.onBind=null;assert.equal((await handler('correct',request(),live(),owner)).created,false);assert.equal(sent,0);
});
