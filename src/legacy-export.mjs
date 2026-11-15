// Legacy3 writers: store.mjs; service.mjs; importer.mjs; context.mjs;
// execution.mjs; learning.mjs; tools.mjs; read-coverage.mjs (2026-11-05 source).
// This is a finite projection, never a general database dump or old Store boot.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, closeSync, createReadStream, fstatSync, fsyncSync, linkSync, lstatSync,
  mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from './store.mjs';
import { IMPORT_LIMITS, importDigest, readLegacyImport } from './legacy-import-source.mjs';

export const LEGACY_EXPORT_VERSION = 'legacy3-finite-projection-v1';
export const LEGACY_COLLECTIONS = Object.freeze('events conversations understandings methods goals opportunities adoptions audit feedback deliveries imports source_controls'.split(' '));
const scalar = 'scalar', array = item => ({ item }), object = (fields, strict = false) => ({ fields, strict });
const fields = names => Object.fromEntries(names.split(' ').filter(Boolean).map(name => [name, scalar]));
const ids = array(scalar), refs = array(object(fields('kind id revision'), true));
const common = fields('id revision createdAt updatedAt createdSequence updatedSequence sequenceEstablishedBy status deleted withdrawn useProhibited withdrawalReason');
const scope = object({ ...fields('conversationId'), topics: ids }, true);
const sourcePackage = object(fields('id name product system version format path sha256 originalUntouched exportedAt'), true);
const original = object({ ...fields('sourceRunId kind role status answerValid originalTextSha256 credentialRedacted'),
  error: { scalarOrObject: object(fields('code message'), true) } }, true);
const provenance = object({ ...fields('kind type idempotencyKey deliveryId assessment interaction methodId methodRevision methodVersion appliesTo doesNotApplyTo goalId definitionVersion action importId sourceRunId originalOrdinal originalTimeKnown requestId name callId toolRecordId path fileSha256 documentSha256 offset totalChars url query contentAuthor userEndorsement artifactSourceId sha256 instructionAuthority'),
  importedOriginalSource: original, sourcePackage }, true);
const artifact = object({ ...fields('path sha256 bytes toolRecordId'), sourceIds: ids }, true);
const evidence = array(object({ ...fields('kind runId sourceId previousStatus previousRevision'), sourceIds: ids,
  scope: object(fields('appliesTo doesNotApplyTo'), true) }, true));
const method = object({ ...common, ...fields('title guidance appliesTo doesNotApplyTo origin proposedOrigin trialUses maxTrialUses version previousId learnedFromRunId signature validated authority pauseReason activationSourceId activationReason activatedAt changedByRunId feedbackId'),
  scope, sourceIds: ids, dependencies: refs, evidence, changeSourceIds: ids });
const understanding = object({ ...common, ...fields('content claimType proposedClaimType version previousId learnedFromRunId changedByRunId authority'),
  scope, sourceIds: ids, dependencies: refs, changeSourceIds: ids,
  claimTypeCheck: object(fields('version reason sourceId sourceRevision'), true) });
const goal = object({ ...common, ...fields('conversationId title outcome definitionVersion claimType contentAuthor userEndorsement learnedFromRunId updatedFromRunId'), scope,
  understandingIds: ids, sourceIds: ids, dependencies: refs,
  sourceInvalidation: object(fields('kind reason'), true),
  progress: object({ ...fields('content runId'), sourceIds: ids, dependencies: refs }, true),
  relations: array(object({ ...fields('type targetId targetDefinitionVersion reason'), sourceIds: ids, dependencies: refs }, true)),
  controlProposal: object({ ...fields('action definitionVersion claimType runId'), sourceIds: ids, dependencies: refs }, true),
  userControl: object(fields('action eventId definitionVersion at'), true) });
const coverage = object({ ...fields('version basis unit retrievalResults documentCount observationCount omittedDocuments omittedObservations'),
  documents: array(object({ ...fields('kind identity sha256 totalChars inconsistentMetadata displayedChars complete multipleVersions'), ranges: array(array(scalar)) }, true)),
  observations: array(object({ ...fields('kind tool callId code path returnedEntries scanCompleteWithinToolScope moreEntries returnedMatches morePossible reason'),
    skipped: object(fields('sensitive dependencies symlinks unavailable otherTypes'), true) }, true)) }, true);
