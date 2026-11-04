import { createServer } from 'node:http';
import { existsSync, statSync, createReadStream, readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.mjs';
import { InputError, parseSubmission, parseLimitedJson, normalizeHostname } from './yabs.mjs';
import { parseRawSubmission } from './raw.mjs';
import { isIP } from 'node:net';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_BODY = 1024 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

export function createApp({ databasePath, distPath, uploadLimit = 30, uploadWindowMs = 600_000, nodesPath, plansPath, plans } = {}) {
  function planOptions() {
    const configured = plans ?? JSON.parse(readFileSync(plansPath || resolve(ROOT, 'config/plans.json'), 'utf8'));
    if (!Array.isArray(configured) || configured.length < 1 || configured.length > 1000
      || configured.some(plan => typeof plan !== 'string' || !plan.trim() || plan.length > 100 || /[\x00-\x1f\x7f]/.test(plan))) {
      throw new Error('Plan configuration must contain 1–1000 nonempty plan names of at most 100 characters.');
    }
    const result = configured.map(plan => plan.trim());
    if (new Set(result).size !== result.length) throw new Error('Plan configuration contains duplicate names.');
    return result;
  }
  planOptions();
  const db = openDatabase(databasePath || resolve(ROOT, 'data/servers.sqlite'), { nodesPath });
  const attempts = new Map();
  const dist = resolve(distPath || resolve(ROOT, 'dist'));
  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
      if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, { uploadsEnabled: true, plans: planOptions() });
      if (url.pathname === '/api/servers' && req.method === 'GET') return json(res, 200, db.list());
      const nodeRoute = url.pathname.match(/^\/api\/nodes\/([^/]+)$/);
      if (nodeRoute && req.method === 'GET') {
        let name;
        try { name = normalizeHostname(decodeURIComponent(nodeRoute[1])); } catch { throw new InputError('Invalid node hostname.'); }
        const positiveQuery = (key, fallback, max, min) => {
          if (!url.searchParams.has(key)) return fallback;
          const values = url.searchParams.getAll(key), text = values[0];
          if (values.length !== 1 || !/^\d+$/.test(text)) throw new InputError(`Invalid ${key}.`);
          const number = Number(text);
          if (!Number.isSafeInteger(number) || number < min || number > max) throw new InputError(`Invalid ${key}.`);
          return number;
        };
        const pagination = { limit: positiveQuery('limit', 20, 100, 1), offset: positiveQuery('offset', 0, 10_000_000, 0) };
        return json(res, 200, db.nodeDetails(name, pagination));
      }
      if (['/api/servers', '/api/servers/raw'].includes(url.pathname) && req.method === 'POST') {
        const now = Date.now();
        for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
        const peer = req.socket.remoteAddress || 'unknown';
		const forwarded = req.headers['x-real-ip'];

		const fromLocalProxy = [
		  '127.0.0.1',
		  '::1',
		  '::ffff:127.0.0.1',
		].includes(peer);

		const ip = fromLocalProxy
		  && typeof forwarded === 'string'
		  && isIP(forwarded)
			? forwarded
			: peer;
        const bucket = attempts.get(ip) || { count: 0, until: now + uploadWindowMs };
        if (attempts.size >= 10000 && !attempts.has(ip)) throw new InputError('Uploads are temporarily busy. Try later.', 429);
        attempts.set(ip, bucket);
        if (++bucket.count > uploadLimit) {
          res.setHeader('Retry-After', Math.ceil((bucket.until - now) / 1000));
          throw new InputError('Too many upload attempts. Try again later.', 429);
        }
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new InputError('Expected application/json.', 415);
        if (Number(req.headers['content-length']) > MAX_BODY) throw new InputError('Upload is too large. Maximum request size is 1 MiB.', 413);
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY) throw new InputError('Upload is too large. Maximum request size is 1 MiB.', 413);
          chunks.push(chunk);
        }
        let body;
        try { body = parseLimitedJson(Buffer.concat(chunks).toString('utf8')); } catch { throw new InputError('The submission is not valid JSON.'); }
        const record = url.pathname === '/api/servers/raw' ? parseRawSubmission(body) : parseSubmission(body);
        if (!planOptions().includes(record.plan)) throw new InputError('Choose a plan from the configured list.');
        const result = db.saveSubmission(record);
        return json(res, result.replaced ? 200 : 201, { ...result, serverName: record.serverName });
      }
      if (url.pathname.startsWith('/api/')) throw new InputError('API route not found.', 404);
      if (!['GET', 'HEAD'].includes(req.method)) throw new InputError('Method not allowed.', 405);
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new InputError('Invalid URL.'); }
      let page = pathname === '/' ? 'index.html' : `.${pathname}`;
      if (/^\/nodes\/[^/]+\/?$/.test(pathname)) {
        normalizeHostname(pathname.slice('/nodes/'.length).replace(/\/$/, ''));
        page = 'index.html';
      }
      const file = resolve(dist, page);
      if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile()) throw new InputError('Page not found. Run npm run build before starting the website.', 404);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' });
      if (req.method === 'HEAD') return res.end();
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (!(error instanceof InputError)) console.error('Request failed:', error.message);
      json(res, error.status || 500, { error: error instanceof InputError ? error.message : 'The server could not complete this request.' });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return { server, close: () => new Promise(resolve => server.close(() => { db.close(); resolve(); })) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp({ databasePath: process.env.DATABASE_PATH,
    nodesPath: process.env.NODE_DATABASE_DIR, plansPath: process.env.PLANS_PATH });
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, host, () => console.log(`Server catalog listening on http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
