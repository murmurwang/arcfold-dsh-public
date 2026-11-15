import test from 'node:test';
import assert from 'node:assert/strict';
import { BusinessStore } from '../src/business.mjs';
import { ImportService } from '../src/importer.mjs';
import { importDigest,textDigest } from '../src/legacy-import-source.mjs';
import { MethodService,usageForVersion } from '../src/methods.mjs';
import { dependenciesCurrent } from '../src/evidence.mjs';

function fixture(){
  const e={id:'e',role:'user',content:'  喜欢可检查来源的方法。\n保留空白  ',conversationId:'old',occurredAt:'2026-01-01T00:00:00Z',revision:1,createdSequence:1,updatedSequence:1};
  const base={version:1,revision:4,createdSequence:2,updatedSequence:10,title:'方法',guidance:'附上来源',appliesTo:'研究',doesNotApplyTo:'闲聊',scope:{},sourceIds:['e'],dependencies:[{kind:'events',id:'e',revision:1}],maxTrialUses:3,validated:false};
  const methods=[{...base,id:'trial2',status:'trial',trialUses:2},{...base,id:'trial0',status:'trial',trialUses:0},
    {...base,id:'paused',status:'paused',trialUses:3},{...base,id:'active',status:'active',trialUses:3,revision:6,activationSourceId:'authorization'}];
  for(const method of methods)method.title+=' '+method.id;
  const active=methods.at(-1),authorization={...e,id:'authorization',content:'继续采用这条方法',createdSequence:20,updatedSequence:20,
    provenance:{kind:'explicit_method_authorization',interaction:'method_activation',methodId:'active',methodRevision:5,methodVersion:1,appliesTo:active.appliesTo,doesNotApplyTo:active.doesNotApplyTo}};
  const u={id:'u',version:1,revision:1,createdSequence:2,updatedSequence:2,status:'active',scope:{},content:'喜欢查证的摘要',claimType:'inference',sourceIds:['e'],dependencies:[{kind:'events',id:'e',revision:1}]};
  const adoptions=[];
  for(const method of methods)for(let n=1;n<=method.trialUses;n++)adoptions.push({id:method.id+':'+n,revision:1,createdSequence:10+n,updatedSequence:10+n,selectedVersions:[{id:method.id,semanticVersion:1,revision:n+1,trialUse:n}]});
  adoptions.push({id:'active:4',revision:1,createdSequence:30,updatedSequence:30,selectedVersions:[{id:'active',semanticVersion:1,revision:6,trialUse:null}]});
  return {events:[e,authorization],conversations:[{id:'old',title:'旧交流'}],understandings:[u],methods,adoptions,
    goals:[],opportunities:[],feedback:[],deliveries:[],imports:[],source_controls:[],
    audit:[{id:'activation',createdSequence:22,updatedSequence:22,action:'user_method_activation',kind:'methods',recordId:'active',sourceId:'authorization',before:{...active,status:'paused',revision:5},after:{...active}}]};
}
function exported(tables=fixture()){
  const rows=Object.entries(tables).flatMap(([kind,records])=>records.map(record=>({type:'record',kind,record})));
  return [{type:'header',format:'arcfold-legacy3-business-export-v1',exportId:'export-one',schemaVersion:2,mutationSequence:100,collections:Object.keys(tables),excluded:['jobs','credentials','budget']},
    ...rows,{type:'footer',complete:true,counts:Object.fromEntries(Object.entries(tables).map(([k,v])=>[k,v.length])),digest:importDigest(rows)}].map(row=>JSON.stringify(row)).join('\n')+'\n';
}
function setup(t){const business=new BusinessStore({filename:':memory:'}),imports=new ImportService({business});
  t.after(async()=>{await imports.close();business.close();});return{business,store:business.storage,imports};}
function request(text,extra={}){const data=Buffer.from(text);return{sessionId:'main',receiptId:'receipt',requestId:'prepare-one',scopeMap:[],
  userIdentity:'browser:owner',file:{name:'export.jsonl',bytes:data.length,sha256:textDigest(data)},read:async function*(){for(let i=0;i<data.length;i+=65536)yield data.subarray(i,i+65536);},...extra};}
