// Real Cordis provider lifecycle and SQLite recovery; no Agent or model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import * as Host from '../src/metered-provider-host.mjs';
import { initializeOwnedWebBudget } from '../src/web-budget-recovery.mjs';
import { ownEvidenceDirectory } from '../src/evidence-ownership.mjs';
import { BudgetLedger } from '../src/budget.mjs';
const webAuthorization={authorizationRef:'fixture-host-web',authorizedAt:'2026-11-07T00:00:00Z',authorizationEvidence:'fixture'};
async function active(fiber) {
  const deadline=Date.now()+3000;
  for(;;){await fiber.await();if(fiber.state===2)return fiber;assert.ok([0,1].includes(fiber.state));assert.ok(Date.now()<deadline);await delay(1);}
}
async function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'arcfold-web-owner-host-'));
  let sends=0;const server=createServer((req,res)=>{sends++;res.writeHead(500);res.end();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const artifactDirectory=join(directory,'receipts');
  const {ledgerPath}=await initializeOwnedWebBudget({artifactDirectory,webAuthorization});
  const ctx=new Context();
  t.after(async()=>{await ctx.fiber.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  await ctx.plugin({name:'synthetic-business-and-session-carrier',apply(child){
    child.provide('arcfoldBusiness',{get(){return null;}});
    child.provide('arcfoldBridge',{});
    child.provide('sessions',{get(){return null;}});
  }});
  await ctx.plugin(LlmRuntime);
  const route={kind:'deepseek',mode:'web-only',scope:'web-unlimited',webAuthorization,ledgerPath,
    endpoint:'http://127.0.0.1:'+server.address().port+'/anthropic/v1/messages',allowLocalTestEndpoint:true,
    network:{mode:'direct'},modelPolicies:{'deepseek-v4-pro':{contextWindow:1024,maxOutputTokens:64,requestMaxTokens:32,
      reasoningEfforts:['off'],prices:{input:1,output:2,cachedInput:0.1},priceVersion:'fixture'}}};
  return {ctx,artifactDirectory,ledgerPath,route,sends:()=>sends};
}
test('independent providerHost owns and recovers web-only without a runtime lease, publishes only afterwards, and releases on close',async t=>{
  const f=await fixture(t);
  execFileSync(process.execPath,['-e',`const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA cache_size=1;BEGIN IMMEDIATE');const s=db.prepare("INSERT INTO budget_requests VALUES(?,?,'reserved',1,0,?,'web-unlimited')");
    for(let i=0;i<100;i++)s.run('uncommitted-'+i,'h',JSON.stringify({pad:'x'.repeat(8192)}));process.exit(0);`,f.ledgerPath]);
  assert.equal(readFileSync(f.ledgerPath+'-journal').subarray(0,8).toString('hex'),'d9d505f920a163d7');
  const fiber=await active(await f.ctx.plugin(Host,{artifactDirectory:f.artifactDirectory,routes:{'deepseek-official':f.route}}));
  assert.equal(f.ctx.arcfoldMeteredTransport.summary('deepseek-official').requests,0);
  assert.equal(f.sends(),0);await assert.rejects(ownEvidenceDirectory(f.artifactDirectory));
  await fiber.dispose();const owner=await ownEvidenceDirectory(f.artifactDirectory);await owner.close();
  const ledger=new BudgetLedger(f.ledgerPath,{mode:'web-only',scope:'web-unlimited',webAuthorization});
  assert.equal(ledger.summary().requests,0);ledger.close();
});
test('wrong independent web authorization fails before provider service publication without changing original bytes',async t=>{
  const f=await fixture(t),before=readFileSync(f.ledgerPath);
  await assert.rejects(async()=>active(await f.ctx.plugin(Host,{artifactDirectory:f.artifactDirectory,routes:{'deepseek-official':{
    ...f.route,webAuthorization:{...webAuthorization,authorizationEvidence:'changed'}}}})), {code:'web_budget_identity_conflict'});
  assert.equal(f.ctx.get('arcfoldMeteredTransport'),undefined);assert.equal(f.sends(),0);
  assert.deepEqual(readFileSync(f.ledgerPath),before);
  const owner=await ownEvidenceDirectory(f.artifactDirectory);await owner.close();
});
