# build_eo.py —— 生成单文件 EO 边缘函数 eo.js
#
# 将网盘前端（template.html + static/app.js + static/style.css + favicon.ico）
# 与后端（认证/用户 API + GitHub 代理与下载中转）打包为一份可直接部署到
# 腾讯云 EdgeOne 边缘函数的 eo.js。前端的一切请求（含下载中转）均与站点同源，
# GitHub key 只存在于 EO 服务端，永不出现在用户端。
#
# 用法：
#   python build_eo.py                 # 生成 eo.js 并自动做语法校验（若有 node）
#   CLOUD=owner/repo BRANCH=main python build_eo.py      # 覆盖仓库配置
#
# GitHub key 配置（按优先级，本仓库不保存任何真实 key）：
#   1. 环境变量 GITHUB_KEY
#   2. 本地 .eo-key 文件（已 gitignore，内容为 key 单行文本）
#   3. 都没有时生成脱敏版（key 为占位符，仅可用于查看/测试路由，无法访问 GitHub）

import base64
import os
import shutil
import subprocess
import time

# ==================== 配置 ====================
def load_github_key() -> str:
    key = os.environ.get('GITHUB_KEY', '').strip()
    if key:
        return key
    if os.path.exists('.eo-key'):
        with open('.eo-key', 'r', encoding='utf-8') as f:
            key = f.read().strip()
        if key:
            return key
    print('WARNING: 未找到 GITHUB_KEY 环境变量或 .eo-key 文件，生成脱敏版 eo.js（占位符 key）')
    return 'PUT_YOUR_GITHUB_KEY_HERE'


GITHUB_KEY = load_github_key()
USER_REPO = os.environ.get('USER_REPO', 'boringstudent/cloud-user')      # 用户数据仓库
STORAGE_REPO = os.environ.get('CLOUD', 'boringstudent/cloud-storage')    # 网盘存储仓库
BRANCH = os.environ.get('BRANCH', 'main')

REPO_OWNER = STORAGE_REPO.split('/')[0]
REPO_NAME = STORAGE_REPO.split('/')[1] if '/' in STORAGE_REPO else STORAGE_REPO


