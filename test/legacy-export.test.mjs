import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { exportLegacy3, LEGACY_COLLECTIONS } from '../src/legacy-export.mjs';
import { IMPORT_LIMITS, importDigest, textDigest, readLegacyImport } from '../src/legacy-import-source.mjs';
import { BusinessStore } from '../src/business.mjs';
import { ImportService } from '../src/importer.mjs';
import { MethodService, usageForVersion } from '../src/methods.mjs';

const now='2026-01-01T00:00:00.000Z';
const fresh=()=>realpathSync(mkdtempSync(join(tmpdir(),'arcfold-legacy-export-')));
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const documents=path=>readFileSync(path,'utf8').trimEnd().split('\n').map(JSON.parse);
const record=(id,rest={})=>({id,revision:1,createdAt:now,updatedAt:now,createdSequence:1,updatedSequence:1,...rest});
function tables(){
  const e=record('e',{role:'user',content:'  原话：保留空白\n以及 {"config":"只是用户正文"}  ',conversationId:'c',occurredAt:now,provenance:{kind:'direct_user',idempotencyKey:'original'}});
  const base={version:1,revision:4,createdSequence:2,updatedSequence:10,title:'查证',guidance:'显示可复核来源\n完整指导',appliesTo:'研究材料',doesNotApplyTo:'闲聊',scope:{},sourceIds:['e'],dependencies:[{kind:'events',id:'e',revision:1}],maxTrialUses:3,validated:false,origin:'inferred',authority:'work-guidance-only; no-new-tool-or-permission'};
  const trial=record('trial',{...base,title:'试用',status:'trial',trialUses:2}),paused=record('paused',{...base,title:'暂停',status:'paused',trialUses:3,pauseReason:'negative_feedback',feedbackId:'e'});
  const active=record('active',{...base,title:'已确认',status:'active',trialUses:3,revision:6,activationSourceId:'allow',previousId:'trial'});
  const authorization=record('allow',{role:'user',content:'继续采用此版本',conversationId:'c',occurredAt:now,createdSequence:20,updatedSequence:20,
    provenance:{kind:'explicit_method_authorization',interaction:'method_activation',methodId:'active',methodRevision:5,methodVersion:1,appliesTo:base.appliesTo,doesNotApplyTo:base.doesNotApplyTo}});
  const methods=[trial,paused,active],adoptions=[];
  for(const method of methods)for(let n=1;n<=method.trialUses;n++)adoptions.push(record(method.id+':'+n,{createdSequence:10+n,updatedSequence:10+n,selectedVersions:[{id:method.id,semanticVersion:1,revision:n+1,trialUse:n}],outcomeEvidence:[]}));
  adoptions.push(record('active:null',{selectedVersions:[{id:'active',semanticVersion:1,revision:6,trialUse:null}]}));
  return {events:[e,authorization],conversations:[record('c',{title:'旧交流'})],understandings:[record('u',{content:'可能偏好查证',claimType:'inference',scope:{},status:'active',version:1,sourceIds:['e'],dependencies:[{kind:'events',id:'e',revision:1}]})],methods,
    audit:[record('activation',{action:'user_method_activation',kind:'methods',recordId:'active',sourceId:'allow',createdSequence:25,updatedSequence:25,before:{...active,status:'paused',revision:5},after:active})],adoptions,
    goals:[record('g',{title:'保留历史方向',outcome:'形成材料',status:'paused',scope:{},definitionVersion:1,sourceIds:['e'],dependencies:[{kind:'events',id:'e',revision:1}],userControl:{action:'pause',eventId:'e',definitionVersion:1,at:now}})],
    opportunities:[],feedback:[],deliveries:[],imports:[],source_controls:[]};
}
function database(path, data=tables(), {wal=false}={}) {
  const db=new DatabaseSync(path);if(wal)db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  db.exec(`CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),PRIMARY KEY(kind,id));
    CREATE TABLE store_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO store_meta VALUES('schema_version','2'),('mutation_sequence','100');`);
  const put=db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)');
  db.exec('BEGIN');for(const[kind,rows]of Object.entries(data))for(const row of rows)put.run(kind,row.id,row.revision,row.createdAt,row.updatedAt,JSON.stringify(row));db.exec('COMMIT');return db;
}
async function exportData(data=tables(), extra={}){const root=fresh(),sourceDb=join(root,'old.sqlite'),output=join(root,'export.jsonl'),db=database(sourceDb,data);db.close();const receipt=await exportLegacy3({sourceDb,output,...extra});return{root,sourceDb,output,receipt,docs:documents(output)};}
async function consumer(path){const bytes=readFileSync(path);return readLegacyImport({stream:(async function*(){for(let i=0;i<bytes.length;i+=65536)yield bytes.subarray(i,i+65536);})(),expectedBytes:bytes.length,expectedSha256:textDigest(bytes)});}
const decide=(batch,id)=>({sessionId:'main',batchId:batch.id,expectedRevision:batch.revision,previewHash:batch.previewHash,requestId:id,userIdentity:'browser:owner'});
const exporterURL=new URL('../src/legacy-export.mjs',import.meta.url).href;
function child(sourceDb,output,phase,{heap}={}){
  const program=`import {exportLegacy3} from ${JSON.stringify(exporterURL)};
    try {const receipt=await exportLegacy3({sourceDb:${JSON.stringify(sourceDb)},output:${JSON.stringify(output)},onProgress:async value=>{
      if(value.phase===${JSON.stringify(phase)}){process.send(value);await new Promise(()=>{setInterval(()=>{},1000);});}}});
      process.send({done:true,receipt,resources:process.resourceUsage(),memory:process.memoryUsage()});}catch(error){process.send({error:error.code,attempt:error.attempt});process.exitCode=1;}`;
  return spawn(process.execPath,[...(heap?['--max-old-space-size='+heap]:[]),'--input-type=module','-e',program],{stdio:['ignore','pipe','pipe','ipc']});
}
async function message(proc){return Promise.race([once(proc,'message').then(([m])=>m),once(proc,'exit').then(([code])=>{throw new Error('Child exited before message: '+code);})]);}

