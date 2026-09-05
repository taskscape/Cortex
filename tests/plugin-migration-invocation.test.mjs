import assert from 'node:assert/strict';
import test from 'node:test';
await import('../local-agent/matbot/apps/cli/register.js');
const { invokeToolEvents, runSession, HookRegistry, createSession, createMessage, appendMessage } = await import('../local-agent/matbot/packages/core/runner/src/index.ts');
const { VaultImpl } = await import('../local-agent/matbot/packages/core/security/src/vault.ts');
const collect = async stream => { const values=[]; for await(const v of stream) values.push(v); return values; };
function fixture() {
  let calls = 0;
  const session = appendMessage(createSession({ ownerPrincipal: { id:'migration', type:'user' } }), createMessage({ role:'user',content:[{type:'text',text:'run'}],traceId:'test' }));
  const tool = { name:'example',description:'Example',inputSchema:{type:'object',required:['value'],properties:{value:{type:'string'}}},executor:{async *execute(input){ calls++; yield {type:'result',value:{text:input.value}};}}};
  const ctx = {callId:'call',session,signal:new AbortController().signal,vault:new VaultImpl(),provider:'test',prompt:async()=>{throw Error('not interactive');},loadPlugin:async()=>{throw Error('unused');},unloadPlugin:async()=>false};
  return { session, tool, ctx, calls:()=>calls };
}
test('direct calls apply validation, policy, hooks and result redaction before returning content', async()=>{
  const f=fixture(); const hooks=new HookRegistry(); let pre=0; let post=0;
  hooks.register({on:'toolcall',handler(){pre++;}});
  hooks.register({on:'toolresult',handler(){post++;return {result:{text:'redacted'}};}});
  assert.equal((await collect(invokeToolEvents(f.tool,{value:'secret'},f.ctx,{hooks})))[0].value.text,'redacted');
  assert.equal(pre,1); assert.equal(post,1); assert.equal(f.calls(),1);
  const invalid=await collect(invokeToolEvents(f.tool,{},f.ctx));
  assert.equal(invalid[0].code,'invalid_input'); assert.equal(f.calls(),1);
  const denied=await collect(invokeToolEvents(f.tool,{value:'x'},f.ctx,{permissions:{defaultAction:'deny'}}));
  assert.equal(denied[0].code,'permission_denied'); assert.equal(f.calls(),1);
  const ask=await collect(invokeToolEvents(f.tool,{value:'x'},f.ctx,{permissions:{defaultAction:'ask'}}));
  assert.equal(ask[0].code,'approval_required'); assert.equal(f.calls(),1);
});
test('model and direct invocation share a rejecting tool hook', async()=>{
  const f=fixture(); const hooks=new HookRegistry();
  hooks.register({on:'toolcall',handler(){return {rejectTool:{message:'blocked by connector'}};}});
  const direct=await collect(invokeToolEvents(f.tool,{value:'x'},f.ctx,{hooks}));
  assert.match(direct[0].message,/blocked by connector/);
  let turns=0;
  const provider={name:'test',async *complete(){if(turns++===0)yield {type:'tool-call',id:'call',name:'example',input:{value:'x'}};yield {type:'done'};},async health(){return {status:'ok'};}};
  const store={async set(){},async get(){return f.session;}};
  const events=await collect(runSession({session:f.session,config:{provider:'test'},provider,providerConfig:{name:'test',module:'test',model:'test'},store,tools:new Map([['example',f.tool]]),signal:f.ctx.signal,vault:f.ctx.vault,hooks,loadPlugin:f.ctx.loadPlugin,unloadPlugin:f.ctx.unloadPlugin}));
  const end=events.find(e=>e.type==='tool:end');
  assert.match(end.result.error,/blocked by connector/); assert.equal(f.calls(),0);
});
test('an already cancelled direct request never calls the executor',async()=>{
  const f=fixture(); const ac=new AbortController(); ac.abort();
  const result=await collect(invokeToolEvents(f.tool,{value:'x'},{...f.ctx,signal:ac.signal}));
  assert.equal(result[0].code,'aborted'); assert.equal(f.calls(),0);
});

test('managed invocations fail closed without host policy and freeze nested rules',async()=>{
  const {createToolInvoker,freezeInvocationPolicy}=await import('../local-agent/matbot/packages/core/runner/src/index.ts');
  const f=fixture(),policy=freezeInvocationPolicy({defaultAction:'deny',rules:[{permission:'example',pattern:'*',action:'allow'}]});
  assert.throws(()=>{policy.rules[0].action='deny';},TypeError);
  assert.throws(()=>policy.rules.push({}),TypeError);
  const services={hooks:new HookRegistry(),ToolInvocationPolicy:policy};
  const invoker=createToolInvoker(services);assert.equal((await collect(invoker.invoke(f.tool,{value:'ok'},f.ctx)))[0].type,'result');
  delete services.ToolInvocationPolicy;assert.equal((await collect(invoker.invoke(f.tool,{value:'ok'},f.ctx)))[0].code,'policy_unavailable');assert.equal(f.calls(),1);
});

test('file tool approval flags require runtime consent on both local and remote adapters',async()=>{
  const {createFileBrokerTool}=await import('../local-agent/matbot/plugins/file-broker/dist/index.js');
  const f=fixture();let writes=0,approved;
  const tool=createFileBrokerTool({async write(_path,_content,consent){writes++;approved=consent;return {ok:true};}});
  const input={action:'write',path:'approved.ps1',content:'reviewed',approved:true};
  const forged=await collect(tool.executor.execute(input,f.ctx));assert.equal(forged[0].type,'error');assert.equal(writes,0);
  const direct=await collect(invokeToolEvents(tool,input,f.ctx));assert.equal(direct[0].code,'approval_required');assert.equal(writes,0);
  const interactive=await collect(invokeToolEvents(tool,input,{...f.ctx,prompt:async()=> 'allow'},{interactive:true}));assert.equal(interactive[0].type,'result');assert.equal(writes,1);assert.equal(approved,true);
});