def js_tpl_escape(s: str) -> str:
    """转义后放入 JS 模板字面量（反引号字符串）：\\、`、${ 需要转义"""
    return s.replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${')


# ==================== 后端 + 资源装配模板 ====================
# 占位符 __XXX__ 在生成时被真实内容替换
BACKEND = r'''// ============================================================================
// eo.js —— cloud-web 全站一体 EO 边缘函数（由 build_eo.py 生成，请勿直接编辑）
// 前端页面 / 静态资源 + 认证用户 API + GitHub 代理与下载中转，全部经本函数
// 同源提供。GitHub key 仅存在于本函数（服务端）：代理白名单永久拒绝用户数据
// 仓库，用户列表密码字段脱敏为 ***，任何后端数据都不会出现在用户端。
// ============================================================================

// ==================== 配置 ====================
const REPO = '__USER_REPO__';   // GitHub 用户数据仓库（禁止通过下方代理访问）
const BRANCH = '__BRANCH__';
const FILE_PATH = 'user.json';
const GITHUB_KEY = '__GITHUB_KEY__';
// user.json 格式：
// {
//   "boring_student": { "password": "<sha512>", "role": "admin", "avatar": "https://..." },
//   "fx":             { "password": "<sha512>", "role": "user" }
// }
// avatar 为可选头像 URL（与密码同一记录），登录时随 /api/login 响应下发

// 允许经本函数代理访问 GitHub 的存储仓库白名单（owner/repo，小写比较）。
// 前端网盘的文件读写、下载中转全部限制在这些仓库内；其余仓库一律 403。
const STORAGE_REPOS = ['__STORAGE_REPO__'];

// ==================== 外部多代理下载候选池 ====================
// 公共 ghproxy 镜像（仅用于匿名下载加速，写操作永不经过它们）。
// 前端"外部多代理"模式用 ?all=1 拿全量候选后在浏览器侧逐个实测可用性
// （真实下载发生在浏览器，EO 视角的探测结果对浏览器没有代表性）；
// 下方的 EO 服务端探测（默认与 ?probe=api）保留作 EO 视角诊断。
//
// 探测目标：本仓库内的 raw 小文件（EXT_PROBE_TARGET，不再是根路径 /）。
// 探测真实文件比 ping 代理首页更能反映其对 GitHub raw 的转发能力，
// 也不会把"首页正常但转发已坏"的代理误判为可用。
// 注意用标准分支形式（/main/...）而非 refs/heads 形式——前者是所有 ghproxy
// 镜像 URL 正则必定兼容的标准 raw 路径。
const EXT_PROBE_TARGET = 'https://raw.githubusercontent.com/boringstudent/cloud-web/main/xxx.json';
const EXT_PROXY_CANDIDATES = [
  'ghproxy.felicity.land',
  'gh.07150721.xyz',
  'cfgh.ikgy.top',
  'ghproxy.imciel.com',
  'gh.xxooo.cf',
  'github.mlmle.cn',
  'github.cnxiaobai.com',
  'gh.1k.ink',
  'ghproxy.cxkpro.top',
  'tvv.tw',
  'proxy.baguoyuyan.com',
  'gh-proxy.com',
  'gh.dpik.top',
  'gh.39.al',
  'getgit.love8yun.eu.org',
  'fastgit.cc',
  'gp.871201.xyz',
  'gh.chjina.com',
  'gh.shiina-rimo.cafe',
  'gh.198962.xyz',
  '30006000.xyz',
  'github.tianrld.top',
  'github.880824.xyz',
  'github.ihnic.com',
  'github-proxy.lixxing.top',
  'github.zzrbk.xyz',
  'github.boringhex.top',
  'github.ednovas.xyz',
  'git.820828.xyz',
  'kenyu.ggff.net'
];
// 探测结果实例级缓存：5 分钟内不重复探测（边缘实例随时可能重建，重建即重探）
let extProxiesCache = { at: 0, list: null };
const EXT_PROXIES_CACHE_MS = 5 * 60 * 1000;

// ==================== 嵌入的前端资源（构建时烘焙） ====================
const INDEX_HTML = `__INDEX_HTML__`;
const APP_JS = `__APP_JS__`;
const STYLE_CSS = `__STYLE_CSS__`;
const FAVICON_B64 = '__FAVICON_B64__';

// connect-src 放行 CF 下载/上传加速通道（cloud-ecr.pages.dev）与外部多代理
// 下载通道（公共 ghproxy 镜像域名众多且动态筛选，故放行全部 https），
// 否则浏览器会按 CSP 拦截页面到这些域名的 fetch/XHR，导致加速通道永远没有流量
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob: https:; media-src 'self' blob: https:; " +
            "connect-src 'self' https://cloud-ecr.pages.dev https:; " +
            "font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";

// ==================== 入口 ====================
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  try {
    // ---------- GitHub 全量代理（列表/读写/下载中转，key 仅服务端持有） ----------
    if (path.startsWith('/api.github.com/') ||
        path.startsWith('/raw.githubusercontent.com/') ||
        path.startsWith('/github.com/')) {
      return await handleGithubProxy(request, url);
    }

    // ---------- 1. 哈希接口（公开） ----------
    if (path === '/api/hash') {
      const { type, value } = await parseBody(request);
      if (!value || (type !== 'password' && type !== 'key')) {
        return json({ error: 'Params: type=password|key & value=<string>' }, 400);
      }
      return json({ type, value_sha512: await sha512(value) });
    }

    // ---------- 外部多代理候选（公开；探测后只返回当前可用的） ----------
    if (path === '/api/proxies') {
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers: corsHeaders() });
      // ?all=1 返回未探测的完整候选列表（不触网，供排查/测试）
      if (url.searchParams.get('all') === '1') {
        return json({ proxies: EXT_PROXY_CANDIDATES.map(h => 'https://' + h + '/') });
      }
      // ?probe=api 服务端逐个 ping 候选代理存活（经代理请求探测目标文件
      // EXT_PROBE_TARGET，9 秒超时，快速失败自动复测一次，能连上且返回 <500
      // 即正常；结果带 status/err 失败原因），
      // 返回含失败站点的全量结果（前端服务检测用：浏览器直连会触发 CORS 预检
      // 被代理 403）
      if (url.searchParams.get('probe') === 'api') {
        return json({ results: await probeExtProxiesApi() });
      }
      const usable = await listUsableExtProxies();
      return json({ proxies: usable.map(h => 'https://' + h + '/') });
    }

    // ---------- 管理员获取 GitHub 写 key（仅 admin） ----------
    // 前端管理员开启"外部上传"通道后调用：外部 ghproxy 镜像不会注入任何鉴权，
    // blob 直传需要客户端自带 key。key 仅经本接口下发给通过密码哈希校验且
    // role=admin 的账号（普通用户 403、未登录 401）；引用类操作仍固定走 EO，
    // key 即使泄露面也被限制在管理员本人浏览器内。
    if (path === '/api/gitkey') {
      const auth = await requireLogin(request);
      if (!auth.ok) return json({ error: auth.error }, auth.status);
      if (auth.role !== 'admin') return json({ error: 'Permission denied: not an admin' }, 403);
      return json({ key: GITHUB_KEY });
    }

    // ---------- 服务器自身 IP 信息（公开，数据源 cip.cc；HEAD 用于 RTT 测量） ----------
    if (path === '/api/my-ip' || path === '/ip') {
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers: corsHeaders() });
      const info = await getServerIpInfo();
      if (info.error) return json(info, 502);
      return json(info);
    }

    // ---------- 2. 登录（公开，实时校验） ----------
    // password 必须是前端计算好的 SHA-512 哈希，直接与存储哈希比对；
    // 成功响应只含 role，不下发任何 key / key 哈希 / 密码哈希
    if (path === '/api/login') {
      const { username, password } = await parseBody(request);
      if (!username || !password) return json({ error: 'Missing username or password' }, 400);
      if (!isSha512Hex(password)) {
        return json({ error: 'password must be a SHA-512 hex string (hashed by client)' }, 400);
      }

      const { users } = await readUsersFile(true);
      const account = users[username];
      if (!account || account.password !== password) {
        return json({ error: 'Invalid credentials' }, 401);
      }
      return json({
        success: true,
        username,
        role: account.role || 'user',
        avatar: account.avatar || ''   // 头像 URL 与密码同一记录，随登录下发
      });
    }

    // ---------- 3. 用户自助修改密码 ----------
    // password / new_password 均为前端计算好的 SHA-512 哈希；
    // 新密码强度规则（>8 位且含大小写字母与数字）由前端校验，
    // 因为服务端收到的已经是哈希，无法还原明文做强度检查
    if (path === '/api/change-password') {
      const { username, password, new_password } = await parseBody(request);
      if (!username || !password || !new_password) {
        return json({ error: 'Missing username / password / new_password' }, 400);
      }
      if (!isSha512Hex(password) || !isSha512Hex(new_password)) {
        return json({ error: 'password / new_password must be SHA-512 hex strings (hashed by client)' }, 400);
      }

      const result = await mutateUsers(`change password: ${username}`, users => {
        const account = users[username];
        if (!account || account.password !== password) {
          throw new ApiError(401, 'Invalid credentials');
        }
        account.password = new_password;   // 只改这一个字段
        return { success: true, username };
      });
      return json(result);
    }

    // ---------- 3.5 用户自助修改头像 ----------
    // avatar 为图片 URL（http/https，最长 300 字符），空字符串表示清除自定义头像；
    // 存放在 user.json 与密码同一记录，登录时随 /api/login 响应下发
    if (path === '/api/change-avatar') {
      const { username, password, avatar } = await parseBody(request);
      if (!username || !password) {
        return json({ error: 'Missing username or password' }, 400);
      }
      if (!isSha512Hex(password)) {
        return json({ error: 'password must be a SHA-512 hex string (hashed by client)' }, 400);
      }
      const av = (avatar === undefined || avatar === null) ? '' : String(avatar).trim();
      if (av.length > 300) return json({ error: 'avatar URL too long (max 300)' }, 400);
      if (av && !/^https?:\/\//i.test(av)) {
        return json({ error: 'avatar must be an http(s) URL' }, 400);
      }

      const result = await mutateUsers(`change avatar: ${username}`, users => {
        const account = users[username];
        if (!account || account.password !== password) {
          throw new ApiError(401, 'Invalid credentials');
        }
        if (av) account.avatar = av;         // 只改这一个字段
        else delete account.avatar;
        return { success: true, username, avatar: av };
      });
      return json(result);
    }

    // ---------- 4. 用户自助注销账户 ----------
    if (path === '/api/delete-account') {
      const { username, password } = await parseBody(request);
      if (!username || !password) {
        return json({ error: 'Missing username or password' }, 400);
      }
      if (!isSha512Hex(password)) {
        return json({ error: 'password must be a SHA-512 hex string (hashed by client)' }, 400);
      }

      const result = await mutateUsers(`delete account: ${username}`, users => {
        const account = users[username];
        if (!account || account.password !== password) {
          throw new ApiError(401, 'Invalid credentials');
        }
        delete users[username];            // 只删这一个键
        return { success: true, deleted: username };
      });
      return json(result);
    }

    // ---------- 5. 用户管理（仅 admin） ----------
    if (path === '/api/users' || path.startsWith('/api/users/')) {
      // GET 从 query 读取，其余方法从 body 读取（parseBody 已统一支持）
      const body = await parseBody(request);

      const auth = await requireAdmin(body);
      if (!auth.ok) return json({ error: auth.error }, auth.status);

      // 列表（密码哈希脱敏为 ***，不下发任何密码哈希）
      if (path === '/api/users' && request.method === 'GET') {
        const { users } = await readUsersFile();
        const masked = {};
        for (const name of Object.keys(users)) {
          masked[name] = { password: '***', role: users[name].role || 'user', avatar: users[name].avatar || '' };
        }
        return json({ users: masked });
      }

      // 添加用户（password 为前端算好的 SHA-512 哈希，直接存储；avatar 可选）
      if (path === '/api/users' && request.method === 'POST') {
        const { username, password, role, avatar } = body;
        if (!username || !password) return json({ error: 'Missing username or password' }, 400);
        if (!isSha512Hex(password)) {
          return json({ error: 'password must be a SHA-512 hex string (hashed by client)' }, 400);
        }
        const newRole = (role === 'admin') ? 'admin' : 'user';
        const newAvatar = avatar ? String(avatar).trim() : '';
        if (newAvatar && (newAvatar.length > 300 || !/^https?:\/\//i.test(newAvatar))) {
          return json({ error: 'avatar must be an http(s) URL (max 300 chars)' }, 400);
        }
        const result = await mutateUsers(`add user: ${username} (${newRole})`, users => {
          if (users[username]) throw new ApiError(409, 'User already exists');
          users[username] = newAvatar
            ? { password, role: newRole, avatar: newAvatar }   // 只加这一个键
            : { password, role: newRole };
          return { success: true, username, role: newRole };
        });
        return json(result);
      }

      // 修改 / 删除：/api/users/:username
      const target = decodeURIComponent(path.slice('/api/users/'.length));
      if (!target) return json({ error: 'Missing username' }, 400);

      if (request.method === 'PUT' || request.method === 'PATCH') {
        const { password, role, avatar } = body;
        if (!password && !role && avatar === undefined) return json({ error: 'Nothing to update (password/role/avatar)' }, 400);
        if (password && !isSha512Hex(password)) {
          return json({ error: 'password must be a SHA-512 hex string (hashed by client)' }, 400);
        }
        if (avatar !== undefined) {
          const av = String(avatar || '').trim();
          if (av && (av.length > 300 || !/^https?:\/\//i.test(av))) {
            return json({ error: 'avatar must be an http(s) URL (max 300 chars)' }, 400);
          }
        }
        const result = await mutateUsers(`update user: ${target}`, users => {
          if (!users[target]) throw new ApiError(404, 'User not found');
          if (password) users[target].password = password;                 // 只改密码
          if (role) users[target].role = (role === 'admin') ? 'admin' : 'user'; // 只改角色
          if (avatar !== undefined) {
            const av = String(avatar || '').trim();
            if (av) users[target].avatar = av;                             // 只改头像
            else delete users[target].avatar;
          }
          return { success: true, username: target, role: users[target].role };
        });
        return json(result);
      }

      if (request.method === 'DELETE') {
        const result = await mutateUsers(`delete user: ${target}`, users => {
          if (!users[target]) throw new ApiError(404, 'User not found');
          delete users[target];            // 只删这一个键
          return { success: true, deleted: target };
        });
        return json(result);
      }

      return json({ error: 'Method not allowed' }, 405);
    }

    // ---------- 6. 页面背景图中转（前端一切外部请求均收敛到本函数） ----------
    if (path === '/api/bg') {
      return await handleBg(request);
    }

    if (path.startsWith('/api/')) {
      return json({
        error: 'Not found',
        endpoints: [
          'GET/POST /api/hash?type=password|key&value=xxx',
          'GET/HEAD /api/my-ip         (服务器出口 IP 信息；HEAD 用于 RTT 测量)',
          'GET/POST /api/login?username=xxx&password=<sha512>',
          'POST   /api/change-password  {username, password:<sha512>, new_password:<sha512>}',
          'POST   /api/change-avatar    {username, password:<sha512>, avatar}',
          'POST   /api/delete-account   {username, password:<sha512>}',
          'GET    /api/users            (admin, admin_pass:<sha512>)',
          'POST   /api/users            {admin_user, admin_pass:<sha512>, username, password:<sha512>, role, avatar?}',
          'PUT    /api/users/:username  {admin_user, admin_pass:<sha512>, password?:<sha512>, role?, avatar?}',
          'DELETE /api/users/:username  {admin_user, admin_pass:<sha512>}',
          'GET    /api/bg               (页面背景图中转)',
          '*      /api.github.com/<path>           (GitHub REST API 代理，限白名单仓库)',
          '*      /raw.githubusercontent.com/<path> (raw 下载中转，限白名单仓库)',
          '*      /github.com/<owner>/<repo>/archive/<ref>.zip (整仓打包下载中转)'
        ]
      }, 404);
    }

    // ---------- 7. 前端静态资源 ----------
    if (path === '/static/app.js') {
      return assetResponse(request, APP_JS, 'application/javascript; charset=utf-8');
    }
    if (path === '/static/style.css') {
      return assetResponse(request, STYLE_CSS, 'text/css; charset=utf-8');
    }
    if (path === '/favicon.ico') {
      return faviconResponse(request);
    }

    // ---------- 8. SPA 兜底：所有子路径都返回网盘主页面（路径即目录） ----------
    if (request.method === 'GET' || request.method === 'HEAD') {
      return pageResponse(request);
    }

    return json({ error: 'Not found' }, 404);

  } catch (err) {
    if (err instanceof ApiError) {
      return json({ error: err.message }, err.status);
    }
    return json({ error: 'Server error', detail: String(err && err.message || err) }, 500);
  }
}

// ==================== 前端资源响应 ====================
// 页面不缓存（保证版本迭代即时生效），静态资源带 ?v= 版本戳可长缓存
function pageResponse(request) {
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': CSP,
    ...secHeaders()
  };
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(INDEX_HTML, { status: 200, headers });
}

function assetResponse(request, body, contentType) {
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    ...secHeaders()
  };
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(body, { status: 200, headers });
}

let faviconBytes = null;   // 首次请求时解码并常驻内存，避免重复 base64 解码
function faviconResponse(request) {
  const headers = {
    'Content-Type': 'image/x-icon',
    'Cache-Control': 'public, max-age=86400',
    ...secHeaders()
  };
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  if (!faviconBytes) {
    const bin = atob(FAVICON_B64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    faviconBytes = bytes;
  }
  return new Response(faviconBytes, { status: 200, headers });
}

function secHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  };
}

// ==================== 页面背景图中转 ====================
// 上游随机图接口（302 到图床），跟随重定向后流式透传；仅放行图片类型，
// 短缓存降低重复回源，失败静默 502（页面自动使用纯色背景兜底）
async function handleBg(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'Method not allowed' }, 405);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let res;
  try {
    res = await fetch('https://www.loliapi.com/acg/', {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8'
      }
    });
  } catch (e) {
    clearTimeout(timer);
    return new Response(null, { status: 502 });
  }
  clearTimeout(timer);
  const ct = res.headers.get('Content-Type') || '';
  if (!res.ok || !ct.startsWith('image/')) {
    return new Response(null, { status: 502 });
  }
  const headers = {
    'Content-Type': ct,
    'Cache-Control': 'public, max-age=300',
    ...secHeaders()
  };
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(res.body, { status: 200, headers });
}

// ==================== GitHub 代理（含下载中转） ====================
// - 仅放行 STORAGE_REPOS 白名单仓库；用户数据仓库（含密码哈希）永远 403，
//   保证 key 与任何后端数据都不会到达用户端。
// - GET/HEAD（浏览、下载、预览）公开；写操作（PUT/DELETE 等）必须携带
//   X-Auth-User / X-Auth-Pass（密码 SHA-512 哈希），服务端校验通过后才代理。
// - Authorization: Bearer <GITHUB_KEY> 由本函数注入，客户端永远不接触 key。
async function handleGithubProxy(request, url) {
  if (!/^(GET|HEAD|POST|PUT|DELETE|PATCH)$/.test(request.method)) {
    return json({ error: 'Method not allowed' }, 405);
  }

  const segs = url.pathname.split('/').filter(Boolean);
  const host = segs[0];
  let owner = '', repo = '';

  if (host === 'api.github.com') {
    // /api.github.com/repos/<owner>/<repo>/...
    if (segs[1] !== 'repos' || segs.length < 4) {
      return json({ error: 'Forbidden path' }, 403);
    }
    owner = segs[2]; repo = segs[3];
  } else if (host === 'raw.githubusercontent.com') {
    // /raw.githubusercontent.com/<owner>/<repo>/<branch>/...
    if (segs.length < 4) {
      return json({ error: 'Forbidden path' }, 403);
    }
    owner = segs[1]; repo = segs[2];
  } else if (host === 'github.com') {
    // /github.com/<owner>/<repo>/archive/... （仅整仓打包下载）
    if (segs.length < 4 || segs[3] !== 'archive') {
      return json({ error: 'Forbidden path' }, 403);
    }
    owner = segs[1]; repo = segs[2];
  } else {
    return json({ error: 'Forbidden host' }, 403);
  }

  const full = (owner + '/' + repo).toLowerCase();
  if (full === REPO.toLowerCase()) {
    return json({ error: 'Forbidden repo' }, 403);
  }
  if (!STORAGE_REPOS.some(r => r.toLowerCase() === full)) {
    return json({ error: 'Repo not allowed: ' + owner + '/' + repo }, 403);
  }

  // 写操作需要登录用户凭据（密码 SHA-512 哈希，与 /api/login 同一校验口径）
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const auth = await requireLogin(request);
    if (!auth.ok) return json({ error: auth.error }, auth.status);
  }

  const upstream = 'https://' + url.pathname.slice(1) + url.search;

  // 只转发必要请求头，浏览器侧其余头（Origin/Cookie 等）一律丢弃
  const headers = new Headers();
  for (const name of ['content-type', 'accept', 'if-none-match', 'if-modified-since', 'range', 'cache-control', 'pragma']) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  headers.set('User-Agent', 'cloud-eo-edge-function');
  if (host === 'api.github.com') {
    headers.set('Authorization', `Bearer ${GITHUB_KEY}`);
    if (!headers.has('Accept')) headers.set('Accept', 'application/vnd.github+json');
    headers.set('X-GitHub-Api-Version', '2022-11-28');
  } else if (host === 'raw.githubusercontent.com') {
    // raw 对私有仓库同样接受 token 鉴权；公开仓库附带无害
    headers.set('Authorization', `Bearer ${GITHUB_KEY}`);
  }
  // github.com archive 重定向到 codeload（公开仓库免鉴权），不注入 key

  const init = { method: request.method, headers, redirect: 'follow' };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // 请求体流式转发，不落地缓冲，降低大文件上传时的内存占用
    init.body = request.body;
    init.duplex = 'half';
  }

  let res;
  try {
    res = await fetch(upstream, init);
  } catch (e) {
    return json({ error: 'Upstream fetch failed: ' + (e && e.message || e) }, 502);
  }

  // 透传状态码/状态行与响应头（流式 body，不落地），仅剔除敏感头再附加 CORS
  const resHeaders = new Headers(res.headers);
  resHeaders.delete('set-cookie');
  for (const [k, v] of Object.entries(corsHeaders())) resHeaders.set(k, v);
  resHeaders.set('Access-Control-Expose-Headers', '*');
  resHeaders.set('X-Content-Type-Options', 'nosniff');
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: resHeaders
  });
}

// ==================== 业务错误（校验失败等，不写回） ====================
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ==================== 权限校验 ====================
// 代理写操作：请求头 X-Auth-User / X-Auth-Pass（密码 SHA-512 哈希）
async function requireLogin(request) {
  const username = request.headers.get('X-Auth-User') || '';
  const password = request.headers.get('X-Auth-Pass') || '';
  if (!username || !password) {
    return { ok: false, status: 401, error: 'Login required (X-Auth-User / X-Auth-Pass)' };
  }
  if (!isSha512Hex(password)) {
    return { ok: false, status: 400, error: 'X-Auth-Pass must be a SHA-512 hex string (hashed by client)' };
  }
  const { users } = await readUsersFile();
  const account = users[username];
  if (!account || account.password !== password) {
    return { ok: false, status: 401, error: 'Invalid credentials' };
  }
  return { ok: true, username, role: account.role || 'user' };
}

// GET 从 query 读取，其余方法从 body 读取：{ admin_user, admin_pass }
// admin_pass 必须是前端计算好的 SHA-512 哈希
async function requireAdmin(body) {
  const { admin_user, admin_pass } = body;
  if (!admin_user || !admin_pass) {
    return { ok: false, status: 401, error: 'Admin auth required (admin_user / admin_pass)' };
  }
  if (!isSha512Hex(admin_pass)) {
    return { ok: false, status: 400, error: 'admin_pass must be a SHA-512 hex string (hashed by client)' };
  }
  const { users } = await readUsersFile();
  const account = users[admin_user];
  if (!account) return { ok: false, status: 401, error: 'Invalid admin credentials' };
  if (account.password !== admin_pass) {
    return { ok: false, status: 401, error: 'Invalid admin credentials' };
  }
  if ((account.role || 'user') !== 'admin') {
    return { ok: false, status: 403, error: 'Permission denied: not an admin' };
  }
  return { ok: true };
}

// ==================== 服务器 IP 查询（多数据源回退） ====================
// 单一数据源（cip.cc）可能屏蔽某些边缘节点出口 IP，依次尝试
// api.ip.sb → cip.cc → ipinfo.io，任一成功即返回统一结构
// {ip, location, isp, data2, data3}；全部失败返回 error（调用方回 502）。
// 注意：查询到的是边缘函数的出口 IP（即“服务器自己”的 IP）。
async function getServerIpInfo() {
  let lastErr = '';
  for (const query of [queryIpSb, queryCipCc, queryIpinfoIo]) {
    try {
      const info = await query();
      if (info && info.ip) return info;
    } catch (e) {
      lastErr = (e && e.message) || String(e);
    }
  }
  return { error: 'All IP providers failed' + (lastErr ? ': ' + lastErr : '') };
}

async function fetchText(url, headers, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 6000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// 分批限并发执行：单实例一次性发出 30 个子请求会排队甚至触发运行时并发限制，
// 排队的请求白白消耗超时预算导致误报失败；分批后每批墙钟时间≈批内最慢者
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push((async () => {
      while (idx < items.length) {
        const i = idx++;
        out[i] = await fn(items[i]);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

// 单次探测：经代理请求探测目标文件（EXT_PROBE_TARGET），
// 能建立连接且返回 <500 的 HTTP 响应即视为可用；
// 返回 { ok, status, err, rtt }——err 为 'timeout' 或底层错误码，供失败原因展示
async function probeExtProxyOnce(host, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch('https://' + host + '/' + EXT_PROBE_TARGET, {
      method: 'GET',
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'cloud-eo-proxy-probe' }
    });
    // 立刻取消 body，避免悬挂流占用连接
    try { if (res.body) await res.body.cancel(); } catch (e) {}
    return { ok: res.status > 0 && res.status < 500, status: res.status, err: '', rtt: Date.now() - start };
  } catch (e) {
    const err = (e && e.name === 'AbortError') ? 'timeout'
      : String((e && e.cause && e.cause.code) || (e && e.name) || 'error');
    return { ok: false, status: 0, err, rtt: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

// 探测单个外部代理连通性（默认 5 秒超时）：
// 快速失败（连接重置/HTTP 5xx 等，非超时）自动复测一次——边缘节点偶发抖动
// 或代理侧瞬时限流不应把正常代理误判为失败；超时失败不复测（再试大概率仍超时，
// 只会拖慢整轮探测）
async function probeExtProxy(host, timeoutMs) {
  const r = await probeExtProxyOnce(host, timeoutMs || 5000);
  if (r.ok || r.err === 'timeout') return r;
  await new Promise(res => setTimeout(res, 300));
  const r2 = await probeExtProxyOnce(host, 4000);
  return r2.ok ? r2 : r;
}

// 分批探测全部候选代理，只返回当前可用者（实例级缓存 5 分钟）
async function listUsableExtProxies() {
  if (extProxiesCache.list && Date.now() - extProxiesCache.at < EXT_PROXIES_CACHE_MS) {
    return extProxiesCache.list;
  }
  const results = await mapLimited(EXT_PROXY_CANDIDATES, 10, async h => {
    return (await probeExtProxy(h)).ok ? h : null;
  });
  const list = results.filter(Boolean);
  extProxiesCache = { at: Date.now(), list };
  return list;
}

// ping 单个代理存活（9 秒超时，带 RTT 与失败原因）：
// 与 probeExtProxy 相同的快速失败复测策略
async function probeExtProxyApi(host, timeoutMs) {
  const r = await probeExtProxyOnce(host, timeoutMs || 9000);
  if (r.ok || r.err === 'timeout') return r;
  await new Promise(res => setTimeout(res, 300));
  const r2 = await probeExtProxyOnce(host, 5000);
  return r2.ok ? r2 : r;
}

// 分批 ping 全部候选存活，返回含失败站点（status/err 失败原因）的全量结果
// （实例级缓存 5 分钟）
let extProxiesApiCache = { at: 0, results: null };
async function probeExtProxiesApi() {
  if (extProxiesApiCache.results && Date.now() - extProxiesApiCache.at < EXT_PROXIES_CACHE_MS) {
    return extProxiesApiCache.results;
  }
  const results = await mapLimited(EXT_PROXY_CANDIDATES, 8, async h => {
    const r = await probeExtProxyApi(h);
    return { site: 'https://' + h + '/', ok: r.ok, rtt: r.rtt, status: r.status, err: r.err };
  });
  extProxiesApiCache = { at: Date.now(), results };
  return results;
}

// api.ip.sb：JSON 免 key，英文归属地
async function queryIpSb() {
  const d = JSON.parse(await fetchText('https://api.ip.sb/geoip', {
    'User-Agent': 'curl/8.5.0', 'Accept': 'application/json'
  }));
  if (!d.ip) throw new Error('ip.sb: missing ip');
  return {
    ip: d.ip,
    location: [d.country, d.region, d.city].filter(Boolean).join(' '),
    isp: d.isp || d.organization || '',
    data2: (d.asn ? 'AS' + d.asn + ' ' : '') + (d.organization || ''),
    data3: [d.country_code, d.timezone].filter(Boolean).join(' | ')
  };
}

// cip.cc：对 curl 类 UA 返回纯文本；对浏览器 UA 返回 HTML（取 <pre> 块解析）
async function queryCipCc() {
  const text = await fetchText('https://cip.cc/', {
    'User-Agent': 'curl/8.5.0', 'Accept': '*/*'
  });
  const parsed = parseCipCc(text);
  if (!parsed.ip) throw new Error('cip.cc: parse failed');
  return parsed;
}

// ipinfo.io：JSON 免 key（有频率限制，作为最终兜底）
async function queryIpinfoIo() {
  const d = JSON.parse(await fetchText('https://ipinfo.io/json', {
    'User-Agent': 'curl/8.5.0', 'Accept': 'application/json'
  }));
  if (!d.ip) throw new Error('ipinfo.io: missing ip');
  return {
    ip: d.ip,
    location: [d.country, d.region, d.city].filter(Boolean).join(' '),
    isp: d.org || '',
    data2: d.timezone || '',
    data3: d.loc || ''
  };
}

// 解析 cip.cc 的文本（或其 HTML 中 <pre> 块内的文本），
// 兼容「IP : 8.8.8.8」和「IP\t: 8.8.8.8」两种分隔，兼容全角冒号
function parseCipCc(text) {
  const pre = text.match(/<pre>([\s\S]*?)<\/pre>/i);
  const body = (pre ? pre[1] : text)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  const out = {};
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*([^:：]+?)\s*[:：]\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (key === 'IP')          out.ip = val;
    else if (key === '地址')   out.location = val;
    else if (key === '运营商') out.isp = val;
    else if (key === '数据二') out.data2 = val;
    else if (key === '数据三') out.data3 = val;
  }
  return out;
}

// ==================== 工具函数 ====================
// 校验是否为合法的 SHA-512 十六进制哈希（128 位 hex）
function isSha512Hex(v) {
  return typeof v === 'string' && /^[0-9a-f]{128}$/i.test(v);
}

async function sha512(text) {
  const buf = await crypto.subtle.digest('SHA-512', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function parseBody(request) {
  if (request.method === 'GET') {
    const out = {};
    new URL(request.url).searchParams.forEach((v, k) => out[k] = v);
    return out;
  }
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('application/json')) return await request.json().catch(() => ({}));
  if (ct.includes('application/x-www-form-urlencoded')) {
    const out = {};
    new URLSearchParams(await request.text()).forEach((v, k) => out[k] = v);
    return out;
  }
  return {};
}

// ---------- user.json 读取（Contents API：鉴权、实时、无 CDN 缓存，同时拿到 sha） ----------
// 同一边缘实例内做 60s 短缓存：分片上传等场景会对写操作做高频鉴权，
// 缓存可避免每次写都回源读用户文件；登录与写回强制实时读取，
// 写成功后立即刷新缓存（改密/注销同实例即时生效，跨实例最多滞后 60s）。
let usersCache = null;   // { at, users, sha }
const USERS_CACHE_TTL = 60 * 1000;

async function readUsersFile(fresh) {
  if (!fresh && usersCache && Date.now() - usersCache.at < USERS_CACHE_TTL) {
    return usersCache;
  }
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`,
    { headers: ghHeaders() }
  );
  if (!res.ok) throw new Error('GitHub read failed: HTTP ' + res.status);
  const file = await res.json();
  usersCache = { at: Date.now(), users: JSON.parse(b64decode(file.content)), sha: file.sha };
  return usersCache;
}

// ---------- 单点变更写回 ----------
// mutate(users) 闭包内只改目标用户的那一个字段；
// 校验失败抛 ApiError（不写回）；PUT 遇 409（并发提交移动了引用）时
// 重新读取最新内容、重放同一变更后重试，最多 3 次，互不覆盖。
async function mutateUsers(message, mutate) {
  const api = `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { users, sha } = await readUsersFile(true);
    const result = mutate(users);
    const put = await fetch(api, {
      method: 'PUT',
      headers: ghHeaders(),
      body: JSON.stringify({
        message,
        content: b64encode(JSON.stringify(users, null, 2)),
        sha,
        branch: BRANCH
      })
    });
    if (put.ok) {
      // 写成功立即刷新实例缓存，保证同实例后续鉴权拿到最新数据
      let newSha = sha;
      try { newSha = (await put.json()).content.sha || sha; } catch (e) {}
      usersCache = { at: Date.now(), users, sha: newSha };
      return result;
    }
    if (put.status === 409 && attempt < 2) continue;
    throw new Error('GitHub write failed: ' + put.status + ' ' + await put.text());
  }
}

function ghHeaders() {
  return {
    'Authorization': `Bearer ${GITHUB_KEY}`,
    'User-Agent': 'cloud-eo-edge-function',
    'Accept': 'application/vnd.github+json'
  };
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Pragma, Expires, Authorization, X-Requested-With, If-None-Match, If-Modified-Since, Range, X-Auth-User, X-Auth-Pass',
    'Access-Control-Max-Age': '86400'
  };
}
'''


def build():
    version = str(int(time.time()))

    # ---- 渲染前端模板（与 build.py 同一套占位符） ----
    # newline='' 保留文件原始换行符，使嵌入资源与源文件字节级一致
    with open('template.html', 'r', encoding='utf-8', newline='') as f:
        template = f.read()
    index_html = template.format(
        title='Home',
        repo_owner=REPO_OWNER,
        repo_name=REPO_NAME,
        default_branch=BRANCH,
        version=version
    )

    with open('static/app.js', 'r', encoding='utf-8', newline='') as f:
        app_js = f.read()
    with open('static/style.css', 'r', encoding='utf-8', newline='') as f:
        style_css = f.read()
    with open('favicon.ico', 'rb') as f:
        favicon_b64 = base64.b64encode(f.read()).decode('ascii')

    # ---- 装配 eo.js ----
    out = BACKEND
    out = out.replace('__USER_REPO__', USER_REPO)
    out = out.replace('__BRANCH__', BRANCH)
    out = out.replace('__GITHUB_KEY__', GITHUB_KEY)
    out = out.replace('__STORAGE_REPO__', STORAGE_REPO)
    out = out.replace('__INDEX_HTML__', js_tpl_escape(index_html))
    out = out.replace('__APP_JS__', js_tpl_escape(app_js))
    out = out.replace('__STYLE_CSS__', js_tpl_escape(style_css))
    out = out.replace('__FAVICON_B64__', favicon_b64)

    with open('eo.js', 'w', encoding='utf-8', newline='\n') as f:
        f.write(out)

    # 保持根目录 404.html 与 template.html 一致（历史约定）
    shutil.copyfile('template.html', '404.html')

    size_kb = len(out.encode('utf-8')) / 1024
    print(f'Build completed. eo.js: {size_kb:.0f} KB, storage repo: {STORAGE_REPO}, version: {version}')

    # ---- 语法自验（环境里有 node 时） ----
    node = shutil.which('node')
    if node:
        r = subprocess.run([node, '--check', 'eo.js'], capture_output=True, text=True)
        if r.returncode == 0:
            print('node --check eo.js: OK')
        else:
            print('node --check eo.js: FAILED')
            print(r.stderr)
            raise SystemExit(1)


if __name__ == '__main__':
    build()