test('real 12-kind export → v2 preview/confirm/withdraw preserves text, trial2/3, pause and exact authorization',async t=>{
  const data=tables(),f=await exportData(data),normalized=await consumer(f.output);
  assert.deepEqual(f.docs[0].collections,LEGACY_COLLECTIONS);assert.equal(f.docs.at(-1).digest,importDigest(f.docs.slice(1,-1)));
  const exported=(kind,id)=>f.docs.find(row=>row.kind===kind&&row.record.id===id).record;
  assert.deepEqual(exported('events','e'),data.events[0]);assert.deepEqual(exported('audit','activation'),data.audit[0]);assert.equal(exported('methods','paused').feedbackId,'e');
  assert.equal(exported('adoptions','active:null').selectedVersions[0].trialUse,null);
  assert.equal(normalized.records.find(row=>row.originalId==='active').eligibility,'enabled');
  assert.equal(f.receipt.referenceGaps.some(g=>g.targetId==='trial'&&g.targetKind==='audit'),false,'historical method reference is not an audit-row identity');
  const business=new BusinessStore({filename:':memory:'}),imports=new ImportService({business});t.after(async()=>{await imports.close();business.close();});
  const bytes=readFileSync(f.output),batch=await imports.prepare({sessionId:'main',receiptId:'upload-receipt',requestId:'prepare',scopeMap:[],userIdentity:'browser:owner',file:{name:'export.jsonl',bytes:bytes.length,sha256:textDigest(bytes)},read:async function*(){for(let i=0;i<bytes.length;i+=65536)yield bytes.subarray(i,i+65536);}});
  assert.equal(batch.status,'ready');const applied=imports.confirm(decide(batch,'confirm'));assert.equal(applied.status,'confirmed');
  const store=business.storage,methods=Object.fromEntries(store.listAll('methods').map(row=>[row.importProvenance.originalId,row]));
  assert.deepEqual(usageForVersion(store,methods.trial),{trialUses:2,maxTrialUses:3,remaining:1});assert.equal(methods.paused.status,'paused');assert.equal(methods.active.status,'active');assert.equal(methods.active.validated,false);
  const original=store.listAll('events'),before=JSON.stringify(original);imports.withdraw(decide(applied,'withdraw'));
  assert.equal(JSON.stringify(store.listAll('events')),before);assert.equal(new MethodService({business}).catalog({sessionId:'main'}).length,0);
  assert.ok(original.every(row=>store.get('source_controls',row.id)?.withdrawn));
});

