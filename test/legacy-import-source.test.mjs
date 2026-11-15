import test from 'node:test';
import assert from 'node:assert/strict';
import { readLegacyImport, textDigest } from '../src/legacy-import-source.mjs';

const snapshot=(extra={})=>({readOnly:true,version:'old2:1',snapshot:{schemaVersion:1,runs:{r:{id:'r',request:'  原话🙂\n尾部  ',answer:'回答',status:'complete',createdAt:'2026-01-01T00:00:00Z',...extra}},states:{}}});
async function parse(value,options={}){
  const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value));
  return readLegacyImport({expectedBytes:bytes.length,expectedSha256:textDigest(bytes),
    stream:(async function*(){for(let n=0;n<bytes.length;n+=options.chunk??3)yield bytes.subarray(n,n+(options.chunk??3));})(),...options});
}
test('official token pipeline retains exact original strings and skips a giant trace before packing',async()=>{
  const value=snapshot({trace:'x'.repeat(3000000),context:{content:'y'.repeat(2000000)}});
  const result=await parse(value,{chunk:65536});
  assert.equal(result.sources.length,2);assert.equal(result.sources[0].content,'  原话🙂\n尾部  ');
  assert.equal(result.sourceScopes[0].sourceConversationId,'r');assert.equal(result.sourceScopes[0].messageCount,2);
  assert.equal(JSON.stringify(result).includes('x'.repeat(100)),false);
});
test('limits reject keys, selected strings, depth, duplicate keys, truncation and native post-last-chunk failure',async()=>{
  await assert.rejects(parse(snapshot({['k'.repeat(1025)]:1})),e=>e.code==='import_key_limit');
  await assert.rejects(parse(snapshot({request:'x'.repeat(1000001)}),{chunk:65536}),e=>e.code==='import_string_limit');
  assert.equal((await parse(snapshot({request:'x'.repeat(1000000)}),{chunk:65536})).sources[0].content.length,1000000);
  await assert.rejects(parse('{"snapshot":{"runs":{},"runs":{}}}'),e=>e.code==='import_duplicate_key');
  await assert.rejects(parse('{"snapshot":'+ '['.repeat(70)+'0'+']'.repeat(70)+'}'),e=>e.code==='import_depth_limit');
  await assert.rejects(parse(JSON.stringify(snapshot()).slice(0,-1)));
  const bytes=Buffer.from(JSON.stringify(snapshot()));
  await assert.rejects(readLegacyImport({expectedBytes:bytes.length,expectedSha256:textDigest(bytes),stream:(async function*(){yield bytes;throw new Error('native digest failure after final yield');})()}),/native digest failure/);
  await assert.rejects(readLegacyImport({expectedBytes:bytes.length,expectedSha256:'0'.repeat(64),stream:(async function*(){yield bytes;})()}),e=>e.code==='import_digest_mismatch');
});
test('malformed UTF-8 is rejected instead of silently replacing original source characters',async()=>{
  const data=Buffer.concat([Buffer.from('{"snapshot":{"runs":{"r":{"id":"r","request":"'),Buffer.from([255]),Buffer.from('"}},"states":{}}}')]);
  await assert.rejects(readLegacyImport({expectedBytes:data.length,expectedSha256:textDigest(data),stream:(async function*(){yield data;})()}),e=>e.code==='invalid_import_json');
  const tail=Buffer.concat([Buffer.from(JSON.stringify(snapshot())),Buffer.from([229])]);
  await assert.rejects(readLegacyImport({expectedBytes:tail.length,expectedSha256:textDigest(tail),stream:(async function*(){yield tail.subarray(0,-1);yield tail.subarray(-1);})()}),e=>e.code==='invalid_import_json');
});
test('old2 summary requires exact original version/quote and remains inference; tasks remain history',async()=>{
  const value=snapshot();value.snapshot.eventLog=[{id:'e',runId:'r',type:'user/message',actor:{kind:'user',verified:true},version:1,occurredAt:'2026-01-01T00:00:00Z',payload:{text:value.snapshot.runs.r.request}}];
  value.snapshot.states={s:{id:'s',text:'保留格式的摘要',scope:'global',status:'active',verification:'supported',revision:1,evidence:[{eventId:'e',version:1,quote:'原话🙂'}],derivedFrom:[]}};
  value.snapshot.tasks={t:{id:'t',title:'旧任务',goal:'旧目标',runIds:['r'],evidence:[{eventId:'e',version:1}]}};
  const parsed=await parse(value);assert.equal(parsed.records[0].eligibility,'enabled');assert.equal(parsed.records[0].claimType,'inference');
  assert.equal(parsed.records[1].eligibility,'history');assert.deepEqual(parsed.records[1].original.runIds,['r']);
  value.snapshot.states.s.evidence[0].version=2;assert.equal((await parse(value)).records[0].eligibility,'needs_review');
  value.snapshot.states.s.evidence[0].version=1;value.snapshot.runs.r.invalidated=true;
  const withdrawn=await parse(value);assert.equal(withdrawn.sources[0].available,false);assert.equal(withdrawn.records[0].eligibility,'needs_review');
});
