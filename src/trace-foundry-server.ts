import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// Only accept Host headers naming loopback or the bound host so a DNS-rebound page cannot read captures.
function hostAllowed(header: string | undefined, bound: string): boolean {
  if (!header) return false;
  let hostname: string;
  try { hostname = new URL(`http://${header}`).hostname.toLowerCase(); } catch { return false; }
  return LOOPBACK_HOSTS.has(hostname) || hostname === bound.toLowerCase() || hostname === `[${bound.toLowerCase()}]`;
}

export function serveTraceFoundry(benchmarkInput: string, port = 3003, host = "127.0.0.1"): Server {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be between 0 and 65535");
  const resolvedRoot = resolve(benchmarkInput, "viewer");
  if (!existsSync(join(resolvedRoot, "index.html"))) throw new Error(`Benchmark viewer not found: ${resolvedRoot}`);
  // Canonicalize once so the per-request realpath check agrees with the root on symlinked paths (macOS /var -> /private/var).
  const root = realpathSync(resolvedRoot), prefix = `${root}${sep}`;
  const server = createServer((request, response) => {
    try {
      if (!hostAllowed(request.headers.host, host)) { response.writeHead(403).end("forbidden"); return; }
      const pathname = decodeURIComponent(new URL(request.url ?? "/", `http://${host}`).pathname);
      const candidate = resolve(root, pathname === "/" ? "index.html" : `.${pathname}`);
      if (candidate !== root && !candidate.startsWith(prefix)) { response.writeHead(403).end("forbidden"); return; }
      if (!existsSync(candidate) || !statSync(candidate).isFile()) { response.writeHead(404).end("not found"); return; }
      // Lexical containment passes for a symlink inside viewer/ pointing elsewhere; check where it really lands.
      const real = realpathSync(candidate);
      if (!real.startsWith(prefix)) { response.writeHead(403).end("forbidden"); return; }
      const ext = extname(real);
      const mime = ext === ".json" ? "application/json" : ext === ".html" ? "text/html; charset=utf-8" : "application/octet-stream";
      response.writeHead(200, { "content-type": mime, "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(readFileSync(real));
    } catch { response.writeHead(400).end("bad request"); }
  });
  server.listen(port, host); return server;
}