test('missing/wrong sources, absent counter and unsupported authority remain gaps, never invented facts',async()=>{
  const data=tables();data.understandings[0].dependencies[0].revision=99;data.methods[0].sourceIds=['missing'];delete data.methods[0].trialUses;
  data.events.find(e=>e.id==='allow').withdrawn=true;
  data.understandings[0].changeSourceIds=['missing-change'];data.events.push(record('artifact',{role:'tool',content:'retained tool original',provenance:{type:'artifact',artifactSourceId:'missing-artifact'}}));
  data.audit.push(record('runtime-audit',{action:'user_withdrawal',kind:'jobs',recordId:'excluded-job',before:{config:{sentinel:'EXCLUDED_AUDIT'}},after:{credentials:'EXCLUDED_AUDIT'}}));
  data.imports.push(record('import',{sourceSnapshot:{config:'EXCLUDED_SNAPSHOT'},sourcePackage:{path:'/old/export.json',sha256:'b'.repeat(64),originalUntouched:true},eventIds:['missing']}));
  data.jobs=[record('excluded-job',{config:'EXCLUDED_JOB'})];
  const f=await exportData(data),normalized=await consumer(f.output);
  assert.equal(normalized.records.find(r=>r.originalId==='trial').eligibility,'needs_review');assert.equal(normalized.records.find(r=>r.originalId==='active').eligibility,'needs_review');
  assert.equal(normalized.records.find(r=>r.originalId==='u').eligibility,'needs_review');assert.equal(normalized.records.find(r=>r.originalId==='g').eligibility,'history');
  const text=readFileSync(f.output,'utf8');assert.doesNotMatch(text,/EXCLUDED_/);assert.ok(f.receipt.referenceGaps.some(g=>g.reason==='revision_mismatch'));assert.ok(f.receipt.referenceGaps.some(g=>g.reason==='missing'));
  assert.deepEqual(f.receipt.excluded.kinds,[{kind:'jobs',count:1}]);assert.ok(f.receipt.excluded.paths.some(p=>p.path==='$."sourceSnapshot"'));
  assert.equal(Object.hasOwn(f.docs.find(r=>r.kind==='methods'&&r.record.id==='trial').record,'trialUses'),false);
  for(const id of ['missing-change','missing-artifact'])assert.ok(f.receipt.referenceGaps.some(g=>g.targetKind==='events'&&g.targetId===id&&g.reason==='missing'));
});

test('finite nested tables preserve actual writer shapes and opaque text without object fallback',async()=>{
  const data=tables();data.events.push(record('imported',{role:'assistant',content:'original false answer',provenance:{kind:'imported_original',importId:'import',sourceRunId:'old-run',originalOrdinal:1,originalTimeKnown:false,
    importedOriginalSource:{sourceRunId:'old-run',kind:'direct_user',role:'user',status:'canceled',answerValid:false,error:'failed',originalTextSha256:'a'.repeat(64),credentialRedacted:false},sourcePackage:{path:'/old',sha256:'b'.repeat(64),originalUntouched:true}}}));
  data.opportunities.push(record('o',{description:'历史机会',rationale:'建议',preparedContent:'历史准备全文',preparedAt:now,preparationArtifact:{path:'/old/draft.md',sha256:'c'.repeat(64),bytes:42,sourceIds:['e'],toolRecordId:'old-tool'},sourceIds:['e'],dependencies:[{kind:'events',id:'e',revision:1}]}));
  data.goals[0].relations=[{type:'supports',targetId:'missing-goal',targetDefinitionVersion:1,reason:'推断',sourceIds:['e'],dependencies:[{kind:'events',id:'e',revision:1}]}];
  data.deliveries.push(record('delivery',{content:'old reply',eventId:'imported',inputEventId:'e',readCoverage:{version:'v1',documents:[{kind:'file',identity:'/old',sha256:'a'.repeat(64),ranges:[[0,7]],complete:false}],observations:[{kind:'directory_listing_only',skipped:{symlinks:1}}]}}));
  const f=await exportData(data);for(const kind of ['events','opportunities','goals','deliveries'])for(const row of data[kind])assert.deepEqual(f.docs.find(x=>x.kind===kind&&x.record.id===row.id).record,row);
  assert.ok(f.receipt.referenceGaps.some(g=>g.targetKind==='tool_calls'&&g.reason==='intentionally_excluded'));
  for(const change of [d=>d.events[0].provenance.extraAuthority={allow:true},d=>d.events[0].provenance.kind='invented-user-authority',d=>d.methods[0].authority={allow:true},d=>d.methods[0].authorization={allow:true},d=>d.methods[0].dependencies[0].extra='new-shape',d=>d.adoptions[0].outcomeEvidence=[{success:true}],d=>d.source_controls.push(record('e',{withdrawn:true}))]){
    const malformed=tables();change(malformed);await assert.rejects(exportData(malformed));
  }
});

