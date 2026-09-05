import {pathToFileURL} from 'node:url';
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {spawn} from 'node:child_process';import {createServer} from 'node:net';import {once} from 'node:events';
const root=path.resolve('.'),matbot=path.join(root,'local-agent/matbot');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function launch(t,profile,permissions=''){
 const dir=await mkdtemp(path.join(os.tmpdir(),'cortex-profile-'));const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
 const provider=path.join(dir,'provider');await mkdir(provider);await writeFile(path.join(provider,'package.json'),JSON.stringify({name:'migration-provider',type:'module',exports:'./index.mjs',matbotRuntime:['node']}));await writeFile(path.join(provider,'index.mjs'),"export const plugin={apiVersion:'0.1',provider:()=>({name:'fixture',async *complete(){yield {type:'text',text:'ready'};yield {type:'done'};}})};");
 const config=path.join(dir,'matbot.yaml'),text='providers:\n  fixture:\n    module: '+provider.replaceAll('\\','/')+'\n    model: fixture\nplugins:\n  - '+path.join(matbot,'packages/plugins/frontend/web').replaceAll('\\','/')+'\n'+permissions;await writeFile(config,text);
 const workspaceConfig=path.join(dir,'host-roots.json'),policyConfig=path.join(dir,'policy.json');await writeFile(workspaceConfig,JSON.stringify({roots:[{path:dir,mode:'read-write',type:'projects'}],indexExcludedPatterns:[]}));await writeFile(policyConfig,JSON.stringify({deniedPathFragments:[],highRiskExtensions:['.ps1'],maxReadBytes:10000,backupRoot:path.join(dir,'backups')}));
 const child=spawn(process.execPath,['--import',pathToFileURL(path.join(matbot,'apps/cli/register.js')).href,path.join(matbot,'apps/cli/src/index.ts'),'start','--config',config],{cwd:dir,windowsHide:true,env:{...process.env,CORTEX_CAPABILITY_PROFILE:profile,CORTEX_WORKSPACES_FILE:path.join(dir,'registry.json'),CORTEX_WORKSPACE_ID:'default',MATBOT_WEB_PORT:String(port),CORTEX_RAG_V2_MODE:'off',CORTEX_RAG_DISABLE_CUDA:'1',CORTEX_RAG_EMBEDDING_BACKEND:'cpu',WORKSPACES_CONFIG:workspaceConfig,SECURITY_POLICY_CONFIG:policyConfig,FILE_INDEX_STORE:path.join(dir,'index.json')}});
 let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);let exited=false;child.on('exit',()=>exited=true);
 t.after(async()=>{if(!exited){child.kill();await Promise.race([once(child,'exit'),delay(5000)]);if(!exited)child.kill('SIGKILL');}await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 const base='http://127.0.0.1:'+port;for(let attempt=0;attempt<100;attempt++){if(exited)assert.fail('Runtime exited: '+output);try{if((await fetch(base+'/health')).ok)break;}catch{}await delay(100);if(attempt===99)assert.fail('Runtime startup timed out: '+output);}
 // The frontend can bind before later configured plugins finish, so wait for the host readiness log.
 for(let i=0;i<100&&!output.includes('server running');i++)await delay(50);
 assert.match(output,/server running/);assert.equal(await readFile(config,'utf8'),text,'launch profiles must not rewrite workspace configuration');
 return {base,output,call:async(name,input)=>{const response=await fetch(base+'/tools/'+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});return {status:response.status,body:await response.json()};}};
}
test('standard profile starts with in-process file services, configuration and contributed feature UI',async(t)=>{
 const runtime=await launch(t,'standard');const health=await (await fetch(runtime.base+'/api/diagnostics')).json();const plugins=health.capabilities.find(c=>c.id==='runtime-plugins');assert.deepEqual(plugins.details.missing,[],'every selected plugin should load: '+runtime.output);assert.ok(health.capabilities.some(c=>c.id==='file-index'));
 const index=await runtime.call('file_index',{action:'status'});assert.equal(index.status,200);assert.equal(index.body.ok,true);
 const configurations=await runtime.call('configuration_action',{action:'list'});assert.ok(configurations.body.some(row=>row.id==='provider-models'));assert.ok(configurations.body.some(row=>row.id==='workspace-rag'));
 const ui=await (await fetch(runtime.base+'/ui/contributions')).json();assert.ok(ui.some(d=>d.id==='configuration'));assert.ok(ui.some(d=>d.id==='diagnostics'));assert.ok(ui.every(d=>d.owner&&d.moduleSource));
});
test('minimal profile exposes no implicit administration or feature panels',async(t)=>{
 const runtime=await launch(t,'minimal');const metadata=await (await fetch(runtime.base+'/providers')).json();assert.deepEqual(metadata.providers,[{name:'fixture'}]);assert.equal((await runtime.call('configuration_action',{action:'list'})).status,404);assert.equal((await runtime.call('plugin',{action:'list'})).status,404);assert.deepEqual(await (await fetch(runtime.base+'/ui/contributions')).json(),[]);
});
test('workspace and diagnostic HTTP adapters enforce the shared host permission policy',async(t)=>{
 const runtime=await launch(t,'standard','permissions:\n  defaultAction: deny\n');
 const response=await fetch(runtime.base+'/workspaces',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Denied'})});assert.equal(response.status,403);assert.equal((await response.json()).code,'permission_denied');
 const diagnostic=await fetch(runtime.base+'/api/diagnostics');assert.equal(diagnostic.status,403);assert.equal((await diagnostic.json()).code,'permission_denied');
});
