/** Standalone HTTP compatibility host over the plugin's index service. */
import path from 'node:path';
import { FileIndexService } from './service.js';
import { createFileIndexServer } from './http-server.js';
const port=Number(process.env.FILE_INDEX_PORT??8877),host=process.env.CORTEX_FILE_INDEX_HOST??'127.0.0.1';
const service=new FileIndexService({storePath:path.resolve(process.env.FILE_INDEX_STORE??'local-agent/file-index/data/index.json'),workspaceConfigPath:path.resolve(process.env.WORKSPACES_CONFIG??'local-agent/config/workspaces.json'),securityPolicyPath:path.resolve(process.env.SECURITY_POLICY_CONFIG??'local-agent/config/security-policy.json'),maxFileBytes:Number(process.env.FILE_INDEX_MAX_FILE_BYTES??1000000)});
const server=createFileIndexServer(service,process.env.CORTEX_FILE_INDEX_TOKEN);
server.listen(port,host,()=>console.log('file-index listening on http://'+host+':'+port));
