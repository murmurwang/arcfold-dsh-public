import { DomainError, canonicalJson, identity } from './store.mjs';
import { IMPORT_LIMITS, readLegacyImport, importDigest, textDigest, importMethodField } from './legacy-import-source.mjs';
import { invalidateDependents } from './learning-goals.mjs';
import { projectUnderstanding } from './learning-contracts.mjs';
import { usageForVersion } from './methods.mjs';
import { browseScope } from './browse-scope.mjs';

const fail = (code,message) => { throw new DomainError(code,message); };
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const usable = row => ['enabled','trial','paused'].includes(row.eligibility);
const safeErrors = new Set(['import_token_limit','import_depth_limit','import_key_limit','import_duplicate_key','import_number_limit',
  'invalid_import_file','import_chunk_limit','import_byte_limit','import_digest_mismatch','import_incomplete','invalid_import_json',
  'invalid_import_format','import_projection_limit','import_string_limit','import_record_limit','invalid_import_identity',
  'import_scope_limit','empty_import','invalid_import_export','invalid_import_source','import_scope_unknown']);
function page(rows,offset,limit) { return {items:rows.slice(offset,offset+limit),total:rows.length,nextOffset:offset+limit<rows.length?offset+limit:null}; }
function pagination(offset,limit,max) { if(!nonnegative(offset)||!positive(limit)||limit>max) fail('invalid_import_page','分页范围无效。'); }
function mapping(sessionId,scopeMap=[]) {
  if(!Array.isArray(scopeMap)||scopeMap.length>1) fail('invalid_import_scope','仅可选择一个旧交流。');
  return scopeMap.map(row=>{
    if(!row||Object.keys(row).sort().join(',')!=='sourceConversationId,targetSessionId'||row.targetSessionId!==sessionId)
      fail('invalid_import_scope','旧交流只能映射到当前主交流。');
    identity(row.sourceConversationId,'Old conversation');return {...row};
  });
}
const commandId = (op,sessionId,requestId) => 'import-command:'+importDigest([op,sessionId,requestId]);
const batchId = (sessionId,requestId) => 'import:'+importDigest([sessionId,requestId]);
const publicBatch = row => Object.fromEntries(['id','revision','sessionId','status','file','format','previewHash','scopeMap','sourceScopes','counts','createdAt','updatedAt','error'].map(key=>[key,row[key]]));
const emptyCounts = () => ({sources:0,records:0,enabled:0,trial:0,paused:0,history:0,needsReview:0});
const methodBody=row=>({title:row.title??'',guidance:row.guidance??'',appliesTo:row.appliesTo??'',doesNotApplyTo:row.doesNotApplyTo??''});
const targetScope=row=>({...(row.scope.topics?.length?{topics:row.scope.topics}:{}),...(row.scope.kind==='mapped'?{conversationId:row.scope.targetSessionId}:{})});
function normalizedExistingScope(row){
  const scope=row.scope??{};
  if(!scope||typeof scope!=='object'||Array.isArray(scope)||Object.keys(scope).some(key=>!['conversationId','topics'].includes(key))||
    scope.topics!==undefined&&!Array.isArray(scope.topics))return null;
  return {...(scope.topics?.length?{topics:scope.topics}:{}),...(scope.conversationId?{conversationId:scope.conversationId}:{})};
}

