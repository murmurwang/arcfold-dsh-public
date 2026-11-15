import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useSyncExternalStore } from 'react';
import { JSDOM } from 'jsdom';
import { createImportSource, IMPORT_MAX_FILE_BYTES } from '../packages/method-ui/src/import-source.mjs';
import { ImportDock } from '../packages/method-ui/src/ImportDock.mjs';
import { importsZh } from '../packages/method-ui/src/import-locales.mjs';
import { zh } from '../packages/method-ui/src/locales.mjs';
const deferred = () => { let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };
const result = value => ({ok:true,value});
const batch = (extra={}) => ({id:'batch-one',sessionId:'main',revision:2,status:'ready',file:{name:'original.json',bytes:2,sha256:'a'.repeat(64)},
  format:'fixture',previewHash:'b'.repeat(64),scopeMap:[],sourceScopes:[{sourceConversationId:'old-one',title:'第一段旧交流',preview:'原文节选',messageCount:2}],
  counts:{sources:2,records:1,enabled:0,trial:1,paused:0,history:0,needsReview:0},createdAt:'2026-11-07T00:00:00Z',error:null,...extra});
const detail = (value=batch()) => ({batch:value,view:'records',items:[{id:'old-method',title:'保留来源',textPreview:'<img src=x onerror=alert(1)> 节选',textKey:'method-text',
  eligibility:'trial',scope:{kind:'global'},methodUsage:{trialUses:2,maxTrialUses:3,remaining:1,status:'trial'},reasonCodes:['proven_trial_basis']}],total:1,nextOffset:null});

test('native File body, exact session and explicit operations; refresh never uploads or confirms',async()=>{
  const calls=[],uploads=[],resets=new Set();
  const source=createImportSource({sessionId:'main',intervalMs:60000,subscribeReset:fn=>{resets.add(fn);return ()=>resets.delete(fn);},
    fileUpload:{async upload(...args){uploads.push(args);return result({receiptId:'receipt-one',file:{name:args[2],bytes:args[1].size}});}},
    rpc:{async call(channel,method,payload,signal){calls.push({channel,method,request:payload.args.request,signal});
      return result(method.endsWith('/list')?{items:[],total:0,nextOffset:null}:batch());}}});
  const stop=source.subscribe(()=>{});await source.refresh();assert.equal(uploads.length,0);
  const file=new File(['{}'],'original.json');const receipt=await source.upload(file);
  assert.equal(uploads[0][0],'main');assert.equal(uploads[0][1],file);assert.ok(uploads[0][3] instanceof AbortSignal);
  await source.prepare({receiptId:receipt.receiptId,requestId:'prepare-one',scopeMap:[]});
  await source.refresh();[...resets][0]();await Promise.resolve();
  assert.equal(uploads.length,1);assert.equal(calls.filter(row=>row.method.endsWith('/prepare')).length,1);
  assert.equal(calls.some(row=>/confirm|withdraw|prompt/.test(row.method)),false);
  assert.ok(calls.every(row=>row.channel==='/api'&&row.request.sessionId==='main'));
  const huge=new Blob(['x']);Object.defineProperty(huge,'size',{value:IMPORT_MAX_FILE_BYTES+1});
  await assert.rejects(source.upload(huge),{code:'invalid_import_file'});assert.equal(uploads.length,1);
  stop();source.dispose();const count=calls.length;
  for(const method of ['details','prepare','confirm','withdraw'])await assert.rejects(source[method]({}),{code:'import_request_cancelled'});
  await assert.rejects(source.upload(file),{code:'import_request_cancelled'});assert.equal(calls.length,count);
});

