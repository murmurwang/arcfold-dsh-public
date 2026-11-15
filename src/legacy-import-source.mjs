import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { parser } from 'stream-json';
import { filter } from 'stream-json/filters/filter.js';
import { stringer } from 'stream-json/stringer.js';
import chain from 'stream-chain';
import { many } from 'stream-chain/core';
import { DomainError, canonicalJson } from './store.mjs';
import { METHOD_SCHEMA, UNDERSTANDING_SCHEMA } from './learning-contracts.mjs';

export const IMPORT_LIMITS = Object.freeze({ maxFileBytes: 805306368, maxChunkBytes: 65536,
  maxKeyCharacters: 1024, maxStringCharacters: 1000000, maxDepth: 64,
  maxProjectionCharacters: 33554432, maxTokens: 3000000, maxRows: 10000, maxScopes: 200 });
const fail = (code, message) => { throw new DomainError(code, message); };
export const importDigest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const textDigest = value => createHash('sha256').update(value).digest('hex');
export const importMethodField = (row,key) => typeof row[key]==='string'&&row[key].trim()&&row[key].length<=METHOD_SCHEMA.properties[key].maxLength?row[key]:null;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const values = value => Array.isArray(value) ? value : object(value) ? Object.values(value) : [];
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');
const unavailable = row => !row || row.deleted || row.withdrawn || row.useProhibited || ['withdrawn','superseded','rejected','dismissed'].includes(row.status);
const runFields = new Set('id request answer status error answerValid clientId sessionId conversationId taskId version sourceMessageRef createdAt updatedAt completedAt startedAt invalidated deleted withdrawn useProhibited'.split(' '));
const eventFields = new Set('id type actor occurredAt observedAt version revision seq runId taskId sourceEventId deleted withdrawn useProhibited status payload'.split(' '));
const eventPayload = new Set('text request answer content detail role sourceNotice sourceProjection'.split(' '));
const stateFields = new Set('id recordType kind verification informationVersion updatedSeq applicability derivedFrom changeReason text scope basis confidence status evidence expiresAt sourceRunId maintainedBy revision createdAt updatedAt versions deleted useProhibited withdrawn'.split(' '));
const taskFields = new Set('id title goal status progress steps runIds informationVersion updatedSeq goalEvidence hypothesisRefs historyInitialization versions revision createdAt updatedAt evidence maintainedBy constraints decisions questions'.split(' '));
const envelopeFields = new Set('type format exportId exporter source schemaVersion mutationSequence collections excluded complete counts record kind digest'.split(' '));