const decide=(batch,requestId,extra={})=>({sessionId:'main',batchId:batch.id,expectedRevision:batch.revision,previewHash:batch.previewHash,requestId,userIdentity:'browser:owner',...extra});

test('complete old3 preview preserves qualified guidance and trial basis; confirm is atomic and replayable',async t=>{
  const {imports,store,business}=setup(t),batch=await imports.prepare(request(exported()));
  assert.equal(batch.status,'ready');assert.deepEqual(batch.counts,{sources:2,records:5,enabled:2,trial:2,paused:1,history:0,needsReview:0});
  const details=imports.details({sessionId:'main',batchId:batch.id});assert.equal(details.items.find(row=>row.originalId==='active').methodUsage.trialUses,3);
  assert.equal(store.listAll('events').length,0);
  assert.throws(()=>imports.confirm(decide(batch,'wrong',{expectedRevision:1})),e=>e.code==='revision_conflict');
  const applied=imports.confirm(decide(batch,'confirm'));assert.equal(applied.status,'confirmed');
  assert.deepEqual(imports.confirm(decide(batch,'confirm')),applied);
  assert.equal(store.listAll('events').length,2);assert.equal(store.listAll('method_adoptions').length,0);
  const service=new MethodService({business}),catalog=service.catalog({sessionId:'main'});
  assert.equal(catalog.length,3);
  const imported=Object.fromEntries(store.listAll('methods').map(row=>[row.importProvenance.originalId,row]));
  assert.deepEqual(usageForVersion(store,imported.trial2),{trialUses:2,maxTrialUses:3,remaining:1});
  assert.deepEqual(usageForVersion(store,imported.trial0),{trialUses:0,maxTrialUses:3,remaining:3});
  assert.equal(imported.paused.status,'paused');assert.equal(imported.active.status,'active');assert.equal(imported.active.validated,false);
  assert.equal(dependenciesCurrent(store,store.listAll('understandings')[0],store.currentSequence()),true);
  const again=await imports.prepare(request(exported(),{requestId:'prepare-two'}));
  assert.equal(imports.confirm(decide(again,'confirm-two')).id,batch.id);assert.equal(store.listAll('events').length,2);
});
test('scope mapping is explicit, reuses receipt but needs new preview; source text pagination is lossless',async t=>{
  const {imports,store}=setup(t),tables=fixture();tables.understandings[0].scope={conversationId:'old'};
  const first=await imports.prepare(request(exported(tables)));assert.equal(imports.details({sessionId:'main',batchId:first.id}).items.find(r=>r.kind==='understandings').eligibility,'history');
  await assert.rejects(imports.prepare(request(exported(tables),{scopeMap:[{sourceConversationId:'old',targetSessionId:'main'}]})),e=>e.code==='import_identity_conflict');
  const second=await imports.prepare(request(exported(tables),{requestId:'mapped',scopeMap:[{sourceConversationId:'old',targetSessionId:'main'}]}));
  assert.equal(second.status,'ready');assert.notEqual(second.previewHash,first.previewHash);
  const sources=imports.details({sessionId:'main',batchId:second.id,view:'sources'}),key=sources.items[0].textKey;
  const a=imports.details({sessionId:'main',batchId:second.id,view:'text',textKey:key,offset:0,limit:4});
  const b=imports.details({sessionId:'main',batchId:second.id,view:'text',textKey:key,offset:4});
  assert.equal(a.text+b.text,tables.events[0].content);
  assert.throws(()=>imports.details({sessionId:'main',batchId:second.id,view:'text',textKey:'../other'}),e=>e.code==='import_text_denied');
  assert.throws(()=>imports.confirm(decide(second,'foreign',{sessionId:'other'})),e=>e.code==='import_not_confirmable');
  imports.confirm(decide(second,'mapped-confirm'));assert.equal(store.listAll('understandings')[0].scope.conversationId,'main');
});
test('missing/stale/unknown trial and active authority evidence remains review, never invented as zero or active',async t=>{
  const {imports,store}=setup(t),tables=fixture();delete tables.methods[0].trialUses;tables.methods[1].dependencies[0]={kind:'events',id:'e',revision:9};tables.audit=[];
  const batch=await imports.prepare(request(exported(tables))),details=imports.details({sessionId:'main',batchId:batch.id});
  const unknown=details.items.find(r=>r.originalId==='trial2');assert.equal(unknown.eligibility,'needs_review');assert.equal(unknown.methodUsage,undefined);
  assert.equal(details.items.find(r=>r.originalId==='active').eligibility,'needs_review');
  imports.confirm(decide(batch,'confirm'));assert.equal(store.listAll('methods').some(r=>r.status==='active'),false);
});
test('withdrawal keeps immutable originals and independent new correction, invalidates mixed dependencies without changing goal user control',async t=>{
  const {imports,store}=setup(t),batch=await imports.prepare(request(exported())),confirmed=imports.confirm(decide(batch,'confirm'));
  const old=store.listAll('events')[0],oldBytes=JSON.stringify(old),native=store.save('events',{id:'new-source',role:'user',content:'新独立原话',conversationId:'main',occurredAt:'2026-02-01T00:00:00Z'});
  store.save('understandings',{id:'independent',status:'active',version:1,previousId:store.listAll('understandings')[0].id,sourceIds:[native.id],dependencies:[{kind:'events',id:native.id,revision:native.revision}]});
  store.save('understandings',{id:'mixed',status:'active',version:1,sourceIds:[native.id,old.id],dependencies:[{kind:'events',id:old.id,revision:old.revision}]});
  store.save('goals',{id:'new-goal',status:'paused',userControl:{action:'pause',source:'owner'},sourceIds:[old.id],dependencies:[{kind:'events',id:old.id,revision:old.revision}]});
  const withdrawn=imports.withdraw(decide(confirmed,'withdraw'));assert.equal(withdrawn.status,'withdrawn');assert.deepEqual(imports.withdraw(decide(confirmed,'withdraw')),withdrawn);
  assert.equal(JSON.stringify(store.get('events',old.id)),oldBytes);assert.equal(store.get('source_controls',old.id).withdrawn,true);
  assert.equal(store.get('understandings','independent').status,'active');assert.equal(store.get('understandings','mixed').status,'withdrawn');
  const goal=store.get('goals','new-goal');assert.equal(goal.status,'paused');assert.deepEqual(goal.userControl,{action:'pause',source:'owner'});assert.equal(goal.useProhibited,true);
  const repeat=await imports.prepare(request(exported(),{requestId:'again'}));assert.throws(()=>imports.confirm(decide(repeat,'confirm-again')),e=>e.code==='import_already_withdrawn');
});
test('failed EOF stays nonconfirmable, concurrent prepare reads once, tampered prepared rows reject atomically',async t=>{
  const {imports,store}=setup(t),text=exported();let reads=0;
  const input=request(text,{read:async function*(){reads++;yield Buffer.from(text);throw new Error('late native digest');}});
  const [one,two]=await Promise.all([imports.prepare(input),imports.prepare(input)]);assert.equal(reads,1);assert.equal(one.status,'failed');assert.deepEqual(one,two);assert.equal(one.previewHash,null);
  assert.equal(store.listAll('events').length,0);
  const ready=await imports.prepare(request(text,{requestId:'clean'})),source=store.listAll('import_sources',{where:{batchId:ready.id}})[0];
  store.save('import_sources',{...source,content:'tampered'},{expectedRevision:source.revision});
  assert.throws(()=>imports.confirm(decide(ready,'tampered-confirm')),e=>e.code==='import_dependency_changed');
  assert.equal(store.listAll('events').length,0);assert.equal(imports.list({sessionId:'main'}).total,2);
});

