import { createServer } from "node:http";

/** Start a local programmable HTTP sidecar and retain every request for assertions. */
export async function startHttpSidecar(routes = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const key = `${request.method ?? "GET"} ${url.pathname}`;
    requests.push({ key, method: request.method ?? "GET", path: url.pathname, raw, headers: request.headers });
    const handler = routes[key] ?? routes[url.pathname];
    if (!handler) { response.writeHead(404); response.end(); return; }
    try {
      const result = await handler({ request, url, raw, requests });
      if (response.writableEnded) return;
      response.writeHead(result?.status ?? 200, { "content-type": "application/json", ...(result?.headers ?? {}) });
      response.end(result?.body === undefined ? "" : typeof result.body === "string" ? result.body : JSON.stringify(result.body));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP sidecar did not bind to TCP.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