// This adapter sees tokens, never JSON syntax. The official parser owns escape,
// UTF-8 and grammar handling. Keys are limited BEFORE being concatenated.
function keyGuard(limits) {
  let key = null, depth = 0, numberLength = 0, heldKeyCharacters = 0;
  const containers = [];
  return token => {
    if (token.name === 'startObject' || token.name === 'startArray') {
      if (++depth > limits.maxDepth) fail('import_depth_limit', '导出嵌套过深。');
      containers.push(token.name === 'startObject' ? {keys:new Set(),characters:0} : null);
    } else if (token.name === 'endObject' || token.name === 'endArray') { depth--; heldKeyCharacters-=containers.pop()?.characters || 0; }
    if (token.name === 'startKey') key = '';
    else if (token.name === 'stringChunk' && key !== null) {
      if (key.length + token.value.length > limits.maxKeyCharacters) fail('import_key_limit', '导出字段名过长。');
      key += token.value;
    } else if (token.name === 'endKey') {
      const container = containers.at(-1),keys=container?.keys;
      if (!keys || keys.has(key) || keys.size >= limits.maxRows) fail('import_duplicate_key', '导出对象含重复字段或过多字段。');
      if(heldKeyCharacters+key.length>2097152)fail('import_key_limit','嵌套对象字段名总量超限。');
      heldKeyCharacters+=key.length;container.characters+=key.length;
      keys.add(key); const value = key; key = null;
      return many([token, { name: 'keyValue', value }]);
    }
    if (token.name === 'startNumber') numberLength = 0;
    if (token.name === 'numberChunk' && (numberLength += token.value.length) > 128)
      fail('import_number_limit', '导出数字过长。');
    return token;
  };
}
function selected(path) {
  if (!path.length) return true;
  if (envelopeFields.has(path[0])) return true;
  if (['readOnly','version'].includes(path[0])) return true;
  if (path[0] !== 'snapshot') return false;
  if (path.length === 1) return true;
  const collection = path[1];
  if (['schemaVersion','revision'].includes(collection)) return true;
  const fields = {runs:runFields,eventLog:eventFields,states:stateFields,tasks:taskFields}[collection];
  if (!fields) return false;
  if (path.length < 4) return true;
  if (!fields.has(path[3])) return false;
  if (collection === 'eventLog' && path[3] === 'payload' && path.length > 4) return eventPayload.has(path[4]);
  return true;
}
function stringGuard(limits) {
  let length = 0,tokens=0;
  return token => {
    if(++tokens>limits.maxTokens)fail('import_token_limit','业务投影结构超过本次上限。');
    if (token.name === 'startString' || token.name === 'startKey') length = 0;
    if (token.name === 'stringChunk' && (length += token.value.length) > limits.maxStringCharacters)
      fail('import_string_limit', '所选正文超过单项上限，未截断。');
    return token;
  };
}

/** The input is the host's native verified reader. Successful EOF is mandatory. */
export async function readLegacyImport({ stream, expectedBytes, expectedSha256, signal, limits = IMPORT_LIMITS }) {
  if (!nonnegative(expectedBytes) || expectedBytes > limits.maxFileBytes || !/^[a-f0-9]{64}$/.test(expectedSha256))
    fail('invalid_import_file', '附件大小或摘要无效。');
  let bytes = 0, ended = false;
  const digest = createHash('sha256'),utf8=new TextDecoder('utf-8',{fatal:true});
  async function* input() {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > limits.maxChunkBytes)
        fail('import_chunk_limit', '附件读取块不符合原生读取合同。');
      bytes += chunk.byteLength;
      if (bytes > limits.maxFileBytes || bytes > expectedBytes) fail('import_byte_limit', '附件超出已声明大小。');
      digest.update(chunk);
      let decoded;try{decoded=utf8.decode(chunk,{stream:true});}catch{fail('invalid_import_json','导出包含损坏的 UTF-8 字节，未替换原话。');}
      if(decoded)yield decoded;
    }
    let tail;try{tail=utf8.decode();}catch{fail('invalid_import_json','导出末尾的 UTF-8 字符不完整。');}
    if(tail)yield tail;
    signal?.throwIfAborted();
    if (bytes !== expectedBytes || digest.digest('hex') !== expectedSha256) fail('import_digest_mismatch', '附件完整摘要不符。');
    ended = true;
  }
  const pipeline = chain([Readable.from(input()), parser({jsonStreaming:true,packKeys:false,packStrings:false,packNumbers:false,
    streamKeys:true,streamStrings:true,streamNumbers:true}), keyGuard(limits),
    filter({filter:selected,acceptObjects:false,streamKeys:true,maxDepth:limits.maxDepth}), stringGuard(limits),
    stringer({useValues:false,makeArray:true})]);
  const pieces = []; let pending = [], pendingLength = 0, characters = 0;
  try {
    for await (const fragment of pipeline) {
      signal?.throwIfAborted();
      if ((characters += fragment.length) > limits.maxProjectionCharacters) fail('import_projection_limit', '业务投影超过上限，未截断。');
      pending.push(fragment); pendingLength += fragment.length;
      if (pendingLength >= 65536) { pieces.push(pending.join('')); pending = []; pendingLength = 0; }
    }
  } finally { pipeline.destroy(); }
  if (!ended) fail('import_incomplete', '附件尚未完成原生完整性校验。');
  pieces.push(pending.join(''));
  let documents;
  try { documents = JSON.parse(pieces.join('')); } catch { fail('invalid_import_json', '导出 JSON 不完整或无效。'); }
  if (!Array.isArray(documents) || !documents.length) fail('invalid_import_format', '导出内容为空。');
  return documents.length === 1 && object(documents[0].snapshot)
    ? normalizeOld2(documents[0], limits) : normalizeOld3(documents, limits);
}

