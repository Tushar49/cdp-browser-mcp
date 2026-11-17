// Two loopback SITES (127.0.0.1 vs 127.0.0.2) so the iframe is a real OOPIF.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const sites = [
  { host: '127.0.0.1', port: Number(process.env.TOP_PORT || 8880) },
  { host: '127.0.0.2', port: Number(process.env.INNER_PORT || 8881) },
];

for (const { host, port } of sites) {
  const server = http.createServer((req, res) => {
    const file = (req.url || '/').split('?')[0].replace(/^\//, '') || 'oopif-top.html';
    fs.readFile(path.join(dir, file), (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' });
      res.end(data);
    });
  });
  server.on('error', (e) => { console.error(`bind ${host}:${port} failed: ${e.message}`); process.exit(1); });
  server.listen(port, host, () => console.log(`OOPIF rig: http://${host}:${port}/oopif-top.html`));
}