test('complete export cannot omit source controls; missing exact source revision and post-cutoff source remain review',async t=>{
  const {imports,store}=setup(t),incomplete=fixture();delete incomplete.source_controls;
  const missing=await imports.prepare(request(exported(incomplete)));assert.equal(missing.status,'failed');assert.equal(missing.error.code,'invalid_import_export');
  const tables=fixture();tables.understandings[0].dependencies=[];
  const noRevision=await imports.prepare(request(exported(tables),{requestId:'no-revision'}));
  assert.equal(imports.details({sessionId:'main',batchId:noRevision.id}).items.find(r=>r.kind==='understandings').eligibility,'needs_review');
  imports.confirm(decide(noRevision,'confirm-revision'));assert.equal(store.listAll('understandings').length,0);
  const future=fixture();future.events[0].updatedSequence=101;
  const postCutoff=await imports.prepare(request(exported(future),{requestId:'future'}));
  assert.equal(imports.details({sessionId:'main',batchId:postCutoff.id}).items.every(r=>r.eligibility==='needs_review'),true);
});
test('withdrawn activation source is not authority even when it is outside old method sourceIds',async t=>{
  const {imports,store}=setup(t),tables=fixture();tables.source_controls=[{id:'authorization',withdrawn:true,useProhibited:true}];
  const batch=await imports.prepare(request(exported(tables)));
  assert.equal(imports.details({sessionId:'main',batchId:batch.id}).items.find(r=>r.originalId==='active').eligibility,'needs_review');
  imports.confirm(decide(batch,'confirm'));assert.equal(store.listAll('methods').some(m=>m.status==='active'),false);
});
test('nested runtime config and old sourceSnapshot cannot migrate inside allowed history collections',async t=>{
  const {imports,store}=setup(t),tables=fixture();tables.imports=[{id:'old-import',sourceSnapshot:{config:{synthetic:'must not migrate'}}}];
  const batch=await imports.prepare(request(exported(tables)));assert.equal(batch.status,'failed');assert.equal(batch.error.code,'invalid_import_export');
  assert.equal(store.listAll('import_history').length,0);assert.equal(store.listAll('events').length,0);
});