test('reset aborts upload and discards late receipt; late details cannot revive an old preview',async()=>{
  const upload=deferred(),read=deferred(),resets=new Set();let uploadSignal;
  const source=createImportSource({sessionId:'main',intervalMs:60000,subscribeReset:fn=>{resets.add(fn);return ()=>resets.delete(fn);},
    fileUpload:{upload(_id,_file,_name,signal){uploadSignal=signal;return upload.promise;}},
    rpc:{async call(_channel,method){return method.endsWith('/details')?read.promise:result({items:[],total:0,nextOffset:null});}}});
  const stop=source.subscribe(()=>{}),u=source.upload(new File(['{}'],'original.json')),d=source.details({batchId:'batch-one'});
  void u.catch(()=>{});void d.catch(()=>{});[...resets][0]();assert.equal(uploadSignal.aborted,true);
  upload.resolve(result({receiptId:'late',file:{bytes:2}}));read.resolve(result(detail()));
  await assert.rejects(u,{code:'import_request_cancelled'});await assert.rejects(d,{code:'import_request_cancelled'});
  assert.equal(source.getSnapshot().readEpoch,1);stop();source.dispose();
});

async function fixture(t,overrides={}) {
  const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://127.0.0.1/'});
  const values={window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true};
  const prior=Object.fromEntries(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const [key,value]of Object.entries(values))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  const {createRoot}=await import('react-dom/client'),root=createRoot(document.getElementById('root'));
  const listeners=new Set(),calls=[];let currentBatch=batch(),state={items:[currentBatch],total:1,offset:0,nextOffset:null,loading:false,readEpoch:0},unmounted=false;
  const props={importSessionId:'main',useImports:selector=>selector(useSyncExternalStore(fn=>{listeners.add(fn);return ()=>listeners.delete(fn);},()=>state)),
    t:key=>({...zh,...importsZh})[key],onImportDetails:async request=>{calls.push(['details',request]);return request.view==='text'?{batch:currentBatch,view:'text',textKey:request.textKey,text:'  完整原文 <script>保留</script>\n ',offset:request.offset,total:40000,nextOffset:16000}:detail(currentBatch);},
    onImportUpload:async file=>{calls.push(['upload',file]);return {receiptId:'receipt-one',file:{name:file.name,bytes:file.size}};},
    onImportPrepare:async request=>{calls.push(['prepare',request]);currentBatch=batch({id:'batch-new',scopeMap:request.scopeMap});return currentBatch;},
    onImportConfirm:async request=>{calls.push(['confirm',request]);currentBatch={...currentBatch,status:'confirmed',revision:3};return currentBatch;},
    onImportWithdraw:async request=>{calls.push(['withdraw',request]);currentBatch={...currentBatch,status:'withdrawn',revision:4};return currentBatch;},
    onImportRefresh:async()=>{calls.push(['refresh']);},onImportPage:async()=>{},...overrides};
  const render=async()=>{await act(async()=>root.render(React.createElement(ImportDock,props)));};await render();
  const unmount=async()=>{if(!unmounted){unmounted=true;await act(async()=>root.unmount());}};
  t.after(async()=>{await unmount();dom.window.close();for(const key of Object.keys(values)){if(prior[key])Object.defineProperty(globalThis,key,prior[key]);else delete globalThis[key];}});
  const buttons=label=>[...document.querySelectorAll('button')].filter(n=>n.textContent===label);
  const click=async(label,index=0)=>{await act(async()=>buttons(label)[index].click());};
  const change=async(node,value)=>{await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype,'value').set.call(node,value);node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});};
  return {calls,props,render,buttons,click,change,unmount,
    open:async()=>{await click(importsZh.importOpen);await click(importsZh.importPreview);},
    choose:async()=>{const input=document.querySelector('input[type=file]');await act(async()=>{Object.defineProperty(input,'files',{value:[new File(['{}'],'original.json')],configurable:true});input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});},
    update:async next=>{await act(async()=>{state={...state,...next};for(const fn of listeners)fn();});},
  };
}