function unique(rows, kind, limits) {
  if (rows.length > limits.maxRows) fail('import_record_limit', '导出记录过多。');
  const map = new Map();
  for (const row of rows) {
    if (!object(row) || !validId(row.id) || map.has(row.id)) fail('invalid_import_identity', '导出记录身份缺失或重复：' + kind);
    map.set(row.id, row);
  }
  return map;
}
function scopeOf(scope, fallback, old3Kind) {
  const result={global:false,sourceConversationId:fallback||null,supported:false};
  // Actual old3 saveMethod has no scope field; its appliesTo/doesNotApplyTo
  // strings define guidance applicability. Its current consumer is global.
  if(old3Kind==='methods'&&scope===undefined)return {...result,global:true,sourceConversationId:null,supported:true};
  if(old3Kind){
    if(!object(scope)||Object.keys(scope).some(key=>!['conversationId','topics'].includes(key))||
      scope.conversationId!==undefined&&!validId(scope.conversationId)||scope.topics!==undefined&&(!Array.isArray(scope.topics)||
        scope.topics.length>UNDERSTANDING_SCHEMA.properties.topics.maxItems||scope.topics.some(x=>typeof x!=='string'||!x||x.length>UNDERSTANDING_SCHEMA.properties.topics.items.maxLength)))return result;
    return {global:!scope.conversationId,sourceConversationId:scope.conversationId||null,supported:true,
      ...(scope.topics?.length?{topics:scope.topics}:{})};
  }
  if(scope==='global'||object(scope)&&scope.type==='global'&&Object.keys(scope).every(k=>k==='type'))return {...result,global:true,sourceConversationId:null,supported:true};
  if(object(scope)&&['run','task'].includes(scope.type)&&validId(scope.id)&&Object.keys(scope).every(k=>['type','id'].includes(k)))
    return {...result,sourceConversationId:scope.type==='task'?'task:'+scope.id:scope.id,supported:true};
  return result;
}
function scopes(sources, conversations, limits) {
  const groups = new Map();
  for (const source of sources) {
    const id = source.sourceConversationId;
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, {sourceConversationId:id,title:String(conversations.get(id)?.title || '').slice(0,120),preview:source.content.slice(0,240),messageCount:0});
    groups.get(id).messageCount++;
  }
  if (groups.size > limits.maxScopes) fail('import_scope_limit', '旧交流数量超过本次上限。');
  return [...groups.values()];
}
function normalizedRecord(kind, row, reasonCodes, sourceIds, scope, fields = {}) {
  return {id:kind+':'+row.id,kind,originalId:row.id,original:row,sourceIds,scope,
    eligibility:reasonCodes.length ? 'needs_review' : 'enabled',reasonCodes,...fields};
}