test('two ready exports cannot create two trial allocations; new export previews reference unchanged existing methods',async t=>{
  const {imports,store}=setup(t),text=exported(),first=await imports.prepare(request(text));
  const secondText=text.replace('export-one','export-two'),second=await imports.prepare(request(secondText,{requestId:'second-ready'}));
  imports.confirm(decide(first,'first-confirm'));
  const before=JSON.stringify(store.listAll('methods'));
  assert.throws(()=>imports.confirm(decide(second,'second-confirm')),e=>e.code==='import_dependency_changed');
  assert.equal(store.listAll('events').length,2);assert.equal(JSON.stringify(store.listAll('methods')),before);
  const again=await imports.prepare(request(secondText,{requestId:'after-first'})),items=imports.details({sessionId:'main',batchId:again.id}).items;
  const duplicate=items.filter(row=>row.kind==='methods');assert.equal(duplicate.length,4);
  assert.equal(duplicate.every(row=>row.eligibility==='history'&&row.reasonCodes.includes('method_already_present')&&row.existingRecordId),true);
  imports.confirm(decide(again,'history-confirm'));assert.equal(JSON.stringify(store.listAll('methods')),before);
  assert.equal(store.listAll('method_adoptions').length,0);
});
test('same old semantic identity with changed body or scope is a visible conflict; absent old3 method scope remains native global',async t=>{
  const {imports,store}=setup(t),tables=fixture();for(const row of tables.methods)delete row.scope;
  for(const row of tables.audit){delete row.before.scope;delete row.after.scope;}
  const first=await imports.prepare(request(exported(tables)));assert.equal(first.counts.trial,2);assert.equal(first.counts.enabled,2);imports.confirm(decide(first,'confirm'));
  const old=store.listAll('methods').find(row=>row.importProvenance.originalId==='trial2');
  const {originalFormat,...compat}=old.importProvenance;
  store.save('methods',{...old,importProvenance:compat},{expectedRevision:old.revision});
  const changed=fixture();changed.methods[0].guidance='相同旧id/version，内容冲突';
  changed.methods[1].scope={conversationId:'old'};
  changed.understandings[0].scope={kind:'unknown-scope'};
  const batch=await imports.prepare(request(exported(changed),{requestId:'conflicts',scopeMap:[{sourceConversationId:'old',targetSessionId:'main'}]}));
  const items=imports.details({sessionId:'main',batchId:batch.id}).items;
  for(const id of ['trial2','trial0']){const row=items.find(item=>item.originalId===id);assert.equal(row.eligibility,'needs_review');assert.ok(row.reasonCodes.includes('method_existing_conflict'));assert.ok(row.existingRecordId);}
  assert.ok(items.find(row=>row.kind==='understandings').reasonCodes.includes('scope_unsupported'));
  const before=JSON.stringify(store.listAll('methods'));imports.confirm(decide(batch,'confirm-conflicts'));assert.equal(JSON.stringify(store.listAll('methods')),before);
});
test('trial history beyond export cutoff is unproven; unknown source roles stay unavailable without relabelling',async t=>{
  const {imports}=setup(t),tables=fixture();tables.adoptions[0].updatedSequence=101;
  const batch=await imports.prepare(request(exported(tables)));
  assert.equal(imports.details({sessionId:'main',batchId:batch.id}).items.find(row=>row.originalId==='trial2').eligibility,'needs_review');
  const unknown=fixture();unknown.events[0].role='unknown-old-role';
  const other=await imports.prepare(request(exported(unknown),{requestId:'unknown-role'}));
  assert.equal(other.status,'ready');const source=imports.details({sessionId:'main',batchId:other.id,view:'sources'}).items[0];
  assert.equal(source.role,'unknown-old-role');assert.equal(source.available,false);
  assert.equal(imports.details({sessionId:'main',batchId:other.id}).items.every(row=>row.eligibility==='needs_review'),true);
});
test('preview exposes full method applicability, exact claim projection and paged retained records',async t=>{
  const {imports,store}=setup(t),tables=fixture();
  tables.methods[0].appliesTo='适'.repeat(2000);tables.methods[0].doesNotApplyTo='不'.repeat(2000);
  tables.methods[1].appliesTo='越'.repeat(2001);
  tables.understandings[0].content=tables.events[0].content;tables.understandings[0].claimType='user_statement';
  tables.understandings.push({...tables.understandings[0],id:'summary',content:'概括而非完整用户原话'});
  const batch=await imports.prepare(request(exported(tables))),items=imports.details({sessionId:'main',batchId:batch.id}).items;
  const good=items.find(row=>row.originalId==='trial2'),bad=items.find(row=>row.originalId==='trial0');
  assert.equal(good.appliesTo,tables.methods[0].appliesTo);assert.equal(good.doesNotApplyTo,tables.methods[0].doesNotApplyTo);
  assert.equal(bad.eligibility,'needs_review');assert.equal(bad.appliesTo,null);assert.ok(bad.reasonCodes.includes('method_contract_unproven'));
  let offset=0,full='';do{const part=imports.details({sessionId:'main',batchId:batch.id,view:'text',textKey:bad.originalTextKey,offset,limit:37});full+=part.text;offset=part.nextOffset;}while(offset!==null);
  assert.deepEqual(JSON.parse(full),tables.methods[1]);
  assert.equal(items.find(row=>row.originalId==='u').claimType,'user_statement');assert.equal(items.find(row=>row.originalId==='summary').claimType,'inference');
  imports.confirm(decide(batch,'confirm-preview'));
  assert.equal(store.listAll('understandings').find(row=>row.importProvenance.originalId==='u').claimType,'user_statement');
  assert.equal(store.listAll('understandings').find(row=>row.importProvenance.originalId==='summary').claimType,'inference');
  assert.equal(store.listAll('methods').some(row=>row.importProvenance.originalId==='trial0'),false);
});

