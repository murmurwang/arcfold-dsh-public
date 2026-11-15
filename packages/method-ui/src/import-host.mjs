import { currentMainAgent } from './main-session.mjs';
import { browseScope } from './browse-scope.mjs';
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
const NAMESPACE='arcfoldImports',SERVICE='arcfoldImportWeb';
const ENDPOINTS=['prepare','list','details','confirm','withdraw'];
export const MAX_IMPORT_FILE_BYTES=805306368;
const reject=(code,message)=>{throw new RemoteError(code,message,{});};
function shape(value,allowed,required=allowed){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(value,k)))
    reject('invalid_import_request','导入请求含缺失或未允许的字段。');
}
function id(value){if(typeof value!=='string'||!value.trim()||value.length>512||value.includes('\0'))reject('invalid_import_request','请求身份无效。');}
function trusted(connection,signal,peer){
  if(!peer||peer!==connection.browserPeer||peer.principal?.kind!=='owner'||peer.interactions!=='answer'||peer.signal?.aborted!==false||signal?.aborted!==false)
    reject('trusted_browser_required','导入只接受当前已认证网页所有者的请求。');
}
const errors={revision_conflict:'预览版本已变化，请重新查看。',import_identity_conflict:'提交编号已绑定另一份内容，未重发。',
  invalid_browse_scope:'请选择全部积累或与当前聊天相关的内容。',
  invalid_import_page:'分页范围无效。',import_not_found:'导入批次不存在。',import_text_denied:'原文不属于此批预览。',
  import_not_confirmable:'请在准备预览的同一个主交流确认完整预览。',import_not_withdrawable:'此批次尚不可撤销。',
  import_already_withdrawn:'相同来源批次已撤销，重复准备不会重新启用。',import_dependency_changed:'已保存预览的证据已变化，未导入。',
  invalid_import_scope:'只能选择一个旧交流映射到当前主交流。',invalid_import_request:'导入请求无效。',invalid_import_file:'附件大小或摘要无效。'};

export function createImportHandler({imports,connection,agents,agentPresets,fileUploads,attachments}){
  const main=sessionId=>{
    const agent=currentMainAgent({agents,agentPresets},sessionId);
    if(!agent)
      reject('import_session_denied','请在当前已打开的 Arcfold 主交流导入。');
    return agent;
  };
  return async(endpoint,payload,signal,peer)=>{
    try{
      trusted(connection,signal,peer);
      if(!imports)reject('import_unavailable','当前部署尚未接通导入。');
      const fields=endpoint==='prepare'?['sessionId','receiptId','requestId','scopeMap']:
        endpoint==='list'?['sessionId','offset','limit','viewScope']:endpoint==='details'?['sessionId','batchId','view','offset','limit','textKey','viewScope']:
        ['sessionId','batchId','expectedRevision','previewHash','requestId'];
      const required=endpoint==='prepare'?['sessionId','receiptId','requestId']:endpoint==='list'?['sessionId']:
        endpoint==='details'?['sessionId','batchId']:fields;
      if(!ENDPOINTS.includes(endpoint))reject('import_endpoint_not_found','不存在的导入操作。');
      shape(payload,fields,required);id(payload.sessionId);
      const reading=endpoint==='list'||endpoint==='details';
      if(reading)browseScope(payload.viewScope,'all');
      if(reading&&payload.viewScope!==undefined)return {...imports[endpoint](payload),
        canImport:currentMainAgent({agents,agentPresets},payload.sessionId)!==null};
      const agent=main(payload.sessionId);
      if(endpoint==='list'||endpoint==='details')return imports[endpoint](payload);
      id(payload.requestId);
      if(endpoint!=='prepare')return imports[endpoint]({...payload,userIdentity:'browser:'+peer.id});
      id(payload.receiptId);
      if(payload.scopeMap!==undefined){
        if(!Array.isArray(payload.scopeMap)||payload.scopeMap.length>1)reject('invalid_import_scope',errors.invalid_import_scope);
        for(const row of payload.scopeMap){shape(row,['sourceConversationId','targetSessionId']);id(row.sourceConversationId);
          if(row.targetSessionId!==payload.sessionId)reject('invalid_import_scope',errors.invalid_import_scope);}
      }
      const prior=imports.replayPreparation(payload);if(prior)return await prior;
      const staged=fileUploads?.resolve(agent,payload.receiptId),ref=staged?.attachment;
      if(staged?.type!=='file'||!ref||typeof ref.attachmentId!=='string'||!/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId)||
          typeof ref.name!=='string'||ref.name.length>512||!Number.isSafeInteger(ref.bytes)||ref.bytes<0||ref.bytes>MAX_IMPORT_FILE_BYTES)
        reject('import_receipt_denied','附件凭证不属于当前真实主交流，或超出导入上限。');
      const frozen={attachmentId:ref.attachmentId,name:ref.name,bytes:ref.bytes};
      const current=()=>{
        trusted(connection,signal,peer);
        if(main(payload.sessionId)!==agent||fileUploads.resolve(agent,payload.receiptId)!==staged||
            ref.attachmentId!==frozen.attachmentId||ref.name!==frozen.name||ref.bytes!==frozen.bytes)
          reject('import_receipt_changed','上传凭证或主交流已变化。');
      };
      current();
      return await imports.prepare({...payload,file:{name:frozen.name,bytes:frozen.bytes,sha256:frozen.attachmentId.slice(7)},
        userIdentity:'browser:'+peer.id,signal:AbortSignal.any([signal,peer.signal]),
        read:async function*(abort){
          current();for await(const chunk of attachments.readFileStream(frozen,abort)){current();abort.throwIfAborted();yield chunk;}
          // Native digest check happens after its last yield; do not mark ready earlier.
          current();abort.throwIfAborted();
        }});
    }catch(error){
      if(error instanceof RemoteError)throw error;
      const code=Object.hasOwn(errors,error?.code)?error.code:'import_request_failed';
      throw new RemoteError(code,errors[code]||'操作未确认，请刷新批次记录。没有自动重试。',{});
    }
  };
}
class ImportWeb extends TypertRemoteService{
  constructor(ctx){super(ctx,SERVICE,{namespace:NAMESPACE});}
  dispatch(method,request){const {signal,peer}=this.ctx.invocation??{};
    return createImportHandler({imports:this.ctx.arcfoldImports,connection:this.ctx.connection,agents:this.ctx.agents,
      agentPresets:this.ctx.agentPresets,fileUploads:this.ctx.fileUploads,attachments:this.ctx.attachments})(method,request,signal,peer);}
  prepare(value){return this.dispatch('prepare',value);}
  list(value){return this.dispatch('list',value);}
  details(value){return this.dispatch('details',value);}
  confirm(value){return this.dispatch('confirm',value);}
  withdraw(value){return this.dispatch('withdraw',value);}
}
export const importInvocations=ENDPOINTS.map(method=>({id:`@arcfold/dsh-method-ui#${NAMESPACE}/${method}`,
  service:SERVICE,namespace:NAMESPACE,method,invocation:{kind:'direct'},
  parameters:[{name:'request',wire:'request',source:'json',codec:{mode:'src-json'}}],result:{mode:'src-json'}}));
export function installImportWeb(ctx){return ctx.inject(['arcfoldImports','connection','agents','agentPresets','fileUploads','attachments'],
  owner=>{new ImportWeb(owner);});}
