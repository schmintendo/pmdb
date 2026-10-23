import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const backend = spawn(process.execPath, [fileURLToPath(new URL('../server/index.mjs', import.meta.url))], { stdio: 'inherit', env: { ...process.env, HOST: '127.0.0.1', PORT: '3000' } });
const vite = await createServer({ server: { host: '127.0.0.1' } });
await vite.listen();
vite.printUrls();
async function stop() { backend.kill(); await vite.close(); process.exit(0); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
backend.on('exit', async code => { await vite.close(); process.exit(code || 0); });