test('one export cannot allocate two identical method trials under different old identities',async t=>{
  const {imports,store}=setup(t),tables=fixture();tables.methods=[tables.methods[1],{...tables.methods[1],id:'same-guidance-new-id'}];
  const batch=await imports.prepare(request(exported(tables))),methods=imports.details({sessionId:'main',batchId:batch.id}).items.filter(row=>row.kind==='methods');
  assert.equal(methods.length,2);assert.equal(methods.every(row=>row.eligibility==='needs_review'&&row.reasonCodes.includes('method_batch_conflict')),true);
  imports.confirm(decide(batch,'confirm-batch-duplicate'));assert.equal(store.listAll('methods').length,0);
});
test('global knowledge cannot widen a mapped dependency',async t=>{
  const {imports,store}=setup(t),tables=fixture();tables.understandings[0].scope={conversationId:'old'};
  tables.methods[1].dependencies=[...tables.methods[1].dependencies,{kind:'understandings',id:'u',revision:1}];
  const batch=await imports.prepare(request(exported(tables),{scopeMap:[{sourceConversationId:'old',targetSessionId:'main'}]}));
  const items=imports.details({sessionId:'main',batchId:batch.id}).items;
  const method=items.find(row=>row.originalId==='trial0');assert.equal(method.eligibility,'needs_review');assert.ok(method.reasonCodes.includes('dependency_scope_mismatch'));
  imports.confirm(decide(batch,'confirm-scope'));assert.equal(store.listAll('understandings').length,1);
  assert.equal(store.listAll('methods').some(row=>row.importProvenance.originalId==='trial0'),false);
});
test('paused and unknown old understanding status is retained as review, never restarted as active',async t=>{
  const {imports,store}=setup(t),tables=fixture();
  tables.understandings.push({...tables.understandings[0],id:'paused-u',status:'paused'}, {...tables.understandings[0],id:'unknown-u',status:'unknown'});
  const batch=await imports.prepare(request(exported(tables))),items=imports.details({sessionId:'main',batchId:batch.id}).items;
  for(const id of ['paused-u','unknown-u'])assert.equal(items.find(row=>row.originalId===id).eligibility,'needs_review');
  imports.confirm(decide(batch,'confirm-inactive'));assert.equal(store.listAll('understandings').length,1);
});