test('schema, body/column identity, duplicate JSON keys, unsupported version and capacity refuse without publishing',async()=>{
  for(const sql of ["UPDATE store_meta SET value='1' WHERE key='schema_version'","ALTER TABLE records ADD COLUMN extra TEXT",
    "UPDATE records SET body=json_set(body,'$.revision',99) WHERE kind='events' AND id='e'",
    `UPDATE records SET body=replace(body,'"role":"user"','"role":"user","role":"assistant"') WHERE kind='events' AND id='e'`,
    "UPDATE records SET body=json_set(body,'$.updatedSequence',101) WHERE kind='events' AND id='e'"]){
    const root=fresh(),sourceDb=join(root,'old.sqlite'),output=join(root,'out'),db=database(sourceDb);db.exec(sql);db.close();const before=readFileSync(sourceDb),mode=statSync(sourceDb).mode;
    await assert.rejects(exportLegacy3({sourceDb,output}));assert.equal(existsSync(output),false);assert.deepEqual(readFileSync(sourceDb),before);assert.equal(statSync(sourceDb).mode,mode);
  }
  const data=Object.fromEntries(LEGACY_COLLECTIONS.map(k=>[k,[]]));data.conversations=Array.from({length:10001},(_,i)=>record('c'+i));
  await assert.rejects(exportData(data),e=>e.code==='export_record_limit');
  const wide=tables();wide.imports=[record('wide',{...Object.fromEntries(Array.from({length:10001},(_,i)=>['extra'+i,'excluded']))})];await assert.rejects(exportData(wide),e=>e.code==='export_object_shape');
  const long=tables();long.events[0].content='x'.repeat(IMPORT_LIMITS.maxStringCharacters+1);await assert.rejects(exportData(long),e=>e.code==='export_string_limit');
});

test('full iteration exceeds old list pagination and deterministic snapshot identity survives copying',async()=>{
  const data=Object.fromEntries(LEGACY_COLLECTIONS.map(k=>[k,[]]));data.conversations=Array.from({length:1005},(_,i)=>record('c'+String(i).padStart(4,'0'),{title:'历史'+i}));
  const f=await exportData(data);assert.equal(f.receipt.counts.conversations,1005);assert.equal(f.docs.length,1007);
  const second=join(f.root,'second.jsonl');await exportLegacy3({sourceDb:f.sourceDb,output:second});assert.deepEqual(readFileSync(second),readFileSync(f.output));
  const copy=join(f.root,'copy.sqlite');copyFileSync(f.sourceDb,copy);const receipt=await exportLegacy3({sourceDb:copy,output:join(f.root,'copy.jsonl')});
  assert.equal(receipt.snapshotDigest,f.receipt.snapshotDigest);assert.notEqual(receipt.source.ino,f.receipt.source.ino);assert.deepEqual(readFileSync(receipt.output.path),readFileSync(f.output));
});

