// simple static server for local dev / smoke testing
import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = process.env.PORT || 8791;
const ROOT = process.cwd();
const types = { '.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json','.png':'image/png' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  const ext = path.extname(file);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': (types[ext] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} already in use — kill existing server or run:  $env:PORT=8792; node server.mjs`);
    console.error(`  netstat -ano | findstr :${PORT}  then  Stop-Process -Id <PID> -Force`);
    process.exit(1);
  } else throw err;
});
server.listen(PORT, () => console.log('serving http://localhost:' + PORT));