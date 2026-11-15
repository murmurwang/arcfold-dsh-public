// Real SQLite, native flock, verified copied code and public CLI subprocesses.
// Installation metadata below is a labelled local fixture, not a pnpm installation or host.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { BudgetLedger } from '../src/budget.mjs';
import { acquireRuntimeLease } from '../src/runtime-lifecycle.mjs';
import { ownEvidenceDirectory } from '../src/evidence-ownership.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))), require = createRequire(join(ROOT,'package.json'));
const hash = b => createHash('sha256').update(b).digest('hex');
const read = p => JSON.parse(fs.readFileSync(p,'utf8'));
const save = (p,v) => { fs.mkdirSync(dirname(p),{recursive:true,mode:0o700});fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n',{mode:0o600}); };
const stamp = p => ({sha256:hash(fs.readFileSync(p)),bytes:fs.statSync(p).size});
function inventory(root, directories) {
  const items=[];
  const visit = p => {
    const st=fs.lstatSync(p);
    if(st.isDirectory()) for(const n of fs.readdirSync(p).sort()) visit(join(p,n));
    else {assert.ok(st.isFile());items.push({path:relative(root,p),...stamp(p),executable:st.mode&0o111});}
  };
  for(const p of directories) {
    const full=join(root,p);
    if(fs.lstatSync(full).isDirectory())visit(full);
    else items.push({path:p,...stamp(full)});
  }
  return items.sort((a,b)=>a.path.localeCompare(b.path));
}
function fixture() {
  const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'arcfold-first-init-'))), installed=join(root,'installed');
  const profile=join(installed,'bootstrap-home/profiles/arcfold'), modules=join(profile,'node_modules');
  const core=join(modules,'@arcfold/dsh'),ui=join(modules,'@arcfold/dsh-method-ui');
  fs.mkdirSync(core,{recursive:true});
  for(const name of ['src','runtime','patches','package.json'])fs.cpSync(join(ROOT,name),join(core,name),{recursive:true});
  save(join(ui,'package.json'),{name:'@arcfold/dsh-method-ui',version:'0.1.0'});
  // Exact loaded patch payloads come from the isolated test installation.
  const definitions=[
    ['deepseek-official','@deepseek-ai/dsh-llm-deepseek','deepseek-0.2.2-rc.1-transport.json','provider-patch'],
    ['openai','@deepseek-ai/dsh-llm-pi-ai','pi-ai-0.2.2-rc.1-transport.json','pi-ai-patch'],
    ['modelSelection','@deepseek-ai/dsh-api-session-controller','session-controller-0.2.2-rc.1-model-selection.json','model-selection-patch'],
  ];
  const proof={};
  for(const [key,name,specFile,receiptDir] of definitions) {
    const source=dirname(require.resolve(name+'/package.json')),target=join(modules,name);
    fs.cpSync(source,target,{recursive:true});
    const spec=read(join(core,'patches',specFile)),receipt=join(installed,receiptDir,'report.json');
    for(const f of spec.files)assert.equal(stamp(join(target,f.path)).sha256,f.afterSha256,'Use the actually patched dependency payload');
    save(receipt,{completed:true,after:{state:'patched',packageDir:target,patchId:spec.id,
      patchSpecSha256:stamp(join(core,'patches',specFile)).sha256}});
    proof[key]={path:target,patchId:spec.id,receipt,receiptSHA256:stamp(receipt).sha256};
  }
  const flock=require.resolve('@deepseek-ai/node-addon-system/flock');
  const addon=dirname(require.resolve('@deepseek-ai/node-addon-system/package.json'));
  fs.cpSync(addon,join(modules,'@deepseek-ai/node-addon-system'),{recursive:true});
  const native='@deepseek-ai/node-addon-system-'+process.platform+'-'+process.arch;
  fs.cpSync(dirname(createRequire(flock).resolve(native+'/package.json')),join(modules,native),{recursive:true});
  save(join(installed,'host/node_modules/fixture-host/package.json'),{name:'fixture-host',version:'0.0.0'});
  save(join(installed,'host/node_modules/fixture-host/bin.mjs'),{notAHost:true});
  save(join(installed,'tooling/package/bin/pnpm.mjs'),{notAnInstaller:true});
  for(const area of ['host','bootstrap-home/profiles/arcfold'])
    for(const name of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml'])save(join(installed,area,name),{fixture:true});
  save(join(profile,'cordis.patch.yml'),[]);
  const paths=['host/node_modules','bootstrap-home/profiles/arcfold/node_modules','tooling/package',
    ...['host','bootstrap-home/profiles/arcfold'].flatMap(p=>['package.json','pnpm-lock.yaml','pnpm-workspace.yaml'].map(n=>p+'/'+n)),
    'bootstrap-home/profiles/arcfold/cordis.patch.yml'];
  const files=inventory(installed,paths);save(join(installed,'installation-files.json'),files);
  save(join(installed,'dependency-consumers.json'),[{fixture:'copied exact source/native-lock; no real install claimed'}]);
  const receipt={schema:'arcfold-installation-v1',installationDir:installed,profileName:'arcfold',
    hostRoot:join(installed,'host'),installAnchor:join(installed,'host/node_modules/fixture-host/package.json'),
    cliPath:join(installed,'host/node_modules/fixture-host/bin.mjs'),profileDir:profile,coreRoot:core,uiRoot:ui,
    sourceCommit:'a'.repeat(40),compatibility:{businessSchema:1,nativeFormat:4},
    provider:proof['deepseek-official'],providers:{'deepseek-official':proof['deepseek-official'],openai:proof.openai},
    modelSelection:proof.modelSelection,packageManager:{command:process.execPath,args:[join(installed,'tooling/package/bin/pnpm.mjs')]},
    identities:{bootstrap:read(join(ROOT,'runtime/bootstrap.json')),node:{path:process.execPath,...stamp(process.execPath)},
      consumers:{path:'dependency-consumers.json',...stamp(join(installed,'dependency-consumers.json')),count:1},
      fileManifest:{path:'installation-files.json',...stamp(join(installed,'installation-files.json')),count:files.length}}};
  const installationFile=join(installed,'installation.json');save(installationFile,receipt);
  const unpacked=join(root,'unpacked');fs.mkdirSync(unpacked);
  for(const name of ['src','bin'])fs.cpSync(join(ROOT,name),join(unpacked,name),{recursive:true});
  const workspace=join(root,'workspace');fs.mkdirSync(workspace);
  const options={installationFile,configPath:join(root,'local.json'),dataRoot:join(root,'data'),workspace,port:0,webUnlimited:true};
  return {root,core,unpacked,options,receipt,planPath:join(options.dataRoot,'runtime/initialization/identity.json'),
    receipts:join(options.dataRoot,'runtime/initialization'),artifact:join(options.dataRoot,'requests')};
}
function invoke(f,{point='',options=f.options}={}) {
  const script=`
    import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    import {DatabaseSync} from 'node:sqlite';import {pathToFileURL} from 'node:url';
    const opts=JSON.parse(process.argv[2]),point=process.argv[3];
    const leave=()=>process.exit(73);
    const exec=DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec=function(sql,...rest) {
      const result=exec.call(this,sql,...rest);
      if(point==='first-format'&&sql.includes('PRAGMA main.application_id='))leave();
      if(point==='second-format'&&sql.includes('PRAGMA journal_mode=WAL'))leave();
      return result;
    };
    const link=fs.linkSync;
    fs.linkSync=function(from,to,...rest) {
      const value=link.call(this,from,to,...rest);
      const records=opts.dataRoot+'/runtime/initialization/';
      if(point==='first-intent'&&to===records+'deepseek-web.sqlite.intent.json')leave();
      if(point==='first-link'&&to===opts.dataRoot+'/requests/deepseek-web.sqlite')leave();
      if(point==='first-complete'&&to===records+'deepseek-web.sqlite.intent.json.completed')leave();
      if(point==='second-complete'&&to===records+'openai-web.sqlite.intent.json.completed')leave();
      if(point==='config-link'&&to===opts.configPath)leave();
      if(point==='final-complete'&&to===records+'completed.json')leave();
      return value;
    };
    syncBuiltinESMExports();
    const api=await import(pathToFileURL(process.argv[1]).href);
    console.log(JSON.stringify(await api.initializeRuntimeDeployment(opts)));
  `;
  return spawnSync(process.execPath,['--input-type=module','-e',script,join(f.core,'src/runtime-init.mjs'),JSON.stringify(options),point],
    {cwd:f.root,env:{...process.env,NODE_PATH:''},encoding:'utf8'});
}
function succeeded(run) { assert.equal(run.status,0,run.stderr);return JSON.parse(run.stdout); }
function records(path) {
  const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT * FROM records ORDER BY kind,id').all().map(r=>({...r}));}
  finally{db.close();}
}
function tree(root) {
  if(!fs.existsSync(root))return {};
  const out={};const visit=p=>{const s=fs.lstatSync(p);if(s.isDirectory())for(const n of fs.readdirSync(p))visit(join(p,n));
    else out[relative(root,p)]={...stamp(p),ino:s.ino,nlink:s.nlink};};visit(root);return out;
}
test('public builtin-only init delegates to the verified installed core and completed retry changes no evidence',()=>{
  const f=fixture(),args=[join(f.unpacked,'bin/arcfold.mjs'),'init','--config',f.options.configPath,
    '--installation-file',f.options.installationFile,'--data',f.options.dataRoot,'--workspace',f.options.workspace,'--port','0','--web-unlimited'];
  const execute=()=>spawnSync(process.execPath,args,{cwd:f.root,env:{...process.env,NODE_PATH:''},encoding:'utf8'});
  const first=succeeded(execute()),config=read(f.options.configPath);assert.equal(first.created,true);
  assert.equal(config.schema,'arcfold-local-v2');assert.deepEqual(config.main,config.learn);
  assert.equal(config.main.model,'deepseek-v4-pro');assert.equal(config.main.maxTokens,128000);
  assert.equal(config.transport.routes['deepseek-official'].apiKeyRef,'ARCFOLD_DEEPSEEK_API_KEY');
  assert.equal(config.transport.routes.openai.apiKeyRef,'ARCFOLD_OPENAI_API_KEY');
  for(const route of Object.values(config.transport.routes)){assert.equal(records(route.ledgerPath).length,1);assert.equal(route.network.mode,'direct');}
  const before=tree(f.options.dataRoot),original=fs.readFileSync(f.options.configPath);
  const again=succeeded(execute());assert.equal(again.created,false);assert.equal(again.initId,first.initId);
  assert.deepEqual(tree(f.options.dataRoot),before);assert.deepEqual(fs.readFileSync(f.options.configPath),original);
  assert.equal(fs.existsSync(join(f.unpacked,'node_modules')),false);assert.equal(fs.existsSync(join(f.core,'node_modules')),false);
});
test('each actual process-exit window preserves failure stages and resumes the same identity',async t=>{
  for(const point of ['first-format','second-format','first-intent','first-link','first-complete','second-complete','config-link','final-complete'])
    await t.test(point,()=>{
      const f=fixture(),failed=invoke(f,{point});assert.equal(failed.status,73,failed.stderr);
      const plan=read(f.planPath),before=tree(join(f.artifact,'initialization'));
      assert.equal(fs.existsSync(f.options.configPath),['config-link','final-complete'].includes(point));
      if(point==='first-format'||point==='second-format') {
        const stages=Object.entries(before).filter(([name])=>name.endsWith('.sqlite'));
        assert.ok(stages.length>=1,'Keep the actually interrupted SQLite file');
      }
      const result=succeeded(invoke(f));assert.equal(result.initId,plan.initId);
      assert.deepEqual(read(f.planPath),plan);
      const after=tree(join(f.artifact,'initialization'));
      if(point==='first-format'||point==='second-format')
        for(const [name,value] of Object.entries(before))assert.deepEqual(after[name],value,'Failed stage must remain exact');
      const config=read(f.options.configPath);
      for(const [provider,route]of Object.entries(config.transport.routes))
        assert.deepEqual(JSON.parse(records(route.ledgerPath)[0].body).specification,
          {...(provider==='openai'?{scope:'web-openai',provider:'openai',accounting:'tokens_only'}:{scope:'web-unlimited'}),...plan.authorizations[provider]});
      const snapshot=tree(f.options.dataRoot);assert.equal(succeeded(invoke(f)).created,false);
      assert.deepEqual(tree(f.options.dataRoot),snapshot);
    });
});
test('held real runtime/evidence locks refuse init without claiming an authorization',async()=>{
  for(const kind of ['runtime','evidence']) {
    const f=fixture(),owner=kind==='runtime'?await acquireRuntimeLease(join(f.options.dataRoot,'runtime')):await ownEvidenceDirectory(f.artifact);
    try{assert.notEqual(invoke(f).status,0);assert.equal(fs.existsSync(f.planPath),false);}
    finally{await owner.close();}
    assert.equal(succeeded(invoke(f)).created,true);
  }
});
test('changed inputs, unexplained canonical contents, aliases and changed installed code refuse without overwriting originals',async t=>{
  for(const variant of ['input','foreign','bytes','inode','extra-link','installed','old-proof'])
    await t.test(variant,()=>{
      const f=fixture();
      if(variant==='installed') {
        fs.appendFileSync(join(f.core,'src/runtime-init.mjs'),'\n// changed installed bytes');
      } else if(variant==='old-proof') {
        const old=read(f.options.installationFile);delete old.modelSelection;save(f.options.installationFile,old);
      } else {
        assert.equal(invoke(f,{point:'first-link'}).status,73);
        const target=join(f.artifact,'deepseek-web.sqlite'),intent=read(join(f.receipts,'deepseek-web.sqlite.intent.json'));
        if(variant==='foreign') { fs.unlinkSync(target);fs.writeFileSync(target,'foreign',{mode:0o600}); }
        if(variant==='bytes') fs.appendFileSync(target,'changed');
        if(variant==='inode') {const bytes=fs.readFileSync(target);fs.unlinkSync(target);fs.writeFileSync(target,bytes,{mode:0o600});}
        if(variant==='extra-link')fs.linkSync(target,join(f.root,'alien-alias'));
        assert.ok(intent.file.ino);
      }
      const before=tree(f.options.dataRoot),options=variant==='input'?{...f.options,port:99}:f.options;
      assert.notEqual(invoke(f,{options}).status,0);
      assert.equal(fs.existsSync(f.options.configPath),false);
      if(variant==='installed'||variant==='old-proof')assert.equal(fs.existsSync(f.options.dataRoot),false);
      else {
        const target=join(f.artifact,'deepseek-web.sqlite');
        assert.equal(stamp(target).sha256,before['requests/deepseek-web.sqlite'].sha256);
      }
    });
});

