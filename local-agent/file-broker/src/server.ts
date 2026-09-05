/** Standalone compatibility host; policy and file operations are owned by HostFileAccessService. */
import path from 'node:path';
import { HostFileAccessService } from './service.js';
import { createFileBrokerServer } from './http-server.js';
const port=Number(process.env.FILE_BROKER_PORT??8878);
const host=process.env.CORTEX_BROKER_HOST??'127.0.0.1';
const service=new HostFileAccessService({ workspaceConfigPath:path.resolve(process.env.WORKSPACES_CONFIG??'local-agent/config/workspaces.json'),securityPolicyPath:path.resolve(process.env.SECURITY_POLICY_CONFIG??'local-agent/config/security-policy.json'),...(process.env.CORTEX_FILE_BROKER_BACKUP_ROOT?{backupRoot:process.env.CORTEX_FILE_BROKER_BACKUP_ROOT}:{}) });
const server=createFileBrokerServer(service,process.env.CORTEX_FILE_BROKER_TOKEN);
server.listen(port,host,()=>console.log('file-broker listening on http://'+host+':'+port));