test('DOM displays trial basis and escaped originals, confirmation binds the viewed batch and withdrawal is explicit',async t=>{
  const f=await fixture(t);await f.open();
  assert.ok(document.body.textContent.includes('已用 2 / 上限 3 · 剩余试用次数 1'));
  assert.equal(f.calls.some(([name])=>/confirm|withdraw|upload|prepare/.test(name)),false);
  await f.click(importsZh.importContent);assert.ok(document.body.textContent.includes('  完整原文 <script>保留</script>\n '));
  assert.equal(document.querySelectorAll('script,img').length,0);
  await f.click(importsZh.importReadMore);assert.equal(f.calls.filter(([name])=>name==='details').at(-1)[1].offset,16000);
  await f.update({items:[batch({revision:99})]});await f.click(importsZh.importConfirm);
  const request=f.calls.find(([name])=>name==='confirm')[1];
  assert.equal(request.expectedRevision,2);assert.equal(request.previewHash,'b'.repeat(64));assert.equal(request.batchId,'batch-one');assert.ok(request.requestId);
  assert.equal(f.calls.some(([name])=>name==='withdraw'),false);
  await f.click(importsZh.importWithdraw);assert.equal(f.calls.filter(([name])=>name==='withdraw').length,1);
  assert.ok(document.body.textContent.includes(importsZh.importWithdrawn));
});

test('upload produces preview only; changing scope requires another exact preview with the same receipt',async t=>{
  const f=await fixture(t);await f.click(importsZh.importOpen);await f.choose();assert.equal(f.calls.length,0);
  await f.click(importsZh.importPrepare);assert.equal(f.calls.filter(([name])=>name==='upload').length,1);
  assert.deepEqual(f.calls.find(([name])=>name==='prepare')[1].scopeMap,[]);
  await f.change(document.querySelector('select'),'old-one');assert.equal(f.buttons(importsZh.importConfirm)[0].disabled,true);
  await f.click(importsZh.importConfirm);assert.equal(f.calls.some(([name])=>name==='confirm'),false);
  await f.click(importsZh.importReprepare);
  const preparations=f.calls.filter(([name])=>name==='prepare').map(([,request])=>request);
  assert.equal(preparations.length,2);assert.equal(preparations[0].receiptId,preparations[1].receiptId);
  assert.notEqual(preparations[0].requestId,preparations[1].requestId);
  assert.deepEqual(preparations[1].scopeMap,[{sourceConversationId:'old-one',targetSessionId:'main'}]);
  assert.equal(f.calls.filter(([name])=>name==='upload').length,1);assert.equal(f.buttons(importsZh.importConfirm)[0].disabled,false);
});

test('lost confirmation only reads back; user retry keeps identity and no refresh-driven mutation occurs',async t=>{
  const sent=[],f=await fixture(t,{onImportConfirm:async request=>{sent.push(request);throw new Error('lost response');}});
  await f.open();await f.click(importsZh.importConfirm);assert.equal(sent.length,1);
  assert.ok(document.body.textContent.includes(importsZh.importUnknown));await f.click(zh.refresh);assert.equal(sent.length,1);
  await f.click(importsZh.importConfirm);assert.equal(sent.length,2);assert.equal(sent[0].requestId,sent[1].requestId);
});

test('another session cannot confirm, same-name/size old preview cannot reuse a receipt, reset clears pending details',async t=>{
  const gate=deferred(),f=await fixture(t);await f.click(importsZh.importOpen);await f.choose();await f.click(importsZh.importPrepare);
  f.props.onImportDetails=async()=>detail(batch({id:'same-name-another-batch',sessionId:'other'}));await f.render();await f.click(importsZh.importPreview);
  assert.equal(document.querySelector('select').disabled,true);assert.equal(f.buttons(importsZh.importConfirm)[0].disabled,true);
  await f.click(importsZh.importConfirm);assert.equal(f.calls.some(([name])=>name==='confirm'),false);
  f.props.onImportDetails=()=>gate.promise;await f.render();await f.click(importsZh.importPreview);await f.update({readEpoch:1,items:[]});
  await act(async()=>gate.resolve(detail()));assert.equal(document.querySelector('article'),null);
});