test('single BEGIN sees committed WAL, excludes uncommitted rows, and cannot mix later source/dependency updates',async()=>{
  const root=fresh(),sourceDb=join(root,'old.sqlite'),writer=database(sourceDb,tables(),{wal:true});
  // Parent writer deliberately leaves the committed family open; exporter reads actual WAL.
  writer.exec("BEGIN;UPDATE records SET body=json_set(body,'$.content','committed WAL') WHERE kind='events' AND id='e';COMMIT");
  assert.ok(statSync(sourceDb+'-wal').size>0);
  writer.exec("BEGIN;UPDATE records SET body=json_set(body,'$.content','UNCOMMITTED') WHERE kind='events' AND id='e'");
  const output=join(root,'uncommitted.jsonl');await exportLegacy3({sourceDb,output});assert.equal(documents(output).find(r=>r.kind==='events'&&r.record.id==='e').record.content,'committed WAL');writer.exec('ROLLBACK');
  const output2=join(root,'snapshot.jsonl');await exportLegacy3({sourceDb,output:output2,onProgress:async({phase})=>{if(phase!=='snapshot')return;
    execFileSync(process.execPath,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(sourceDb)});db.exec("BEGIN;UPDATE records SET revision=2,body=json_set(body,'$.revision',2,'$.content','NEW SOURCE','$.updatedSequence',101) WHERE kind='events' AND id='e';UPDATE records SET revision=2,body=json_set(body,'$.revision',2,'$.dependencies[0].revision',2,'$.updatedSequence',102) WHERE kind='understandings' AND id='u';UPDATE store_meta SET value='102' WHERE key='mutation_sequence';COMMIT");db.close();`]);
  }});
  const docs=documents(output2);assert.equal(docs[0].mutationSequence,100);assert.equal(docs.find(r=>r.kind==='events'&&r.record.id==='e').record.revision,1);assert.equal(docs.find(r=>r.kind==='understandings').record.dependencies[0].revision,1);
  const after=join(root,'after.jsonl');await exportLegacy3({sourceDb,output:after});assert.equal(documents(after)[0].mutationSequence,102);assert.equal(documents(after).find(r=>r.kind==='events'&&r.record.id==='e').record.revision,2);writer.close();
});

test('large excluded nested payload never becomes JS projection; measured process heap/RSS stay within explicit fixture bounds',async()=>{
  const root=fresh(),sourceDb=join(root,'old.sqlite'),data=tables();
  data.imports=[record('old-import',{sourceSnapshot:{payload:'EXCLUDED_LARGE_SENTINEL'.repeat(2400000)},note:'kept'})];
  const db=database(sourceDb,data);db.close();const proc=child(sourceDb,join(root,'export.jsonl'),'none',{heap:96});
  const result=await message(proc),[code]=await once(proc,'exit');assert.equal(code,0);assert.equal(result.done,true);
  assert.ok(result.memory.heapUsed<96*1024*1024);assert.ok(result.resources.maxRSS<900*1024,'SQLite RSS fixture upper bound, not constant-memory claim');
  assert.doesNotMatch(readFileSync(result.receipt.output.path,'utf8'),/EXCLUDED_LARGE_SENTINEL/);writeFileSync(join(root,'memory.json'),JSON.stringify({resources:result.resources,memory:result.memory,excludedCharacters:data.imports[0].sourceSnapshot.payload.length}));
});

test('real SIGKILL before footer/publication leaves retained evidence but no output; after publication has complete bytes and no success receipt',async()=>{
  for(const phase of ['snapshot','before-footer','before-publication','published']){
    const root=fresh(),sourceDb=join(root,'old.sqlite'),output=join(root,'out.jsonl'),db=database(sourceDb);db.close();const proc=child(sourceDb,output,phase),mark=await message(proc);
    assert.equal(mark.phase,phase);proc.kill('SIGKILL');const[code,signal]=await once(proc,'exit');assert.equal(code,null);assert.equal(signal,'SIGKILL');
    assert.equal(existsSync(join(mark.attempt,'receipt.json')),false);assert.equal(existsSync(output),phase==='published');assert.ok(readdirSync(mark.attempt).includes('started.json'));
    if(phase==='before-footer')assert.notEqual(documents(join(mark.attempt,'complete.jsonl')).at(-1).type,'footer');
    if(phase==='published'){assert.equal((await consumer(output)).format,'arcfold-legacy3-business-export-v1');await assert.rejects(exportLegacy3({sourceDb,output}),e=>e.code==='export_output_exists');}
  }
});

test('aliases, existing files, replaced source and post-publication receipt failure cannot be claimed as successful export',async()=>{
  const f=await exportData();const alias=join(f.root,'source-link');symlinkSync(f.sourceDb,alias);await assert.rejects(exportLegacy3({sourceDb:alias,output:join(f.root,'bad')}));
  for(const target of [f.sourceDb,f.output])await assert.rejects(exportLegacy3({sourceDb:f.sourceDb,output:target}));
  const hard=join(f.root,'hard');linkSync(f.sourceDb,hard);await assert.rejects(exportLegacy3({sourceDb:f.sourceDb,output:hard}));
  const changed=join(f.root,'changed-output');await assert.rejects(exportLegacy3({sourceDb:f.sourceDb,output:changed,onProgress:async({phase})=>{if(phase==='projected'){renameSync(f.sourceDb,f.sourceDb+'.saved');copyFileSync(f.sourceDb+'.saved',f.sourceDb);}}}));assert.equal(existsSync(changed),false);
  const out=join(f.root,'published-error');let attempt;await assert.rejects(exportLegacy3({sourceDb:f.sourceDb,output:out,onProgress:async mark=>{attempt=mark.attempt;if(mark.phase==='published')writeFileSync(join(attempt,'receipt.json'),'foreign');}}),e=>e.published===true);
  assert.equal(read(join(attempt,'failure.json')).complete,false);assert.equal(readFileSync(join(attempt,'receipt.json'),'utf8'),'foreign');assert.equal((await consumer(out)).format,'arcfold-legacy3-business-export-v1');
});


test('SQL gates large allowed values, wrong scalar shapes, keys and row metadata before they cross into JS',async()=>{
  const cases=[
    ['allowed-text',"UPDATE records SET body=json_set(body,'$.content',printf('%.*c',12582912,'x')) WHERE kind='events' AND id='e'"],
    ['array-text',"UPDATE records SET body=json_set(body,'$.sourceIds[0]',printf('%.*c',12582912,'x')) WHERE kind='methods' AND id='trial'"],
    ['wrong-array-large',"UPDATE records SET body=json_set(body,'$.sourceIds',printf('%.*c',12582912,'x')) WHERE kind='methods' AND id='trial'"],
    ['wrong-array-item-large',"UPDATE records SET body=json_set(body,'$.dependencies[0]',printf('%.*c',12582912,'x')) WHERE kind='methods' AND id='trial'"],
    ['wrong-array',"UPDATE records SET body=json_set(body,'$.sourceIds','SQL_BOUNDARY_WRONG_SCALAR') WHERE kind='methods' AND id='trial'"],
    ['wrong-object',"UPDATE records SET body=json_set(body,'$.provenance','SQL_BOUNDARY_WRONG_SCALAR') WHERE kind='events' AND id='e'"],
    ['wrong-array-item',"UPDATE records SET body=json_set(body,'$.dependencies[0]','SQL_BOUNDARY_WRONG_SCALAR') WHERE kind='methods' AND id='trial'"],
    ['audit-kind',"UPDATE records SET body=json_set(body,'$.kind',printf('%.*c',12582912,'x')) WHERE kind='audit'"],
    ['audit-goal',"UPDATE records SET body=json_set(body,'$.goalId',printf('%.*c',12582912,'x')) WHERE kind='audit'"],
    ['object-key',"UPDATE records SET body=json_patch(body,json_object(printf('%.*c',12582912,'x'),0)) WHERE kind='imports'"],
    ['outer-created',"UPDATE records SET created_at=printf('%.*c',12582912,'x') WHERE kind='events' AND id='e'"],
    ['outer-updated',"UPDATE records SET updated_at=printf('%.*c',12582912,'x') WHERE kind='events' AND id='e'"],
    ['outer-revision',"UPDATE records SET revision=printf('%.*c',12582912,'x') WHERE kind='events' AND id='e'"],
    ['audit-goal-type',"UPDATE records SET body=json_set(body,'$.goalId',42) WHERE kind='audit'"],
    ['meta-value',"UPDATE store_meta SET value=printf('%.*c',12582912,'x') WHERE key='mutation_sequence'"],
    ['kind-nul',"UPDATE records SET kind='x'||char(0)||printf('%.*c',12582912,'x') WHERE kind='feedback'"],
    ['id-nul',"UPDATE records SET id='x'||char(0)||printf('%.*c',12582912,'x') WHERE kind='feedback'"],
  ];
  const evidence=[];
  for(const[name,sql]of cases){
    const root=fresh(),sourceDb=join(root,'old.sqlite'),output=join(root,'export.jsonl'),data=tables();
    data.imports=[record('import')];data.feedback=[record('feedback')];
    const db=database(sourceDb,data);db.exec(sql);db.close();
    const program=`
      import {DatabaseSync} from 'node:sqlite';
      import {exportLegacy3} from ${JSON.stringify(exporterURL)};
      const probe=new DatabaseSync(':memory:'),proto=Object.getPrototypeOf(probe.prepare('SELECT 1'));probe.close();
      const originals=Object.fromEntries(['get','all','iterate'].map(name=>[name,proto[name]]));
      let largestReturnedString=0,largestReturnedBytes=0,largeValues=0,wrongScalars=0;
      const observe=value=>{
        if(value instanceof Uint8Array){largestReturnedBytes=Math.max(largestReturnedBytes,value.byteLength);if(value.byteLength>${IMPORT_LIMITS.maxStringCharacters * 3})largeValues++;
          if(value.byteLength==='SQL_BOUNDARY_WRONG_SCALAR'.length && Buffer.from(value).toString()==='SQL_BOUNDARY_WRONG_SCALAR')wrongScalars++;}
        else if(typeof value==='string'){largestReturnedString=Math.max(largestReturnedString,value.length);
          if(value.length>${IMPORT_LIMITS.maxStringCharacters})largeValues++;
          if(value==='SQL_BOUNDARY_WRONG_SCALAR')wrongScalars++;}
        else if(value&&typeof value==='object')for(const item of Object.values(value))observe(item);
      };
      for(const name of ['get','all'])proto[name]=function(...args){const value=originals[name].apply(this,args);observe(value);return value;};
      proto.iterate=function*(...args){for(const row of originals.iterate.apply(this,args)){observe(row);yield row;}};
      let result;
      try{await exportLegacy3({sourceDb:${JSON.stringify(sourceDb)},output:${JSON.stringify(output)}});result={accepted:true};}
      catch(error){result={accepted:false,code:error.code,attempt:error.attempt};}
      finally{for(const[name,fn]of Object.entries(originals))proto[name]=fn;}
      process.send({...result,largestReturnedString,largestReturnedBytes,largeValues,wrongScalars,memory:process.memoryUsage(),resources:process.resourceUsage()});
    `;
    const proc=spawn(process.execPath,['--max-old-space-size=48','--input-type=module','-e',program],{stdio:['ignore','pipe','pipe','ipc']});
    const stderr=[];proc.stderr.on('data',chunk=>stderr.push(chunk));
    const result=await message(proc),[code,signal]=await once(proc,'exit');
    const raw={name,code,signal,stderr:Buffer.concat(stderr).toString(),...result};
    writeFileSync(join(root,'sql-boundary.json'),JSON.stringify(raw,null,2));evidence.push({...raw,root});
    assert.equal(code,0);assert.equal(signal,null);assert.equal(result.accepted,false,name);assert.equal(existsSync(output),false,name);
    assert.ok(result.memory.heapUsed<48*1024*1024,name);assert.ok(result.resources.maxRSS<500*1024,name);
  }
  const summary=fresh();writeFileSync(join(summary,'sql-boundaries.json'),JSON.stringify(evidence,null,2));
  assert.deepEqual(evidence.filter(row=>row.largeValues||row.wrongScalars).map(row=>({name:row.name,largeValues:row.largeValues,wrongScalars:row.wrongScalars})),[],
    'Invalid allowed values and wrong-shape scalars must be rejected in SQL before JavaScript decoding');
});

test('SQL text bounds preserve valid Unicode and embedded NUL without truncation',async()=>{
  const data=tables();data.events[0].content='\uFEFF'+'汉'.repeat(IMPORT_LIMITS.maxStringCharacters-4)+'\u0000🦉';
  const f=await exportData(data);assert.equal(textDigest(f.docs.find(row=>row.kind==='events'&&row.record.id==='e').record.content),textDigest(data.events[0].content));
  for(const value of ['\u0000'+'x'.repeat(IMPORT_LIMITS.maxStringCharacters), '🦉'.repeat(IMPORT_LIMITS.maxStringCharacters/2+1)]){
    const bad=tables();bad.events[0].content=value;await assert.rejects(exportData(bad),error=>error.code==='export_string_limit');
  }
});