const TABLES = {
  events: object({ ...common, ...fields('role content conversationId runId sourceRunId importId occurredAt'), provenance }),
  conversations: object({ ...common, ...fields('title importId') }), understandings: understanding, methods: method, goals: goal,
  opportunities: object({ ...common, ...fields('conversationId description rationale suggestedPreparation preparationStatus cancellationReason preparationRunId learnedFromRunId signature authority jobId preparedContent preparedAt'), sourceIds: ids, dependencies: refs, artifactIds: ids, preparationArtifact: artifact,
    preparationError: { scalarOrObject: object(fields('code message'), true) } }),
  adoptions: object({ ...common, ...fields('runId conversationId proof sourceDigest'), methodIds: ids, selectedMethodIds: ids,
    included: object({ understandingIds: ids, methodIds: ids, goalIds: ids }, true),
    declared: object({ understandingIds: ids, methodIds: ids,
      methodAssessments: array(object({ ...fields('methodId applicability reason'), sourceIds: ids }, true)),
      goalSelection: object({ ...fields('status goalId'), sourceIds: ids }, true) }, true),
    selectedVersions: array(object(fields('id semanticVersion version revision trialUse'), true)),
    goalRef: object({ ...fields('id revision definitionVersion'), sourceIds: ids }, true),
    behaviorEvidence: object({ ...fields('deliveryId opportunityId'), artifactIds: ids, toolRecordIds: ids, modelRequestIds: ids, preparationArtifact: artifact }, true),
    // The old writer creates [] and has no writer for outcome claims.
    outcomeEvidence: { emptyArray: true } }),
  audit: object({ ...common, ...fields('action kind recordId goalId commandId actor reason runId sourceId'), sourceIds: ids }),
  feedback: object({ ...common, ...fields('runId deliveryId sourceId content assessment') }),
  deliveries: object({ ...common, ...fields('runId conversationId inputEventId eventId content sourceDigest learningStatus readCoverageRequestId'), readCoverage: coverage }),
  imports: object({ ...common, ...fields('fingerprint conversationId messageCount oldUnderstandingCount note'), eventIds: ids, sourcePackage,
    sourceStatusCounts: object(fields('unknown queued pending running completed succeeded failed cancelled canceled aborted delivered ready invalid'), false),
    answerValidationCounts: object(fields('valid invalid unknown'), true) }),
};
const sha = value => createHash('sha256').update(value).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;
// SQL bounds every decoded text before it crosses the native/JS boundary.
// UTF-8 needs at most three bytes per valid UTF-16 code unit. JS retains the
// consumer's exact code-unit limit. The byte bound also covers text after NUL,
// where SQLite length(TEXT) stops; supplementary code points are checked in JS.
const boundedText = (value, limit) => `(typeof(${value})='text' AND length(CAST(${value} AS BLOB))<=${limit * 3} AND length(${value})<=${limit})`;
const decodeText = value => new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(value);

