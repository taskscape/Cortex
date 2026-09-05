import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
await import('../local-agent/matbot/apps/cli/register.js');
const {PluginContributions}=await import('../local-agent/matbot/packages/core/runner/src/contributions.ts');
const {makePluginSettings}=await import('../local-agent/matbot/packages/core/runner/src/settings.ts');
const {MemoryStore}=await import('../local-agent/matbot/apps/cli/src/storage-isolation.ts');
const {ConfigurationAdmin}=await import('../local-agent/matbot/packages/plugins/configuration-admin/src/index.ts');
const {settingsContributor}=await import('../local-agent/matbot/packages/plugins/configuration-contributors/src/index.ts');
const {FederatedRetrieval}=await import('../local-agent/matbot/packages/plugins/retrieval-federation/src/index.ts');
const {FileWorkspaceManager}=await import('../local-agent/matbot/packages/plugins/workspace-manager/src/index.ts');
const {profilePlugins,selectCapabilityProfile}=await import('../local-agent/matbot/apps/cli/src/capability-profiles.ts');
const {registerModelConfiguration}=await import('../local-agent/matbot/packages/plugins/runtime-admin/src/configuration.ts');
const {EnvFileVault}=await import('../local-agent/matbot/packages/plugins/vault-env/src/index.ts');
const {indexRoot}=await import('../local-agent/file-index/dist/indexer.js');
const {createExpertPanelPlugin}=await import('../local-agent/matbot/plugins/expert-panel/src/index.ts');
const collect=async stream=>{const rows=[];for await(const row of stream)rows.push(row);return rows;};
const temporary=async(t)=>{const dir=await mkdtemp(path.join(os.tmpdir(),'cortex-migration-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};
function host(){const registry=new PluginContributions(),stores=new Map();return {registry,services:{contributions:registry.forOwner('host'),WorkspaceContext:{id:'one'},createStore(name){if(!stores.has(name))stores.set(name,new MemoryStore());return stores.get(name);}}};}

test('contributions reject route collisions and release identity and lifetime on unload',()=>{
 const registry=new PluginContributions(),a=registry.forOwner('a'),b=registry.forOwner('b');
 a.register('http','one',{method:'GET',path:'/api/status',handle(){}});
 const row=a.list('http')[0];assert.equal(row.owner,'a');
 assert.throws(()=>b.register('http','two',{method:'GET',path:'/api/status',handle(){}}),/Duplicate/);
 assert.throws(()=>b.register('http','three',{method:'POST',path:'/sessions',handle(){}}),/api/);
 registry.removeOwner('a');assert.equal(row.signal.aborted,true);assert.equal(b.list('http').length,0);
 b.register('http','one',{method:'GET',path:'/api/status',handle(){}});assert.equal(b.list('http').length,1);
});
test('settings first writes serialize and configuration CAS preserves unrelated owner state',async()=>{
 const store=new MemoryStore(),a=makePluginSettings(store,'owner'),b=makePluginSettings(store,'owner');
 await Promise.all([a.set('one',1),b.set('two',2)]);assert.deepEqual((await a.snapshot()).data,{one:1,two:2});
 const c=settingsContributor(a,{title:'One',keys:['one'],schema:{},validate(v){if(typeof v.one!=='number')throw Error('invalid');}});
 const snapshot=await c.read();await b.set('two',3);
 await assert.rejects(()=>c.update({one:4},snapshot.version),/conflict/);
 await c.update({one:4},(await c.read()).version);assert.deepEqual((await a.snapshot()).data,{one:4,two:3});
});
test('configuration history redacts secrets and restores under the current schema and version',async()=>{
 const {services,registry}=host();let version='v1',value={count:1,auth:{token:'secret-a'}};
 registry.forOwner('domain').register('configuration','sample',{title:'Sample',scope:'workspace',schema:{},secretPaths:['auth.token'],apply:'immediate',async read(){return {version,value};},async validate(v){if(typeof v.count!=='number'||v.count<0)throw Error('bad count');},async update(v,expected){assert.equal(expected,version);value=v;version=crypto.randomUUID();return {version,value};}});
 const admin=new ConfigurationAdmin(services),before=await admin.execute({action:'get',id:'sample'});assert.equal(before.value.auth.token,'[REDACTED]');
 await admin.execute({action:'update',id:'sample',value:{count:2},expectedVersion:version});assert.equal(value.auth.token,'secret-a');
 const history=await admin.execute({action:'history',id:'sample'});assert.equal(history.items[0].state,'applied');assert.ok(!JSON.stringify(history).includes('secret-a'));
 value.auth.token='secret-b';await admin.execute({action:'restore',id:'sample',historyId:history.items[0].id,expectedVersion:version});assert.deepEqual(value,{count:1,auth:{token:'secret-b'}});
 await assert.rejects(()=>admin.execute({action:'update',id:'sample',value:{count:-1},expectedVersion:version}),/bad count/);
 await assert.rejects(()=>admin.execute({action:'update',id:'sample',value:{count:3},expectedVersion:before.version}),/conflict/);
 registry.removeOwner('domain');await assert.rejects(()=>admin.execute({action:'get',id:'sample'}),/unavailable/);
});
test('federation distinguishes no matches from partial failure, isolates workspaces and follows unload',async()=>{
 const {services,registry}=host();const source=registry.forOwner('source');
 source.register('retrieval','empty',{title:'Empty',scope:'workspace',async search(){return [];}});
 source.register('retrieval','good',{title:'Good',scope:'workspace',async search(q){return [{id:'passage',sourceId:'good',workspaceId:q.workspaceId,content:'evidence',citation:{documentVersionId:'immutable'}},{id:'leak',sourceId:'good',workspaceId:'two',content:'hidden'}];}});
 registry.forOwner('failing').register('retrieval','broken',{title:'Broken',scope:'workspace',async search(){throw Error('offline');}});
 const federation=new FederatedRetrieval(services),query={query:'evidence',limit:5,workspaceId:'one',principal:{id:'user',type:'user'},signal:new AbortController().signal};
 const result=await federation.search(query);assert.equal(result.partial,true);assert.deepEqual(result.hits.map(h=>h.id),['passage']);assert.equal(result.sources.find(s=>s.id==='empty').state,'ready');
 await assert.rejects(()=>federation.search({...query,workspaceId:'two'}),/workspace/);
 registry.removeOwner('failing');assert.equal((await federation.search(query)).partial,false);
 registry.removeOwner('source');assert.equal((await federation.search(query)).hits.length,0);
 registry.forOwner('slow').register('retrieval','slow',{title:'Slow',scope:'workspace',async search(){return new Promise(()=>{});}});
 const ac=new AbortController(),pending=federation.search({...query,signal:ac.signal});ac.abort();await assert.rejects(pending);federation.close();assert.equal(federation.lastResult,undefined);
});
test('workspace mutations reserve deletion and commit participants without an owned directory',async(t)=>{
 const dir=await temporary(t),config=path.join(dir,'matbot.yaml');await writeFile(config,'plugins: []\n');const manager=new FileWorkspaceManager(path.join(dir,'registry.json'),config,{deletionLogger(){}});
 const rows=await Promise.all([manager.create('One'),manager.create('Two'),manager.create('Three')]);assert.equal((await manager.list()).workspaces.length,4);
 let committed=0,released=0,locked=true;manager.registerParticipant({id:'index',readiness:()=>({canDelete:!locked,locked}),async acquireDeletion(){assert.equal(locked,false);locked=true;return {async commit(){committed++;},release(){released++;locked=false;}};}});
 await assert.rejects(()=>manager.delete(rows[0].id),/blocked/);locked=false;
 await rm(path.join(dir,'workspaces',rows[0].id),{recursive:true,force:true});await manager.delete(rows[0].id);assert.equal(committed,1);assert.equal(released,1);
});
test('incomplete host-index discovery retains prior chunks and current policy still excludes denied paths',async(t)=>{
 const dir=await temporary(t),scan=path.join(dir,'scan');await mkdir(scan);await writeFile(path.join(scan,'evidence.txt'),'retained evidence');
 const options={root:scan,indexExcludedPatterns:[],maxFileBytes:10000,workspaces:{roots:[{path:dir,mode:'read-write',type:'projects'}],indexExcludedPatterns:[]},policy:{deniedPathFragments:[],highRiskExtensions:[],maxReadBytes:10000,backupRoot:path.join(dir,'backups')}};
 const first=await indexRoot(options,{version:1,updatedAt:'',chunks:[],skipped:[]});assert.equal(first.chunks.length,1);await rm(scan,{recursive:true,force:true});
 const next=await indexRoot(options,first);assert.equal(next.chunks.length,1);assert.match(next.skipped[0].reason,/unreadable-directory/);
 const denied=await indexRoot({...options,policy:{...options.policy,deniedPathFragments:['evidence.txt']}},first);assert.equal(denied.chunks.length,0);
});
test('provider model configuration preserves credentials and unrelated YAML and rejects stale writes',async(t)=>{
 const dir=await temporary(t),configPath=path.join(dir,'matbot.yaml');const original='providers:\n  local:\n    module: ./adapter\n    model: old\n    credentials:\n      apiKey: secret-sentinel\nplugins:\n  - ./one\nprompt: untouched\n';await writeFile(configPath,original);
 const {services}=host();services.configPath=configPath;const live=new Map([['local',{name:'local',module:'adapter',model:'old'}]]);registerModelConfiguration(services,live);const c=services.contributions.list('configuration')[0].value;const snapshot=await c.read();assert.deepEqual(snapshot.value,{local:'old'});await c.update({local:'new-model'},snapshot.version);
 const text=await readFile(configPath,'utf8');assert.match(text,/apiKey: secret-sentinel/);assert.match(text,/prompt: untouched/);assert.equal(live.get('local').model,'new-model');await assert.rejects(()=>c.update({local:'later'},snapshot.version),/conflict/);
});
test('vault serializes durable writes and failed persistence leaves memory unchanged',async(t)=>{
 const dir=await temporary(t),file=path.join(dir,'.env'),vault=new EnvFileVault(file);await Promise.all([vault.writeSecret('FIRST','one'),vault.writeSecret('SECOND','two')]);const text=await readFile(file,'utf8');assert.match(text,/FIRST=one/);assert.match(text,/SECOND=two/);assert.equal(await vault.resolve('${FIRST}'),'one');
 const broken=new EnvFileVault(path.join(dir,'missing','.env'));await assert.rejects(()=>broken.writeSecret('UNSAVED','value'));await assert.rejects(()=>broken.resolve('${UNSAVED}'));
 await assert.rejects(()=>vault.writeSecret('BAD','line\nINJECTED=yes'),/single-line/);assert.equal(await readFile(file,'utf8'),text);
});
test('profiles migrate hybrid selection without requiring legacy HTTP in the standard runtime',()=>{
 const local=name=>'plugins/'+name,configured=['plugins/hybrid-knowledge-index','plugins/frontend/web'];
 const standard=profilePlugins('standard',configured,true,local);assert.ok(standard.includes('plugins/file-index'));assert.ok(standard.includes('plugins/memory-mem0'));assert.ok(!standard.some(s=>s.includes('hybrid-knowledge-index')||s.includes('file-index-client')));
 const compatibility=profilePlugins('compatibility',configured,true,local);assert.ok(compatibility.includes('plugins/file-index-client'));assert.ok(!compatibility.includes('plugins/host-file-access'));assert.deepEqual(profilePlugins('minimal',configured,true,local),configured);assert.throws(()=>selectCapabilityProfile('unknown'),/Unknown/);
});
test('expert definition refresh affects subsequent calls while in-flight panels retain their snapshot',async()=>{
 let version='one',title='First',release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);let call=0;
 const store=new MemoryStore(),services={providers:new Map([['selected',{}]]),createStore:()=>store,async register(key,value){this[key]=value;},tools:{register(){}},async singleTurn(request){if(++call===1){entered();await gate;}return {text:request.system,usage:{inputTokens:1,outputTokens:1}};}};
 const plugin=createExpertPanelPlugin({definitions:{async snapshot(){return {version,config:{experts:[{id:'expert',title,description:'',roots:[],systemPrompt:title}]}};}},knowledge:()=>({async searchWithDiagnostics(){return {sources:[],warnings:[]};}})});await plugin.setup(services);
 const input={question:'Question',mode:'parallel',synthesize:false},ctx={provider:'selected',signal:new AbortController().signal};const first=services.ExpertPanel.askPanel(input,ctx);await started;version='two';title='Second';const second=await services.ExpertPanel.askPanel(input,ctx);release();assert.equal((await first).experts[0].answer,'First');assert.equal(second.experts[0].answer,'Second');
});

test('loader rollback removes failed contributions; unloading an older provider preserves its replacement',async()=>{
 const {loadPlugins,registerPlugin,setupPlugin,unloadPlugin,ToolRegistryImpl,HookRegistry,SystemContextRegistryImpl,unifyServices}=await import('../local-agent/matbot/packages/core/runner/src/index.ts');
 const map=new Map(),stores=new Map();
 const services=unifyServices({tools:new ToolRegistryImpl(),hooks:new HookRegistry(),systemContext:new SystemContextRegistryImpl(),mounted:{consume(){}},createStore(name){if(!stores.has(name))stores.set(name,new MemoryStore());return stores.get(name);},get:key=>map.get(key),async register(key,value){map.set(key,value);},unregister:key=>map.delete(key)});
 const probe={apiVersion:'0.1',name:'migration-probe',specifier:'migration-probe',setup(s){map.set('probe',s);}};
 registerPlugin(probe);await setupPlugin(probe,services);const scoped=map.get('probe');
 assert.throws(()=>scoped.unregister('ToolInvocationPolicy'),/host/);await assert.rejects(()=>scoped.register('ToolInvocationPolicy',{}),/host/);
 const source="export const plugin={apiVersion:'0.1',async setup(s){s.contributions.register('health','failed-health',{probe:async()=>({state:'ready'})});await s.tools.register({name:'failed-tool',description:'test',inputSchema:{},executor:{async *execute(){}}});throw Error('setup failed');}};";
 await loadPlugins([{spec:'migration-failed',importSpec:'data:text/javascript,'+encodeURIComponent(source),name:'migration-failed'}],services);
 assert.equal(scoped.contributions.list('health').length,0);assert.equal(services.tools.resolve('failed-tool'),null);
 const a={apiVersion:'0.1',name:'migration-a',specifier:'migration-a',async setup(s){await s.register('KnowledgeIndex',{name:'a'});s.contributions.register('health','owned',{probe:async()=>({state:'ready'})});await s.tools.register({name:'owned-tool',description:'owned',inputSchema:{},executor:{async *execute(){}}});}};
 const b={apiVersion:'0.1',name:'migration-b',specifier:'migration-b',async setup(s){await s.register('KnowledgeIndex',{name:'b'});}};
 registerPlugin(a);await setupPlugin(a,services);const row=scoped.contributions.list('health')[0],tool=services.tools.resolve('owned-tool');registerPlugin(b);await setupPlugin(b,services);
 await unloadPlugin(a.name,services);assert.equal(map.get('KnowledgeIndex').name,'b');assert.equal(row.signal.aborted,true);assert.equal(tool.signal.aborted,true);assert.equal(scoped.contributions.list('health').length,0);
 await unloadPlugin(b.name,services);assert.equal(map.has('KnowledgeIndex'),false);await unloadPlugin(probe.name,services);
});

test('persistent BGE memory contributes to federation without taking over KnowledgeIndex',async()=>{
 const {createPersistKIBGEPlugin}=await import('../local-agent/matbot/packages/plugins/persist-ki-bge/src/plugin.ts');
 const {VaultImpl}=await import('../local-agent/matbot/packages/core/security/src/vault.ts');
 const {services}=host();const singleton={name:'federated'};services.KnowledgeIndex=singleton;services.RetrievalFederation={};services.Vault=new VaultImpl();services.register=async(key,value)=>{services[key]=value;};
 await createPersistKIBGEPlugin().setup(services);assert.equal(services.KnowledgeIndex,singleton);assert.equal(services.contributions.list('retrieval')[0].id,'persistent-memory');assert.ok(services.MemoryWriteSink);
 const selected=profilePlugins('standard',['plugins/persist-ki-bge'],true,name=>'plugins/'+name);assert.ok(!selected.includes('plugins/memory-local'));assert.ok(selected.indexOf('plugins/retrieval-federation')<selected.indexOf('plugins/persist-ki-bge'));
});