test('import reasons explain missing trial evidence and existing decisions without raw internal labels',async t=>{
  const value=detail();value.items[0]={...value.items[0],eligibility:'needs_review',reasonCodes:['method_trial_basis_unknown','method_existing_conflict'],existingRecordId:'existing-method-one'};
  const f=await fixture(t,{onImportDetails:async()=>value});await f.open();
  assert.ok(document.body.textContent.includes(importsZh.importReason_method_trial_basis_unknown));
  assert.ok(document.body.textContent.includes(importsZh.importReason_method_existing_conflict));
  assert.ok(document.body.textContent.includes('existing-method-one'));
  assert.equal(document.body.textContent.includes('method_trial_basis_unknown'),false);
  assert.equal(f.calls.some(([name])=>/confirm|prepare/.test(name)),false);
});


test('preview shows complete method applicability, understanding nature and the retained record before confirmation',async t=>{
  const value=detail();value.items[0]={...value.items[0],kind:'methods',appliesTo:'Only when comparing original source evidence.',doesNotApplyTo:'Not for unaudited claims.',originalTextKey:'original-method'};
  value.items.push({id:'understanding',kind:'understandings',textPreview:'An inference',claimType:'inference',scope:{kind:'global',topics:['Research']},reasonCodes:[]});
  const f=await fixture(t,{onImportDetails:async request=>request.view==='text'?{batch:batch(),view:'text',textKey:request.textKey,text:'retained earlier fields',offset:0,total:23,nextOffset:null}:value});
  await f.open();
  for(const text of [value.items[0].appliesTo,value.items[0].doesNotApplyTo,importsZh.importClaimInference,'Research'])assert.ok(document.body.textContent.includes(text));
  assert.equal(f.calls.some(([name])=>name==='confirm'),false);
  await f.click(importsZh.importOriginalRecord);assert.ok(document.body.textContent.includes('retained earlier fields'));
});


for(const status of ['confirmed','withdrawn'])test(`DOM ${status} details label the saved preview rather than current eligibility`,async t=>{
  const current=batch({status,revision:status==='confirmed'?3:4}),records=detail(current);
  records.items[0].eligibility='enabled';
  const sources={batch:current,view:'sources',items:[{id:'source',role:'user',available:true,textPreview:'保留的用户原话',textKey:'source-text'}],total:1,nextOffset:null};
  const originals=JSON.stringify({records,sources});
  const f=await fixture(t,{onImportDetails:async request=>request.view==='sources'?sources:records});await f.open();
  assert.ok(document.body.textContent.includes('以下为当时保存的导入预览，资格、来源状态和试用次数不代表当前状态。'));
  assert.ok(document.body.textContent.includes('当时预览资格：可采用'));
  assert.ok(document.body.textContent.includes('导入时试用次数：已用 2 / 上限 3 · 剩余试用次数 1'));
  assert.ok(document.body.textContent.includes('当时预览统计'));
  if(status==='withdrawn')assert.ok(document.body.textContent.includes('这批导入已撤回，不再作为当前依据。以下保留当时预览和原文。'));
  assert.equal(f.buttons(importsZh.importConfirm).length,0);
  assert.equal(f.buttons(importsZh.importWithdraw).length,status==='confirmed'?1:0);
  await f.click(importsZh.importSources);
  assert.ok(document.body.textContent.includes('当时来源状态：来源可用'));
  if(status==='withdrawn')assert.ok(document.body.textContent.includes('这批导入已撤回，不再作为当前依据。以下保留当时预览和原文。'));
  await f.update({readEpoch:1});await f.click(importsZh.importPreview);
  assert.ok(document.body.textContent.includes('当时预览资格：可采用'));
  assert.equal(JSON.stringify({records,sources}),originals);
  assert.equal(f.calls.some(([name])=>/confirm|withdraw|prepare|upload/.test(name)),false);
});