function normalizeOld2(document, limits) {
  const snapshot = document.snapshot, runs = unique(values(snapshot.runs),'runs',limits);
  const events = unique(values(snapshot.eventLog),'events',limits), sources = [], sourceAliases = new Map();
  for (const run of runs.values()) {
    // Old2's ordinary sessionId is the literal "continuous", not a proof that
    // distinct runs belong to one conversation. Preserve separate run groups.
    const group = run.id;
    for (const [role,field,type] of [['user','request','user/message'],['assistant','answer','main.answer']]) {
      if (typeof run[field] !== 'string' || !run[field].trim()) continue;
      const matches = [...events.values()].filter(event => event.runId === run.id && event.type === type);
      const event = matches.length === 1 ? matches[0] : null;
      const eventBody = event?.payload?.[field] ?? event?.payload?.text ?? event?.payload?.content ?? event?.payload?.detail;
      const verified = event && eventBody === run[field] && event.actor?.verified === true && event.actor.kind === (role === 'user' ? 'user' : 'agent') && positive(event.version);
      const originalId = verified ? event.id : run.id+':'+field;
      const source = {id:'events:'+originalId,originalId,role,content:run[field],sourceConversationId:group,
        occurredAt:event?.occurredAt || run.createdAt || run.startedAt || null,
        available:!unavailable(event || {}) && !unavailable(run) && run.invalidated!==true,
        original:verified ? event : {runId:run.id,field,status:run.status ?? null,error:run.error ?? null,answerValid:run.answerValid ?? null},
        originalVersion:verified ? event.version : null,provenance:{kind:'legacy2_original',runId:run.id,field,verifiedEvent:Boolean(verified)}};
      sources.push(source);
      if (verified) sourceAliases.set(event.id,source);
    }
  }
  if (!sources.length) fail('empty_import', '未找到完整保存的旧原话。');
  if (sources.length > limits.maxRows) fail('import_record_limit', '旧原话数量超过上限。');
  const records = [];
  for (const state of unique(values(snapshot.states),'states',limits).values()) {
    const reasons = [], refs = [], scope = scopeOf(state.scope,state.sourceRunId);
    if (typeof state.text !== 'string' || !state.text.trim() || !positive(state.revision) || state.status !== 'active' || (state.verification?.status ?? state.verification) !== 'supported' || state.expiresAt || unavailable(state)) reasons.push('old_state_not_current');
    if(!scope.supported)reasons.push('scope_unsupported');
    if (!Array.isArray(state.evidence) || !state.evidence.length || state.derivedFrom?.length) reasons.push('source_closure_unproven');
    for (const ref of state.evidence || []) {
      const source = sourceAliases.get(ref.eventId);
      if (!source || !source.available || source.originalVersion !== ref.version || typeof ref.quote !== 'string' || !ref.quote || !source.content.includes(ref.quote)) { reasons.push('source_reference_unproven'); continue; }
      if (ref.startCharacter !== undefined || ref.endCharacter !== undefined) {
        const boundary=index=>index===0||index===source.content.length||!(/[\uD800-\uDBFF]/.test(source.content[index-1])&&/[\uDC00-\uDFFF]/.test(source.content[index]));
        if (!nonnegative(ref.startCharacter) || !positive(ref.endCharacter) || ref.endCharacter>source.content.length ||
            !boundary(ref.startCharacter)||!boundary(ref.endCharacter)||source.content.slice(ref.startCharacter,ref.endCharacter) !== ref.quote) reasons.push('source_range_mismatch');
      }
      if(state.basis==='user' && (source.role!=='user'||!userQuote(source.content,ref.quote)))reasons.push('user_authored_range_unproven');
      refs.push(source.id);
    }
    records.push(normalizedRecord('understandings',state,[...new Set(reasons)],[...new Set(refs)],scope,
      {content:(state.text || '')+(typeof state.applicability==='string'&&state.applicability?'\n适用条件：'+state.applicability:''),claimType:'inference',version:positive(state.revision)?state.revision:null}));
  }
  for (const task of unique(values(snapshot.tasks),'tasks',limits).values()) records.push(normalizedRecord('tasks',task,
    ['old_tasks_history_only'],[],scopeOf('conversation',null),{eligibility:'history',content:typeof task.goal==='string'?task.goal:typeof task.title==='string'?task.title:''}));
  return {format:'arcfold2-database-snapshot',sources,records,sourceScopes:scopes(sources,new Map(),limits),
    provenance:{version:document.version ?? null,schemaVersion:snapshot.schemaVersion ?? null,revision:snapshot.revision ?? null,runCount:runs.size},
    history:[...runs.values()].map(record => ({kind:'runs',record}))};
}