test('completed retry refuses a replaced ledger while preserving legitimately used same-inode records',()=>{
  const f=fixture();succeeded(invoke(f));
  const config=read(f.options.configPath),route=config.transport.routes['deepseek-official'];
  const ledger=new BudgetLedger(route.ledgerPath,{mode:'web-only',scope:'web-unlimited',webAuthorization:route.webAuthorization});
  ledger.reserve({requestId:'fixture-after-init',bodyHash:'fixture',model:'deepseek-v4-pro',inputTokenCeiling:4,
    maxOutputTokens:4,prices:{input:9,output:27,cachedInput:0.3}});
  ledger.markDispatched('fixture-after-init');ledger.markUnknown('fixture-after-init','Synthetic incomplete request; no network');
  ledger.close();
  const before=tree(f.options.dataRoot);assert.equal(succeeded(invoke(f)).created,false);
  assert.deepEqual(tree(f.options.dataRoot),before);
  for(const route of Object.values(config.transport.routes)) {
    const original=route.ledgerPath+'.retained';fs.renameSync(route.ledgerPath,original);
    fs.writeFileSync(route.ledgerPath,'foreign private file',{mode:0o600});
    const foreign=stamp(route.ledgerPath);
    assert.notEqual(invoke(f).status,0,'Completed init cannot claim a replacement inode');
    assert.deepEqual(stamp(route.ledgerPath),foreign);
    fs.unlinkSync(route.ledgerPath);fs.renameSync(original,route.ledgerPath);
  }
});
test('first init rejects foreign existing data and path aliases before persisting an identity',()=>{
  for(const variant of ['data','ledger','config','alias']) {
    const f=fixture();let original;
    if(variant==='config'){save(f.options.configPath,{foreign:true});original=f.options.configPath;}
    else if(variant==='data'){original=join(f.options.dataRoot,'business.sqlite');save(original,{foreign:true});}
    else if(variant==='ledger'){original=join(f.artifact,'openai-web.sqlite');save(original,{foreign:true});}
    else {const outside=join(f.root,'outside');fs.mkdirSync(outside);fs.mkdirSync(f.options.dataRoot);
      fs.symlinkSync(outside,f.artifact);original=join(outside,'retained');save(original,{foreign:true});}
    const before=stamp(original);assert.notEqual(invoke(f).status,0);
    assert.deepEqual(stamp(original),before);assert.equal(fs.existsSync(f.planPath),false);
  }
});