test('user batch withdrawal explains paused methods without Learn and retains the exact frozen preview',async t=>{
  const {imports,store,business}=setup(t),batch=await imports.prepare(request(exported()));
  const frozen=JSON.stringify(['import_records','import_sources'].map(kind=>store.listAll(kind,{where:{batchId:batch.id}})));
  const records=imports.details({sessionId:'main',batchId:batch.id}),sources=imports.details({sessionId:'main',batchId:batch.id,view:'sources'});
  const confirmed=imports.confirm(decide(batch,'confirm')),withdrawn=imports.withdraw(decide(confirmed,'withdraw'));
  const audit=store.get('audit','import-withdraw:'+batch.id);
  assert.equal(audit.actor,'user');assert.equal(audit.action,'import_batch_withdrawn');
  assert.equal(withdrawn.previewHash,batch.previewHash);
  assert.equal(JSON.stringify(['import_records','import_sources'].map(kind=>store.listAll(kind,{where:{batchId:batch.id}}))),frozen);
  assert.deepEqual(imports.details({sessionId:'main',batchId:batch.id}).items,records.items);
  assert.deepEqual(imports.details({sessionId:'main',batchId:batch.id,view:'sources'}).items,sources.items);
  for(const source of store.listAll('events'))assert.equal(store.get('source_controls',source.id).withdrawn,true);
  const methods=new MethodService({business}),explanation='你已撤销这批导入；方法依赖的来源已停止作为依据，因此暂停。原记录保留。';
  for(const method of store.listAll('methods')){
    assert.equal(method.status,'paused');assert.equal(method.pauseReason,'import_batch_withdrawn');
    const detail=methods.details(method.id);assert.equal(detail.activation.allowed,false);
    assert.equal(detail.reason,explanation);assert.equal(detail.reason.includes('学习提出'),false);
  }
  const notices=store.listAll('notifications');assert.ok(notices.length>0);
  for(const notice of notices){assert.equal(notice.reason,'import_batch_withdrawn');assert.ok(notice.message.includes(explanation));}
  for(const kind of ['learning_pending','learning_inputs','learning_runs','deliveries','method_adoptions','jobs'])assert.equal(store.listAll(kind).length,0,kind);
});
