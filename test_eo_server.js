// 本地 EO 模拟服务器：把 eo.js 的 fetch 处理器包装成 HTTP 服务，用于端到端测试
// 用法: node test_eo_server.js [port]
const fs = require('fs');
const http = require('http');

let handler = null;
global.addEventListener = (type, fn) => { if (type === 'fetch') handler = fn; };
eval(fs.readFileSync(__dirname + '/eo.js', 'utf8'));

const port = parseInt(process.argv[2] || '3210', 10);

http.createServer(async (nodeReq, nodeRes) => {
  try {
    const chunks = [];
    nodeReq.on('data', c => chunks.push(c));
    nodeReq.on('end', async () => {
      try {
        const url = 'http://localhost:' + port + nodeReq.url;
        const headers = new Headers();
        for (const k of Object.keys(nodeReq.headers)) headers.set(k, nodeReq.headers[k]);
        const init = { method: nodeReq.method, headers };
        if (nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD') {
          init.body = Buffer.concat(chunks);
        }
        let resp;
        handler({ request: new Request(url, init), respondWith(p) { resp = p; } });
        const r = await resp;
        // 先完整缓冲再写响应：上游中途断流时 arrayBuffer 抛错，
        // 此时尚未 writeHead，可正常返回 500 而不至于崩溃
        const buf = (nodeReq.method === 'HEAD' || !r.body) ? null : Buffer.from(await r.arrayBuffer());
        const outHeaders = {};
        // Node undici 会自动解压 gzip 但保留原始头，转发时剔除以免长度/编码不匹配
        //（真实 EO 运行时为字节级透传，无此问题）
        r.headers.forEach((v, k) => {
          if (k !== 'content-encoding' && k !== 'content-length' && k !== 'transfer-encoding') outHeaders[k] = v;
        });
        nodeRes.writeHead(r.status, outHeaders);
        nodeRes.end(buf);
      } catch (e) {
        if (!nodeRes.headersSent) {
          nodeRes.writeHead(500, { 'Content-Type': 'text/plain' });
        }
        nodeRes.end('handler error: ' + (e && e.stack || e));
      }
    });
  } catch (e) {
    nodeRes.writeHead(500);
    nodeRes.end(String(e));
  }
}).listen(port, () => console.log('EO local server: http://localhost:' + port));