const assertExport = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };
const forbidden = /^(config|settings|credentials?|secrets?|password|api[_-]?key|env|environment|transport|authorization|budget(?:_settings|_requests)?|jobs|leases|sourceSnapshot)$/i;
const authorityKey = /(?:authority|authorization|permission|endorsement|control|provenance)/i;
const jsonPath = (path, key) => typeof key === 'number' ? `${path}[${key}]` : `${path}.${JSON.stringify(key)}`;
const fsyncDirectory = path => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
const jsonFile = (path, value) => { const fd = openSync(path, 'wx', 0o600); try { writeFileSync(fd, canonicalJson(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); } };
function identity(path) { const s = lstatSync(path); assertExport(s.isFile() && !s.isSymbolicLink(), 'export_source_not_regular'); return { dev: s.dev, ino: s.ino }; }
function sameSource(path, expected) { assert.deepEqual(identity(path), expected, 'export_source_replaced'); assert.equal(realpathSync(path), path, 'export_source_alias'); }
function canonical(path, existing) {
  assertExport(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'export_path_not_absolute');
  assertExport(realpathSync(existing ? path : dirname(path)) === (existing ? path : dirname(path)), 'export_path_alias');
  return path;
}
function schema(db) {
  for (const [name, expected] of Object.entries({
    records: [['kind','TEXT',1,1],['id','TEXT',1,2],['revision','INTEGER',1,0],['created_at','TEXT',1,0],['updated_at','TEXT',1,0],['body','TEXT',1,0]],
    store_meta: [['key','TEXT',0,1],['value','TEXT',1,0]],
  })) {
    const table = db.prepare('SELECT type FROM sqlite_schema WHERE name=?').get(name);
    assertExport(table?.type === 'table', 'export_schema_shape');
    assert.deepEqual(db.prepare(`PRAGMA table_info(${name})`).all().map(r => [r.name,r.type,r.notnull,r.pk]), expected, 'export_schema_shape');
  }
  const valid = boundedText('value',32);
  const meta = db.prepare(`SELECT key,${valid} AS valid,CASE WHEN ${valid} THEN CAST(value AS BLOB) END AS value FROM store_meta WHERE key IN ('schema_version','mutation_sequence')`).all();
  assertExport(meta.every(row=>row.valid===1),'export_schema_version');
  const values = Object.fromEntries(meta.map(r => [r.key,decodeText(r.value)]));
  assertExport(values.schema_version === '2' && /^(0|[1-9]\d*)$/.test(values.mutation_sequence ?? '') && Number.isSafeInteger(Number(values.mutation_sequence)), 'export_schema_version');
  return Number(values.mutation_sequence);
}

/** SQL only returns allowed scalar values, key/type metadata and finite array
 * indexes. It never returns body, a container value or an excluded atom to JS.
 * SQLite's own JSON scan is not claimed to have constant memory. */
function projector(db, excluded) {
  const queries = new Map(); let characters = 0, nodes = 0;
  function note(kind, path) {
    const key = canonicalJson([kind,path]);
    if(!excluded.has(key)) characters += key.length;
    assertExport(++nodes <= IMPORT_LIMITS.maxTokens && characters <= IMPORT_LIMITS.maxProjectionCharacters, 'export_projection_limit');
    excluded.set(key, (excluded.get(key) ?? 0) + 1);
  }
  function children(kind, id, path, shape) {
    const isArray = !!(shape.item || shape.emptyArray);
    const permitsScalar = item => item === scalar || !!item?.scalarOrObject;
    const scalarKeys = isArray ? [] : Object.keys(shape.fields).filter(key=>permitsScalar(shape.fields[key]));
    const key = canonicalJson(shape);
    let query = queries.get(key);
    if (!query) {
      const keyValid = isArray ? `(typeof(key)='integer' AND key>=0 AND key<${IMPORT_LIMITS.maxRows})` : boundedText('key',IMPORT_LIMITS.maxKeyCharacters);
      const textValid = `(type!='text' OR ${boundedText('atom',IMPORT_LIMITS.maxStringCharacters)})`;
      const selected = isArray ? (permitsScalar(shape.item)?'1':'0') : `key IN (${scalarKeys.map(()=>'?').join(',') || 'NULL'})`;
      query = db.prepare(`SELECT ${keyValid} AS keyValid,
        CASE WHEN ${keyValid} THEN ${isArray?'key':'CAST(key AS BLOB)'} END AS key,type,${textValid} AS textValid,
        CASE WHEN ${keyValid} AND ${selected} AND ${textValid} AND type NOT IN ('object','array')
          THEN CASE WHEN type='text' THEN CAST(atom AS BLOB) ELSE atom END END AS value
        FROM records,json_each(records.body,?) WHERE records.kind=? AND records.id=?`);
      queries.set(key,query);
    }
    return query.iterate(...scalarKeys,path,kind,id);
  }
  function project(kind, id, path, shape, type = 'object', atom, textValid = 1) {
    assertExport(++nodes <= IMPORT_LIMITS.maxTokens, 'export_structure_limit');
    if (type === 'null') return null;
    if (shape.scalarOrObject && !['object','array'].includes(type)) return project(kind,id,path,scalar,type,atom,textValid);
    if (shape.scalarOrObject) shape = shape.scalarOrObject;
    if (shape === scalar) {
      assertExport(!['object','array'].includes(type), 'export_unsupported_shape');
      if (type === 'text') { assertExport(textValid === 1, 'export_string_limit'); atom=decodeText(atom); assertExport(atom.length <= IMPORT_LIMITS.maxStringCharacters, 'export_string_limit'); characters += atom.length; }
      else assertExport(['integer','real','true','false'].includes(type) && (typeof atom !== 'number' || Number.isFinite(atom)), 'export_scalar_shape');
      assertExport(characters <= IMPORT_LIMITS.maxProjectionCharacters, 'export_projection_limit');
      return type === 'true' ? true : type === 'false' ? false : atom;
    }
    if (shape.item || shape.emptyArray) {
      assertExport(type === 'array', 'export_unsupported_shape');
      const result = [], seen = new Set();
      for (const entry of children(kind,id,path,shape)) {
        assertExport(entry.keyValid === 1 && !shape.emptyArray && entry.key === result.length && !seen.has(entry.key) && result.length < IMPORT_LIMITS.maxRows, 'export_array_shape');
        seen.add(entry.key); result.push(project(kind,id,jsonPath(path,entry.key),shape.item,entry.type,entry.value,entry.textValid));
      }
      return result;
    }
    assertExport(type === 'object' && shape.fields, 'export_unsupported_shape');
    const result = {}, seen = new Set();
    for (const entry of children(kind,id,path,shape)) {
      assertExport(entry.keyValid === 1,'export_object_shape');
      entry.key=decodeText(entry.key);
      assertExport(typeof entry.key === 'string' && entry.key.length <= IMPORT_LIMITS.maxKeyCharacters && !seen.has(entry.key) && seen.size < IMPORT_LIMITS.maxRows, 'export_object_shape');
      seen.add(entry.key);
      assertExport(++nodes <= IMPORT_LIMITS.maxTokens,'export_structure_limit');
      const next = jsonPath(path,entry.key);
      if (!Object.hasOwn(shape.fields,entry.key)) {
        assertExport(!shape.strict && !authorityKey.test(entry.key), 'export_unknown_authority_shape');
        note(kind,next); continue;
      }
      assertExport(!forbidden.test(entry.key), 'export_excluded_field');
      Object.defineProperty(result,entry.key,{ value: project(kind,id,next,shape.fields[entry.key],entry.type,entry.value,entry.textValid), enumerable:true, writable:true, configurable:true });
    }
    if(shape === provenance) {
      const knownKinds=['direct_user','explicit_feedback','explicit_method_authorization','direct_goal_control','imported_original'];
      const knownTypes=['delivered_answer','tool_receipt','file','file_search','url','artifact'];
      assertExport((knownKinds.includes(result.kind) && result.type === undefined) ||
        (knownTypes.includes(result.type) && result.kind === undefined), 'export_unknown_provenance');
    }
    return result;
  }
  return { project };
}
function checkRow(row, columns, cutoff) {
  for (const [body,column] of [['id','id'],['revision','revision'],['createdAt','created_at'],['updatedAt','updated_at']])
    assertExport(row[body] === columns[column], 'export_column_body_mismatch');
  assertExport(typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 512 && positive(row.revision) &&
    positive(row.createdSequence) && positive(row.updatedSequence) && row.createdSequence <= row.updatedSequence && row.updatedSequence <= cutoff,
  'export_record_identity');
}
function referenceGaps(rows) {
  const maps = new Map(LEGACY_COLLECTIONS.map(kind => [kind,new Map()]));
  for (const {kind,record} of rows) maps.get(kind).set(record.id,record);
  const gaps = [], seen = new Set();
  function ref(owner,path,kind,id,revision) {
    if (typeof id !== 'string' || !id) return;
    const target = maps.get(kind)?.get(id), reason = !maps.has(kind) ? 'intentionally_excluded' : !target ? 'missing' : revision !== undefined && target.revision !== revision ? 'revision_mismatch' : null;
    if (reason) { const gap={kind:owner.kind,id:owner.record.id,path,targetKind:kind,targetId:id,reason,...(revision===undefined?{}:{expectedRevision:revision}),...(target?{actualRevision:target.revision}:{})};
      const key=canonicalJson(gap); if(!seen.has(key)){seen.add(key);gaps.push(gap);} }
  }
  function scan(owner,value,path='$') {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((item,i)=>scan(owner,item,`${path}[${i}]`)); return; }
    for (const [key,item] of Object.entries(value)) {
      const at=jsonPath(path,key);
      if (key==='dependencies' && Array.isArray(item)) for (const d of item) ref(owner,at,d.kind || 'events',d.id,d.revision);
      else if (['sourceIds','changeSourceIds','eventIds','artifactIds'].includes(key) && Array.isArray(item)) for(const id of item) ref(owner,at,'events',id);
      else if (['understandingIds','methodIds','selectedMethodIds','goalIds'].includes(key) && Array.isArray(item)) for(const id of item) ref(owner,at,key==='understandingIds'?'understandings':key==='goalIds'?'goals':'methods',id);
      else if (key==='selectedVersions' && Array.isArray(item)) for(const v of item) ref(owner,at,'methods',v.id); // historical revision is not the current version
      else if (['sourceId','artifactSourceId','activationSourceId','inputEventId','eventId','feedbackId'].includes(key)) ref(owner,at,'events',item);
      else if (key==='previousId') ref(owner,at,owner.kind==='audit'?(owner.record.kind || (owner.record.goalId?'goals':'audit')):owner.kind,item);
      else if (key==='recordId' && owner.kind==='audit' && owner.record.kind) ref(owner,at,owner.record.kind,item);
      else if (key==='goalId') ref(owner,at,'goals',item);
      else if (key==='methodId') ref(owner,at,'methods',item);
      else if (key==='importId') ref(owner,at,'imports',item);
      else if (key==='goalRef' && item) ref(owner,at,'goals',item.id);
      else if (key==='conversationId') ref(owner,at,'conversations',item);
      else if (key==='targetId' && path.includes('relations')) ref(owner,at,'goals',item);
      else if (key==='deliveryId') ref(owner,at,'deliveries',item);
      else if (key==='opportunityId') ref(owner,at,'opportunities',item);
      else if (['runId','sourceRunId','learnedFromRunId','updatedFromRunId','changedByRunId','preparationRunId','jobId'].includes(key)) ref(owner,at,key==='sourceRunId'&&owner.record.provenance?.kind==='imported_original'?'legacy_runs':'jobs',item);
      else if (key==='toolRecordId') ref(owner,at,'tool_calls',item);
      else if (['toolRecordIds','modelRequestIds'].includes(key) && Array.isArray(item)) for(const id of item) ref(owner,at,key==='toolRecordIds'?'tool_calls':'model_calls',id);
      scan(owner,item,at);
    }
  }
  for(const row of rows) scan(row,row.record);
  return gaps;
}

