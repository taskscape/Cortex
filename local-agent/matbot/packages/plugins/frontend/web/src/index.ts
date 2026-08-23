/** Web frontend plugin barrel: HTTP+SSE chat server for Node. */
export { createWebServer, defaultWebPrincipal } from './server.js';
export type { WebServerDeps, WebPrincipalResolver } from './server.js';
export { plugin } from './plugin.js';