test('config publication before final receipt permits later unknown records and retry never reopens the ledger',()=>{
  const f=fixture();assert.equal(invoke(f,{point:'config-link'}).status,73);
  const config=read(f.options.configPath),route=config.transport.routes['deepseek-official'];
  assert.equal(fs.existsSync(join(f.receipts,'completed.json')),false);
  const ledger=new BudgetLedger(route.ledgerPath,{mode:'web-only',scope:'web-unlimited',webAuthorization:route.webAuthorization});
  ledger.reserve({requestId:'fixture-after-config',bodyHash:'fixture',model:'deepseek-v4-pro',
    inputTokenCeiling:4,maxOutputTokens:4,prices:{input:9,output:27,cachedInput:0.3}});
  ledger.markDispatched('fixture-after-config');ledger.markUnknown('fixture-after-config','Synthetic unknown; not sent');ledger.close();
  const original=Object.values(config.transport.routes).map(r=>({path:r.ledgerPath,...stamp(r.ledgerPath),rows:records(r.ledgerPath)}));
  const result=succeeded(invoke(f));assert.equal(result.created,false);
  assert.equal(result.initialization,'completed');assert.equal(result.runtimeChecked,false);
  for(const item of original){assert.deepEqual(stamp(item.path),{sha256:item.sha256,bytes:item.bytes});assert.deepEqual(records(item.path),item.rows);}
  assert.equal(fs.statSync(f.options.configPath).nlink,1);
  assert.equal(fs.existsSync(join(f.receipts,'completed.json')),true);
});

