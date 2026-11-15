// Command routing and damaged-record fixtures only. Installed lifecycle methods
// are deliberately labelled spies; native locking is real. No DSH host, package
// install, browser, credential read, model, or production directory is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { managementInstallation, parseRuntimeCommand, runRuntimeCommand, selectRuntimeVersion } from '../src/runtime-command.mjs';
import { loadRuntimeIdentity, runtimeHash, loadRuntimePlan } from '../src/runtime-config.mjs';
import { acquireRuntimeLease } from '../src/runtime-lifecycle.mjs';
import { BudgetLedger } from '../src/budget.mjs';
import { initializeOwnedWebBudget } from '../src/web-budget-recovery.mjs';
import { ownEvidenceDirectory } from '../src/evidence-ownership.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))), execute = promisify(execFile);
const bootstrap = JSON.parse(readFileSync(join(ROOT, 'runtime/bootstrap.json')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => {
  mkdirSync(dirname(path), { recursive:true, mode:0o700 });
  writeFileSync(path, JSON.stringify(value,null,2)+'\n', {mode:0o600});
};
const stamp = path => { const bytes = readFileSync(path); return {sha256:hash(bytes),bytes:bytes.length}; };
const fresh = () => realpathSync(mkdtempSync(join(tmpdir(), 'arcfold-command-test-')));
const trace = f => existsSync(f.tracePath) ? readFileSync(f.tracePath,'utf8').trim().split('\n').map(JSON.parse) : [];
async function until(readValue, label) {
  const deadline = Date.now()+10000;
  for (;;) { const value = readValue(); if (value) return value; assert.ok(Date.now()<deadline,'Timed out: '+label); await delay(10); }
}

function installation(root, version, tracePath, hooksPath, { runtime = 'complete' } = {}) {
  const directory = join(root, version), profile = join(directory,'bootstrap-home/profiles/arcfold');
  const core = join(profile,'node_modules/@arcfold/dsh'), ui = join(profile,'node_modules/@arcfold/dsh-method-ui');
  const put = (path, text) => { mkdirSync(dirname(path),{recursive:true,mode:0o700}); writeFileSync(path,text,{mode:0o600}); };
  save(join(core,'package.json'),{name:'@arcfold/dsh',version:'0.1.0',type:'module'});
  save(join(ui,'package.json'),{name:'@arcfold/dsh-method-ui',version:'0.1.0',type:'module'});
  save(join(profile,'node_modules/provider/package.json'),{name:'synthetic-provider',version:'0.0.0'});
  save(join(directory,'host/node_modules/synthetic-host/package.json'),{name:'synthetic-host',version:'0.0.0'});
  put(join(directory,'host/node_modules/synthetic-host/bin.mjs'),'// deliberately not a host\n');
  put(join(directory,'tooling/package/bin/pnpm.mjs'),'// deliberately not a package manager\n');
  for (const name of ['runtime-config.mjs','openai-models.mjs','store.mjs','budget.mjs','web-budget-recovery.mjs','evidence-ownership.mjs','legacy-export.mjs','legacy-import-source.mjs','learning-contracts.mjs']) {
    if (runtime === 'no-web-recovery' && name === 'web-budget-recovery.mjs' ||
        runtime === 'legacy-management' && ['budget.mjs','web-budget-recovery.mjs','evidence-ownership.mjs'].includes(name)) continue;
    mkdirSync(join(core,'src'),{recursive:true});
    let text=readFileSync(join(ROOT,'src',name),'utf8');
    if(['no-web-recovery','legacy-management'].includes(runtime)&&name==='runtime-config.mjs')
      text=text.replace("import { preflightWebBudget, webBudgetPath } from './web-budget-recovery.mjs';", '');
    if(runtime==='unsupported-web-capability'&&name==='web-budget-recovery.mjs')
      text=text.replace("WEB_BUDGET_RECOVERY_VERSION = 'web-only-recovery-v1'", "WEB_BUDGET_RECOVERY_VERSION = 'unsupported-fixture'");
    writeFileSync(join(core,'src',name),text);
  }
  let lifecycle = readFileSync(join(ROOT,'src/runtime-lifecycle.mjs'),'utf8');
  for (const name of ['startRuntime','stopRuntime','statusRuntime','openRuntime','restartRuntime','acquireRuntimeLease'])
    lifecycle = lifecycle.replace('export async function '+name+'(', 'async function actual_'+name+'(');
  lifecycle += `
    import { appendFileSync as fixtureAppend, writeFileSync as fixtureWrite, existsSync as fixtureExists } from 'node:fs';
    const fixtureTrace=${JSON.stringify(tracePath)}, fixtureHooks=${JSON.stringify(hooksPath)}, fixtureVersion=${JSON.stringify(version)};
    const fixtureRecord=action => fixtureAppend(fixtureTrace,JSON.stringify({version:fixtureVersion,action})+'\\n');
    export async function statusRuntime() {fixtureRecord('status');return {fixtureVersion,action:'status'};}
    export async function stopRuntime() {fixtureRecord('stop');return {fixtureVersion,action:'stop',shutdownEvidence:'fixture-only'};}
    export async function openRuntime() {fixtureRecord('open');return {fixtureVersion,opened:true};}
    export async function startRuntime() {fixtureRecord('start');return {fixtureVersion,action:'start'};}
    export async function acquireRuntimeLease(directory) {
      const lease=await actual_acquireRuntimeLease(directory);fixtureRecord('lock-acquired');
      const hooks=JSON.parse(await readFile(fixtureHooks,'utf8'));
      if(hooks.changeIdentity) {
        const config=JSON.parse(await readFile(hooks.configPath,'utf8'));
        config.dataRoot=hooks.changeIdentity;fixtureWrite(hooks.configPath,JSON.stringify(config));
      }
      while(hooks.gate&&!fixtureExists(hooks.gate)) await delay(10);
      return {close:async()=>{await lease.close();fixtureRecord('lock-released');}};
    }
  `;
  if (runtime === 'wrong-protocol') lifecycle = lifecycle.replace("export const RUNTIME_PROTOCOL = 'arcfold-runtime-v1'", "export const RUNTIME_PROTOCOL = 'unsupported-runtime' ");
  if (runtime === 'missing-operation') lifecycle = lifecycle.replace('export async function openRuntime()', 'async function omittedOpenRuntime()');
  if (runtime === 'broken-import') lifecycle += "\nimport './missing-runtime-dependency.mjs';\n";
  if (runtime !== 'plugin-only') put(join(core,'src/runtime-lifecycle.mjs'),lifecycle);
  if (!['plugin-only','missing-host'].includes(runtime)) {
    let host = readFileSync(join(ROOT,'src/runtime-host.mjs'),'utf8');
    if (runtime === 'missing-host-operation') host = host.replace('export async function runOwnedRuntime(', 'async function omittedRunOwnedRuntime(');
    put(join(core,'src/runtime-host.mjs'),host);
  }
  // The actual lazy flock JS and current platform native binary are copied into
  // this synthetic installation. No symlink can resolve back to the source.
  const require = createRequire(join(ROOT,'package.json'));
  // Actual installed exporter + parser, resolved only inside this private profile.
  for (const name of ['stream-json','stream-chain']) {
    let directory=dirname(require.resolve(name));
    while(!existsSync(join(directory,'package.json'))) directory=dirname(directory);
    cpSync(directory,join(profile,'node_modules',name),{recursive:true});
  }
  const flockSource = require.resolve('@deepseek-ai/node-addon-system/flock');
  const addonManifest = require.resolve('@deepseek-ai/node-addon-system/package.json');
  const addonRoot = join(profile,'node_modules/@deepseek-ai/node-addon-system');
  mkdirSync(join(addonRoot,'lib'),{recursive:true});
  copyFileSync(addonManifest,join(addonRoot,'package.json')); copyFileSync(flockSource,join(addonRoot,'lib/flock.js'));
  const nativeName = '@deepseek-ai/node-addon-system-'+process.platform+'-'+process.arch;
  const nativeManifest = createRequire(flockSource).resolve(nativeName+'/package.json');
  const nativeRoot = join(profile,'node_modules',nativeName);
  mkdirSync(join(nativeRoot,'bin'),{recursive:true});
  copyFileSync(nativeManifest,join(nativeRoot,'package.json'));
  copyFileSync(join(dirname(nativeManifest),'bin/system.node'),join(nativeRoot,'bin/system.node'));
  for (const target of ['host','bootstrap-home/profiles/arcfold']) for (const name of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml'])
    put(join(directory,target,name),'{}\n');
  put(join(profile,'cordis.patch.yml'),'[]\n');
  const files=[];
  function inventory(path) {
    for (const name of readdirSync(path).sort()) {
      const full=join(path,name),info=statSync(full);
      if(info.isDirectory()) inventory(full);
      else files.push({path:relative(directory,full),...stamp(full),executable:info.mode&0o111});
    }
  }
  for (const path of ['host/node_modules','bootstrap-home/profiles/arcfold/node_modules','tooling/package']) inventory(join(directory,path));
  for (const path of ['host/package.json','host/pnpm-lock.yaml','host/pnpm-workspace.yaml',
    'bootstrap-home/profiles/arcfold/package.json','bootstrap-home/profiles/arcfold/pnpm-lock.yaml',
    'bootstrap-home/profiles/arcfold/pnpm-workspace.yaml','bootstrap-home/profiles/arcfold/cordis.patch.yml'])
    files.push({path,...stamp(join(directory,path))});
  files.sort((a,b)=>a.path.localeCompare(b.path)); save(join(directory,'installation-files.json'),files);
  save(join(directory,'dependency-consumers.json'),[{owner:{name:'synthetic-routing-fixture'},requires:[]}]);
  const receipt={schema:'arcfold-installation-v1',installationDir:directory,hostRoot:join(directory,'host'),
    installAnchor:join(directory,'host/node_modules/synthetic-host/package.json'),cliPath:join(directory,'host/node_modules/synthetic-host/bin.mjs'),
    profileDir:profile,profileName:'arcfold',sourceCommit:(version==='old'?'a':'b').repeat(40),coreRoot:core,uiRoot:ui,
    provider:{path:join(profile,'node_modules/provider')},compatibility:{businessSchema:1,nativeFormat:4},
    packageManager:{command:process.execPath,args:[join(directory,'tooling/package/bin/pnpm.mjs')]},
    identities:{bootstrap,node:{path:process.execPath,...stamp(process.execPath)},
      consumers:{path:'dependency-consumers.json',...stamp(join(directory,'dependency-consumers.json')),count:1},
      fileManifest:{path:'installation-files.json',...stamp(join(directory,'installation-files.json')),count:files.length}}};
  const path=join(directory,'installation.json');save(path,receipt);
  return {...receipt,installationFile:path,fixturePaths:{addonRoot,nativeRoot}};
}

function fixture({current=true,nextRuntime='complete',oldRuntime='complete'}={}) {
  const root=fresh(),tracePath=join(root,'calls.jsonl'),hooksPath=join(root,'hooks.json');save(hooksPath,{});
  const old=installation(root,'old',tracePath,hooksPath,{runtime:oldRuntime}),next=installation(root,'next',tracePath,hooksPath,{runtime:nextRuntime});
  const dataRoot=join(root,'data'),runtimeDirectory=join(dataRoot,'runtime'),workspace=join(root,'workspace');mkdirSync(workspace);
  const configPath=join(root,'local.json'),config={schema:'arcfold-local-v1',installationFile:old.installationFile,
    dataRoot,workspace,listen:{host:'127.0.0.1',port:0},main:null,learn:null,transport:null}; save(configPath,config);
  const runId='fixture-prior-run',runDirectory=join(runtimeDirectory,'runs',runId);
  const currentPath=join(runtimeDirectory,'current.json'),launchPath=join(runDirectory,'launch.json');
  const {fixturePaths,...installed}=old;
  if(current) {
    save(currentPath,{schema:'arcfold-runtime-v1',dataRoot,runId,phase:'ready',configurationHash:runtimeHash(config)});
    save(launchPath,{schema:'arcfold-runtime-v1',runId,runDirectory,plan:{configPath,dataRoot,runtimeDirectory,
      configurationHash:runtimeHash(config),config,installation:installed}});
  }
  return {root,tracePath,hooksPath,old,next,config,configPath,dataRoot,runtimeDirectory,currentPath,launchPath,runDirectory};
}

test('unpacked command entry has builtin-only help and rejects an old installation lacking dual proofs', async () => {
  const f=fixture({current:false}),unpacked=join(f.root,'unpacked'),outside=join(f.root,'another-cwd');mkdirSync(outside);
  for (const path of ['bin/arcfold.mjs','src/runtime-command.mjs','src/runtime-config.mjs','src/openai-models.mjs','src/runtime-installation.mjs','src/store.mjs','src/budget.mjs','src/web-budget-recovery.mjs','src/evidence-ownership.mjs']) {
    mkdirSync(dirname(join(unpacked,path)),{recursive:true});copyFileSync(join(ROOT,path),join(unpacked,path));
  }
  const invoke=args=>execute(process.execPath,[join(unpacked,'bin/arcfold.mjs'),...args],{cwd:outside,env:{...process.env,NODE_PATH:''}});
  const help=await invoke(['--help']);assert.match(help.stdout,/use-version/);
  const created=join(f.root,'fresh-local.json');
  await assert.rejects(invoke(['init','--config',created,'--installation-file',f.old.installationFile,
    '--data',f.dataRoot,'--workspace',f.config.workspace,'--web-unlimited']), /both actual provider proofs/);
  assert.equal(existsSync(created),false);
  assert.equal(existsSync(join(unpacked,'node_modules')),false);assert.equal(existsSync(f.dataRoot),false);
});

test('status stop and open select the recorded old manager despite broken new model and installation settings', async () => {
  const f=fixture();save(f.configPath,{...f.config,installationFile:join(f.root,'missing-version/installation.json'),main:{broken:true},transport:'bad-new-config'});
  for(const command of ['status','stop','open']) assert.equal((await runRuntimeCommand([command,'--config',f.configPath])).fixtureVersion,'old');
  assert.deepEqual(trace(f).map(row=>row.action),['status','stop','open']);
});

test('current and launch identity disagreement is rejected before a manager runs', async () => {
  for(const mutate of [
    f=>save(f.currentPath,{...read(f.currentPath),dataRoot:join(f.root,'other-data')}),
    f=>save(f.currentPath,{...read(f.currentPath),configurationHash:'c'.repeat(64)}),
    f=>save(f.launchPath,{...read(f.launchPath),runId:'different-run'}),
    f=>{const value=read(f.launchPath);value.plan.runtimeDirectory=join(f.root,'other-runtime');save(f.launchPath,value);},
  ]) {
    const f=fixture();mutate(f);
    await assert.rejects(runRuntimeCommand(['status','--config',f.configPath]));assert.deepEqual(trace(f),[]);
  }
});

test('changed management JS or native lock bytes are refused while unrelated UI damage does not prevent stop', async () => {
  const f=fixture(),identity=loadRuntimeIdentity(f.configPath);
  for(const path of [join(f.old.coreRoot,'src/runtime-lifecycle.mjs'),join(f.old.coreRoot,'src/runtime-config.mjs'),join(f.old.coreRoot,'src/openai-models.mjs'),
    join(f.old.coreRoot,'src/store.mjs'),join(f.old.fixturePaths.addonRoot,'lib/flock.js'),join(f.old.fixturePaths.nativeRoot,'bin/system.node')]) {
    const original=readFileSync(path);writeFileSync(path,Buffer.concat([original,Buffer.from('\nchanged')]));
    try {assert.throws(()=>managementInstallation(identity),/Management code changed/);} finally {writeFileSync(path,original);}
  }
  writeFileSync(join(f.old.uiRoot,'package.json'),'not the old UI anymore');
  assert.equal((await runRuntimeCommand(['stop','--config',f.configPath])).fixtureVersion,'old');
});

test('an unrecorded nested native-lock package cannot shadow the verified manager dependency', () => {
  const f=fixture(),shadow=join(f.old.coreRoot,'node_modules/@deepseek-ai/node-addon-system');
  save(join(shadow,'package.json'),{name:'@deepseek-ai/node-addon-system',version:'0.1.2',type:'module',exports:{'./flock':'./flock.mjs','./package.json':'./package.json'}});
  writeFileSync(join(shadow,'flock.mjs'),'throw new Error("must not execute")');
  assert.throws(()=>managementInstallation(loadRuntimeIdentity(f.configPath)),/absent from the recorded installation/);
  assert.deepEqual(trace(f),[]);
});

test('the manager refuses a mutually consistent receipt and launch that name different Node bytes', () => {
  const f=fixture(),receipt=read(f.old.installationFile),launch=read(f.launchPath);
  receipt.identities.node.sha256='e'.repeat(64);
  save(f.old.installationFile,receipt);launch.plan.installation={...receipt,installationFile:f.old.installationFile};save(f.launchPath,launch);
  assert.throws(()=>managementInstallation(loadRuntimeIdentity(f.configPath)),/Node executable changed/);
  assert.deepEqual(trace(f),[]);
});

test('restart routes old stop before new start without calling the old restart helper', async () => {
  const f=fixture();save(f.configPath,{...f.config,installationFile:f.next.installationFile});
  const result=await runRuntimeCommand(['restart','--config',f.configPath]);
  assert.deepEqual(trace(f),[{version:'old',action:'stop'},{version:'next',action:'start'}]);
  assert.equal(result.fixtureVersion,'next');assert.equal(result.previous.fixtureVersion,'old');
});

test('a bad newly selected installation cannot stop old shutdown or trigger a fallback start', async () => {
  const f=fixture();save(f.configPath,{...f.config,installationFile:join(f.root,'missing/installation.json')});
  await assert.rejects(runRuntimeCommand(['restart','--config',f.configPath]));
  assert.deepEqual(trace(f),[{version:'old',action:'stop'}]);
});

test('use-version holds the real data lock while changing only the code pointer and preserves original data bytes', async t => {
  const f=fixture(),gate=join(f.root,'release-version-gate');save(f.hooksPath,{gate});
  const native=join(f.dataRoot,'native/original-session'),notes=join(f.dataRoot,'original-unknown-receipt');
  mkdirSync(dirname(native),{recursive:true});writeFileSync(native,'original incomplete session');writeFileSync(notes,'unknown request remains unknown');
  const business=join(f.dataRoot,'business.sqlite'),db=new DatabaseSync(business);
  db.exec("CREATE TABLE business_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO business_meta VALUES ('schema_version','1'); CREATE TABLE original_facts (id TEXT PRIMARY KEY,value TEXT); INSERT INTO original_facts VALUES ('preserved','original business fact');");
  db.close();
  const originalsPaths=[native,notes,business],before=read(f.configPath),originals=originalsPaths.map(path=>stamp(path));
  const change=selectRuntimeVersion({configPath:f.configPath,installationFile:f.next.installationFile});
  void change.catch(()=>{});
  t.after(async()=>{writeFileSync(gate,'release after test');await change.catch(()=>{});});
  await until(()=>trace(f).some(row=>row.action==='lock-acquired'),'version data lock');
  await assert.rejects(acquireRuntimeLease(f.runtimeDirectory),{code:'already_running'});
  assert.deepEqual(read(f.configPath),before);writeFileSync(gate,'continue');
  const result=await change;
  assert.deepEqual(read(f.configPath),{...before,installationFile:f.next.installationFile});
  assert.deepEqual(originalsPaths.map(path=>stamp(path)),originals);
  assert.equal(result.dataPreserved,true);assert.equal(result.started,false);
  assert.deepEqual(trace(f),[{version:'old',action:'lock-acquired'},{version:'old',action:'lock-released'}]);
});

test('use-version refuses an already owned data directory without modifying its configuration', async () => {
  const f=fixture(),before=readFileSync(f.configPath),lease=await acquireRuntimeLease(f.runtimeDirectory);
  try {await assert.rejects(selectRuntimeVersion({configPath:f.configPath,installationFile:f.next.installationFile}),{code:'already_running'});}
  finally {await lease.close();}
  assert.deepEqual(readFileSync(f.configPath),before);assert.deepEqual(trace(f),[]);
});

test('a data identity change during lease acquisition cannot switch code under the wrong data lock', async () => {
  const f=fixture(),otherData=join(f.root,'other-data');save(f.hooksPath,{changeIdentity:otherData,configPath:f.configPath});
  await assert.rejects(selectRuntimeVersion({configPath:f.configPath,installationFile:f.next.installationFile}),/identity|directory|data/i);
  const after=read(f.configPath);assert.equal(after.dataRoot,otherData);assert.equal(after.installationFile,f.old.installationFile);
  assert.deepEqual(trace(f),[{version:'old',action:'lock-acquired'},{version:'old',action:'lock-released'}]);
  const lease=await acquireRuntimeLease(f.runtimeDirectory);await lease.close();
});

test('an incompatible selected version leaves configuration unchanged and releases its data lock', async () => {
  const f=fixture(),before=readFileSync(f.configPath),receipt=read(f.next.installationFile);
  receipt.compatibility.nativeFormat=3;save(f.next.installationFile,receipt);
  await assert.rejects(selectRuntimeVersion({configPath:f.configPath,installationFile:f.next.installationFile}));
  assert.deepEqual(readFileSync(f.configPath),before);
  assert.deepEqual(trace(f),[{version:'old',action:'lock-acquired'},{version:'old',action:'lock-released'}]);
  const lease=await acquireRuntimeLease(f.runtimeDirectory);await lease.close();
});

test('version selection requires real runtime entry exports before replacing the code pointer', async t => {
  for (const nextRuntime of ['plugin-only','missing-host','missing-operation','missing-host-operation','wrong-protocol','broken-import']) {
    await t.test(nextRuntime, async () => {
      // The fixture's inventory hashes match its actual payload. It still has
      // compatible data-format declarations, which alone must not authorize it.
      const f=fixture({nextRuntime}),before=readFileSync(f.configPath);
      const native=join(f.dataRoot,'native/session-original'),business=join(f.dataRoot,'business.sqlite'),fees=join(f.dataRoot,'fees.sqlite');
      mkdirSync(dirname(native),{recursive:true});writeFileSync(native,'unit-only original session bytes');
      const db=new DatabaseSync(business);
      db.exec("CREATE TABLE business_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO business_meta VALUES ('schema_version','1'); CREATE TABLE original_facts (id TEXT PRIMARY KEY,value TEXT); INSERT INTO original_facts VALUES ('retained','later user knowledge');");
      db.close();
      const budget=new BudgetLedger(fees,{create:true,ceilingCny:1,authorizationRef:'synthetic-version-rejection'});
      budget.reserve({requestId:'synthetic-unknown',bodyHash:hash('unit-only request'),model:'synthetic',maxOutputTokens:2,inputTokenCeiling:2,
        prices:{input:1,output:1,cachedInput:1}});
      budget.markDispatched('synthetic-unknown');budget.markUnknown('synthetic-unknown','unit-only incomplete receipt');budget.close();
      const originals=[native,business,fees].map(path=>stamp(path));
      await assert.rejects(selectRuntimeVersion({configPath:f.configPath,installationFile:f.next.installationFile}),{code:'version_not_launchable'});
      assert.deepEqual(readFileSync(f.configPath),before);
      assert.deepEqual([native,business,fees].map(path=>stamp(path)),originals);
      assert.deepEqual(readdirSync(f.root).filter(name=>name.startsWith('.arcfold-version-')),[]);
      assert.deepEqual(trace(f),[{version:'old',action:'lock-acquired'},{version:'old',action:'lock-released'}]);
      const lease=await acquireRuntimeLease(f.runtimeDirectory);await lease.close();
      // Failed target validation has not replaced the old owner's management code.
      assert.equal((await runRuntimeCommand(['status','--config',f.configPath])).fixtureVersion,'old');
    });
  }
});

test('command arguments reject duplicates, missing values and relative deployment paths', () => {
  for(const argv of [['start','--config'],['status','--config','relative.json'],['stop','--config','/a','--config','/b'],
    ['open','--config','/a','--url','http://example.invalid'],['start','--config','/a','--timeout-ms','not-a-number']])
    assert.throws(()=>parseRuntimeCommand(argv));
});

async function webOnlyFixture(options) {
  const f=fixture(options),artifactDirectory=join(f.dataRoot,'requests');
  const webAuthorization={authorizationRef:'synthetic-command-web',authorizedAt:'2026-11-07T00:00:00Z',authorizationEvidence:'fixture only'};
  const {ledgerPath}=await initializeOwnedWebBudget({artifactDirectory,webAuthorization});
  const transport={artifactDirectory,routes:{'deepseek-official':{kind:'deepseek',mode:'web-only',scope:'web-unlimited',
    apiKeyRef:'FIXTURE_REF',ledgerPath,webAuthorization,network:{mode:'direct'},
    endpoint:'https://api.deepseek.com/anthropic/v1/messages',
    modelPolicies:{'deepseek-v4-pro':{contextWindow:1024,maxOutputTokens:64,requestMaxTokens:32,
      reasoningEfforts:['off'],prices:{input:1,output:2,cachedInput:0.1},priceVersion:'fixture'}}}}};
  f.config={...f.config,schema:'arcfold-local-v2',transport};save(f.configPath,f.config);
  return {...f,artifactDirectory,ledgerPath,webAuthorization};
}
test('use-version validates the actual target web-only capability on a copy, under both real locks',async()=>{
  const f=await webOnlyFixture(),before=readFileSync(f.ledgerPath);
  const owner=await ownEvidenceDirectory(f.artifactDirectory);
  try{await assert.rejects(selectRuntimeVersion({configPath:f.configPath,installationFile:f.next.installationFile}));}
  finally{await owner.close();}
  assert.equal(read(f.configPath).installationFile,f.old.installationFile);
  const result=await selectRuntimeVersion({configPath:f.configPath,installationFile:f.next.installationFile});
  assert.equal(result.started,false);assert.deepEqual(readFileSync(f.ledgerPath),before);
  const recoveries=readdirSync(join(f.artifactDirectory,'web-budget-recovery'));
  assert.equal(recoveries.length,1);
  assert.equal(existsSync(join(f.artifactDirectory,'web-budget-recovery',recoveries[0],'original-recovery-started.json')),false);
});
test('use-version refuses a verified old target without web-only recovery and does not replace config',async()=>{
  for(const nextRuntime of ['no-web-recovery','unsupported-web-capability']) {
    const f=await webOnlyFixture({nextRuntime}),config=readFileSync(f.configPath),db=readFileSync(f.ledgerPath);
    await assert.rejects(selectRuntimeVersion({configPath:f.configPath,installationFile:f.next.installationFile}));
    assert.deepEqual(readFileSync(f.configPath),config);assert.deepEqual(readFileSync(f.ledgerPath),db);
  }
});

test('unlocked runtime planning preserves a genuine hot web-only journal and does not grant an opened ledger',async()=>{
  const f=await webOnlyFixture();
  await execute(process.execPath,['-e',`
    const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA cache_size=1;BEGIN IMMEDIATE');
    const q=db.prepare("INSERT INTO budget_requests VALUES(?,?,'reserved',1,0,?,'web-unlimited')");
    for(let i=0;i<100;i++)q.run('partial-'+i,'h',JSON.stringify({pad:'x'.repeat(8192)}));process.exit(0);
  `,f.ledgerPath]);
  const before=readFileSync(f.ledgerPath),journal=readFileSync(f.ledgerPath+'-journal');
  assert.equal(journal.subarray(0,8).toString('hex'),'d9d505f920a163d7');
  await loadRuntimePlan(f.configPath);
  assert.deepEqual(readFileSync(f.ledgerPath),before);assert.deepEqual(readFileSync(f.ledgerPath+'-journal'),journal);
  await selectRuntimeVersion({configPath:f.configPath,installationFile:f.next.installationFile});
  assert.deepEqual(readFileSync(f.ledgerPath),before);assert.deepEqual(readFileSync(f.ledgerPath+'-journal'),journal);
});
test('owned initialization delegates to selected installed core from an empty caller without node_modules',async()=>{
  const f=fixture({current:false}),outside=join(f.root,'empty-caller');mkdirSync(outside);
  const artifactDirectory=join(f.dataRoot,'independent-first-use'),webAuthorization={
    authorizationRef:'owned-init-fixture',authorizedAt:'2026-11-07T00:00:00Z',authorizationEvidence:'fixture'};
  const {stdout}=await execute(process.execPath,['--input-type=module','-e',`
    const {pathToFileURL}=await import('node:url');
    const api=await import(pathToFileURL(process.argv[1]).href);
    console.log(JSON.stringify(await api.initializeOwnedWebBudget(JSON.parse(process.argv[2]))));
  `,join(f.next.coreRoot,'src/web-budget-recovery.mjs'),JSON.stringify({artifactDirectory,webAuthorization})],
  {cwd:outside,env:{...process.env,NODE_PATH:''}});
  const result=JSON.parse(stdout);assert.equal(result.created,true);
  assert.equal(result.ledgerPath,join(artifactDirectory,'deepseek-web.sqlite'));
  assert.equal(existsSync(join(outside,'node_modules')),false);
  assert.equal(existsSync(join(f.next.coreRoot,'node_modules')),false,'native addon resolves from installed profile, not caller');
});

test('old-owner management verifies the new known import closure before loading it',async()=>{
  for(const name of ['web-budget-recovery.mjs','budget.mjs','evidence-ownership.mjs']) {
    const f=fixture(),path=join(f.old.coreRoot,'src',name);
    writeFileSync(path,readFileSync(path,'utf8')+'\\n// fixture tampering\\n');
    for(const command of ['status','stop','open'])
      await assert.rejects(runRuntimeCommand([command,'--config',f.configPath]),/Management code changed/);
    assert.deepEqual(trace(f),[]);
  }
});
test('old management without recovery helpers can still stop/status/open despite invalid current model settings',async()=>{
  const f=fixture({oldRuntime:'legacy-management'});
  for(const name of ['web-budget-recovery.mjs','budget.mjs','evidence-ownership.mjs'])
    assert.equal(existsSync(join(f.old.coreRoot,'src',name)),false);
  save(f.configPath,{...f.config,main:{broken:true},transport:'invalid-current-selection'});
  for(const command of ['status','stop','open'])
    assert.equal((await runRuntimeCommand([command,'--config',f.configPath])).fixtureVersion,'old');
});

test('init distinguishes permission and model choices from filesystem paths',()=>{
 const base=['init','--config','/tmp/arcfold.json','--installation-file','/tmp/code/installation.json','--data','/tmp/data','--workspace','/tmp/work'];
 assert.throws(()=>parseRuntimeCommand(base),/web-unlimited/);
 const result=parseRuntimeCommand([...base,'--web-unlimited','--learn-provider','deepseek-official','--learn-model','deepseek-v4-pro','--learn-reasoning','off','--proxy','http://localhost:8080/']);
 assert.equal(result.options['web-unlimited'],true);assert.equal(result.options['learn-provider'],'deepseek-official');
 assert.equal(result.options.proxy,'http://localhost:8080/');
 for(const rest of [['--learn-model','gpt-6-astra'],['--web-unlimited'],['--proxy','http://user:secret@localhost/']])
   assert.throws(()=>parseRuntimeCommand([...base,'--web-unlimited',...rest]));
});

// Public child entry has no local node_modules and never boots the old Store.
test('verified installed export CLI reads explicit old3 DB and refuses tampered exporter',async()=>{
  const f=fixture({current:false}),unpacked=join(f.root,'export-unpacked'),outside=join(f.root,'export-cwd');mkdirSync(outside);
  for(const path of ['bin/arcfold.mjs','src/runtime-command.mjs','src/runtime-config.mjs','src/openai-models.mjs','src/runtime-installation.mjs','src/store.mjs','src/budget.mjs','src/web-budget-recovery.mjs','src/evidence-ownership.mjs']){
    mkdirSync(dirname(join(unpacked,path)),{recursive:true});copyFileSync(join(ROOT,path),join(unpacked,path));
  }
  const source=join(f.root,'old3.sqlite'),db=new DatabaseSync(source);
  db.exec("CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));CREATE TABLE store_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO store_meta VALUES('schema_version','2'),('mutation_sequence','0')");db.close();
  const invoke=out=>execute(process.execPath,[join(unpacked,'bin/arcfold.mjs'),'export-legacy','--installation-file',f.old.installationFile,'--source-db',source,'--output',out],{cwd:outside,env:{...process.env,NODE_PATH:''}});
  const output=join(f.root,'empty.jsonl'),result=await invoke(output);assert.equal(JSON.parse(result.stdout).complete,true);assert.equal(readFileSync(output,'utf8').trim().split('\n').length,2);assert.equal(trace(f).length,0);
  assert.equal(existsSync(join(unpacked,'node_modules')),false);assert.throws(()=>parseRuntimeCommand(['export-legacy','--installation-file',f.old.installationFile,'--source-db',source]),/output/);
  const alias=join(f.root,'old3-alias');symlinkSync(source,alias);
  await assert.rejects(execute(process.execPath,[join(unpacked,'bin/arcfold.mjs'),'export-legacy','--installation-file',f.old.installationFile,'--source-db',alias,'--output',join(f.root,'alias-output')],{cwd:outside,env:{...process.env,NODE_PATH:''}}));
  assert.equal(existsSync(join(f.root,'alias-output')),false);
  const exporter=join(f.old.coreRoot,'src/legacy-export.mjs');writeFileSync(exporter,readFileSync(exporter,'utf8')+'\n// tampered\n');
  await assert.rejects(invoke(join(f.root,'tampered.jsonl')));assert.equal(existsSync(join(f.root,'tampered.jsonl')),false);assert.equal(trace(f).length,0);
});
