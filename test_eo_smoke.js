// eo.js 本地冒烟测试：用 Node 模拟 fetch 事件，验证路由/资源/安全，不触网
const fs = require('fs');
const crypto = require('crypto');

let handler = null;
global.addEventListener = (type, fn) => { if (type === 'fetch') handler = fn; };
eval(fs.readFileSync(__dirname + '/eo.js', 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')); }
}

async function call(path, opts) {
  const req = new Request('https://eo.local' + path, opts);
  let resp;
  handler({ request: req, respondWith(p) { resp = p; } });
  return await resp;
}

(async () => {
  // 1. 主页面
  let r = await call('/');
  let body = await r.text();
  check('GET / -> 200 HTML', r.status === 200 && (r.headers.get('Content-Type') || '').includes('text/html'));
  check('HTML 注入 __APP__', body.includes('window.__APP__') && body.includes("repoOwner: 'boringstudent'") && body.includes("repoName: 'cloud-storage'"));
  check('HTML 无外部 preconnect', !body.includes('api.github.com') && !body.includes('boring-student.cn') && !body.includes('loliapi.com'));
  check('HTML 有 CSP 头', !!r.headers.get('Content-Security-Policy'));

  // 2. 静态资源逐字还原
  r = await call('/static/app.js?v=1');
  body = await r.text();
  const appJs = fs.readFileSync(__dirname + '/static/app.js', 'utf8');
  check('GET /static/app.js 与原文件逐字一致', body === appJs, `len ${body.length} vs ${appJs.length}`);
  check('app.js 不含任何 key/令牌', !/ghp_|GITHUB_KEY|bearer/i.test(body));
  check('app.js 不含旧后端域名', !body.includes('boring-student') && !body.includes('cloud-ecr') && !body.includes('redeem-key'));

  r = await call('/static/style.css?v=1');
  body = await r.text();
  const css = fs.readFileSync(__dirname + '/static/style.css', 'utf8');
  check('GET /static/style.css 与原文件逐字一致', body === css);
  check('CSS 背景图走 /api/bg', body.includes("url('/api/bg')") && !body.includes('loliapi.com'));

  // 3. favicon 字节一致
  r = await call('/favicon.ico');
  const buf = Buffer.from(await r.arrayBuffer());
  const ico = fs.readFileSync(__dirname + '/favicon.ico');
  check('GET /favicon.ico 200 且类型正确', r.status === 200 && r.headers.get('Content-Type') === 'image/x-icon');
  check('favicon 字节一致', crypto.createHash('md5').update(buf).digest('hex') === crypto.createHash('md5').update(ico).digest('hex'));

  // 4. SPA 兜底
  r = await call('/photos/2024/');
  check('GET /photos/2024/ -> SPA HTML', r.status === 200 && (r.headers.get('Content-Type') || '').includes('text/html'));

  // 5. OPTIONS
  r = await call('/api/login', { method: 'OPTIONS' });
  check('OPTIONS -> 204 CORS', r.status === 204 && r.headers.get('Access-Control-Allow-Origin') === '*');

  // 6. hash 接口
  r = await call('/api/hash?type=password&value=test');
  const j = await r.json();
  const expect = crypto.createHash('sha512').update('test').digest('hex');
  check('GET /api/hash 计算正确', j.value_sha512 === expect);
  r = await call('/api/hash?type=bad&value=x');
  check('GET /api/hash 非法 type -> 400', r.status === 400);

  // 7. 代理安全：用户仓库永拒 / 非白名单仓库拒绝 / 畸形路径拒绝（均不触网）
  r = await call('/api.github.com/repos/boringstudent/cloud-user/contents/user.json');
  check('代理拒绝用户数据仓库', r.status === 403);
  r = await call('/raw.githubusercontent.com/other/repo/main/a.txt');
  check('代理拒绝非白名单仓库', r.status === 403);
  r = await call('/api.github.com/user');
  check('代理拒绝非 repos 路径', r.status === 403);
  r = await call('/github.com/boringstudent/cloud-storage/releases/latest');
  check('代理仅放行 archive 路径', r.status === 403);

  // 8. 代理写操作缺凭据 -> 401（不触网）
  r = await call('/api.github.com/repos/boringstudent/cloud-storage/contents/a.txt', { method: 'PUT' });
  check('代理写操作缺凭据 -> 401', r.status === 401);
  r = await call('/api.github.com/repos/boringstudent/cloud-storage/contents/a.txt', { method: 'PUT', headers: { 'X-Auth-User': 'x', 'X-Auth-Pass': 'nothex' } });
  check('代理写操作非法哈希 -> 400', r.status === 400);

  // 9. HEAD 轻量检查（不触网）
  r = await call('/api/my-ip', { method: 'HEAD' });
  check('HEAD /api/my-ip -> 200', r.status === 200);
  r = await call('/static/app.js', { method: 'HEAD' });
  check('HEAD /static/app.js -> 200 无 body', r.status === 200 && (await r.text()) === '');

  // 10. 未知 API -> JSON 404；登录参数缺失 -> 400（不触网）
  r = await call('/api/nope');
  check('未知 /api/* -> JSON 404', r.status === 404 && (r.headers.get('Content-Type') || '').includes('application/json'));
  r = await call('/api/login');
  check('登录缺参数 -> 400', r.status === 400);
  r = await call('/api/login?username=a&password=plain');
  check('登录明文密码 -> 400', r.status === 400);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