/** onProgress is an optional local observation hook, never a CLI/config flag;
 * it receives no connection or source data and cannot change the projection.
 * It permits real process-interruption/concurrent-writer boundary tests. */
export async function exportLegacy3({ sourceDb, output, signal, onProgress } = {}) {
  canonical(sourceDb,true); canonical(output,false);
  const expected = identity(sourceDb);
  try { lstatSync(output); throw Object.assign(new Error('export_output_exists'),{code:'export_output_exists'}); }
  catch(error) { if(error.code!=='ENOENT') throw error; }
  assertExport(!['','-wal','-shm','-journal'].some(suffix=>output===sourceDb+suffix), 'export_output_alias');
  const attempt = mkdtempSync(join(dirname(output),'.arcfold-export-'));
  const producer = { version:LEGACY_EXPORT_VERSION,sha256:sha(readFileSync(fileURLToPath(import.meta.url))),
    consumerSha256:sha(readFileSync(new URL('./legacy-import-source.mjs',import.meta.url))),
    contractsSha256:sha(readFileSync(new URL('./learning-contracts.mjs',import.meta.url))),
    canonicalSourceSha256:sha(readFileSync(new URL('./store.mjs',import.meta.url))) };
  let db, sourceFd, spoolFd, completeFd, published=false, receipt;
  const progress = async phase => { signal?.throwIfAborted(); jsonFile(join(attempt,phase+'.json'),{phase}); await onProgress?.(Object.freeze({phase,attempt})); signal?.throwIfAborted(); };
  try {
    sourceFd=openSync(sourceDb,constants.O_RDONLY | constants.O_NOFOLLOW);
    assert.deepEqual({dev:fstatSync(sourceFd).dev,ino:fstatSync(sourceFd).ino},expected);
    jsonFile(join(attempt,'started.json'),{source:{path:sourceDb,...expected},output,producer});
    sameSource(sourceDb,expected);
    db = new DatabaseSync(sourceDb,{readOnly:true});
    db.exec('PRAGMA query_only=ON; BEGIN');
    const cutoff=schema(db),sqliteVersion=db.prepare('SELECT sqlite_version() AS version').get().version;
    assertExport(!db.prepare(`SELECT 1 FROM records WHERE NOT (${boundedText('kind',IMPORT_LIMITS.maxKeyCharacters)} AND ${boundedText('id',512)}) LIMIT 1`).get(),'export_record_identity');
    assertExport(db.prepare('SELECT COUNT(DISTINCT kind) AS count FROM records').get().count <= IMPORT_LIMITS.maxRows,'export_structure_limit');
    const kindCounts=db.prepare('SELECT CAST(kind AS BLOB) AS kind,COUNT(*) AS count FROM records GROUP BY kind ORDER BY kind').all().map(row=>({...row,kind:decodeText(row.kind)}));
    const counts=Object.fromEntries(LEGACY_COLLECTIONS.map(kind=>[kind,kindCounts.find(r=>r.kind===kind)?.count ?? 0]));
    assertExport(counts.source_controls===0,'export_unsupported_source_controls');
    assertExport(Object.values(counts).reduce((a,b)=>a+b,0)<=IMPORT_LIMITS.maxRows,'export_record_limit');
    const excludedKinds=kindCounts.filter(row=>!LEGACY_COLLECTIONS.includes(row.kind)).map(row=>({kind:row.kind,count:row.count}));
    await progress('snapshot');
    const excludedPaths=new Map(), {project}=projector(db,excludedPaths), rows=[];
    spoolFd=openSync(join(attempt,'rows.jsonl'),'wx',0o600);
    const rowHash=createHash('sha256').update('['); let first=true;
    for(const kind of LEGACY_COLLECTIONS) {
      const createdValid=boundedText('created_at',IMPORT_LIMITS.maxStringCharacters),updatedValid=boundedText('updated_at',IMPORT_LIMITS.maxStringCharacters);
      const query=db.prepare(`SELECT CAST(id AS BLOB) AS id,CASE WHEN typeof(revision)='integer' AND revision>0 AND revision<=9007199254740991 THEN revision END AS revision,
        ${createdValid} AND ${updatedValid} AND typeof(revision)='integer' AND revision>0 AND revision<=9007199254740991 AS metadataValid,
        CASE WHEN ${createdValid} THEN CAST(created_at AS BLOB) END AS created_at,
        CASE WHEN ${updatedValid} THEN CAST(updated_at AS BLOB) END AS updated_at,
        json_valid(body) AS valid,json_type(body) AS type FROM records WHERE kind=? ORDER BY id COLLATE BINARY`);
      for(const columns of query.iterate(kind)) {
        signal?.throwIfAborted(); assertExport(columns.valid===1&&columns.type==='object','export_record_shape');
        assertExport(columns.metadataValid===1,'export_record_identity');
        for(const key of ['id','created_at','updated_at']) columns[key]=decodeText(columns[key]);
        let shape=TABLES[kind];
        if(kind==='audit') {
          const tag = name => {
            const path=`'$.${name}'`,type=`json_type(body,${path})`,value=`json_extract(body,${path})`;
            const valid=`(${type} IS NULL OR ${type}='null' OR (${type}='text' AND ${boundedText(value,IMPORT_LIMITS.maxStringCharacters)}))`;
            return `${valid} AS ${name}Valid,CASE WHEN ${valid} AND ${type}='text' THEN CAST(${value} AS BLOB) END AS ${name}`;
          };
          const tags=db.prepare(`SELECT ${tag('kind')},${tag('goalId')} FROM records WHERE kind='audit' AND id=?`).get(columns.id);
          assertExport(tags.kindValid===1&&tags.goalIdValid===1,'export_audit_target_shape');
          const target=tags.kind===null ? tags.goalId!==null && decodeText(tags.goalId) ? 'goals' : null : decodeText(tags.kind);
          // Only known business snapshots; jobs/config audit bodies stay inside SQLite.
          shape=object({...TABLES.audit.fields,...(TABLES[target] && !['audit','imports'].includes(target)?{before:TABLES[target],after:TABLES[target]}:{})});
        }
        const row=project(kind,columns.id,'$',shape); checkRow(row,columns,cutoff);
        const envelope={type:'record',kind,record:row}, text=canonicalJson(envelope);
        rowHash.update((first?'':',')+text);first=false;writeSync(spoolFd,text+'\n');rows.push(envelope);
      }
      assertExport(rows.filter(row=>row.kind===kind).length===counts[kind],'export_count_changed');
    }
    fsyncSync(spoolFd); closeSync(spoolFd);spoolFd=undefined;
    const digest=rowHash.update(']').digest('hex');
    const excluded={kinds:excludedKinds,paths:[...excludedPaths].map(([key,count])=>{const[kind,path]=JSON.parse(key);return{kind,path,count};}).sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b)))};
    const gaps=referenceGaps(rows);
    const snapshotDigest=importDigest({projection:LEGACY_EXPORT_VERSION,schemaVersion:2,mutationSequence:cutoff,digest});
    const header={type:'header',format:'arcfold-legacy3-business-export-v1',exportId:'legacy3-'+snapshotDigest,
      exporter:producer,source:{snapshotDigest,identity:'business_snapshot_not_persistent_lineage_or_authorship'},
      schemaVersion:2,mutationSequence:cutoff,collections:LEGACY_COLLECTIONS,excluded};
    const footer={type:'footer',complete:true,counts,digest};
    sameSource(sourceDb,expected); db.exec('COMMIT');db.close();db=undefined;
    await progress('projected');
    completeFd=openSync(join(attempt,'complete.jsonl'),'wx',0o600);
    writeSync(completeFd,canonicalJson(header)+'\n');
    for await(const chunk of createReadStream(join(attempt,'rows.jsonl'),{highWaterMark:65536})) { signal?.throwIfAborted();writeSync(completeFd,chunk); }
    await progress('before-footer');
    writeSync(completeFd,canonicalJson(footer)+'\n');fsyncSync(completeFd);closeSync(completeFd);completeFd=undefined;
    const fileHash=createHash('sha256');let bytes=0;
    for await(const chunk of createReadStream(join(attempt,'complete.jsonl'),{highWaterMark:65536})) { bytes+=chunk.length;fileHash.update(chunk);assertExport(bytes<=IMPORT_LIMITS.maxFileBytes,'export_file_limit'); }
    const fileSha256=fileHash.digest('hex');
    // The existing consumer remains the single final capacity/format authority.
    await readLegacyImport({stream:createReadStream(join(attempt,'complete.jsonl'),{highWaterMark:IMPORT_LIMITS.maxChunkBytes}),expectedBytes:bytes,expectedSha256:fileSha256,signal});
    receipt={schema:'arcfold-legacy3-export-receipt-v1',source:{path:sourceDb,...expected,sqliteVersion},producer,
      schemaVersion:2,mutationSequence:cutoff,snapshotDigest,counts,excluded,referenceGaps:gaps,output:{path:output,bytes,sha256:fileSha256},attempt};
    jsonFile(join(attempt,'validated.json'),receipt);
    await progress('before-publication');sameSource(sourceDb,expected);canonical(output,false);
    linkSync(join(attempt,'complete.jsonl'),output);published=true;fsyncDirectory(dirname(output));
    await progress('published');
    jsonFile(join(attempt,'receipt.json'),{...receipt,complete:true});fsyncDirectory(attempt);
    return {...receipt,complete:true};
  } catch(error) {
    // Never serialize arbitrary SQLite/source text or observer errors.
    try {jsonFile(join(attempt,'failure.json'),{complete:false,published,code:typeof error.code==='string'?error.code:'export_failed'});} catch { /* original failure remains */ }
    throw Object.assign(new Error('Legacy export failed; private attempt retained at ' + attempt,{cause:error}),{code:typeof error.code==='string'?error.code:'export_failed',attempt,published});
  } finally {
    if(spoolFd!==undefined)closeSync(spoolFd);if(completeFd!==undefined)closeSync(completeFd);
    try{db?.close();}finally{if(sourceFd!==undefined)closeSync(sourceFd);}
  }
}