test('retry rejects aliased staging ancestry before writing outside the owned requests directory',()=>{
  const f=fixture();assert.equal(invoke(f,{point:'first-format'}).status,73);
  const staging=join(f.artifact,'initialization'),outside=join(f.root,'moved-failed-stages');
  fs.renameSync(staging,outside);fs.symlinkSync(outside,staging);
  const before=tree(outside);const result=invoke(f);
  assert.notEqual(result.status,0);assert.deepEqual(tree(outside),before,'No attempt or SQLite file may be created through an alias');
  assert.equal(fs.existsSync(f.options.configPath),false);
});

test('first-format retry rejects an aliased recovery archive before writing outside requests',()=>{
  for(const dangling of [false,true]) {
    const f=fixture();assert.equal(invoke(f,{point:'first-format'}).status,73);
    const outside=join(f.root,'external-recovery');
    if(!dangling){fs.mkdirSync(outside);save(join(outside,'retained.json'),{original:true});}
    fs.symlinkSync(outside,join(f.artifact,'web-budget-recovery'));
    const before=tree(outside),failed=invoke(f);
    assert.deepEqual(tree(outside),before,'Recovery must not create archive files through a symlink');
    assert.notEqual(failed.status,0);
    assert.equal(fs.existsSync(f.options.configPath),false);
  }
});