// Old2's Codex annotation packet contains quoted assistant text. Only its
// explicit request suffix is user-authored; ordinary source text is intact.
function userQuote(text,quote){
  if(!/<\/?response-annotations\b|^\s*#{1,6}\s*(?:Response annotations|My request)\s*:/im.test(text))return text.includes(quote);
  const opens=[...text.matchAll(/<response-annotations>/g)],closes=[...text.matchAll(/<\/response-annotations>/g)],headers=[...text.matchAll(/^## My request:[\t ]*(?:\r?\n|$)/gm)];
  if(opens.length!==1||closes.length!==1||headers.length!==1||opens[0].index>=closes[0].index||closes[0].index+closes[0][0].length>headers[0].index||!/^\s*# Response annotations:[^]*$/.test(text.slice(0,opens[0].index)))return false;
  try{const rows=JSON.parse(text.slice(opens[0].index+opens[0][0].length,closes[0].index));if(!Array.isArray(rows)||rows.some(row=>!object(row)||typeof row.text!=='string'))return false;}catch{return false;}
  const body=text.slice(headers[0].index+headers[0][0].length);
  return Boolean(body.trim())&&!/<\/?response-annotations\b|^\s*#{1,6}\s*(?:Response annotations|My request)\s*:/im.test(body)&&body.includes(quote);
}

const old3Kinds = new Set(['events','conversations','understandings','methods','goals','opportunities','adoptions','audit','feedback','deliveries','imports','source_controls']);
const excludedBusinessKeys = /^(?:config|settings|credentials?|secrets?|password|api[_-]?key|env|environment|transport|authorization|budget(?:_settings|_requests)?|jobs|leases|sourceSnapshot)$/i;
function assertBusinessProjection(value) {
  if(!value||typeof value!=='object')return;
  for(const [key,item]of Object.entries(value)){
    if(excludedBusinessKeys.test(key))fail('invalid_import_export','业务导出不能携带运行配置、凭据、费用或旧数据库快照。');
    assertBusinessProjection(item);
  }
}
function normalizeOld3(documents, limits) {
  const header = documents[0], footer = documents.at(-1), rows = documents.slice(1,-1);
  if (header?.type !== 'header' || header.format !== 'arcfold-legacy3-business-export-v1' || !validId(header.exportId) ||
      header.schemaVersion !== 2 || !nonnegative(header.mutationSequence) || !Array.isArray(header.collections) ||
      header.collections.some(kind => !old3Kinds.has(kind)) || new Set(header.collections).size !== header.collections.length ||
      header.collections.length !== old3Kinds.size || ![...old3Kinds].every(kind => header.collections.includes(kind)) ||
      footer?.type !== 'footer' || footer.complete !== true || footer.digest !== importDigest(rows))
    fail('invalid_import_export', '旧3导出缺少完整头、结束记录或内容摘要。');
  assertBusinessProjection(header);
  const tables = new Map(header.collections.map(kind=>[kind,[]]));
  for (const row of rows) {
    if (row?.type !== 'record' || !tables.has(row.kind) || !object(row.record)) fail('invalid_import_export','旧3导出包含未声明的记录类别。');
    assertBusinessProjection(row.record);
    tables.get(row.kind).push(row.record);
  }
  const maps = new Map();
  for (const [kind,items] of tables) {
    if (footer.counts?.[kind] !== items.length) fail('invalid_import_export','旧3导出记录计数不符。');
    maps.set(kind,unique(items,kind,limits));
  }
  if (rows.length > limits.maxRows || Object.keys(footer.counts || {}).length !== tables.size) fail('import_record_limit','导出记录计数超出合同。');
  const get = (kind,id) => maps.get(kind)?.get(id), sourceList = [], sourceMap = new Map();
  for (const row of maps.get('events').values()) {
    if (typeof row.content !== 'string' || typeof row.role!=='string' || !row.role || row.role.length>100)
      fail('invalid_import_source','旧3原话缺少准确角色、正文或版本。');
    const control = get('source_controls',row.id);
    const source = {id:'events:'+row.id,originalId:row.id,role:row.role,content:row.content,
      sourceConversationId:validId(row.conversationId)?row.conversationId:null,occurredAt:row.occurredAt ?? null,
      available:['user','assistant','tool','system','material'].includes(row.role) && positive(row.revision) && !unavailable(row) && !unavailable(control || {}) && positive(row.createdSequence) && positive(row.updatedSequence) &&
        row.createdSequence<=row.updatedSequence && row.updatedSequence<=header.mutationSequence,
      original:row,originalVersion:positive(row.revision)?row.revision:null,
      provenance:{kind:'legacy3_original',exportId:header.exportId,originalProvenance:row.provenance ?? null}};
    sourceList.push(source);sourceMap.set(row.id,source);
  }
  const validation = new Map();
  function qualify(kind,row,path=new Set()) {
    const key=kind+':'+row.id;
    if (validation.has(key)) return validation.get(key);
    const reasons=[];
    if (path.has(key)) return ['source_cycle'];
    const next=new Set([...path,key]);
    if(kind==='understandings'&&row.status!=='active')reasons.push('old_record_not_current');
    if (unavailable(row) || !positive(row.revision) || !positive(row.version) ||
        !positive(row.createdSequence) || !positive(row.updatedSequence) || row.updatedSequence>header.mutationSequence || row.createdSequence>row.updatedSequence)
      reasons.push('old_record_not_current');
    if (!Array.isArray(row.sourceIds) || !row.sourceIds.length || !Array.isArray(row.dependencies)) reasons.push('source_closure_unproven');
    for (const id of row.sourceIds || []) {
      const source=sourceMap.get(id);
      if (!source?.available) reasons.push('source_unavailable');
      if(!source || !(row.dependencies || []).some(ref=>ref.id===id && (ref.kind===undefined || ref.kind==='events') && ref.revision===source.originalVersion))
        reasons.push('source_revision_unproven');
    }
    for (const ref of row.dependencies || []) {
      const depKind=ref.kind || ['events','understandings','methods'].find(k=>get(k,ref.id)), dep=get(depKind,ref.id);
      if (!dep || !['events','understandings','methods'].includes(depKind) || dep.revision!==ref.revision || unavailable(dep) || dep.status==='paused' ||
          depKind==='events' && !sourceMap.get(dep.id)?.available) reasons.push('dependency_version_unproven');
      else if (depKind!=='events') reasons.push(...qualify(depKind,dep,next));
    }
    validation.set(key,[...new Set(reasons)]);return validation.get(key);
  }
  const records=[];
  for (const kind of ['understandings','methods','goals','opportunities']) for (const row of maps.get(kind)?.values() || []) {
    const reasons=[...qualify(kind,row)], scope=scopeOf(row.scope,row.conversationId,kind);
    if(!scope.supported)reasons.push('scope_unsupported');
    let eligibility='enabled', usage;
    if(kind==='understandings'&&(typeof row.content!=='string'||!row.content.trim()))reasons.push('old_record_not_current');
    if (kind==='methods') {
      if (!['title','guidance','appliesTo','doesNotApplyTo'].every(key=>importMethodField(row,key)!==null) ||
          !['trial','paused','active'].includes(row.status)) reasons.push('method_contract_unproven');
      if (!nonnegative(row.trialUses) || !positive(row.maxTrialUses)) reasons.push('method_trial_basis_unknown');
      else {
        const trial=[];let valid=true;
        for (const adoption of maps.get('adoptions')?.values() || []) for (const selected of adoption.selectedVersions || []) {
          if(selected.id!==row.id)continue;
          if(!positive(adoption.revision)||!positive(adoption.createdSequence)||!positive(adoption.updatedSequence)||
            adoption.createdSequence>adoption.updatedSequence||adoption.updatedSequence>header.mutationSequence)valid=false;
          if(!positive(selected.semanticVersion ?? selected.version) || !positive(selected.revision)){valid=false;continue;}
          if ((selected.semanticVersion ?? selected.version)!==row.version) continue;
          if(selected.revision>row.revision)valid=false;
          if (selected.trialUse!==null) { if(!positive(selected.trialUse)) valid=false;else trial.push(selected.trialUse); }
        }
        if (!valid || trial.length!==row.trialUses || new Set(trial).size!==trial.length || trial.some(n=>n>row.trialUses)) reasons.push('method_trial_history_mismatch');
        else usage={trialUses:row.trialUses,maxTrialUses:row.maxTrialUses,remaining:Math.max(0,row.maxTrialUses-row.trialUses),status:row.status};
      }
      if (row.status==='active' && (!sourceMap.get(row.activationSourceId)?.available || !activeProof(row,get,[...(maps.get('audit')?.values() || [])],header.mutationSequence))) reasons.push('method_active_authority_unproven');
      eligibility=row.status==='paused'?'paused':row.status==='trial'?'trial':'enabled';
    }
    // Historical user goal controls and preparation states are never revived.
    if (['goals','opportunities'].includes(kind)) { reasons.push('historical_control_not_migrated');eligibility='history'; }
    const originals=[...(row.sourceIds || [])];
    if(kind==='methods'&&row.status==='active'&&sourceMap.has(row.activationSourceId)&&!originals.includes(row.activationSourceId))originals.push(row.activationSourceId);
    records.push(normalizedRecord(kind,row,[...new Set(reasons)],originals.map(id=>'events:'+id),scope,
      {eligibility:reasons.length && eligibility!=='history'?'needs_review':eligibility,
        content:[row.content,row.guidance,row.outcome,row.description].find(value=>typeof value==='string')??'',version:row.version ?? null,
        ...(usage?{methodUsage:usage}:{})}));
  }
  return {format:header.format,sources:sourceList,records,sourceScopes:scopes(sourceList,maps.get('conversations') || new Map(),limits),
    provenance:header,history:rows.filter(row=>!['events','understandings','methods','goals','opportunities'].includes(row.kind)).map(row=>({kind:row.kind,record:row.record}))};
}
function activeProof(method,get,audits,cutoff) {
  const source=get('events',method.activationSourceId), p=source?.provenance;
  if (!source || source.role!=='user' || !source.content?.trim() || unavailable(source) || p?.kind!=='explicit_method_authorization' || p.interaction!=='method_activation' ||
      p.methodId!==method.id || p.methodVersion!==method.version || !positive(p.methodRevision) ||
      p.appliesTo!==method.appliesTo || p.doesNotApplyTo!==method.doesNotApplyTo || method.validated!==false || method.revision<p.methodRevision+1) return false;
  return audits.some(audit=>audit.action==='user_method_activation' && audit.kind==='methods' && audit.recordId===method.id &&
    audit.sourceId===source.id && positive(audit.createdSequence) && positive(audit.updatedSequence) && audit.createdSequence<=audit.updatedSequence && audit.updatedSequence<=cutoff &&
    audit.before?.id===method.id && audit.after?.id===method.id && ['trial','paused'].includes(audit.before?.status) &&
    audit.before?.revision===p.methodRevision && audit.after?.revision===p.methodRevision+1 &&
    audit.after?.status==='active' && audit.after?.validated===false && audit.after?.activationSourceId===source.id &&
    ['title','guidance','appliesTo','doesNotApplyTo','version','sourceIds','dependencies','scope'].every(key=>
      canonicalJson(audit.before?.[key] ?? null)===canonicalJson(method[key] ?? null) &&
      canonicalJson(audit.after?.[key] ?? null)===canonicalJson(method[key] ?? null)));
}