/** Business import only: the caller proves owner/live-main/native receipt. */
export class ImportService {
  constructor({business}) {
    if(!business?.storage) fail('invalid_import_config','需要业务存储。');
    this.store=business.storage;this.inflight=new Map();this.closed=false;this.abort=new AbortController();
    this.store.transaction(()=>{
      for(const row of this.store.listAll('import_batches',{where:{status:'preparing'}}))
        this.store.save('import_batches',{...row,status:'failed',error:{code:'import_interrupted',message:'上次准备未完成；没有自动重试或确认。'}},{expectedRevision:row.revision});
    });
  }
  async close() { this.closed=true;this.abort.abort();await Promise.allSettled([...this.inflight.values()]); }
  compareMethod(row,existing){
    const bodyHash=importDigest(methodBody(row.original));
    const sameIdentity=existing.filter(old=>old.importProvenance?.originalId===row.originalId&&old.importProvenance.originalVersion===row.version&&
      (!old.importProvenance.originalFormat||old.importProvenance.originalFormat===row.originalFormat));
    const matches=sameIdentity.length?sameIdentity:existing.filter(old=>importDigest(methodBody(old))===bodyHash);
    const evidence=matches.map(old=>{let usage;try{usage=usageForVersion(this.store,old);}catch{usage=null;}
      return {id:old.id,revision:old.revision,recordHash:importDigest(old),usage};});
    if(!matches.length)return {match:'new',evidence};
    const same=matches.length===1&&importDigest(methodBody(matches[0]))===bodyHash&&normalizedExistingScope(matches[0])!==null&&
      canonicalJson(normalizedExistingScope(matches[0]))===canonicalJson(targetScope(row))&&evidence[0].usage!==null;
    return {match:same?'duplicate':'conflict',existingRecordId:matches[0].id,evidence};
  }
  preparationRequest({sessionId,receiptId,requestId,scopeMap=[]}) {
    identity(sessionId,'Session');identity(receiptId,'Receipt');identity(requestId,'Request');
    return {sessionId,receiptId,requestId,scopeMap:mapping(sessionId,scopeMap)};
  }
  replayPreparation(input) {
    const request=this.preparationRequest(input),old=this.store.get('import_batches',batchId(request.sessionId,request.requestId));
    if(!old)return null;
    if(old.requestHash!==importDigest(request))fail('import_identity_conflict','这个提交编号已绑定另一份内容。');
    return this.inflight.get(old.id) || publicBatch(old);
  }
  async prepare(input) {
    const request=this.preparationRequest(input),prior=this.replayPreparation(request);
    if(prior)return await prior;
    if(this.closed)fail('import_unavailable','导入服务已停止。');
    const {file,read,signal,userIdentity}=input;
    if(!file||typeof file.name!=='string'||file.name.length>512||!nonnegative(file.bytes)||file.bytes>IMPORT_LIMITS.maxFileBytes||
      !/^[a-f0-9]{64}$/.test(file.sha256)||typeof read!=='function')fail('invalid_import_file','原生附件元数据无效。');
    identity(userIdentity,'Owner');
    const row=this.store.save('import_batches',{id:batchId(request.sessionId,request.requestId),...request,
      requestHash:importDigest(request),status:'preparing',file:{name:file.name,bytes:file.bytes,sha256:file.sha256},
      format:null,previewHash:null,scopeMap:request.scopeMap,sourceScopes:[],counts:emptyCounts(),error:null,owner:userIdentity});
    const pending=Promise.resolve().then(async()=>{
      try {
        const abort=signal?AbortSignal.any([signal,this.abort.signal]):this.abort.signal;
        abort.throwIfAborted();
        const parsed=await readLegacyImport({stream:read(abort),expectedBytes:file.bytes,expectedSha256:file.sha256,signal:abort});
        abort.throwIfAborted();
        if(request.scopeMap.some(m=>!parsed.sourceScopes.some(s=>s.sourceConversationId===m.sourceConversationId)))
          fail('import_scope_unknown','映射的旧交流不在这份完整导出中。');
        const mapped=new Map(request.scopeMap.map(m=>[m.sourceConversationId,m.targetSessionId]));
        const records=parsed.records.map(item=>{
          const target=item.scope.global?null:mapped.get(item.scope.sourceConversationId)||null;
          const scope={kind:item.scope.global?'global':target?'mapped':'historical',
            sourceConversationId:item.scope.sourceConversationId,targetSessionId:target,...(item.scope.topics?{topics:item.scope.topics}:{})};
          return {...item,originalFormat:parsed.format,scope,...(!item.scope.global&&!target&&usable(item)?{eligibility:'history',reasonCodes:[...item.reasonCodes,'scope_not_mapped']}:{})};
        });
        for(const item of records)if(item.kind==='understandings'){
          const direct=parsed.sources.map(source=>({id:source.id,role:source.role,content:source.content,revision:source.originalVersion,withdrawn:!source.available}));
          const dependencies=(item.original.dependencies||[]).map(ref=>{
            const kind=ref.kind||['events','understandings','methods'].find(kind=>kind==='events'?parsed.sources.some(source=>source.originalId===ref.id):records.some(record=>record.kind===kind&&record.originalId===ref.id));
            return {...ref,kind:kind??'unknown',id:kind+':'+ref.id};
          });
          item.claimType=parsed.format==='arcfold2-database-snapshot'?'inference':projectUnderstanding({content:item.content,
            claimType:item.original.claimType||'inference',proposedClaimType:item.original.proposedClaimType??item.original.claimType??'inference',
            sourceIds:item.sourceIds,dependencies},direct).claimType;
        }
        const methodGroups=new Map();
        for(const item of records)if(item.kind==='methods'&&usable(item)){
          const key=importDigest(methodBody(item.original));
          methodGroups.set(key,[...(methodGroups.get(key)||[]),item]);
        }
        for(const group of methodGroups.values())if(group.length>1)for(const item of group){
          item.eligibility='needs_review';item.reasonCodes.push('method_batch_conflict');
        }
        const existingMethods=this.store.listAll('methods');
        for(const item of records){
          if(item.kind!=='methods'||!usable(item))continue;
          item.methodCheck=this.compareMethod(item,existingMethods);
          if(item.methodCheck.match!=='new'){
            item.existingRecordId=item.methodCheck.existingRecordId;
            item.eligibility=item.methodCheck.match==='duplicate'?'history':'needs_review';
            item.reasonCodes.push(item.methodCheck.match==='duplicate'?'method_already_present':'method_existing_conflict');
          }
        }
        // A qualified dependency cannot be silently widened through a global parent.
        const byId=new Map(records.map(item=>[item.id,item]));let changed;
        do {changed=false;for(const item of records){
          if(!usable(item))continue;
          for(const ref of item.original.dependencies || []){
            const kind=ref.kind||['events','understandings','methods'].find(k=>k==='events'?parsed.sources.some(s=>s.originalId===ref.id):byId.has(k+':'+ref.id));
            if(kind==='events')continue;
            const dep=byId.get(kind+':'+ref.id);
            if(!dep||!usable(dep)||dep.eligibility==='paused'){
              item.eligibility='needs_review';item.reasonCodes.push('dependency_not_eligible');changed=true;break;
            }
            if(dep.scope.kind!=='global'&&(item.scope.kind!=='mapped'||dep.scope.kind!=='mapped'||item.scope.targetSessionId!==dep.scope.targetSessionId)){
              item.eligibility='needs_review';item.reasonCodes.push('dependency_scope_mismatch');changed=true;break;
            }
          }
        }}while(changed);
        const counts=emptyCounts();counts.sources=parsed.sources.length;counts.records=records.length;
        for(const item of records)counts[item.eligibility==='needs_review'?'needsReview':item.eligibility]++;
        const previewHash=importDigest({file:row.file,format:parsed.format,scopeMap:request.scopeMap,
          provenance:parsed.provenance,sources:parsed.sources,records,history:parsed.history});
        return this.store.transaction(()=>{
          abort.throwIfAborted();
          for(const source of parsed.sources)this.store.save('import_sources',{...source,id:row.id+':source:'+importDigest(source.id),
            batchId:row.id,sourceKey:source.id,textKey:'source:'+importDigest(source.id),sha256:textDigest(source.content)});
          for(const record of records)this.store.save('import_records',{...record,id:row.id+':record:'+importDigest(record.id),
            batchId:row.id,recordKey:record.id,textKey:'record:'+importDigest(record.id),originalTextKey:'original:'+importDigest(record.id)});
          for(const [index,entry] of parsed.history.entries())this.store.save('import_history',{id:row.id+':history:'+index,batchId:row.id,...entry});
          const projectionHash=importDigest(['import_sources','import_records','import_history'].map(kind=>this.store.listAll(kind,{where:{batchId:row.id}})));
          const saved=this.store.save('import_batches',{...row,status:'ready',format:parsed.format,previewHash,projectionHash,
            sourceScopes:parsed.sourceScopes,counts,provenance:parsed.provenance},{expectedRevision:row.revision});
          return publicBatch(saved);
        });
      }catch(error){
        const current=this.store.get('import_batches',row.id);
        const code=safeErrors.has(error?.code)?error.code:'import_prepare_failed';
        return publicBatch(this.store.save('import_batches',{...current,status:'failed',previewHash:null,
          error:{code,message:safeErrors.has(code)?error.message.slice(0,240):'附件准备未完成；原文未启用，没有自动重试。'}},{expectedRevision:current.revision}));
      }
    });
    this.inflight.set(row.id,pending);
    try{return await pending;}finally{this.inflight.delete(row.id);}
  }
  list({sessionId,viewScope,offset=0,limit=20}) {
    identity(sessionId,'Session');pagination(offset,limit,100);
    if(browseScope(viewScope,'all')==='current') {
      const rows=this.store.listAll('import_batches',{where:{sessionId}}).reverse();
      return page(rows.map(publicBatch),offset,limit);
    }
    const total=this.store.db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='import_batches'").get().n;
    const items=this.store.list('import_batches',{offset,limit,order:'desc'}).map(publicBatch);
    return {items,total,nextOffset:offset+limit<total?offset+limit:null};
  }
  batch(id) {identity(id,'Batch');const row=this.store.get('import_batches',id);if(!row)fail('import_not_found','导入批次不存在。');return row;}
  details({sessionId,batchId:id,view='records',offset=0,limit,textKey}) {
    identity(sessionId,'Session');const batch=this.batch(id),header=publicBatch(batch);
    if(!['records','sources','text'].includes(view))fail('invalid_import_page','预览类型无效。');
    limit??=view==='text'?16000:20;pagination(offset,limit,view==='text'?32000:50);
    if(view==='text'){
      identity(textKey,'Text');
      const ordinary=['import_sources','import_records'].flatMap(kind=>this.store.list(kind,{where:{batchId:id,textKey},limit:1}))[0];
      const original=this.store.list('import_records',{where:{batchId:id,originalTextKey:textKey},limit:1})[0];
      const row=ordinary||original;
      if(!row)fail('import_text_denied','该原文不属于此批预览。');
      const text=original?canonicalJson(row.original):row.content;
      return {batch:header,view,textKey,text:text.slice(offset,offset+limit),offset,total:text.length,nextOffset:offset+limit<text.length?offset+limit:null};
    }
    if(textKey!==undefined)fail('invalid_import_page','记录列表不接受原文编号。');
    const rows=this.store.listAll(view==='records'?'import_records':'import_sources',{where:{batchId:id}});
    const projected=rows.map(row=>view==='sources'?{id:row.sourceKey,originalId:row.originalId,role:row.role,
      sourceConversationId:row.sourceConversationId,occurredAt:row.occurredAt,textPreview:row.content.slice(0,240),textKey:row.textKey,
      sha256:row.sha256,available:row.available}:{id:row.recordKey,kind:row.kind,originalId:row.originalId,
      title:row.kind==='methods'?importMethodField(row.original,'title'):String(row.original.title || '').slice(0,120),
      textPreview:row.content.slice(0,240),textKey:row.textKey,...(row.originalTextKey?{originalTextKey:row.originalTextKey}:{}),
      eligibility:row.eligibility,reasonCodes:row.reasonCodes,sourceIds:row.sourceIds,scope:row.scope,
      ...(row.kind==='methods'?{appliesTo:importMethodField(row.original,'appliesTo'),doesNotApplyTo:importMethodField(row.original,'doesNotApplyTo')}:{}),
      ...(row.kind==='understandings'?{claimType:row.claimType}:{}),
      ...(row.methodUsage?{methodUsage:row.methodUsage}:{}),...(row.existingRecordId?{existingRecordId:row.existingRecordId}:{})});
    return {batch:header,view,...page(projected,offset,limit)};
  }
  mutation(op,input,apply) {
    const {sessionId,batchId:id,expectedRevision,previewHash,requestId,userIdentity}=input;
    for(const value of [sessionId,id,requestId,userIdentity])identity(value,'Request identity');
    if(!positive(expectedRevision)||!/^[a-f0-9]{64}$/.test(previewHash))fail('invalid_import_request','确认必须绑定完整预览和版本。');
    const request={sessionId,batchId:id,expectedRevision,previewHash,requestId},key=commandId(op,sessionId,requestId),requestHash=importDigest(request);
    return this.store.transaction(()=>{
      const prior=this.store.get('import_commands',key);
      if(prior){if(prior.requestHash!==requestHash)fail('import_identity_conflict','这个提交编号已绑定另一项决定。');return prior.result;}
      const batch=this.batch(id);
      if(batch.revision!==expectedRevision||batch.previewHash!==previewHash)fail('revision_conflict','预览版本已变化，请重新查看。');
      const result=publicBatch(apply(batch));
      this.store.save('import_commands',{id:key,operation:op,request,requestHash,actor:'user',userIdentity,result,
        authority:'listed-knowledge-guidance-only; no-tools-execution-spending-or-goal-control'});
      return result;
    });
  }
  confirm(input) {return this.mutation('confirm',input,batch=>{
    if(batch.sessionId!==input.sessionId||batch.status!=='ready')fail('import_not_confirmable','仅能在准备预览的当前主交流中确认完整预览。');
    const fingerprint=importDigest([batch.file.sha256,batch.scopeMap]);
    const prior=this.store.get('import_applications',fingerprint);
    if(prior){const existing=this.batch(prior.batchId);if(existing.status==='withdrawn')fail('import_already_withdrawn','相同来源批次已撤销，不会借重复准备重新启用。');return existing;}
    const sources=this.store.listAll('import_sources',{where:{batchId:batch.id}}),records=this.store.listAll('import_records',{where:{batchId:batch.id}});
    if(importDigest([sources,records,this.store.listAll('import_history',{where:{batchId:batch.id}})])!==batch.projectionHash)
      fail('import_dependency_changed','保存的预览正文已变化，未导入。');
    const existingMethods=this.store.listAll('methods');
    for(const row of records)if(row.methodCheck&&canonicalJson(row.methodCheck)!==canonicalJson(this.compareMethod(row,existingMethods)))
      fail('import_dependency_changed','已有方法或试用记录已变化，请重新准备预览。');
    const saved=new Map(),byKey=new Map(records.map(row=>[row.recordKey,row]));
    const targetId=key=>'legacy:'+importDigest([fingerprint,key]);
    const mapped=new Map(batch.scopeMap.map(row=>[row.sourceConversationId,row.targetSessionId]));
    for(const source of sources){
      const conversationId=mapped.get(source.sourceConversationId)||'legacy-conversation:'+importDigest([fingerprint,source.sourceConversationId]);
      const event=this.store.save('events',{id:targetId(source.sourceKey),conversationId,sessionId:conversationId,role:source.role,author:source.role,
        content:source.content,occurredAt:source.occurredAt,importBatchId:batch.id,
        provenance:{...source.provenance,importBatchId:batch.id,originalId:source.originalId,originalRevision:source.originalVersion,
          originalConversationId:source.sourceConversationId,fileSha256:batch.file.sha256,bodySha256:source.sha256}});
      saved.set(source.sourceKey,event);
      if(!source.available)this.store.save('source_controls',{id:event.id,withdrawn:true,useProhibited:true,reason:'legacy_source_unavailable',importBatchId:batch.id});
    }
    function currentDependency(ref){
      const kind=ref.kind||['events','understandings','methods'].find(kind=>saved.has(kind+':'+ref.id)||byKey.has(kind+':'+ref.id));
      const key=kind+':'+ref.id;
      if(!saved.has(key))write(byKey.get(key));
      const row=saved.get(key);if(!row)fail('import_dependency_changed','预览的依赖不能完整写入。');
      return {kind,id:row.id,revision:row.revision};
    }
    const store=this.store;
    function write(row){
      if(!row||!usable(row)||saved.has(row.recordKey))return;
      const original=row.original,scope=targetScope(row);
      const sourceIds=row.sourceIds.map(key=>saved.get(key)?.id);
      if(sourceIds.some(id=>!id))fail('import_dependency_changed','预览的原话缺失。');
      const dependencies=(original.dependencies||[]).map(currentDependency);
      for(const key of row.sourceIds){const source=saved.get(key);if(!dependencies.some(ref=>ref.id===source.id))dependencies.push({kind:'events',id:source.id,revision:source.revision});}
      const provenance={importBatchId:batch.id,originalFormat:row.originalFormat,originalId:row.originalId,originalRevision:original.revision ?? null,
        originalVersion:row.version,fileSha256:batch.file.sha256};
      const common={id:targetId(row.recordKey),conversationId:row.scope.targetSessionId||'legacy-conversation:'+importDigest([fingerprint,row.scope.sourceConversationId]),
        scope,sourceIds,dependencies,version:row.version,importBatchId:batch.id,importProvenance:provenance};
      let value;
      if(row.kind==='understandings'){
        const old2=row.originalFormat==='arcfold2-database-snapshot';
        value=projectUnderstanding({...common,content:row.content,status:'active',claimType:old2?'inference':original.claimType||'inference',
          proposedClaimType:old2?'inference':original.proposedClaimType??original.claimType??'inference'},row.sourceIds.map(key=>saved.get(key)));
        if(value.claimType!==row.claimType)fail('import_dependency_changed','理解性质与已确认预览不符，未导入。');
      }
      else if(row.kind==='methods')value={...common,title:original.title,guidance:original.guidance,appliesTo:original.appliesTo,
        doesNotApplyTo:original.doesNotApplyTo,status:original.status,trialUses:row.methodUsage.trialUses,maxTrialUses:row.methodUsage.maxTrialUses,
        validated:false,origin:'imported_guidance',signature:importDigest({title:original.title,guidance:original.guidance,appliesTo:original.appliesTo,doesNotApplyTo:original.doesNotApplyTo}),
        pauseReason:original.pauseReason ?? null,authority:'work-guidance-only; no-new-tool-or-permission',
        activationSourceId:original.activationSourceId?saved.get('events:'+original.activationSourceId)?.id ?? null:null,
        importedTrialBasis:{trialUses:row.methodUsage.trialUses,version:row.version,source:'complete-legacy-export'}};
      else return;
      saved.set(row.recordKey,store.save(row.kind,value));
    }
    for(const row of records)write(row);
    const appliedIds=[...saved.values()].map(row=>row.id);
    this.store.save('import_applications',{id:fingerprint,batchId:batch.id,fileSha256:batch.file.sha256,scopeMap:batch.scopeMap,appliedIds});
    return this.store.save('import_batches',{...batch,status:'confirmed',fingerprint,appliedIds},{expectedRevision:batch.revision});
  });}
  withdraw(input) {return this.mutation('withdraw',input,batch=>{
    if(batch.status!=='confirmed')fail('import_not_withdrawable','只有已确认批次可以撤销。');
    const ids=[];
    for(const source of this.store.listAll('events',{where:{importBatchId:batch.id}})){
      const old=this.store.get('source_controls',source.id);
      if(!old?.withdrawn)this.store.save('source_controls',{...old,id:source.id,withdrawn:true,useProhibited:true,
        reason:'import_batch_withdrawn',importBatchId:batch.id},{expectedRevision:old?.revision ?? null});
      ids.push(source.id);
    }
    const changes=invalidateDependents(this.store,{ids,pendingId:batch.id,reason:'import_batch_withdrawn'});
    this.store.save('audit',{id:'import-withdraw:'+batch.id,actor:'user',action:'import_batch_withdrawn',batchId:batch.id,
      sourceIds:ids,changes,meaning:'future knowledge eligibility only; original sources, independent later experience and goal control retained'});
    return this.store.save('import_batches',{...batch,status:'withdrawn'},{expectedRevision:batch.revision});
  });}
}
