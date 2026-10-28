import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8877);
http.createServer((req, res) => {
  const file = req.url === '/' ? 'rig.html' : req.url.replace(/^\//, '').split('?')[0];
  fs.readFile(path.join(dir, file), (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`WS0 rig on http://127.0.0.1:${port}/rig.html`));
