var APP = window.__APP__ || {};
var REPO_OWNER = APP.repoOwner || '';
var REPO_NAME = APP.repoName || '';
var DEFAULT_BRANCH = APP.defaultBranch || 'main';
// 站点整体运行于 EO 边缘函数：页面、认证 API、GitHub 读写与下载中转全部同源，
// GitHub key 由 EO 在服务端注入，客户端不持有任何后端凭据
var API_BASE = '';

// 所有 GitHub 请求统一改写为 EO 同源代理路径：/api.github.com/... 等，
// 下载中转（raw / archive zip）同样经 EO
function ghUrl(url) {
    return '/' + url.replace(/^https?:\/\//, '');
}

// ---- 下载多通道：EO（同源，服务端注入 key，稳定无限流）+ CF 代理（匿名公开仓库可访问）
// + 可选外部多代理（公共 ghproxy 镜像，详见"外部多代理"区块） ----
// 大文件分段并行下载时段在各通道间按在途均衡 + 实测速率加权分配，聚合多条链路的带宽；
// 段失败自动换源重试，CF/外部代理连续失败即熔断，剩余段全部回退 EO，保证最终可用性。
// 写操作默认只走 EO——GitHub key 永不下发浏览器；仅当 CF 侧配置了服务端 key 时，
// blob 传输才会分流到 CF 通道，引用类操作（提交/删除）始终固定走 EO；
// 提交冲突由 409/sha 竞争重试算法保证安全。
var CF_PROXY_BASE = 'https://cloud-ecr.pages.dev/';
var DUAL_DL_MIN = 2 * 1024 * 1024;   // 大于 2MB 才启用分段双通道
var DUAL_DL_PARTS = 12;              // 分段数（多于并发数，调度器滚动补位）
var DUAL_SEG_MAX_ATTEMPTS = 3;       // 单段最大尝试次数（每次换源）

function cfRawUrl(filePath) {
    return CF_PROXY_BASE + 'raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME + '/' + DEFAULT_BRANCH + '/' + encodeURI(filePath);
}

function cfApiUrl(filePath) {
    return CF_PROXY_BASE + 'api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + encodeURI(filePath);
}

// ---- 外部多代理下载通道（可选，公共 ghproxy 镜像，仅匿名下载加速） ----
// 候选列表由同源 /api/proxies 动态下发（EO 探测后只返回当前可用的）；
// 在下载进度卡片上开启"多代理"后启用：段/片在 EO / CF / 外部代理间
// 按在途均衡 + 实测速率加权分配；单个代理连续失败 2 次即熔断轮换，
// 全部外部代理熔断后外部通道整体退出，剩余任务回退 EO/CF。
var EXT_PROXY_API = '/api/proxies';
var EXT_PROXY_STORAGE_KEY = 'cloud_web_ext_proxy';
var extProxyState = {
    enabled: false,   // 用户开关（持久化于 localStorage）
    list: [],         // 可用代理 base 数组（'https://host/'）
    loading: null,    // 进行中的拉取回调队列（null=空闲）
    rr: 0,            // 代理轮询游标
    fails: {},        // base -> 连续失败次数（>=2 熔断）
    ul404: {}         // base -> 上传 404 累计次数（>=5 永久封禁该代理的上传）
};
// 部分外部镜像只代理 raw 下载、不代理 api.github.com：blob 上传会持续 404，
// 累计 5 次即判定该代理不支持 API，永久移出上传通道（下载不受影响）
var EXT_UL_404_BAN = 5;

// 代理池是否有未熔断的可用代理（不区分下载/上传开关）
function extProxiesUsable() {
    if (!extProxyState.list.length) return false;
    for (var i = 0; i < extProxyState.list.length; i++) {
        if ((extProxyState.fails[extProxyState.list[i]] || 0) < 2) return true;
    }
    return false;
}

function extDlAvailable() {
    return extProxyState.enabled && extProxiesUsable();
}

// 轮询挑选一个未熔断的代理；全部熔断返回 null
function extPickBase() {
    var n = extProxyState.list.length;
    for (var k = 0; k < n; k++) {
        var i = (extProxyState.rr + k) % n;
        var base = extProxyState.list[i];
        if ((extProxyState.fails[base] || 0) < 2) {
            extProxyState.rr = (i + 1) % n;
            return base;
        }
    }
    return null;
}

function extNoteFail(base) {
    if (!base) return;
    extProxyState.fails[base] = (extProxyState.fails[base] || 0) + 1;
}

// 上传 404 计数：达到阈值即封禁该代理的上传能力（返回是否已封禁）
function extNoteUpload404(base) {
    if (!base) return false;
    var n = (extProxyState.ul404[base] || 0) + 1;
    extProxyState.ul404[base] = n;
    return n >= EXT_UL_404_BAN;
}

function extUlBanned(base) {
    return (extProxyState.ul404[base] || 0) >= EXT_UL_404_BAN;
}

// 上传通道视角的代理可用性：未熔断且未因 404 被封禁
function extUploadProxiesUsable() {
    if (!extProxyState.list.length) return false;
    for (var i = 0; i < extProxyState.list.length; i++) {
        var base = extProxyState.list[i];
        if ((extProxyState.fails[base] || 0) < 2 && !extUlBanned(base)) return true;
    }
    return false;
}

// 轮询挑选一个可用于上传的代理（跳过熔断与 404 封禁）；无可用返回 null
function extPickUploadBase() {
    var n = extProxyState.list.length;
    for (var k = 0; k < n; k++) {
        var i = (extProxyState.rr + k) % n;
        var base = extProxyState.list[i];
        if ((extProxyState.fails[base] || 0) < 2 && !extUlBanned(base)) {
            extProxyState.rr = (i + 1) % n;
            return base;
        }
    }
    return null;
}

function extRawUrl(base, filePath) {
    return base + 'https://raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME + '/' + DEFAULT_BRANCH + '/' + encodeURI(filePath);
}

function extProxyLoad(cb) {
    if (extProxyState.list.length) {
        cb(extProxyState.list);
        return;
    }
    if (extProxyState.loading) {
        extProxyState.loading.push(cb);
        return;
    }
    var cbs = [cb];
    extProxyState.loading = cbs;
    var xhr = new XMLHttpRequest();
    xhr.open('GET', EXT_PROXY_API, true);
    xhr.onload = function() {
        var list = [];
        try {
            var j = JSON.parse(xhr.responseText);
            if (j && j.proxies && j.proxies.length) list = j.proxies;
        } catch (e) {}
        extProxyState.list = list;
        extProxyState.fails = {};
        extProxyState.loading = null;
        cbs.forEach(function(f) { f(list); });
    };
    xhr.onerror = function() {
        extProxyState.loading = null;
        cbs.forEach(function(f) { f([]); });
    };
    xhr.send();
}

function extProxySetEnabled(on, quiet) {
    extProxyState.enabled = on;
    try {
        localStorage.setItem(EXT_PROXY_STORAGE_KEY, on ? '1' : '0');
    } catch (e) {}
    if (!on) {
        updateDlLegendExtVisibility();
        return;
    }
    extProxyLoad(function(list) {
        updateDlLegendExtVisibility();
        if (!quiet && extProxyState.enabled) {
            showToast(list.length ? ('外部多代理已启用（' + list.length + ' 个可用）') : '暂无可用外部代理，仍走 EO/CF 通道');
            setTimeout(hideToast, 3000);
        }
    });
}

function extProxyRestore() {
    var saved = '0';
    try {
        saved = localStorage.getItem(EXT_PROXY_STORAGE_KEY) || '0';
    } catch (e) {}
    if (saved === '1') {
        var btn = document.getElementById('taskDlExtBtn');
        if (btn) btn.classList.add('active');
        extProxySetEnabled(true, true);
    }
}

// ---- 下载通道开关（EO/CF；外部通道开关即"多代理"按钮） ----
// 与并行数一样实时生效：新调度的段/片立即避开已关闭通道，在途任务自然跑完；
// 至少保留一个可用通道，最后一个通道不允许关闭
var DL_CHAN_STORAGE_KEY = 'cloud_web_dl_chans';
var dlChanSwitch = { eo: true, cf: true };

function dlChanSwitchLoad() {
    try {
        var j = JSON.parse(localStorage.getItem(DL_CHAN_STORAGE_KEY) || 'null');
        if (j && typeof j === 'object') {
            if (j.eo === false || j.eo === true) dlChanSwitch.eo = j.eo;
            if (j.cf === false || j.cf === true) dlChanSwitch.cf = j.cf;
        }
    } catch (e) {}
    if (!dlChanSwitch.eo && !dlChanSwitch.cf) dlChanSwitch.eo = true;   // 兜底
}

function dlChanSwitchSave() {
    try {
        localStorage.setItem(DL_CHAN_STORAGE_KEY, JSON.stringify(dlChanSwitch));
    } catch (e) {}
}

// 切换 EO/CF 下载通道；返回 false 表示被拒绝（最后一个通道不能关）
function dlChanToggle(chan) {
    if (dlChanSwitch[chan] && !dlChanSwitch[chan === 'eo' ? 'cf' : 'eo'] && !extDlAvailable()) {
        return false;
    }
    dlChanSwitch[chan] = !dlChanSwitch[chan];
    dlChanSwitchSave();
    dlNotify();   // 调度器立即按新通道集合补位
    return true;
}

function dlChanBtnRefresh() {
    var pairs = [['taskDlEoBtn', 'eo'], ['taskDlCfBtn', 'cf']];
    for (var i = 0; i < pairs.length; i++) {
        var btn = document.getElementById(pairs[i][0]);
        if (btn) btn.classList.toggle('active', !!dlChanSwitch[pairs[i][1]]);
    }
}

// ---- 上传通道开关（EO/CF/外部）：与并行数一样实时生效（新任务立即避开
// 已关闭通道）；外部上传通道仅限管理员——外部 ghproxy 镜像不注入鉴权，
// blob 直传需自带 GitHub 写 key：key 由 /api/gitkey 仅下发给 admin 且
// 只保存在内存（不持久化）；blob 创建不移动 git 引用（任意并行零冲突），
// 引用类操作（提交）仍固定走 EO，冲突面不变 ----
var UL_CHAN_STORAGE_KEY = 'cloud_web_ul_chans';
var ulChanSwitch = { eo: true, cf: true, ext: false };
var ulGitKey = null;          // 管理员 GitHub 写 key（仅内存）
var ulGitKeyLoading = null;

function isAdminUser() {
    var a = getSavedAuth();
    return !!(a && a.role === 'admin');
}

function ulChanSwitchLoad() {
    try {
        var j = JSON.parse(localStorage.getItem(UL_CHAN_STORAGE_KEY) || 'null');
        if (j && typeof j === 'object') {
            if (j.eo === false || j.eo === true) ulChanSwitch.eo = j.eo;
            if (j.cf === false || j.cf === true) ulChanSwitch.cf = j.cf;
            // 外部上传开关不持久化：key 只存内存，每次会话需管理员重新开启
        }
    } catch (e) {}
    if (!ulChanSwitch.eo && !ulChanSwitch.cf) ulChanSwitch.eo = true;   // 兜底
}

function ulChanSwitchSave() {
    try {
        localStorage.setItem(UL_CHAN_STORAGE_KEY, JSON.stringify({ eo: ulChanSwitch.eo, cf: ulChanSwitch.cf }));
    } catch (e) {}
}

function ulChanBtnRefresh() {
    var pairs = [['ulEoBtn', 'eo'], ['ulCfBtn', 'cf'], ['ulExtBtn', 'ext']];
    for (var i = 0; i < pairs.length; i++) {
        var btn = document.getElementById(pairs[i][0]);
        if (btn) btn.classList.toggle('active', !!ulChanSwitch[pairs[i][1]]);
    }
}

// 拉取管理员 GitHub 写 key（仅内存缓存；cb(key|null)）
function fetchUlGitKey(cb) {
    if (ulGitKey) {
        cb(ulGitKey);
        return;
    }
    if (ulGitKeyLoading) {
        ulGitKeyLoading.push(cb);
        return;
    }
    var cbs = [cb];
    ulGitKeyLoading = cbs;
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/gitkey', true);
    applyEoAuth(xhr);
    xhr.onload = function() {
        var key = null;
        try {
            if (xhr.status === 200) key = JSON.parse(xhr.responseText).key || null;
        } catch (e) {}
        if (key) ulGitKey = key;
        ulGitKeyLoading = null;
        cbs.forEach(function(f) { f(ulGitKey); });
    };
    xhr.onerror = function() {
        ulGitKeyLoading = null;
        cbs.forEach(function(f) { f(null); });
    };
    xhr.send();
}

// 切换上传通道；返回 false 表示被拒绝（最后一个通道不能关）
// 开启外部通道：仅管理员，需成功取得 key 并加载可用代理列表
function ulChanToggle(chan, done) {
    if (chan !== 'ext') {
        if (ulChanSwitch[chan] && !ulChanSwitch[chan === 'eo' ? 'cf' : 'eo'] && !ulChanSwitch.ext) {
            return false;
        }
        ulChanSwitch[chan] = !ulChanSwitch[chan];
        ulChanSwitchSave();
        if (done) done(true);
        return true;
    }
    if (ulChanSwitch.ext) {
        ulChanSwitch.ext = false;
        if (done) done(true);
        return true;
    }
    if (!isAdminUser()) {
        if (done) done(false, '外部上传通道仅限管理员');
        return false;
    }
    if (done) done(null, '正在获取管理员凭据与可用代理...');
    fetchUlGitKey(function(key) {
        if (!key) {
            if (done) done(false, '获取管理员 key 失败，外部上传不可用');
            return;
        }
        extProxyLoad(function(list) {
            if (!list.length) {
                if (done) done(false, '暂无可用外部代理');
                return;
            }
            ulChanSwitch.ext = true;
            if (done) done(true);
        });
    });
    return true;
}

// ---- CF 上传通道能力探测 ----
// CF 代理本身不注入 GitHub key：若部署方在 CF 侧配置了服务端 key，
// 写请求会被鉴权通过（此时浏览器同样不接触 key，key 只在 CF 服务端）；
// 否则 GitHub 返回 401。用必失败的请求体探测，不会创建任何提交。
// 探测结果缓存于会话内；不可用时上传自动仅走 EO，功能无任何影响。
var cfUploadState = null;   // null=未探测, true/false
var cfUploadProbedAt = 0;
var cfUploadHint = '';      // 探测失败时的诊断提示（区分未部署/key 无效）

function probeCfUpload(cb) {
    // 失败结果 60 秒后重探（CF 侧可能后来才配置服务端 key）
    if (cfUploadState !== null && (cfUploadState || Date.now() - cfUploadProbedAt < 60000)) {
        cb(cfUploadState);
        return;
    }
    var xhr = new XMLHttpRequest();
    xhr.open('PUT', cfApiUrl('.cf-write-probe'), true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function() {
        // 仅 400/422 才算可写：鉴权通过、仅因请求体无效被拒；
        // 未鉴权的写请求 GitHub 对公开仓库返回 404（而非 401/403），不能误判为可用
        cfUploadState = xhr.status === 400 || xhr.status === 422;
        // 诊断：新版 cf-worker 注入 key 后响应带 x-cf-auth-injected 标记——
        // 401 且无标记 = CF 未配置 GITHUB_TOKEN 或未部署新版；401 且有标记 = key 无效/无权限
        if (cfUploadState) {
            cfUploadHint = '';
        } else if (xhr.getResponseHeader('x-cf-auth-injected') === '1') {
            cfUploadHint = 'CF 服务端 key 无效或无仓库写权限（请检查 GITHUB_TOKEN 配置）';
        } else {
            cfUploadHint = 'CF 侧未配置服务端 key 或未部署新版 cf-worker.js';
        }
        cfUploadProbedAt = Date.now();
        cb(cfUploadState);
    };
    xhr.onerror = function() {
        cfUploadState = false;
        cfUploadProbedAt = Date.now();
        cb(false);
    };
    xhr.send('not-json');
}

// 写操作（上传/编辑/删除）附加登录凭据头，EO 校验通过后才代理写 GitHub；
// 只读 GET 请求不带凭据
function applyEoAuth(xhr) {
    var a = getSavedAuth();
    if (a && a.u && a.h) {
        xhr.setRequestHeader('X-Auth-User', a.u);
        xhr.setRequestHeader('X-Auth-Pass', a.h);
    }
}

// ---- HTTP cache (ETag conditional requests, 304 responses don't hit rate limits) ----
var httpCache = {};
// After a mutation (upload/edit/delete), bypass proxy/ETag caches for a short window
// so the refreshed list reflects the change immediately.
var noCacheUntil = 0;

function bypassHttpCache() {
    httpCache = {};
    noCacheUntil = Date.now() + 15000;
}

function cachedGet(url, cb) {
    var bypass = Date.now() < noCacheUntil;
    var reqUrl = bypass
        ? url + (url.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now()
        : url;
    var cached = httpCache[url];
    var xhr = new XMLHttpRequest();
    xhr.open('GET', ghUrl(reqUrl), true);
    if (!bypass && cached && cached.etag) {
        xhr.setRequestHeader('If-None-Match', cached.etag);
    }
    xhr.onload = function() {
        if (xhr.status === 304 && cached) {
            cb(304, cached.body, true);
            return;
        }
        if (xhr.status === 200) {
            var etag = xhr.getResponseHeader('ETag');
            if (etag) {
                httpCache[url] = { etag: etag, body: xhr.responseText };
            }
        }
        cb(xhr.status, xhr.responseText, false);
    };
    xhr.onerror = function() { cb(0, '', false); };
    xhr.send();
}

var menuFileInfo = {};
var previewFileInfo = {};
var previewBlobUrl = null;
var fileTreeCache = null;
var menuOpenedAt = 0;

// Media previews create ObjectURLs from Blobs; track and revoke them when the
// modal closes or a new preview starts, so repeated previews don't leak memory.
function setPreviewBlobUrl(url) {
    if (previewBlobUrl) {
        URL.revokeObjectURL(previewBlobUrl);
    }
    previewBlobUrl = url;
}

var previewAbort = null; // 图片流式预览的 AbortController
var previewProbe = null; // 音/视频预览的测速探测请求
var previewMerge = null; // 分片合并预览的取消句柄
var previewAudioVolume = null; // 跨预览记忆用户调节的音量/静音状态
var DEFAULT_AUDIO_VOLUME = 0.2; // 首次预览的默认音量（20%）

// 新建的音频元素应用记忆中的音量（无记忆时用默认 20%），并持续跟踪用户调节
function bindAudioVolume(audioEl) {
    if (previewAudioVolume) {
        try {
            audioEl.volume = previewAudioVolume.v;
            audioEl.muted = previewAudioVolume.m;
        } catch (e) {}
    } else {
        try {
            audioEl.volume = DEFAULT_AUDIO_VOLUME;
        } catch (e) {}
        previewAudioVolume = { v: DEFAULT_AUDIO_VOLUME, m: false };
    }
    audioEl.addEventListener('volumechange', function() {
        previewAudioVolume = { v: audioEl.volume, m: audioEl.muted };
    });
}

// 关闭/切换预览时停止媒体继续缓冲、中断进行中的流式读取与测速探测，避免后台浪费带宽
function stopPreviewMedia() {
    teardownAudioPlaylist();
    if (previewAbort) {
        try { previewAbort.abort(); } catch (e) {}
        previewAbort = null;
    }
    if (previewProbe) {
        var probes = Array.isArray(previewProbe) ? previewProbe.slice() : [previewProbe];
        probes.forEach(function(x) { try { x.abort(); } catch (e) {} });
        previewProbe = null;
    }
    if (previewMerge) {
        previewMerge.cancel();
        previewMerge = null;
    }
    var content = document.getElementById('previewContent');
    if (!content) return;
    var media = content.querySelectorAll('audio, video');
    for (var i = 0; i < media.length; i++) {
        try {
            media[i].pause();
            media[i].removeAttribute('src');
            media[i].load();
        } catch (e) {}
    }
}

var CHUNK_SIZE_LEVELS = [
    Math.floor((47185920 - 4096) * 3 / 4),
    Math.floor((31457280 - 4096) * 3 / 4)
];
var chunkSizeLevel = 0;

function currentChunkLabel() {
    return formatSize(CHUNK_SIZE_LEVELS[chunkSizeLevel]);
}
var PART_SUFFIX = /\.part(\d+)$/;

function getPartNumber(name) {
    var m = name.match(PART_SUFFIX);
    return m ? parseInt(m[1], 10) : 0;
}

var AUTH_STORAGE_KEY = 'cloud_web_auth';
var REMEMBER_STORAGE_KEY = 'cloud_web_remember';
var sessionAuth = null;

function saveAuth(username, hash, role) {
    try {
        localStorage.setItem(AUTH_STORAGE_KEY, btoa(unescape(encodeURIComponent(JSON.stringify({
            v: 2, u: username, h: hash, role: role || 'user'
        })))));
    } catch (e) {}
}

function getSavedAuth() {
    if (sessionAuth) return sessionAuth;
    try {
        var data = localStorage.getItem(AUTH_STORAGE_KEY);
        if (!data) return null;
        var obj = JSON.parse(decodeURIComponent(escape(atob(data))));
        if (obj && obj.v === 2 && obj.u && obj.h) return obj;
        // legacy plaintext format: force re-login once
        clearAuth();
        return null;
    } catch (e) {
        return null;
    }
}

function clearAuth() {
    sessionAuth = null;
    try {
        localStorage.removeItem(AUTH_STORAGE_KEY);
    } catch (e) {}
}

// “记住密码”只存 SHA-512 哈希（v2），不再保存明文：登录时若密码框未被修改，
// 直接用缓存哈希完成登录；明文始终只存在于用户输入的瞬间
var REMEMBER_PWD_PLACEHOLDER = '••••••••••';

function saveRemember(username, pwHash) {
    try {
        localStorage.setItem(REMEMBER_STORAGE_KEY, btoa(unescape(encodeURIComponent(JSON.stringify({
            v: 2, u: username, h: pwHash
        })))));
    } catch (e) {}
}

function getRemember() {
    try {
        var data = localStorage.getItem(REMEMBER_STORAGE_KEY);
        if (!data) return null;
        var obj = JSON.parse(decodeURIComponent(escape(atob(data))));
        if (obj && obj.v === 2 && obj.u && obj.h) return obj;
        // 旧格式（明文）：哈希一次后迁移为 v2，明文随即丢弃
        if (obj && obj.u && obj.p) {
            sha512Hex(obj.p, function(err, hash) {
                if (!err && hash) saveRemember(obj.u, hash);
            });
        }
        return null;
    } catch (e) {
        return null;
    }
}

function clearRemember() {
    try {
        localStorage.removeItem(REMEMBER_STORAGE_KEY);
    } catch (e) {}
}

// ---- auth API（与站点同源的 EO 边缘函数） ----

// Known API error messages shown in Chinese
var API_ERROR_MAP = {
    'Invalid credentials': '账号或密码错误',
    'Invalid admin credentials': '账号或密码错误',
    'Admin auth required (admin_user / admin_pass)': '需要管理员身份验证',
    'Permission denied: not an admin': '权限不足：不是管理员',
    'Missing username / password / new_password': '缺少用户名或密码',
    'Missing username / password': '缺少用户名或密码',
    'Nothing to update (password/role)': '没有需要修改的内容 (password/role)',
    'User already exists': '用户已存在',
    'User not found': '用户不存在',
    'Missing username or password': '缺少用户名或密码',
    'Invalid key hash': '密钥哈希无效',
    'Password must be longer than 8 characters': '新密码长度必须大于 8 位',
    'Password must contain lowercase letters (a-z)': '新密码必须包含小写字母 (a-z)',
    'Password must contain uppercase letters (A-Z)': '新密码必须包含大写字母 (A-Z)',
    'Password must contain digits (0-9)': '新密码必须包含数字 (0-9)'
};

function translateApiError(msg) {
    return API_ERROR_MAP[msg] || msg;
}

// Client-side SHA-512: passwords are hashed locally before being sent to the
// API, so plaintext never leaves the browser (HTTPS aside).
function sha512Hex(text, cb) {
    if (!window.crypto || !crypto.subtle) {
        cb('当前环境不支持加密（需要 HTTPS 环境），无法登录');
        return;
    }
    var data = new TextEncoder().encode(String(text));
    crypto.subtle.digest('SHA-512', data).then(function(buf) {
        var hex = Array.prototype.map.call(new Uint8Array(buf), function(b) {
            return b.toString(16).padStart(2, '0');
        }).join('');
        cb(null, hex);
    }).catch(function() {
        cb('密码加密失败');
    });
}

function apiGetJson(url, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onload = function() {
        if (xhr.status === 200) {
            try {
                cb(null, JSON.parse(xhr.responseText));
            } catch (e) {
                cb('解析响应失败');
            }
        } else {
            var msg = '状态码: ' + xhr.status;
            try {
                var err = JSON.parse(xhr.responseText);
                if (err.error) msg = translateApiError(err.error);
            } catch (e) {}
            cb(msg);
        }
    };
    xhr.onerror = function() { cb('网络错误'); };
    xhr.send();
}

function apiSendJson(method, url, body, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function() {
        if (xhr.status === 200 || xhr.status === 201) {
            try {
                cb(null, JSON.parse(xhr.responseText));
            } catch (e) {
                cb('解析响应失败');
            }
        } else {
            var msg = '状态码: ' + xhr.status;
            try {
                var err = JSON.parse(xhr.responseText);
                if (err.error) msg = translateApiError(err.error);
            } catch (e) {}
            cb(msg);
        }
    };
    xhr.onerror = function() { cb('网络错误'); };
    xhr.send(body ? JSON.stringify(body) : null);
}

// 登录流程：密码在浏览器本地计算 SHA-512 哈希后调用 /api/login（与站点同源），
// 服务端实时校验。persist=true 将 {u, hash, role} 存入 localStorage（"保持登录"），
// 否则仅保留在本标签页会话内。登录后不再获取任何 GitHub key——后续写操作
// 经 X-Auth-User / X-Auth-Pass 请求头由 EO 逐请求实时校验并代为写 GitHub。
function loginUser(username, password, persist, cb) {
    sha512Hex(password, function(err, pwHash) {
        if (err || !pwHash) { cb(err || '密码加密失败'); return; }
        loginWithHash(username, pwHash, persist, cb);
    });
}

// 已持有密码哈希时直接登录（“记住密码”自动填充的场景）；
// 成功回调为 cb(null, pwHash)，便于调用方缓存哈希
function loginWithHash(username, pwHash, persist, cb) {
    apiGetJson(API_BASE + '/api/login?username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(pwHash), function(err2, data) {
        if (err2 || !data || !data.success) {
            cb(err2 || '用户名或密码错误');
            return;
        }
        var role = data.role || 'user';
        if (persist) {
            saveAuth(username, pwHash, role);
        } else {
            sessionAuth = { v: 2, u: username, h: pwHash, role: role };
        }
        updateAuthBtn();
        cb(null, pwHash);
    });
}


// 自动填充记住的账号：密码框填入占位符并把缓存哈希挂在输入框上，
// 用户一旦修改密码框即视为输入了新密码，缓存哈希失效
function fillAuthInputs(usernameId, passwordId, checkboxId) {
    var remembered = getRemember();
    if (remembered) {
        document.getElementById(usernameId).value = remembered.u;
        var pwdInput = document.getElementById(passwordId);
        pwdInput.value = REMEMBER_PWD_PLACEHOLDER;
        pwdInput._rememberedHash = remembered.h;
        if (!pwdInput._rememberBound) {
            pwdInput._rememberBound = true;
            pwdInput.addEventListener('input', function() {
                pwdInput._rememberedHash = null;
            });
        }
        if (checkboxId) document.getElementById(checkboxId).checked = true;
    }
}

// ---- Password visibility toggle (eye icon) ----
// All password inputs get an eye button wrapped at init; no HTML changes needed.
var PWD_EYE_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
var PWD_EYE_OFF_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

function togglePwdEye(btn) {
    var input = btn.parentNode.querySelector('input');
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.innerHTML = show ? PWD_EYE_SVG : PWD_EYE_OFF_SVG;
    btn.title = show ? '隐藏密码' : '显示密码';
}

function initPwdEyes() {
    var inputs = document.querySelectorAll('input[type="password"]');
    for (var i = 0; i < inputs.length; i++) {
        var input = inputs[i];
        var wrap = document.createElement('div');
        wrap.className = 'pwd-wrap';
        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(input);
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pwd-eye';
        btn.title = '显示密码';
        btn.innerHTML = PWD_EYE_OFF_SVG;
        btn.onclick = function() { togglePwdEye(this); };
        wrap.appendChild(btn);
    }
}

// ---- 用户头像：按用户名映射头像 URL，未配置时显示默认人像图标 ----
var USER_AVATAR_MAP = {
    'boringstudent': 'https://q.qlogo.cn/headimg_dl?dst_uin=1972403603&spec=640&img_type=jpg',
    'fx': 'https://q.qlogo.cn/headimg_dl?dst_uin=251104925&spec=640&img_type=jpg'
};
var USER_AVATAR_DEFAULT_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

function userAvatarUrl(username) {
    return USER_AVATAR_MAP[username] || null;
}

function renderUserAvatar() {
    var btn = document.getElementById('userAvatarBtn');
    if (!btn) return;
    var saved = getSavedAuth();
    var url = saved ? userAvatarUrl(saved.u) : null;
    btn.innerHTML = '';
    if (url) {
        var img = document.createElement('img');
        img.alt = saved.u;
        img.referrerPolicy = 'no-referrer';
        img.onerror = function() {
            // 头像加载失败回退默认图标
            btn.innerHTML = USER_AVATAR_DEFAULT_SVG;
        };
        img.src = url;
        btn.appendChild(img);
    } else {
        btn.innerHTML = USER_AVATAR_DEFAULT_SVG;
    }
}

function toggleUserMenu(e) {
    if (e) e.stopPropagation();
    var menu = document.getElementById('userMenu');
    if (menu) menu.classList.toggle('show');
}

function closeUserMenu() {
    var menu = document.getElementById('userMenu');
    if (menu) menu.classList.remove('show');
}

function updateAuthBtn() {
    var btn = document.getElementById('authBtn');
    var wrap = document.getElementById('userMenuWrap');
    var saved = getSavedAuth();
    if (btn) {
        btn.style.display = saved ? 'none' : '';
    }
    if (wrap) {
        wrap.style.display = saved ? '' : 'none';
        if (saved) {
            var nameEl = document.getElementById('userMenuName');
            if (nameEl) nameEl.textContent = saved.u + (saved.role === 'admin' ? '（管理员）' : '');
            var adminItem = document.getElementById('userMenuAdmin');
            if (adminItem) adminItem.style.display = saved.role === 'admin' ? '' : 'none';
            renderUserAvatar();
        } else {
            closeUserMenu();
        }
    }
}

function handleAuthBtnClick() {
    if (getSavedAuth()) {
        logout();
    } else {
        openLoginModal();
    }
}

function openLoginModal() {
    document.getElementById('loginMessage').className = 'message';
    document.getElementById('loginMessage').textContent = '';
    fillAuthInputs('loginUsername', 'loginPassword', 'loginRememberPwd');
    document.getElementById('loginModal').classList.add('show');
}

function closeLoginModal() {
    document.getElementById('loginModal').classList.remove('show');
}

function doLogin() {
    var username = document.getElementById('loginUsername').value;
    var password = document.getElementById('loginPassword').value;
    var rememberPwd = document.getElementById('loginRememberPwd').checked;
    var loginBtn = document.getElementById('loginBtn');

    if (!username || !password) {
        setMsg('loginMessage', '请输入用户名和密码', 'error');
        return;
    }

    loginBtn.disabled = true;
    setMsg('loginMessage', '正在登录...', 'success');

    // 密码框未被修改且挂着缓存哈希：直接哈希登录；否则按新输入的明文哈希后登录
    var pwdInput = document.getElementById('loginPassword');
    var rememberedHash = (password === REMEMBER_PWD_PLACEHOLDER && pwdInput._rememberedHash) || null;
    var doAuth = rememberedHash
        ? function(cb) { loginWithHash(username, rememberedHash, true, cb); }
        : function(cb) { loginUser(username, password, true, cb); };

    // Sessions are always persisted ("保持登录" is the default, no UI toggle)
    doAuth(function(err, pwHash) {
        if (err) {
            setMsg('loginMessage', '登录失败: ' + err, 'error');
            loginBtn.disabled = false;
            return;
        }
        if (rememberPwd) {
            saveRemember(username, pwHash || rememberedHash);
        } else {
            clearRemember();
        }
        setMsg('loginMessage', '登录成功！', 'success');
        setTimeout(function() {
            closeLoginModal();
            document.getElementById('loginBtn').disabled = false;
        }, 1000);
    });
}

function logout() {
    clearAuth();
    updateAuthBtn();
    document.getElementById('deleteUsername').value = '';
    document.getElementById('deletePassword').value = '';
    document.getElementById('loginUsername').value = '';
    var loginPwd = document.getElementById('loginPassword');
    loginPwd.value = '';
    loginPwd._rememberedHash = null;
}

// ---- Self-service account (change password / delete account) ----
function openAccountModal() {
    document.getElementById('accountMessage').className = 'message';
    document.getElementById('accountMessage').textContent = '';
    document.getElementById('cpCurrent').value = '';
    document.getElementById('cpNew').value = '';
    document.getElementById('cpConfirm').value = '';
    document.getElementById('daPassword').value = '';
    document.getElementById('accountModal').classList.add('show');
}

function closeAccountModal() {
    document.getElementById('accountModal').classList.remove('show');
}

function validateNewPassword(p) {
    if (p.length <= 8) return '新密码长度必须大于 8 位';
    if (!/[a-z]/.test(p)) return '新密码必须包含小写字母 (a-z)';
    if (!/[A-Z]/.test(p)) return '新密码必须包含大写字母 (A-Z)';
    if (!/[0-9]/.test(p)) return '新密码必须包含数字 (0-9)';
    return null;
}

function changeOwnPassword() {
    var auth = getSavedAuth();
    if (!auth) {
        setMsg('accountMessage', '请先登录', 'error');
        return;
    }
    var current = document.getElementById('cpCurrent').value;
    var newPwd = document.getElementById('cpNew').value;
    var confirmPwd = document.getElementById('cpConfirm').value;
    if (!current || !newPwd) {
        setMsg('accountMessage', '请输入当前密码和新密码', 'error');
        return;
    }
    if (newPwd !== confirmPwd) {
        setMsg('accountMessage', '两次输入的新密码不一致', 'error');
        return;
    }
    var ruleErr = validateNewPassword(newPwd);
    if (ruleErr) {
        setMsg('accountMessage', ruleErr, 'error');
        return;
    }
    var btn = document.getElementById('cpBtn');
    btn.disabled = true;
    setMsg('accountMessage', '正在修改...', 'success');
    // Hash both the current and the new password locally before sending
    sha512Hex(current, function(err, curHash) {
        if (err || !curHash) {
            setMsg('accountMessage', '修改失败: ' + (err || '密码加密失败'), 'error');
            btn.disabled = false;
            return;
        }
        sha512Hex(newPwd, function(err2, newHash) {
            if (err2 || !newHash) {
                setMsg('accountMessage', '修改失败: ' + (err2 || '密码加密失败'), 'error');
                btn.disabled = false;
                return;
            }
            apiSendJson('POST', API_BASE + '/api/change-password', {
                username: auth.u,
                password: curHash,
                new_password: newHash
            }, function(err3) {
                if (err3) {
                    setMsg('accountMessage', '修改失败: ' + err3, 'error');
                    btn.disabled = false;
                    return;
                }
                // refresh stored credentials with the locally computed new password hash
                if (sessionAuth) {
                    sessionAuth = { v: 2, u: auth.u, h: newHash, role: auth.role };
                } else {
                    saveAuth(auth.u, newHash, auth.role);
                }
                if (getRemember()) {
                    saveRemember(auth.u, newHash);
                }
                setMsg('accountMessage', '密码修改成功！', 'success');
                btn.disabled = false;
                document.getElementById('cpCurrent').value = '';
                document.getElementById('cpNew').value = '';
                document.getElementById('cpConfirm').value = '';
            });
        });
    });
}

function deleteOwnAccount() {
    var auth = getSavedAuth();
    if (!auth) {
        setMsg('accountMessage', '请先登录', 'error');
        return;
    }
    var password = document.getElementById('daPassword').value;
    if (!password) {
        setMsg('accountMessage', '请输入密码以确认注销', 'error');
        return;
    }
    if (!confirm('确定要永久注销账户 ' + auth.u + ' 吗？此操作不可撤销！')) {
        return;
    }
    var btn = document.getElementById('daBtn');
    btn.disabled = true;
    setMsg('accountMessage', '正在注销...', 'success');
    sha512Hex(password, function(err, pwHash) {
        if (err || !pwHash) {
            setMsg('accountMessage', '注销失败: ' + (err || '密码加密失败'), 'error');
            btn.disabled = false;
            return;
        }
        apiSendJson('POST', API_BASE + '/api/delete-account', {
            username: auth.u,
            password: pwHash
        }, function(err2) {
            btn.disabled = false;
            if (err2) {
                setMsg('accountMessage', '注销失败: ' + err2, 'error');
                return;
            }
            clearAuth();
            clearRemember();
            updateAuthBtn();
            closeAccountModal();
            showToast('账户已注销');
            setTimeout(hideToast, 2500);
        });
    });
}

// ---- Admin user management (role=admin only) ----
// 本地缓存的密码哈希即管理员凭据，直接作为 admin_pass 使用；
// EO 服务端对每个管理请求实时校验，无需重复输入密码
function withAdminCreds(cb) {
    var a = getSavedAuth();
    if (!a || a.role !== 'admin') { cb(null); return; }
    cb({ admin_user: a.u, admin_pass: a.h });
}

function openAdminModal() {
    document.getElementById('adminMessage').className = 'message';
    document.getElementById('adminMessage').textContent = '';
    document.getElementById('adminUserList').innerHTML = '<div class="loading">加载中...</div>';
    document.getElementById('adminModal').classList.add('show');
    loadAdminUsers();
}

function closeAdminModal() {
    document.getElementById('adminModal').classList.remove('show');
}

// 用户列表走 /api/users（管理员鉴权），服务端返回脱敏数据（密码字段为 ***），
// 用户数据文件不再经过客户端读取；附加时间戳防止任何中间缓存。
var adminUsersData = null;

function loadAdminUsers() {
    var refreshBtn = document.getElementById('adminRefreshBtn');
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.classList.add('spinning');
    }
    var done = function(err, data) {
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.classList.remove('spinning');
        }
        if (err || !data || typeof data !== 'object') {
            adminUsersData = null;
            var errDiv = document.createElement('div');
            errDiv.className = 'message error';
            errDiv.textContent = '加载失败: ' + (err || '响应异常');
            var listEl = document.getElementById('adminUserList');
            listEl.innerHTML = '';
            listEl.appendChild(errDiv);
            return;
        }
        adminUsersData = data;
        renderAdminUserList();
    };
    withAdminCreds(function(creds) {
        if (!creds) { done('需要管理员权限', null); return; }
        apiGetJson(API_BASE + '/api/users?admin_user=' + encodeURIComponent(creds.admin_user)
            + '&admin_pass=' + encodeURIComponent(creds.admin_pass) + '&_=' + Date.now(),
            function(err, data) {
                if (err || !data || !data.users) { done(err || '响应异常', null); return; }
                done(null, data.users);
            });
    });
}

function toggleAdminUserList() {
    var list = document.getElementById('adminUserList');
    var arrow = document.getElementById('adminListArrow');
    var open = list.style.display !== 'none';
    list.style.display = open ? 'none' : '';
    if (arrow) arrow.textContent = open ? '▸' : '▾';
}

function renderAdminUserList() {
    var container = document.getElementById('adminUserList');
    if (!adminUsersData) {
        container.innerHTML = '<div class="loading">加载中...</div>';
        return;
    }
    container.innerHTML = '';
    var searchEl = document.getElementById('adminSearchInput');
    var keyword = searchEl ? searchEl.value.trim().toLowerCase() : '';
    // admin 靠前，同角色内按字母序；再按搜索关键词过滤
    var names = Object.keys(adminUsersData).sort(function(a, b) {
        var ra = (adminUsersData[a].role || 'user') === 'admin' ? 0 : 1;
        var rb = (adminUsersData[b].role || 'user') === 'admin' ? 0 : 1;
        if (ra !== rb) return ra - rb;
        return a.localeCompare(b);
    });
    if (keyword) {
        names = names.filter(function(n) { return n.toLowerCase().indexOf(keyword) !== -1; });
    }
    if (!names.length) {
        container.innerHTML = '<div class="loading">' + (keyword ? '没有匹配的用户' : '暂无用户') + '</div>';
        return;
    }
    var me = getSavedAuth();
    names.forEach(function(name) {
        var role = adminUsersData[name].role || 'user';
        var row = document.createElement('div');
        row.className = 'admin-user-row';

        var info = document.createElement('span');
        info.className = 'admin-user-info';
        info.textContent = name + ' ';
        var roleTag = document.createElement('span');
        roleTag.className = 'admin-role-tag';
        roleTag.style.background = role === 'admin' ? '#6c5ce7' : '#95a5a6';
        roleTag.textContent = role;
        info.appendChild(roleTag);
        row.appendChild(info);

        var ops = document.createElement('span');
        ops.className = 'admin-user-ops';

        var mkBtn = function(text, bg, fn) {
            var b = document.createElement('button');
            b.className = 'btn';
            b.style.background = bg;
            b.textContent = text;
            b.addEventListener('click', fn);
            return b;
        };

        ops.appendChild(mkBtn('改密', '#2c82c9', function() { adminResetPassword(name); }));
        ops.appendChild(mkBtn(role === 'admin' ? '降为user' : '升为admin', '#e67e22', function() {
            adminChangeRole(name, role === 'admin' ? 'user' : 'admin');
        }));
        if (!me || me.u !== name) {
            ops.appendChild(mkBtn('删除', '#dc3545', function() { adminDeleteUser(name); }));
        }
        row.appendChild(ops);
        container.appendChild(row);
    });
}

function adminAddUser() {
    var username = document.getElementById('adminNewUsername').value.trim();
    var password = document.getElementById('adminNewPassword').value;
    var role = document.getElementById('adminNewRole').value;
    if (!username || !password) {
        setMsg('adminMessage', '请输入用户名和密码', 'error');
        return;
    }
    var btn = document.getElementById('adminAddBtn');
    btn.disabled = true;
    setMsg('adminMessage', '正在添加...', 'success');
    withAdminCreds(function(creds) {
        if (!creds) {
            setMsg('adminMessage', '需要管理员权限或身份验证失败', 'error');
            btn.disabled = false;
            return;
        }
        // hash the new user's password client-side before sending
        sha512Hex(password, function(err, pwHash) {
            if (err || !pwHash) {
                setMsg('adminMessage', '添加失败: ' + (err || '密码加密失败'), 'error');
                btn.disabled = false;
                return;
            }
            var body = {
                admin_user: creds.admin_user,
                admin_pass: creds.admin_pass,
                username: username,
                password: pwHash,
                role: role
            };
            apiSendJson('POST', API_BASE + '/api/users', body, function(err2) {
                btn.disabled = false;
                if (err2) {
                    setMsg('adminMessage', '添加失败: ' + err2, 'error');
                    return;
                }
                setMsg('adminMessage', '添加成功: ' + username, 'success');
                document.getElementById('adminNewUsername').value = '';
                document.getElementById('adminNewPassword').value = '';
                loadAdminUsers();
            });
        });
    });
}

function adminResetPassword(username) {
    var password = prompt('为用户 ' + username + ' 设置新密码（前端加密后传输）:');
    if (!password) return;
    withAdminCreds(function(creds) {
        if (!creds) {
            setMsg('adminMessage', '需要管理员权限或身份验证失败', 'error');
            return;
        }
        setMsg('adminMessage', '正在修改 ' + username + ' 的密码...', 'success');
        sha512Hex(password, function(err, pwHash) {
            if (err || !pwHash) {
                setMsg('adminMessage', '修改失败: ' + (err || '密码加密失败'), 'error');
                return;
            }
            var body = {
                admin_user: creds.admin_user,
                admin_pass: creds.admin_pass,
                password: pwHash
            };
            apiSendJson('PUT', API_BASE + '/api/users/' + encodeURIComponent(username), body, function(err2) {
                if (err2) {
                    setMsg('adminMessage', '修改失败: ' + err2, 'error');
                    return;
                }
                setMsg('adminMessage', '已重置 ' + username + ' 的密码', 'success');
                loadAdminUsers();
            });
        });
    });
}

function adminChangeRole(username, newRole) {
    withAdminCreds(function(creds) {
        if (!creds) {
            setMsg('adminMessage', '需要管理员权限或身份验证失败', 'error');
            return;
        }
        setMsg('adminMessage', '正在修改 ' + username + ' 的角色...', 'success');
        var body = {
            admin_user: creds.admin_user,
            admin_pass: creds.admin_pass,
            role: newRole
        };
        apiSendJson('PUT', API_BASE + '/api/users/' + encodeURIComponent(username), body, function(err) {
            if (err) {
                setMsg('adminMessage', '修改失败: ' + err, 'error');
                return;
            }
            setMsg('adminMessage', '已将 ' + username + ' 调整为 ' + newRole, 'success');
            loadAdminUsers();
        });
    });
}

function adminDeleteUser(username) {
    if (!confirm('确定要删除用户 ' + username + ' 吗？此操作不可撤销。')) return;
    withAdminCreds(function(creds) {
        if (!creds) {
            setMsg('adminMessage', '需要管理员权限或身份验证失败', 'error');
            return;
        }
        setMsg('adminMessage', '正在删除用户 ' + username + '...', 'success');
        apiSendJson('DELETE', API_BASE + '/api/users/' + encodeURIComponent(username), {
            admin_user: creds.admin_user,
            admin_pass: creds.admin_pass
        }, function(err) {
            if (err) {
                setMsg('adminMessage', '删除失败: ' + err, 'error');
                return;
            }
            setMsg('adminMessage', '已删除用户: ' + username, 'success');
            loadAdminUsers();
        });
    });
}

// Auto refresh every 45s with a visible countdown; paused while the tab is hidden
var REFRESH_INTERVAL = 45000;
var nextRefreshAt = Date.now() + REFRESH_INTERVAL;

setInterval(function() {
    if (document.hidden) return;
    var now = Date.now();
    if (now >= nextRefreshAt) {
        nextRefreshAt = now + REFRESH_INTERVAL;
        loadFileList();
        return;
    }
    var el = document.getElementById('refreshCountdown');
    if (el) {
        var text = Math.max(0, Math.ceil((nextRefreshAt - now) / 1000)) + 's';
        if (el.textContent !== text) el.textContent = text;
    }
}, 1000);

document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
        nextRefreshAt = Date.now() + REFRESH_INTERVAL;
        loadFileList();
    }
});

// ---- service status: EO 边缘函数单点检测（页面/API/代理同体），每 10 min 刷新 ----
// RTT 用 HEAD 轻量请求测量：不含响应体传输与服务端地理查询耗时，更接近真实网络延迟
var SVC_CHECK_INTERVAL = 10 * 60 * 1000;
var svcStatus = { api: null };
var svcChecking = false;
var svcCheckGen = 0;    // 代数令牌：被取代的旧检测回调一律忽略
var svcCheckXhrs = [];  // 当前轮次在途请求，供强制重检时中止

// 浏览器无法 ICMP ping，以请求往返时间（RTT）作为延时
function measureRtt(url, cb) {
    var xhr = new XMLHttpRequest();
    var done = function(rtt) {
        if (done.called) return;
        done.called = true;
        cb(rtt);
    };
    var timer = setTimeout(function() { xhr.abort(); done(null); }, 15000);
    xhr.open('HEAD', url + (url.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now(), true);
    xhr.setRequestHeader('Cache-Control', 'no-cache');
    var startTs = performance.now();
    xhr.onload = function() { clearTimeout(timer); done(Math.round(performance.now() - startTs)); };
    xhr.onerror = function() { clearTimeout(timer); done(null); };
    xhr.onabort = function() { clearTimeout(timer); done(null); };
    xhr.send();
    return xhr;
}

function checkOneService(url, cb) {
    // RTT 与详情并行：HEAD 测延迟，GET 取 IP/归属地/ISP
    var rtt = null;
    var info = null;
    var pending = 2;
    var finish = function() {
        pending--;
        if (pending > 0) return;
        var res = info || { ok: false };
        if (rtt !== null) res.rtt = rtt;
        cb(res);
    };
    var rttXhr = measureRtt(url, function(r) { rtt = r; finish(); });
    var xhr = new XMLHttpRequest();
    var done = function(res) {
        if (done.called) return;
        done.called = true;
        info = res;
        finish();
    };
    var timer = setTimeout(function() { xhr.abort(); done({ ok: false }); }, 15000);
    xhr.open('GET', url + (url.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now(), true);
    xhr.setRequestHeader('Cache-Control', 'no-cache');
    xhr.onload = function() {
        clearTimeout(timer);
        if (xhr.status === 200) {
            try {
                var d = JSON.parse(xhr.responseText);
                done({ ok: true, ip: d.ip || '', location: d.location || '', isp: d.isp || '' });
                return;
            } catch (e) {}
        }
        done({ ok: false });
    };
    xhr.onerror = function() { clearTimeout(timer); done({ ok: false }); };
    xhr.onabort = function() { clearTimeout(timer); done({ ok: false }); };
    xhr.send();
    return [rttXhr, xhr];
}

var svcFadeTimer = null;   // 检测完成后延迟淡出的计时器

function renderSvcStatus() {
    var el = document.getElementById('svcStatus');
    var text = document.getElementById('svcStatusText');
    var tip = document.getElementById('svcStatusTip');
    var a = svcStatus.api;
    if (svcFadeTimer) {
        clearTimeout(svcFadeTimer);
        svcFadeTimer = null;
    }
    if (!a) {
        el.className = 'svc-status';
        text.textContent = '服务检测中…';
        return;
    }
    el.className = 'svc-status ' + (a.ok ? 'ok' : 'fail');
    text.textContent = a.ok ? '服务正常' : '服务异常';
    tip.textContent = '';
    addSvcTipLine(tip, 'EO 边缘函数', '', a);
    var timeDiv = document.createElement('div');
    var timeLabel = document.createElement('span');
    timeLabel.className = 'svc-name';
    timeLabel.textContent = '检测时间';
    timeDiv.appendChild(timeLabel);
    timeDiv.appendChild(document.createTextNode(new Date().toLocaleTimeString()));
    tip.appendChild(timeDiv);
    // 检测完成 4 秒后角标淡出为半透明（悬停恢复），减少常驻视觉干扰
    svcFadeTimer = setTimeout(function() {
        el.classList.add('faded');
    }, 4000);
}

function addSvcTipLine(tip, name, addr, st) {
    var div = document.createElement('div');
    var label = document.createElement('span');
    label.className = 'svc-name';
    label.textContent = name;
    div.appendChild(label);
    if (addr) div.appendChild(document.createTextNode(addr + ' '));
    var state = document.createElement('span');
    if (st && st.ok) {
        state.className = 'svc-ok';
        var detail = st.ip || '';
        var extra = [st.location, st.isp].filter(function(s) { return s; }).join(' · ');
        state.textContent = (extra ? detail + '（' + extra + '）' : detail) + ' 正常';
    } else {
        state.className = 'svc-fail';
        state.textContent = st ? '连接失败' : '检测中…';
    }
    div.appendChild(state);
    if (st && typeof st.rtt === 'number') {
        var rttSpan = document.createElement('span');
        rttSpan.className = 'svc-rtt';
        rttSpan.textContent = ' ' + st.rtt + 'ms';
        div.appendChild(rttSpan);
    }
    tip.appendChild(div);
}

// force=true（手动点击）时中止上一轮未完成的检测立即重来；定时轮询不重入
function checkSvcStatus(force) {
    if (svcChecking) {
        if (!force) return;
        svcCheckGen++;
        svcCheckXhrs.forEach(function(x) { try { x.abort(); } catch (e) {} });
        svcCheckXhrs = [];
        svcChecking = false;
    }
    svcChecking = true;
    var gen = svcCheckGen;
    // 立即重置为“检测中”，点击重新检测时才有即时反馈（否则角标保持旧状态看似没反应）
    svcStatus.api = null;
    renderSvcStatus();
    svcCheckXhrs = checkOneService(API_BASE + '/api/my-ip', function(res) {
        if (gen !== svcCheckGen) return;
        svcChecking = false;
        svcCheckXhrs = [];
        svcStatus.api = res;
        renderSvcStatus();
    });
}

setInterval(function() {
    if (document.hidden) return;
    checkSvcStatus();
}, SVC_CHECK_INTERVAL);

function openUploadModal() {
    if (!getSavedAuth()) {
        openLoginModal();
        setMsg('loginMessage', '请先登录后再上传文件', 'error');
        return;
    }
    document.getElementById('uploadModal').classList.add('show');
}

function closeUploadModal() {
    // 上传进行中：关闭即转入后台——浮泡实时显示进度，点击恢复弹窗
    if (uploadState) {
        document.getElementById('uploadModal').classList.remove('show');
        showBgTask(document.getElementById('progressText').textContent || '上传中...', function() {
            document.getElementById('uploadModal').classList.add('show');
        });
        showToast('上传已转入后台，点击右下角浮泡可查看');
        setTimeout(hideToast, 2500);
        return;
    }
    document.getElementById('uploadModal').classList.remove('show');
    document.getElementById('uploadMessage').className = 'message';
    document.getElementById('uploadMessage').textContent = '';
    document.querySelector('.progress-container').style.display = 'none';
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressText').textContent = '0%';
    document.getElementById('chunkPanel').style.display = 'none';
    document.getElementById('chunkList').style.display = 'none';
    document.getElementById('chunkList').innerHTML = '';
    document.getElementById('chunkPanelArrow').textContent = '▸';
    document.getElementById('speedPanel').style.display = 'none';
    document.getElementById('speedGraph').style.display = 'none';
    document.getElementById('speedLegend').style.display = 'none';
    document.getElementById('speedPanelArrow').textContent = '▸';
    document.getElementById('stopUploadBtn').style.display = 'none';
    resetUploadSpeedHist();
    pendingFiles = [];
    document.getElementById('selectedFiles').textContent = '';
    document.getElementById('fileInput').value = '';
    document.getElementById('folderInput').value = '';
}

var SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function formatSize(size) {
    if (size === undefined || size === null) return '0B';
    for (var i = 0; i < SIZE_UNITS.length; i++) {
        if (size < 1024.0) {
            return size.toFixed(1) + SIZE_UNITS[i];
        }
        size /= 1024.0;
    }
    return size.toFixed(1) + 'PB';
}

// 预计剩余时间格式化：<1s 不显示；支持 秒/分/小时
function formatEtaText(sec) {
    if (!isFinite(sec) || sec < 1) return '';
    sec = Math.round(sec);
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    if (m > 59) {
        var h = Math.floor(m / 60);
        return h + '小时' + (m % 60) + '分';
    }
    return (m > 0 ? m + '分' : '') + s + '秒';
}

// 由"剩余字节 / 近期实测速度"计算预计剩余时间文本（多通道提速/降速时
// 速度随最近采样窗口动态变化，ETA 随之实时调整）；速度无效时返回空
function etaTextFromSpeed(remainingBytes, recentSpeed) {
    if (!remainingBytes || remainingBytes <= 0 || !recentSpeed || recentSpeed <= 0) return '';
    return formatEtaText(remainingBytes / recentSpeed);
}

function fetchFileTree(onDone, onFail) {
    if (fileTreeCache) {
        onDone();
        return;
    }
    var commitUrl = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/commits/' + DEFAULT_BRANCH;
    cachedGet(commitUrl, function(status, body) {
        if (status !== 200 && status !== 304) {
            if (onFail) onFail();
            return;
        }
        try {
            var commitData = JSON.parse(body);
            var treeUrl = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/git/trees/' + commitData.commit.tree.sha + '?recursive=1';
            cachedGet(treeUrl, function(status2, body2) {
                if (status2 !== 200 && status2 !== 304) {
                    if (onFail) onFail();
                    return;
                }
                try {
                    var data = JSON.parse(body2);
                    fileTreeCache = data.tree || [];
                    onDone();
                } catch (e) {
                    if (onFail) onFail();
                }
            });
        } catch (e) {
            if (onFail) onFail();
        }
    });
}

function fetchFolderSizes() {
    fetchFileTree(updateFolderSizes);
}

function updateFolderSizes() {
    if (!fileTreeCache) return;
    // Single pass over the tree: accumulate each blob's size into all ancestor dirs
    var dirSizes = {};
    var rootTotal = 0;
    fileTreeCache.forEach(function(item) {
        if (item.type !== 'blob' || !item.path) return;
        var size = item.size || 0;
        rootTotal += size;
        var p = item.path;
        var idx = p.lastIndexOf('/');
        while (idx > 0) {
            p = p.substring(0, idx);
            dirSizes[p] = (dirSizes[p] || 0) + size;
            idx = p.lastIndexOf('/');
        }
    });
    // 全仓总用量（数据量），显示在标题右侧
    var usageEl = document.getElementById('totalUsage');
    if (usageEl) {
        var usageText = '总用量 ' + formatSize(rootTotal);
        if (usageEl.textContent !== usageText) usageEl.textContent = usageText;
    }
    var sizeSpans = document.querySelectorAll('.dir-size');
    sizeSpans.forEach(function(span) {
        var dirPath = span.getAttribute('data-path');
        if (!dirPath) return;
        var text = formatSize(dirSizes[dirPath] || 0);
        if (span.textContent !== text) {
            span.textContent = text;
        }
    });
}

function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function propRow(label, value, mono) {
    return '<div class="prop-row"><span class="prop-label">' + label + '</span><span class="prop-value' + (mono ? ' mono' : '') + '">' + value + '</span></div>';
}

// ---- 音频标签（ID3v1 / ID3v2）读取：经 Range 请求只取文件头尾，不下载整文件 ----
function rawUrlFor(path) {
    return ghUrl('https://raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME + '/' + DEFAULT_BRANCH + '/' + encodeURI(path));
}

function fetchRange(url, rangeHeader, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.setRequestHeader('Range', rangeHeader);
    xhr.responseType = 'arraybuffer';
    xhr.onload = function() {
        if ((xhr.status === 200 || xhr.status === 206) && xhr.response) {
            cb(new Uint8Array(xhr.response));
        } else {
            cb(null);
        }
    };
    xhr.onerror = function() { cb(null); };
    xhr.send();
}

function decodeId3Text(bytes, offset, length) {
    if (length <= 0) return '';
    var enc = bytes[offset];
    var data = bytes.subarray(offset + 1, offset + length);
    // 去掉末尾的 NUL 终止符
    var end = data.length;
    while (end > 0 && data[end - 1] === 0) end--;
    data = data.subarray(0, end);
    try {
        if (enc === 0) return new TextDecoder('iso-8859-1').decode(data).trim();
        if (enc === 1) return new TextDecoder('utf-16').decode(data).trim();
        if (enc === 2) return new TextDecoder('utf-16be').decode(data).trim();
        return new TextDecoder('utf-8').decode(data).trim();
    } catch (e) {
        try { return new TextDecoder('utf-8').decode(data).trim(); } catch (e2) { return ''; }
    }
}

function syncsafe(b0, b1, b2, b3) {
    return (b0 << 21) | (b1 << 14) | (b2 << 7) | b3;
}

// 解析 ID3v2（v2.3 / v2.4）常用文本帧：TIT2 标题 / TPE1 歌手 / TALB 专辑 / TYER、TDRC 年份
function parseId3v2(bytes) {
    var tags = {};
    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return tags;
    var verMajor = bytes[3];
    var tagSize = syncsafe(bytes[6], bytes[7], bytes[8], bytes[9]);
    var pos = 10;
    var tagEnd = Math.min(bytes.length, 10 + tagSize);
    var wanted = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TYER: 'year', TDRC: 'year' };
    while (pos + 10 <= tagEnd) {
        var id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
        if (!/^[A-Z0-9]{4}$/.test(id)) break;
        var size = (verMajor >= 4)
            ? syncsafe(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
            : ((bytes[pos + 4] << 24) | (bytes[pos + 5] << 16) | (bytes[pos + 6] << 8) | bytes[pos + 7]);
        if (size <= 0 || pos + 10 + size > bytes.length) break;
        if (wanted[id] && !tags[wanted[id]]) {
            var text = decodeId3Text(bytes, pos + 10, size);
            if (text) tags[wanted[id]] = text;
        }
        pos += 10 + size;
    }
    return tags;
}

// 解析 ID3v1（文件末尾 128 字节，"TAG" 开头，字段为定长 GBK/拉丁文本）
function parseId3v1(bytes) {
    var tags = {};
    if (bytes.length < 128) return tags;
    var base = bytes.length - 128;
    if (bytes[base] !== 0x54 || bytes[base + 1] !== 0x41 || bytes[base + 2] !== 0x47) return tags;
    var field = function(off, len) {
        var data = bytes.subarray(base + off, base + off + len);
        var end = data.length;
        while (end > 0 && (data[end - 1] === 0 || data[end - 1] === 0x20)) end--;
        if (!end) return '';
        try { return new TextDecoder('gbk').decode(data.subarray(0, end)).trim(); } catch (e) {
            try { return new TextDecoder('iso-8859-1').decode(data.subarray(0, end)).trim(); } catch (e2) { return ''; }
        }
    };
    var title = field(3, 30), artist = field(33, 30), album = field(63, 30), year = field(93, 4);
    if (title) tags.title = title;
    if (artist) tags.artist = artist;
    if (album) tags.album = album;
    if (year) tags.year = year;
    return tags;
}

// 读取音频标签：ID3v2 在文件头（取首 256KB），ID3v1 在文件尾（取末 128 字节）；
// 分片文件分别取首/尾分片。ID3v2 字段优先，缺失时用 ID3v1 补齐
function fetchAudioTags(fileInfo, cb) {
    var headPath = (fileInfo.chunked && fileInfo.parts && fileInfo.parts.length)
        ? fileInfo.parts[0].path : fileInfo.path;
    var tailPath = (fileInfo.chunked && fileInfo.parts && fileInfo.parts.length)
        ? fileInfo.parts[fileInfo.parts.length - 1].path : fileInfo.path;
    var headTags = null;
    var tailTags = null;
    var pending = 2;
    var finish = function() {
        pending--;
        if (pending > 0) return;
        if (!headTags && !tailTags) { cb(null); return; }
        var tags = {};
        var src = [tailTags || {}, headTags || {}];
        src.forEach(function(t) {
            ['title', 'artist', 'album', 'year'].forEach(function(k) {
                if (!tags[k] && t[k]) tags[k] = t[k];
            });
        });
        cb((tags.title || tags.artist || tags.album || tags.year) ? tags : null);
    };
    fetchRange(rawUrlFor(headPath), 'bytes=0-262143', function(bytes) {
        headTags = bytes ? parseId3v2(bytes) : null;
        finish();
    });
    fetchRange(rawUrlFor(tailPath), 'bytes=-128', function(bytes) {
        tailTags = bytes ? parseId3v1(bytes) : null;
        finish();
    });
}

// ---- 双通道分段下载器：拉取整个文件为 Blob ----
// onProgress(loadedBytes, totalBytes)；onDone(blob)；onFail()。
// 返回取消句柄。小文件（<=2MB 或大小未知）单段 EO 直取；
// 大文件分 6 段并行，EO/CF 交替分配，段失败换源续传（从已收位置继续 Range）。
// limitOverride>0 时限制本下载器的并发（多文件并行池内分摊连接数用）；
// 否则跟随全局并行数 dlGetLimit()
// budget：多文件并行池的共享连接预算 {active}——池内所有文件共同竞争
// dlGetLimit() 个全局槽位（工作窃取），空闲文件让出的连接立即被其他文件
// 抢占，消除"每文件固定配额"在文件尾段/批次尾部造成的并行数跑不满
function fetchFileBlobDual(filePath, sizeHint, onProgress, onDone, onFail, limitOverride, budget) {
    var state = {
        cancelled: false,
        controllers: [],
        cfFails: 0,
        cfDown: false,
        failed: false
    };
    var total = sizeHint || 0;
    var segments = null;
    var loaded = 0;
    var nextSeg = 0;
    var activeSegs = 0;
    var getLimit = function() {
        return limitOverride > 0 ? limitOverride : dlGetLimit();
    };
    dlTrackStart();

    function report() {
        if (onProgress && !state.failed && !state.cancelled) onProgress(loaded, total);
    }

    function failAll() {
        if (state.failed || state.cancelled) return;
        state.failed = true;
        // 在途段回调将因 failed 提前返回、不再自行释放，统一归还预算槽位
        if (segments) segments.forEach(function(s) { releaseBudget(s); });
        dlUnregisterScheduler(pumpSegs);
        dlTrackStop();
        onFail();
    }

    function cancel() {
        if (state.cancelled) return;
        state.cancelled = true;
        if (segments) segments.forEach(function(s) { releaseBudget(s); });
        dlUnregisterScheduler(pumpSegs);
        state.controllers.forEach(function(c) { try { c.abort(); } catch (e) {} });
        // 中止的在途段不会回调 dlChanDec，直接清零在途计数避免负载均衡失真
        dlActive.eo = dlActive.cf = dlActive.ext = 0;
        dlTrackStop();
    }

    function isAbort(err) { return err && err.name === 'AbortError'; }

    function checkAll() {
        if (state.failed || state.cancelled) return;
        for (var i = 0; i < segments.length; i++) {
            if (!segments[i].done) return;
        }
        var parts = [];
        segments.forEach(function(s) {
            for (var j = 0; j < s.chunks.length; j++) parts.push(s.chunks[j]);
        });
        dlUnregisterScheduler(pumpSegs);
        dlTrackStop();
        onDone(new Blob(parts));
    }

    // 段占用的共享预算槽位只释放一次（重试不释放：槽位随段换源保留）
    function releaseBudget(seg) {
        if (budget && seg && seg._budgetHeld) {
            seg._budgetHeld = false;
            budget.active = Math.max(0, budget.active - 1);
        }
    }

    // 段调度器：在途段数不超过当前下载并发限制（自适应动态调整）；
    // 预算模式下另受池级全局槽位约束，耗尽即停，由 dlNotify 唤醒补位
    function pumpSegs() {
        if (state.failed || state.cancelled || !segments) return;
        while (activeSegs < getLimit() && nextSeg < segments.length) {
            if (budget && budget.active >= dlGetLimit()) return;
            var seg = segments[nextSeg++];
            seg.t0 = Date.now();
            activeSegs++;
            if (budget) {
                budget.active++;
                seg._budgetHeld = true;
            }
            fetchSeg(seg, 0);
        }
    }

    function fetchSeg(seg, attempt) {
        if (state.failed || state.cancelled) return;
        // 通道：首次按各通道在途均衡 + 实测速率加权分配（无数据时轮询），
        // 重试在上次失败的通道之外换源；CF 熔断后排除 CF 通道
        var chan;
        if (attempt > 0) {
            var ex = seg._lastChan;
            chan = pickDlChannel(ex) || pickDlFallback(ex);
        } else if (state.cfDown) {
            chan = pickDlChannel('cf') || pickDlFallback('cf');
        } else {
            chan = pickDlChannel() || pickDlFallback();
        }
        // 外部代理：先锁定所用代理（记录以便按代理熔断）；
        // 挑选期间全部熔断的极端情况直接回退 EO
        if (chan === 'ext') {
            seg._extBase = extPickBase();
            if (!seg._extBase) chan = 'eo';
        }
        seg._lastChan = chan;
        dlChanInc(chan);
        var ctrl = new AbortController();
        state.controllers.push(ctrl);
        var headers = {};
        // 续传：从该段已收位置继续，避免重复拉取
        var from = seg.start + seg.received;
        if (seg.end !== null) {
            headers['Range'] = 'bytes=' + from + '-' + seg.end;
        } else if (from > 0) {
            headers['Range'] = 'bytes=' + from + '-';
        }
        var url;
        if (chan === 'cf') {
            url = cfRawUrl(filePath);
        } else if (chan === 'ext') {
            url = extRawUrl(seg._extBase, filePath);
        } else {
            url = rawUrlFor(filePath);
        }
        // 停滞看门狗：15 秒未收到任何字节即中止换源——代理挂起（连接不断但
        // 不再发数据）时在途槽位会被永久占住，表现为"跑完一批就没有新任务"
        seg._lastRecvAt = Date.now();
        var watchdog = setInterval(function() {
            if (Date.now() - seg._lastRecvAt > 15000) {
                try { ctrl.abort(); } catch (e) {}
            }
        }, 3000);
        fetch(url, { signal: ctrl.signal, cache: 'no-store', headers: headers }).then(function(resp) {
            if (state.failed || state.cancelled) return;
            var ranged = headers['Range'] !== undefined;
            var ok = ranged ? resp.status === 206 : resp.ok;
            // 整文件单段且从头开始：200/206 均可
            if (seg.end === null && seg.received === 0) ok = resp.ok || resp.status === 206;
            if (!ok || !resp.body) {
                clearInterval(watchdog);
                retrySeg(seg, attempt, chan);
                return;
            }
            // 整文件单段响应：从 Content-Length 补出总大小（免单独探测请求）
            if (!ranged && !total) {
                var cl = parseInt(resp.headers.get('Content-Length'), 10);
                if (cl > 0) total = cl;
            }
            var reader = resp.body.getReader();
            var pump = function() {
                reader.read().then(function(r) {
                    if (state.failed || state.cancelled) return;
                    if (r.done) {
                        clearInterval(watchdog);
                        seg.done = true;
                        activeSegs--;
                        dlChanDec(chan);
                        releaseBudget(seg);
                        if (budget) dlNotify();   // 唤醒池内其他文件抢占空出的全局槽位
                        dlAdaptiveSuccess(Date.now() - (seg.t0 || Date.now()));
                        checkAll();
                        pumpSegs();
                        return;
                    }
                    seg._lastRecvAt = Date.now();
                    seg.chunks.push(r.value);
                    seg.received += r.value.byteLength;
                    loaded += r.value.byteLength;
                    dlTrackAdd(chan, r.value.byteLength);
                    report();
                    pump();
                }, function(err) {
                    // 看门狗中止（非用户取消）同样换源重试，否则在途槽位泄漏
                    if (isAbort(err) && (state.failed || state.cancelled)) return;
                    clearInterval(watchdog);
                    retrySeg(seg, attempt, chan);
                });
            };
            pump();
        }, function(err) {
            if (isAbort(err) && (state.failed || state.cancelled)) return;
            clearInterval(watchdog);
            retrySeg(seg, attempt, chan);
        });
    }

    function retrySeg(seg, attempt, chan) {
        if (state.failed || state.cancelled) return;
        dlChanDec(chan);
        if (chan === 'cf') {
            state.cfFails++;
            if (state.cfFails >= 2) state.cfDown = true;
        } else if (chan === 'ext') {
            // 外部代理按代理熔断：单个代理连续失败 2 次即轮换下一个
            extNoteFail(seg._extBase);
        } else {
            // EO 段失败暗示链路饱和，自适应降低下载并发（CF/外部失败只熔断通道）
            dlAdaptiveFail();
        }
        if (attempt + 1 >= DUAL_SEG_MAX_ATTEMPTS) {
            failAll();
            return;
        }
        fetchSeg(seg, attempt + 1);
    }

    function start(totalSize) {
        total = totalSize;
        dlRegisterScheduler(pumpSegs);
        if (!total || total <= DUAL_DL_MIN) {
            segments = [{ index: 0, start: 0, end: total ? total - 1 : null, chunks: [], received: 0, done: false }];
            if (!total) segments[0].end = null;
        } else {
            // 段数多于并发数：小步快跑，配合调度器按当前并发限制滚动补位；
            // 段数下限随当前限制抬升（最小 1MB/段），单文件也能吃满高并行数
            var count = Math.min(Math.max(DUAL_DL_PARTS, getLimit()), Math.ceil(total / (1024 * 1024)));
            var segSize = Math.ceil(total / count);
            segments = [];
            for (var i = 0; i < count; i++) {
                var s = i * segSize;
                var e = Math.min(s + segSize, total) - 1;
                if (s > e) break;
                segments.push({ index: i, start: s, end: e, chunks: [], received: 0, done: false });
            }
        }
        pumpSegs();
        report();
    }

    // 大小未知（sizeHint=0）时直接单段整文件请求，不额外发探测请求；
    // 总大小从响应 Content-Length 补出（上面的 fetchSeg 处理）
    start(total);

    return { cancel: cancel };
}

// ---- ZIP 打包（store 模式：媒体文件本无压缩收益，速度快且 CPU 占用低） ----
var CRC32_TABLE = (function() {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
        c = CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}

// 分段 CRC（携带中间态）：异步打包按片计算，片间让出主线程避免界面卡死
function crc32Chunk(bytes, from, to, c) {
    for (var i = from; i < to; i++) {
        c = CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return c;
}

// 异步 ZIP 打包（store 模式）：逐条目 + 条目内按 8MB 切片计算 CRC，
// 每片之间 setTimeout(0) 让出主线程并回报进度，大文件夹打包不再卡死页面。
// entries: [{name, data: Uint8Array}]；onProgress(doneCount, total, entryFrac)；
// isCancelled() 返回 true 时中止（不回掉 onDone）
function buildZipBlobAsync(entries, onProgress, isCancelled, onDone) {
    var encoder = new TextEncoder();
    var now = new Date();
    var dosTime = ((now.getHours() & 0x1F) << 11) | ((now.getMinutes() & 0x3F) << 5) | (Math.floor(now.getSeconds() / 2) & 0x1F);
    var dosDate = (((now.getFullYear() - 1980) & 0x7F) << 9) | (((now.getMonth() + 1) & 0xF) << 5) | (now.getDate() & 0x1F);
    var parts = [];
    var central = [];
    var offset = 0;
    var idx = 0;
    var CRC_SLICE = 8 * 1024 * 1024;

    function finish() {
        var cdSize = 0;
        central.forEach(function(p) { cdSize += p.length; });
        var end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true);      // end of central directory
        end.setUint16(8, entries.length, true);
        end.setUint16(10, entries.length, true);
        end.setUint32(12, cdSize, true);
        end.setUint32(16, offset, true);
        onDone(new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/zip' }));
    }

    function processEntry() {
        if (isCancelled && isCancelled()) return;
        if (idx >= entries.length) {
            finish();
            return;
        }
        var e = entries[idx];
        var nameBytes = encoder.encode(e.name);
        var size = e.data.length;
        var pos = 0;
        var c = 0xFFFFFFFF;
        (function crcStep() {
            if (isCancelled && isCancelled()) return;
            var end = Math.min(pos + CRC_SLICE, size);
            c = crc32Chunk(e.data, pos, end, c);
            pos = end;
            if (pos < size) {
                if (onProgress) onProgress(idx, entries.length, pos / size);
                setTimeout(crcStep, 0);
                return;
            }
            var crc = (c ^ 0xFFFFFFFF) >>> 0;
            var lh = new DataView(new ArrayBuffer(30));
            lh.setUint32(0, 0x04034b50, true);   // local file header
            lh.setUint16(4, 20, true);
            lh.setUint16(6, 0x0800, true);       // UTF-8 文件名
            lh.setUint16(8, 0, true);            // store
            lh.setUint16(10, dosTime, true);
            lh.setUint16(12, dosDate, true);
            lh.setUint32(14, crc, true);
            lh.setUint32(18, size, true);
            lh.setUint32(22, size, true);
            lh.setUint16(26, nameBytes.length, true);
            lh.setUint16(28, 0, true);
            parts.push(new Uint8Array(lh.buffer), nameBytes, e.data);
            var ch = new DataView(new ArrayBuffer(46));
            ch.setUint32(0, 0x02014b50, true);   // central directory header
            ch.setUint16(4, 20, true);
            ch.setUint16(6, 20, true);
            ch.setUint16(8, 0x0800, true);
            ch.setUint16(10, dosTime, true);
            ch.setUint16(12, dosDate, true);
            ch.setUint32(16, crc, true);
            ch.setUint32(20, size, true);
            ch.setUint32(24, size, true);
            ch.setUint16(28, nameBytes.length, true);
            ch.setUint32(42, offset, true);
            central.push(new Uint8Array(ch.buffer), nameBytes);
            offset += 30 + nameBytes.length + size;
            idx++;
            if (onProgress) onProgress(idx, entries.length, 0);
            setTimeout(processEntry, 0);
        })();
    }

    processEntry();
}

// entries: [{name: zip 内路径（UTF-8，保留子目录结构）, data: Uint8Array}]
function buildZipBlob(entries) {
    var encoder = new TextEncoder();
    var now = new Date();
    var dosTime = ((now.getHours() & 0x1F) << 11) | ((now.getMinutes() & 0x3F) << 5) | (Math.floor(now.getSeconds() / 2) & 0x1F);
    var dosDate = (((now.getFullYear() - 1980) & 0x7F) << 9) | (((now.getMonth() + 1) & 0xF) << 5) | (now.getDate() & 0x1F);
    var parts = [];
    var central = [];
    var offset = 0;
    entries.forEach(function(e) {
        var nameBytes = encoder.encode(e.name);
        var crc = crc32(e.data);
        var size = e.data.length;
        var lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true);   // local file header
        lh.setUint16(4, 20, true);
        lh.setUint16(6, 0x0800, true);       // UTF-8 文件名
        lh.setUint16(8, 0, true);            // store
        lh.setUint16(10, dosTime, true);
        lh.setUint16(12, dosDate, true);
        lh.setUint32(14, crc, true);
        lh.setUint32(18, size, true);
        lh.setUint32(22, size, true);
        lh.setUint16(26, nameBytes.length, true);
        lh.setUint16(28, 0, true);
        parts.push(new Uint8Array(lh.buffer), nameBytes, e.data);
        var ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true);   // central directory header
        ch.setUint16(4, 20, true);
        ch.setUint16(6, 20, true);
        ch.setUint16(8, 0x0800, true);
        ch.setUint16(10, 0, true);
        ch.setUint16(12, dosTime, true);
        ch.setUint16(14, dosDate, true);
        ch.setUint32(16, crc, true);
        ch.setUint32(20, size, true);
        ch.setUint32(24, size, true);
        ch.setUint16(28, nameBytes.length, true);
        ch.setUint32(42, offset, true);
        central.push(new Uint8Array(ch.buffer), nameBytes);
        offset += 30 + nameBytes.length + size;
    });
    var cdSize = 0;
    central.forEach(function(p) { cdSize += p.length; });
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);      // end of central directory
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/zip' });
}

function showProperties(filePath, fileName, fileType) {
    document.getElementById('propertiesTitle').textContent = '属性: ' + fileName;
    var content = document.getElementById('propertiesContent');
    var propsHtml = '<div class="props-list">';
    propsHtml += propRow('名称', escapeHtml(displayName(fileName)));
    propsHtml += propRow('类型', fileType === 'dir' ? '文件夹' : (menuFileInfo.chunked ? '文件（分片存储）' : '文件'));
    propsHtml += propRow('路径', escapeHtml(filePath), true);
    if (fileType === 'dir') {
        var fileCount = 0, dirCount = 0, totalSize = 0;
        if (fileTreeCache) {
            var prefix = filePath + '/';
            fileTreeCache.forEach(function(item) {
                if (item.path && item.path.indexOf(prefix) === 0) {
                    if (item.type === 'blob') { fileCount++; totalSize += (item.size || 0); }
                    else if (item.type === 'tree') { dirCount++; }
                }
            });
        }
        propsHtml += propRow('包含文件', fileCount + ' 个');
        propsHtml += propRow('包含子文件夹', dirCount + ' 个');
        propsHtml += propRow('总大小', formatSize(totalSize));
    } else if (menuFileInfo.chunked) {
        propsHtml += propRow('分片数量', (menuFileInfo.parts ? menuFileInfo.parts.length : 0) + ' 个');
        propsHtml += propRow('总大小', formatSize(menuFileInfo.size));
    } else {
        propsHtml += propRow('大小', formatSize(menuFileInfo.size));
        propsHtml += propRow('SHA', menuFileInfo.sha || 'N/A', true);
    }
    // 音频文件追加标签占位行，异步读取 ID3（歌手/标题/专辑/年份）后填充
    var ext = getFileExtension(fileName);
    var isAudio = fileType !== 'dir' && AUDIO_EXTS.indexOf(ext) !== -1;
    if (isAudio) {
        propsHtml += propRow('标签', '<span id="audioTagLoading">读取中...</span>');
    }
    propsHtml += '</div>';
    content.innerHTML = propsHtml;
    document.getElementById('propertiesModal').classList.add('show');
    if (isAudio) {
        var info = {
            path: filePath,
            chunked: !!menuFileInfo.chunked,
            parts: menuFileInfo.parts || null
        };
        fetchAudioTags(info, function(tags) {
            var holder = document.getElementById('audioTagLoading');
            if (!holder) return;
            var row = holder.parentNode.parentNode;
            if (!tags) {
                row.parentNode.removeChild(row);
                return;
            }
            row.parentNode.removeChild(row);
            var list = content.querySelector('.props-list');
            if (!list) return;
            var html = '';
            if (tags.artist) html += propRow('歌手', escapeHtml(tags.artist));
            if (tags.title) html += propRow('标题', escapeHtml(tags.title));
            if (tags.album) html += propRow('专辑', escapeHtml(tags.album));
            if (tags.year) html += propRow('年份', escapeHtml(tags.year));
            list.insertAdjacentHTML('beforeend', html);
        });
    }
}

// 文件夹下载：经 git tree 收集全部文件后打包为 zip 下载（文件级并行池拉取，
// 带总进度条与停止按钮）；zip 内保留子目录结构，同名文件自动改名
function downloadFolder(filePath, fileName) {
    showTaskProgress('正在获取文件夹内容: ' + displayName(fileName), null);
    fetchFileTree(function() {
        var prefix = filePath + '/';
        var blobs = [];
        fileTreeCache.forEach(function(item) {
            if (item.type === 'blob' && item.path && item.path.indexOf(prefix) === 0) {
                blobs.push(item);
            }
        });
        // 分片文件（.partN）按组归并为一个虚拟文件，下载时合并还原
        var partGroups = {};
        var normal = [];
        blobs.forEach(function(item) {
            var name = item.path.substring(prefix.length);
            if (PART_SUFFIX.test(name)) {
                var base = name.replace(PART_SUFFIX, '');
                if (!partGroups[base]) partGroups[base] = [];
                partGroups[base].push(item);
            } else {
                normal.push({ name: name, path: item.path, size: item.size });
            }
        });
        for (var base in partGroups) {
            var parts = partGroups[base];
            parts.sort(function(a, b) {
                return getPartNumber(a.path.substring(prefix.length)) - getPartNumber(b.path.substring(prefix.length));
            });
            var total = 0;
            parts.forEach(function(p) { total += (p.size || 0); });
            normal.push({ name: base, size: total, chunked: true, parts: parts });
        }
        normal.sort(function(a, b) { return a.name.localeCompare(b.name); });
        var models = [];
        var seen = {};
        normal.forEach(function(m) {
            var zipName = m.name;   // zip 内路径：保留子目录结构
            if (seen[zipName]) zipName = zipName.replace(/\//g, '_');
            seen[zipName] = true;
            models.push({
                zipName: zipName,
                displayName: displayName(zipName),
                path: m.path,
                size: m.size,
                chunked: m.chunked || false,
                parts: m.parts || null
            });
        });
        if (!models.length) {
            hideTaskProgress();
            showToast('文件夹为空');
            setTimeout(hideToast, 2000);
            return;
        }
        downloadFolderZip(models, displayName(fileName));
    }, function() {
        hideTaskProgress();
        showToast('获取文件夹内容失败');
        setTimeout(hideToast, 2500);
    });
}

// 文件夹打包下载：文件级并行池拉取（分片先合并，普通文件走多通道加速），
// 全部就绪后在前端打包为 zip 一次性保存，保留子目录结构
function downloadFolderZip(models, folderLabel) {
    var totalBytes = 0;
    models.forEach(function(m) { totalBytes += (m.size || 0); });
    var loadedMap = {};
    var rawEntries = [];
    var doneCount = 0;
    var cancelled = false;
    var lastLoaded = 0;
    var lastTime = Date.now();
    var speedText = '';
    var etaText = '';

    var sumLoaded = function() {
        var s = 0;
        for (var k in loadedMap) s += loadedMap[k];
        return s;
    };
    var report = function() {
        var now = Date.now();
        if (now - lastTime >= 500) {
            var sp = (sumLoaded() - lastLoaded) / ((now - lastTime) / 1000);
            lastLoaded = sumLoaded();
            lastTime = now;
            speedText = sp > 1024 ? formatSize(Math.round(sp)) + '/s' : '';
            // ETA 跟随最近采样速度：多通道开关/通道增减时动态变化
            etaText = totalBytes ? etaTextFromSpeed(totalBytes - sumLoaded(), sp) : '';
        }
        var pct = totalBytes ? Math.min(99, Math.round(sumLoaded() / totalBytes * 100)) : Math.round(doneCount / models.length * 100);
        updateTaskProgress('正在下载 (' + doneCount + '/' + models.length + ') · ' + folderLabel + (speedText ? ' · ' + speedText : '') + (etaText ? ' · 预计剩余 ' + etaText : ''), pct);
    };

    var pool = null;
    showTaskProgress('正在下载 (0/' + models.length + ') · ' + folderLabel, 0, function() {
        cancelled = true;
        if (pool) pool.cancel();
        hideTaskProgress();
        showToast('已取消打包下载');
        setTimeout(hideToast, 2000);
    });

    var failFile = function() {
        if (cancelled) return;
        cancelled = true;
        if (pool) pool.cancel();
        hideTaskProgress();
        showToast('文件下载失败，打包中止');
        setTimeout(hideToast, 2500);
    };

    // 打包缓存：文件一下载完立即异步转存为 Uint8Array 条目（读取开销摊到
    // 下载期间，打包阶段不再集中读盘）；打包本身分片计算 CRC 并回报进度
    var pendingReads = 0;
    var readFail = false;

    var pack = function() {
        // zip 条目按名称排序，保证并行下载完成后打包结果确定
        rawEntries.sort(function(a, b) { return a.name.localeCompare(b.name); });
        updateTaskProgress('正在打包 ' + folderLabel + '.zip（0/' + rawEntries.length + '）', 0);
        buildZipBlobAsync(rawEntries,
            function(done, total, entryFrac) {
                if (cancelled) return;
                var pct = total ? Math.round((done + (entryFrac || 0)) / total * 100) : 100;
                updateTaskProgress('正在打包 ' + folderLabel + '.zip（' + done + '/' + total + '）', Math.max(0, Math.min(99, pct)));
            },
            function() { return cancelled; },
            function(zipBlob) {
                if (cancelled) return;
                hideTaskProgress();
                saveBlobAs(zipBlob, folderLabel + '.zip');
                showToast('打包下载完成: ' + folderLabel + '.zip（' + formatSize(zipBlob.size) + '）');
                setTimeout(hideToast, 3000);
            });
    };
    // 全部下载完成后，可能仍有少量条目在转存缓存，待其就绪再打包
    var packWhenReady = function() {
        if (cancelled) return;
        if (readFail) return;   // failFile 已处理
        if (pendingReads > 0) {
            updateTaskProgress('正在缓存 (' + (doneCount - pendingReads) + '/' + doneCount + ') · ' + folderLabel, null);
            setTimeout(packWhenReady, 100);
            return;
        }
        pack();
    };

    var limit = dlGetLimit();
    var poolLimit = Math.min(models.length, limit);
    pool = runFileDownloadPool(models, poolLimit, {
        onFileBlob: function(idx, m, blob) {
            loadedMap[idx] = m.size || blob.size;
            doneCount++;
            report();
            // 立即转存为打包缓存条目，读取开销摊到下载期间
            pendingReads++;
            var reader = new FileReader();
            reader.onload = function() {
                pendingReads--;
                if (!cancelled) rawEntries.push({ name: m.zipName, data: new Uint8Array(reader.result) });
            };
            reader.onerror = function() {
                pendingReads--;
                readFail = true;
                failFile();
            };
            reader.readAsArrayBuffer(blob);
        },
        onFileFail: function() {
            failFile();
        },
        onFileProgress: function(idx, m, loaded) {
            loadedMap[idx] = loaded;
            report();
        },
        onSettle: function() {
            if (!cancelled) packWhenReady();
        }
    });
}

var deleteFilePath = '';
var deleteFileSha = '';
var deleteFileType = 'file';
var deleteParts = null;

function openDeleteModal(filePath, fileSha, fileName, fileType) {
    deleteFilePath = filePath;
    deleteFileSha = fileSha;
    deleteFileType = fileType || 'file';
    deleteParts = deleteFileType === 'chunked' ? (menuFileInfo.parts || []) : null;
    var deleteBtn = document.getElementById('deleteBtn');
    deleteBtn.disabled = false;
    var deleteMsg = document.getElementById('deleteMessage');
    deleteMsg.className = 'message';
    deleteMsg.textContent = '';
    setDeleteProgress(null);
    var confirmP = document.getElementById('deleteConfirmText');
    confirmP.textContent = '';
    confirmP.appendChild(document.createTextNode('确定要删除' + (deleteFileType === 'dir' ? '文件夹 ' : '')));
    var nameStrong = document.createElement('strong');
    nameStrong.textContent = fileName;
    confirmP.appendChild(nameStrong);
    var suffixText = ' 吗？';
    if (deleteFileType === 'dir') suffixText += '其中的所有文件都将被删除，';
    else if (deleteFileType === 'chunked') suffixText += '该文件的所有分片都将被删除，';
    confirmP.appendChild(document.createTextNode(suffixText + '此操作不可撤销。'));
    var savedAuth = getSavedAuth();
    document.getElementById('deleteAuthFields').style.display = savedAuth ? 'none' : '';
    document.getElementById('deleteModal').classList.add('show');
}

function closeDeleteModal() {
    document.getElementById('deleteModal').classList.remove('show');
    document.getElementById('deleteMessage').className = 'message';
    document.getElementById('deleteMessage').textContent = '';
    document.getElementById('deleteUsername').value = '';
    document.getElementById('deletePassword').value = '';
    document.getElementById('deleteStopBtn').style.display = 'none';
    setDeleteProgress(null);
}

// 删除进度条（删除弹窗内）：done=null 隐藏
function setDeleteProgress(done, total) {
    var wrap = document.getElementById('deleteProgress');
    if (!wrap) return;
    if (done === null) {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = 'block';
    var pct = total ? Math.round(done / total * 100) : 0;
    document.getElementById('deleteProgressFill').style.width = pct + '%';
    document.getElementById('deleteProgressText').textContent = done + ' / ' + total + ' · ' + pct + '%';
}

function bindEntryEvents(entry) {
    entry.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(e.clientX, e.clientY, entry._model);
    });
    entry.addEventListener('click', function(e) {
        if (Date.now() - menuOpenedAt < 400) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        // File cards toggle selection; folders keep their default navigation
        if (entry._model && entry._model.type === 'file') {
            e.preventDefault();
            toggleSelect(entry._key);
        }
    });
    var touchTimer = null;
    var touchX = 0;
    var touchY = 0;
    entry.addEventListener('touchstart', function(e) {
        if (e.touches.length !== 1) return;
        touchX = e.touches[0].clientX;
        touchY = e.touches[0].clientY;
        touchTimer = setTimeout(function() {
            touchTimer = null;
            openContextMenu(touchX, touchY, entry._model);
        }, 500);
    });
    entry.addEventListener('touchmove', function() {
        if (touchTimer) {
            clearTimeout(touchTimer);
            touchTimer = null;
        }
    });
    entry.addEventListener('touchend', function() {
        if (touchTimer) {
            clearTimeout(touchTimer);
            touchTimer = null;
        }
    });
}

function openContextMenu(x, y, fileInfo) {
    menuFileInfo = fileInfo;
    menuOpenedAt = Date.now();

    document.getElementById('menuPreview').style.display = fileInfo.type === 'dir' ? 'none' : '';
    document.getElementById('menuEdit').style.display = (fileInfo.type === 'dir' || fileInfo.chunked) ? 'none' : '';
    document.getElementById('menuDownload').style.display = '';
    document.getElementById('menuDelete').style.display = '';

    var menu = document.getElementById('contextMenu');
    menu.classList.add('show');
    var menuWidth = menu.offsetWidth || 120;
    var menuHeight = menu.offsetHeight || 160;
    if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 5;
    if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 5;
    if (x < 0) x = 5;
    if (y < 0) y = 5;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    document.addEventListener('click', closeContextMenuHandler);
}

function closeContextMenu() {
    var menu = document.getElementById('contextMenu');
    menu.classList.remove('show');
    document.removeEventListener('click', closeContextMenuHandler);
}

function closeContextMenuHandler(e) {
    if (Date.now() - menuOpenedAt < 400) return;
    var menu = document.getElementById('contextMenu');
    if (!menu.contains(e.target)) {
        closeContextMenu();
    }
}

function handleMenuAction(action) {
    closeContextMenu();
    var filePath = menuFileInfo.path;
    var fileSha = menuFileInfo.sha;
    var fileName = menuFileInfo.name;
    var fileType = menuFileInfo.type;

    if (action === 'properties') {
        showProperties(filePath, fileName, fileType);
    } else if (action === 'preview') {
        previewFile(filePath, fileName);
    } else if (action === 'edit') {
        editFile(filePath, fileName);
    } else if (action === 'download') {
        if (fileType === 'dir') {
            downloadFolder(filePath, fileName);
        } else if (menuFileInfo.chunked) {
            downloadMergedFile(menuFileInfo.parts, fileName);
        } else {
            downloadFile(filePath, fileName, null, null, menuFileInfo.size);
        }
    } else if (action === 'delete') {
        openDeleteModal(filePath, fileSha, fileName, menuFileInfo.chunked ? 'chunked' : fileType);
    }
}

function saveBlobAs(blob, fileName) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function() { URL.revokeObjectURL(url); }, 10000);
}

// Fetch as Blob first: the download attribute is ignored cross-origin,
// which made previewable files (jpg/mp4/...) open in the tab instead of saving.
// 下载走双通道分段下载器（大文件 EO+CF 并行加速，失败自动回退）。
// 单独下载时驱动全局进度条（可点 ✕ 中止）；批量下载时经 onProgress(loaded, speed, total)
// 汇报字节进度，由调度器汇总为总进度条；onDone(ok) 供串行调度。
function downloadFile(filePath, fileName, onDone, onProgress, sizeHint) {
    var standalone = !onProgress;
    var lastLoaded = 0;
    var lastTime = Date.now();
    var speedText = '';
    var etaText = '';
    var cancelled = false;
    var handle = fetchFileBlobDual(filePath, sizeHint || 0,
        function(loaded, total) {
            var now = Date.now();
            if (now - lastTime >= 500) {
                var sp = (loaded - lastLoaded) / ((now - lastTime) / 1000);
                lastLoaded = loaded;
                lastTime = now;
                speedText = sp > 1024 ? formatSize(Math.round(sp)) + '/s' : '';
                // ETA 跟随最近采样速度：多通道开关/通道增减时动态变化
                etaText = total ? etaTextFromSpeed(total - loaded, sp) : '';
            }
            if (onProgress) {
                onProgress(loaded, speedText, total);
            } else {
                var pct = total ? Math.min(99, Math.round(loaded / total * 100)) : null;
                updateTaskProgress('正在下载: ' + fileName + ' · ' + formatSize(loaded) + (speedText ? ' · ' + speedText : '') + (etaText ? ' · 预计剩余 ' + etaText : ''), pct);
            }
        },
        function(blob) {
            finish(true, blob);
        },
        function() {
            if (cancelled) return;
            showToast('下载失败: ' + fileName);
            setTimeout(hideToast, 2500);
            finish(false);
        });
    if (standalone) {
        showTaskProgress('正在下载: ' + fileName, 0, function() {
            cancelled = true;
            handle.cancel();
            hideTaskProgress();
        });
    }
    function finish(ok, blob) {
        if (standalone) hideTaskProgress();
        if (ok && blob) saveBlobAs(blob, fileName);
        if (onDone) onDone(ok);
    }
    return handle;
}

function setMsg(id, text, type) {
    var msg = document.getElementById(id);
    msg.className = 'message ' + type;
    msg.textContent = text;
}

function showToast(text) {
    var toast = document.getElementById('toast');
    toast.textContent = text;
    toast.classList.add('show');
}

function hideToast() {
    document.getElementById('toast').classList.remove('show');
}

// ---- 后台任务浮泡与持久化 ----
// 进行中的任务（上传/下载）可挂后台：浮泡显示进度，点击恢复界面；
// 任务快照定期写入 localStorage，整页刷新后浮泡仍以“已中断”样式提示
// （传输本身无法在页面刷新后继续，这是浏览器限制）
var BG_TASK_KEY = 'cloud_web_bgtask';
var bgTaskRestore = null;
var bgTaskInterrupted = false;

function showBgTask(text, restoreFn, interrupted) {
    var b = document.getElementById('bgTaskBubble');
    b.style.display = 'flex';
    bgTaskInterrupted = !!interrupted;
    b.classList.toggle('interrupted', bgTaskInterrupted);
    document.getElementById('bgTaskText').textContent = text;
    bgTaskRestore = restoreFn || null;
}

function updateBgTask(text) {
    var b = document.getElementById('bgTaskBubble');
    if (b.style.display === 'none' || bgTaskInterrupted) return;
    document.getElementById('bgTaskText').textContent = text;
}

function clearBgTask() {
    document.getElementById('bgTaskBubble').style.display = 'none';
    bgTaskRestore = null;
    bgTaskInterrupted = false;
    clearBgTaskPersist();
}

function persistBgTask(type, label) {
    try {
        localStorage.setItem(BG_TASK_KEY, JSON.stringify({ type: type, label: label, at: Date.now() }));
    } catch (e) {}
}

function clearBgTaskPersist() {
    try {
        localStorage.removeItem(BG_TASK_KEY);
    } catch (e) {}
}

// 页面加载时恢复提示：有未完成任务记录则显示“已中断”浮泡
function restoreBgTaskHint() {
    var rec = null;
    try {
        rec = JSON.parse(localStorage.getItem(BG_TASK_KEY) || 'null');
    } catch (e) {}
    if (!rec || !rec.label) return;
    if (Date.now() - (rec.at || 0) > 24 * 3600 * 1000) {
        clearBgTaskPersist();
        return;
    }
    showBgTask(rec.label + ' · 已被页面刷新中断', null, true);
}

// ---- 全局任务进度条（单文件/批量/文件夹下载共用） ----
var taskProgressCancelFn = null;

function showTaskProgress(text, pct, onCancel) {
    var el = document.getElementById('taskProgress');
    el.classList.add('show');
    taskProgressCancelFn = onCancel || null;
    document.getElementById('taskProgressCancel').style.display = onCancel ? '' : 'none';
    persistBgTask('download', text);
    updateTaskProgress(text, pct);
}

function updateTaskProgress(text, pct) {
    var el = document.getElementById('taskProgress');
    if (!el.classList.contains('show')) return;
    document.getElementById('taskProgressText').textContent = text;
    var fill = document.getElementById('taskProgressFill');
    if (pct === null || pct === undefined) {
        fill.style.width = '100%';
        fill.style.opacity = '0.35';
        persistBgTask('download', text);
    } else {
        fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
        fill.style.opacity = '';
        persistBgTask('download', text + ' · ' + Math.round(pct) + '%');
    }
}

function hideTaskProgress() {
    document.getElementById('taskProgress').classList.remove('show');
    taskProgressCancelFn = null;
    clearBgTaskPersist();
}

// quiet=true 时不弹 toast（下载场景由全局进度条反馈，避免与 toast 叠在一起）；
// limitOverride>0 时限制本合并下载的并发；budget 为多文件并行池的共享连接
// 预算（工作窃取，见 fetchFileBlobDual），传入后 per-file 配额失效、由全局槽位兜底
function fetchMergedBlob(parts, onDone, onFail, onProgress, onPart, quiet, limitOverride, budget) {
    var buffers = new Array(parts.length);
    var nextIndex = 0;
    var doneCount = 0;
    var failed = false;
    var cancelled = false;
    var mergeCfDown = false;   // CF 通道熔断标志
    var mergeCfFails = 0;
    var getLimit = function() {
        return limitOverride > 0 ? limitOverride : dlGetLimit();
    };
    // quiet=下载场景：纳入分通道速度统计（预览不统计）
    var tracked = false;
    if (quiet) {
        dlTrackStart();
        tracked = true;
    }
    function untrack() {
        if (tracked) {
            tracked = false;
            dlUnregisterScheduler(pumpMerge);
            dlTrackStop();
        }
    }
    var actives = [];
    var lastPrefix = 0;
    var totalBytes = 0;
    parts.forEach(function(p) { totalBytes += p.size || 0; });
    var loadedBytes = 0;
    var lastSampleLoaded = 0;
    var lastSampleTime = Date.now();
    var speedText = '';
    // 分通道速度统计（预览场景展示 EO/CF/外部 各自速度）
    var chanBytes = { eo: 0, cf: 0, ext: 0 };
    var lastChanBytes = { eo: 0, cf: 0, ext: 0 };
    var chanSpeedText = '';
    var etaText = '';

    var progressText = function() {
        var pct = totalBytes ? Math.min(99, Math.round(loadedBytes / totalBytes * 100)) : 0;
        return '正在加载 ' + doneCount + '/' + parts.length + ' · ' + pct + '%' + (speedText ? ' · ' + speedText : '');
    };

    var report = function() {
        if (!quiet) showToast(progressText());
        if (onProgress) {
            onProgress(totalBytes ? Math.min(99, Math.round(loadedBytes / totalBytes * 100)) : null, speedText, chanSpeedText, etaText);
        }
    };

    var sample = function() {
        var now = Date.now();
        var dt = (now - lastSampleTime) / 1000;
        if (now - lastSampleTime >= 500) {
            var sp = (loadedBytes - lastSampleLoaded) / dt;
            lastSampleLoaded = loadedBytes;
            lastSampleTime = now;
            speedText = sp > 1024 ? formatSize(Math.round(sp)) + '/s' : '';
            // 各通道速度：仅显示有流量的通道
            var chanParts = [];
            var names = { eo: 'EO', cf: 'CF', ext: '外部' };
            for (var c in chanBytes) {
                var csp = (chanBytes[c] - lastChanBytes[c]) / dt;
                lastChanBytes[c] = chanBytes[c];
                if (csp > 1024) chanParts.push(names[c] + ' ' + formatSize(Math.round(csp)) + '/s');
            }
            chanSpeedText = chanParts.join(' · ');
            // ETA 跟随最近采样速度：多通道开关/通道增减时动态变化
            etaText = etaTextFromSpeed(totalBytes - loadedBytes, sp);
        }
    };

    if (!quiet) showToast('正在加载 0/' + parts.length + ' ...');

    // 片占用的共享预算槽位只释放一次（重试不释放：槽位随片换源保留）
    var releaseBudget = function(p) {
        if (budget && p && p._budgetHeld) {
            p._budgetHeld = false;
            budget.active = Math.max(0, budget.active - 1);
        }
    };

    var fail = function() {
        if (failed || cancelled) return;
        failed = true;
        // 在途片回调将因 failed 提前返回、不再自行释放，统一归还预算槽位
        parts.forEach(function(p) { releaseBudget(p); });
        untrack();
        hideToast();
        if (onFail) onFail();
    };

    var next = function() {
        if (failed || cancelled) return;
        if (doneCount >= parts.length) {
            untrack();
            hideToast();
            if (onProgress) onProgress(100, '');
            onDone(new Blob(buffers));
            return;
        }
        if (nextIndex >= parts.length) return;
        var i = nextIndex++;
        if (budget) {
            budget.active++;
            parts[i]._budgetHeld = true;
        }
        // 每片在 EO/CF/外部代理间按在途均衡 + 实测速率加权分配；失败换源
        // 重试（最多 3 次），CF 连续失败 2 次熔断，外部代理按代理熔断轮换
        var attempt = 0;
        var startPart = function() {
            if (failed || cancelled) return;
            parts[i]._t0 = Date.now();
            // 通道：重试在上次失败的通道之外换源；CF 熔断后排除 CF 通道
            var chan;
            if (attempt > 0) {
                var ex = parts[i]._lastChan;
                chan = pickDlChannel(ex) || pickDlFallback(ex);
            } else if (mergeCfDown) {
                chan = pickDlChannel('cf') || pickDlFallback('cf');
            } else {
                chan = pickDlChannel() || pickDlFallback();
            }
            // 外部代理：先锁定所用代理（记录以便按代理熔断）；
            // 挑选期间全部熔断的极端情况直接回退 EO
            if (chan === 'ext') {
                parts[i]._extBase = extPickBase();
                if (!parts[i]._extBase) chan = 'eo';
            }
            parts[i]._lastChan = chan;
            dlChanInc(chan);
            var url;
            if (chan === 'cf') {
                url = cfRawUrl(parts[i].path);
            } else if (chan === 'ext') {
                url = extRawUrl(parts[i]._extBase, parts[i].path);
            } else {
                url = ghUrl('https://raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME + '/' + DEFAULT_BRANCH + '/' + encodeURI(parts[i].path));
            }
            var xhr = new XMLHttpRequest();
            actives.push(xhr);
            xhr.open('GET', url, true);
            xhr.responseType = 'arraybuffer';
            // 停滞看门狗：15 秒无进度即中止换源（代理挂起会在途槽位被永久占住）
            parts[i]._lastRecvAt = Date.now();
            var wd = setInterval(function() {
                if (Date.now() - parts[i]._lastRecvAt > 15000) {
                    try { xhr.abort(); } catch (e) {}
                }
            }, 3000);
            xhr.onprogress = function(e) {
                parts[i]._lastRecvAt = Date.now();
                var delta = e.loaded - (parts[i]._loaded || 0);
                parts[i]._loaded = e.loaded;
                loadedBytes += delta;
                chanBytes[chan] += delta;
                if (quiet) dlTrackAdd(chan, delta);
                sample();
                report();
            };
            xhr.onload = function() {
                clearInterval(wd);
                actives.splice(actives.indexOf(xhr), 1);
                if (cancelled) return;
                if (xhr.status === 200) {
                    buffers[i] = xhr.response;
                    dlChanDec(chan);
                    releaseBudget(parts[i]);
                    if (budget) dlNotify();   // 唤醒池内其他文件抢占空出的全局槽位
                    loadedBytes += (parts[i].size || 0) - (parts[i]._loaded || 0);
                    doneCount++;
                    dlAdaptiveSuccess(Date.now() - (parts[i]._t0 || Date.now()));
                    report();
                    // 已连续完成的前缀分片数增长时回调，供分片音频边下边播
                    if (onPart) {
                        var prefix = 0;
                        while (prefix < buffers.length && buffers[prefix]) prefix++;
                        if (prefix > lastPrefix) {
                            lastPrefix = prefix;
                            onPart(prefix, buffers);
                        }
                    }
                    next();
                    pumpMerge();
                } else {
                    retryPart(chan);
                }
            };
            xhr.onerror = function() {
                clearInterval(wd);
                actives.splice(actives.indexOf(xhr), 1);
                retryPart(chan);
            };
            xhr.onabort = function() {
                // 看门狗中止（非用户取消）同样换源重试，否则在途槽位泄漏
                clearInterval(wd);
                actives.splice(actives.indexOf(xhr), 1);
                if (failed || cancelled) return;
                retryPart(chan);
            };
            xhr.send();
        };
        var retryPart = function(chan) {
            if (failed || cancelled) return;
            dlChanDec(chan);
            if (chan === 'cf') {
                mergeCfFails++;
                if (mergeCfFails >= 2) mergeCfDown = true;
            } else if (chan === 'ext') {
                // 外部代理按代理熔断：单个代理连续失败 2 次即轮换下一个
                extNoteFail(parts[i]._extBase);
            } else {
                // EO 片失败暗示链路饱和，自适应降低下载并发
                dlAdaptiveFail();
            }
            attempt++;
            if (attempt >= DUAL_SEG_MAX_ATTEMPTS) {
                fail();
                return;
            }
            // 整片换源重下：回退已计进度
            loadedBytes -= (parts[i]._loaded || 0);
            parts[i]._loaded = 0;
            startPart();
        };
        startPart();
    };

    // 片调度器：在途片数不超过当前下载并发限制（自适应动态调整）；
    // 预算模式下另受池级全局槽位约束，耗尽即停，由 dlNotify 唤醒补位
    var pumpMerge = function() {
        while (!failed && !cancelled && actives.length < getLimit() && nextIndex < parts.length) {
            if (budget && budget.active >= dlGetLimit()) return;
            next();
        }
    };
    dlRegisterScheduler(pumpMerge);
    pumpMerge();

    // 返回句柄供关闭预览时中止合并，避免后台继续拉分片
    return {
        cancel: function() {
            cancelled = true;
            parts.forEach(function(p) { releaseBudget(p); });
            untrack();
            actives.slice().forEach(function(x) { try { x.abort(); } catch (e) {} });
            // 中止的在途片不会回调 dlChanDec，直接清零在途计数避免负载均衡失真
            dlActive.eo = dlActive.cf = dlActive.ext = 0;
            hideToast();
        }
    };
}

// Fetch a whole file as Blob with live percentage + speed updates
function loadMediaWithRate(url, totalSize, loadingDiv, onDone, onFail) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'blob';
    var lastLoaded = 0;
    var lastTime = Date.now();
    var speedText = '';
    xhr.onprogress = function(e) {
        var now = Date.now();
        if (now - lastTime >= 500) {
            var sp = (e.loaded - lastLoaded) / ((now - lastTime) / 1000);
            lastLoaded = e.loaded;
            lastTime = now;
            speedText = sp > 1024 ? formatSize(Math.round(sp)) + '/s' : '';
        }
        var pct = null;
        if (totalSize) pct = Math.min(99, Math.round(e.loaded / totalSize * 100));
        else if (e.lengthComputable) pct = Math.round(e.loaded / e.total * 100);
        loadingDiv.textContent = '加载中' + (pct !== null ? ' ' + pct + '%' : '...') + (speedText ? ' · ' + speedText : '');
    };
    xhr.onload = function() {
        if (xhr.status === 200) {
            onDone(xhr.response);
        } else {
            onFail(xhr.status);
        }
    };
    xhr.onerror = function() {
        onFail(0);
    };
    xhr.send();
}

// 图片流式预览：fetch 分块读取，角标实时显示速度与百分比，
// 每 400ms 用已收到的部分数据重建 ObjectURL 实现渐进式渲染（边下边显示）。
// 多线程加速：先用 Range 探测总大小，大图（>512KB 且支持 206）切成 4 段并行拉取；
// 渐进渲染只取“已连续完成的前缀分段 + 当前段的已收部分”，并行度不影响边下边显示。
// 基线 JPEG 等非渐进格式收完前无法解码属正常，加载文案会持续显示进度。
// 返回 false 表示环境不支持流式读取，调用方回退为直接设置 img.src。
var PREVIEW_STREAMS = 4;
var PREVIEW_PARALLEL_MIN = 512 * 1024;

function streamImagePreview(url, img, loadingDiv, rateTag, onFail, filePath) {
    if (!window.fetch || typeof AbortController === 'undefined' || typeof ReadableStream === 'undefined') {
        return false;
    }
    var controller = new AbortController();
    previewAbort = controller;
    var signal = controller.signal;
    var total = menuFileInfo.size || 0;
    var segments = null; // [{chunks:[], received, done, failed}]
    var received = 0;
    var lastLoaded = 0;
    var lastTime = Date.now();
    var lastPaint = 0;
    var tmpUrl = null;
    var failed = false;
    var finished = false;   // 全程完成后置位，迟到的部分数据探针不得再换源
    // 三通道（EO/CF/外部）分通道速度统计
    var chanBytes = { eo: 0, cf: 0, ext: 0 };
    var lastChanBytes = { eo: 0, cf: 0, ext: 0 };
    var CHAN_NAMES = { eo: 'EO', cf: 'CF', ext: '外部' };

    var isAbort = function(err) { return err && err.name === 'AbortError'; };

    var failOnce = function(status) {
        if (failed) return;
        failed = true;
        if (previewAbort === controller) previewAbort = null;
        try { controller.abort(); } catch (e) {}
        onFail(status || 0);
    };

    // 已连续完成的前缀分段 + 首个未完成段的已收部分（段内数据天然连续）
    var prefixChunks = function() {
        var list = [];
        for (var i = 0; i < segments.length; i++) {
            var s = segments[i];
            for (var j = 0; j < s.chunks.length; j++) list.push(s.chunks[j]);
            if (!s.done) break;
        }
        return list;
    };

    var paint = function() {
        if (finished || failed) return;
        // 先用隐藏 Image 验证部分数据可解码再换到可见 img：
        // 基线 JPEG / WebP 等格式收完前无法解码，直接换源会闪破图图标
        var u = URL.createObjectURL(new Blob(prefixChunks()));
        var probe = new Image();
        probe.onload = function() {
            // 竞态防护：探针解码是异步的，finishAll 完成后迟到的部分数据
            // 若再换源会把完整图片覆盖回不完整数据（加载后显示不全）
            if (finished || failed) {
                URL.revokeObjectURL(u);
                return;
            }
            if (tmpUrl) URL.revokeObjectURL(tmpUrl);
            tmpUrl = u;
            img.src = u;
        };
        probe.onerror = function() {
            URL.revokeObjectURL(u);
        };
        probe.src = u;
    };

    var finishAll = function() {
        finished = true;
        var all = [];
        segments.forEach(function(s) {
            for (var j = 0; j < s.chunks.length; j++) all.push(s.chunks[j]);
        });
        var u = URL.createObjectURL(new Blob(all));
        if (tmpUrl) {
            URL.revokeObjectURL(tmpUrl);
            tmpUrl = null;
        }
        setPreviewBlobUrl(u);
        if (previewAbort === controller) previewAbort = null;
        img.src = u;
        loadingDiv.style.display = 'none';
        // 完成后保留最终速度 3s 再消失，避免一闪而过
        setTimeout(function() { rateTag.textContent = ''; }, 3000);
    };

    // 读取一个响应流到指定分段；rangeEnd 为 null 表示整文件单段。
    // attempt>=0 时可换源续传重试（从该段已收位置继续 Range）；-1 表示单流不重试
    var pumpInto = function(resp, seg, attempt) {
        var reader = resp.body.getReader();
        var pump = function() {
            reader.read().then(function(r) {
                if (failed) return;
                if (r.done) {
                    seg.done = true;
                    if (seg._chan) dlChanDec(seg._chan);
                    for (var i = 0; i < segments.length; i++) {
                        if (!segments[i].done) return;
                    }
                    finishAll();
                    return;
                }
                seg.chunks.push(r.value);
                seg.received += r.value.byteLength;
                received += r.value.byteLength;
                if (seg._chan) chanBytes[seg._chan] += r.value.byteLength;
                else chanBytes.eo += r.value.byteLength;
                var now = Date.now();
                if (now - lastTime >= 500) {
                    var dt = (now - lastTime) / 1000;
                    var sp = (received - lastLoaded) / dt;
                    lastLoaded = received;
                    lastTime = now;
                    // 分通道速度：仅显示有流量的通道，三通道负载一目了然
                    var chanParts = [];
                    for (var c in chanBytes) {
                        var csp = (chanBytes[c] - lastChanBytes[c]) / dt;
                        lastChanBytes[c] = chanBytes[c];
                        if (csp > 1024) chanParts.push(CHAN_NAMES[c] + ' ' + formatSize(Math.round(csp)) + '/s');
                    }
                    var speedPart = chanParts.length ? chanParts.join(' · ') : (sp > 1024 ? formatSize(Math.round(sp)) + '/s' : '');
                    var pctPart = total ? Math.min(99, Math.round(received / total * 100)) + '%' : '';
                    rateTag.textContent = [speedPart, pctPart].filter(function(s) { return s; }).join(' · ');
                    // 非渐进式图片在收完前无法渲染，加载文案同步显示进度避免无反馈
                    loadingDiv.textContent = '加载中' + (pctPart ? ' ' + pctPart : '...') + (speedPart ? ' · ' + speedPart : '');
                }
                if (now - lastPaint >= 400) {
                    lastPaint = now;
                    paint();
                }
                pump();
            }, function(err) {
                if (isAbort(err)) {
                    if (seg._chan) dlChanDec(seg._chan);
                    return;
                }
                if (attempt >= 0) {
                    if (seg._chan) dlChanDec(seg._chan);
                    retrySeg(seg, attempt, seg._chan);
                    return;
                }
                failOnce(0);
            });
        };
        pump();
    };

    // 段级三通道调度：按在途均衡 + 速率加权在 EO/CF/外部代理间分配，
    // 失败换源续传（最多 3 次），外部代理按代理熔断轮换
    var fetchSeg = function(seg, attempt) {
        if (failed || finished) return;
        var chan;
        if (attempt > 0) {
            chan = pickDlChannel(seg._lastChan) || pickDlFallback(seg._lastChan);
        } else {
            chan = pickDlChannel() || pickDlFallback();
        }
        if (chan === 'ext') {
            seg._extBase = extPickBase();
            if (!seg._extBase) chan = 'eo';
        }
        seg._lastChan = chan;
        seg._chan = chan;
        dlChanInc(chan);
        var segUrl = chan === 'cf' ? cfRawUrl(filePath) : (chan === 'ext' ? extRawUrl(seg._extBase, filePath) : url);
        // 续传：从该段已收位置继续，避免重复拉取
        var from = seg.start + seg.received;
        fetch(segUrl, {
            signal: signal,
            cache: 'no-store',
            headers: { 'Range': 'bytes=' + from + '-' + seg.end }
        }).then(function(r2) {
            if (failed) {
                dlChanDec(chan);
                return;
            }
            if (r2.status !== 206 || !r2.body) {
                dlChanDec(chan);
                retrySeg(seg, attempt, chan);
                return;
            }
            pumpInto(r2, seg, attempt);
        }, function(err) {
            if (isAbort(err)) {
                dlChanDec(chan);
                return;
            }
            dlChanDec(chan);
            retrySeg(seg, attempt, chan);
        });
    };
    var retrySeg = function(seg, attempt, chan) {
        if (failed || finished) return;
        if (chan === 'ext') extNoteFail(seg._extBase);
        if (attempt + 1 >= DUAL_SEG_MAX_ATTEMPTS) {
            failOnce(0);
            return;
        }
        fetchSeg(seg, attempt + 1);
    };

    // Range 探测：拿总大小并确认服务器支持分段
    var probeUrl = url;
    fetch(probeUrl, { signal: signal, cache: 'no-store', headers: { 'Range': 'bytes=0-0' } }).then(function(resp) {
        if (failed) return;
        if (resp.status === 206 && resp.body) {
            var cr = resp.headers.get('Content-Range') || '';
            var m = cr.match(/\/(\d+)\s*$/);
            if (m) total = parseInt(m[1], 10);
            try { resp.body.cancel(); } catch (e) {}
            if (total > PREVIEW_PARALLEL_MIN) {
                // 多线程：切 PREVIEW_STREAMS 段并行 Range 拉取（三通道分配）
                var segSize = Math.ceil(total / PREVIEW_STREAMS);
                segments = [];
                for (var i = 0; i < PREVIEW_STREAMS; i++) {
                    var start = i * segSize;
                    var end = Math.min(start + segSize, total) - 1;
                    if (start > end) break;
                    segments.push({ start: start, end: end, chunks: [], received: 0, done: false });
                }
                segments.forEach(function(seg) {
                    fetchSeg(seg, 0);
                });
                return;
            }
            // 小图：探测响应只有 1 字节不可复用，重新拉全量单流
            fetch(url, { signal: signal, cache: 'no-store' }).then(function(r3) {
                if (failed) return;
                if (!r3.ok || !r3.body) {
                    failOnce(r3.status || 0);
                    return;
                }
                segments = [{ start: 0, end: null, chunks: [], received: 0, done: false }];
                pumpInto(r3, segments[0], -1);
            }, function(err) {
                if (isAbort(err)) return;
                failOnce(0);
            });
            return;
        }
        if (!resp.ok || !resp.body) {
            failOnce(resp.status || 0);
            return;
        }
        // 服务器忽略 Range 返回全量：单流模式，直接复用该响应继续读
        var len = parseInt(resp.headers.get('Content-Length'), 10);
        if (len > 0) total = len;
        segments = [{ start: 0, end: null, chunks: [], received: 0, done: false }];
        pumpInto(resp, segments[0], -1);
    }, function(err) {
        if (isAbort(err)) return;
        failOnce(0);
    });
    return true;
}

// 音/视频三通道测速探测：在 EO/CF/外部（可用时）各拉取文件头部最多 1MB，
// 按实际收到字节计算各通道真实下载速度并汇总显示。
// 媒体元素自身的缓冲增长受浏览器懒加载/暂停预读策略影响，不代表真实带宽，故单独探测。
// onSpeed(speedText) 实时回调（各通道速度拼接）；请求数组存入 previewProbe 以便关闭预览时中止。
function probeMediaSpeed(url, onSpeed, filePath) {
    var chans = dlChannels();
    var probes = [];
    previewProbe = probes;
    var CHAN_NAMES = { eo: 'EO', cf: 'CF', ext: '外部' };
    var speeds = {};   // chan -> speedText
    var emit = function() {
        var partsOut = [];
        ['eo', 'cf', 'ext'].forEach(function(c) {
            if (speeds[c]) partsOut.push(CHAN_NAMES[c] + ' ' + speeds[c]);
        });
        if (partsOut.length) onSpeed(partsOut.join(' · '));
    };
    var cleanup = function(xhr) {
        var i = probes.indexOf(xhr);
        if (i !== -1) probes.splice(i, 1);
        if (!probes.length && previewProbe === probes) previewProbe = null;
    };
    chans.forEach(function(chan) {
        var purl = url;
        if (chan === 'cf') {
            if (!filePath) return;
            purl = cfRawUrl(filePath);
        } else if (chan === 'ext') {
            if (!filePath) return;
            var extBase = extPickBase();
            if (!extBase) return;
            purl = extRawUrl(extBase, filePath);
        }
        var xhr = new XMLHttpRequest();
        probes.push(xhr);
        xhr.open('GET', purl, true);
        var total = menuFileInfo.size || 0;
        if (total > 0) {
            xhr.setRequestHeader('Range', 'bytes=0-' + (Math.min(total, 1048576) - 1));
        }
        xhr.responseType = 'arraybuffer';
        var startTime = Date.now();
        var lastLoaded = 0;
        var lastTime = startTime;
        xhr.onprogress = function(e) {
            var now = Date.now();
            if (now - lastTime >= 300) {
                var sp = (e.loaded - lastLoaded) / ((now - lastTime) / 1000);
                lastLoaded = e.loaded;
                lastTime = now;
                if (sp > 1024) {
                    speeds[chan] = formatSize(Math.round(sp)) + '/s';
                    emit();
                }
            }
            // 代理忽略 Range 时（200 全量响应）收到 1MB 即中止，避免拉完整文件
            if (e.loaded > 1048576) {
                var el = (now - startTime) / 1000;
                var spAll = e.loaded / el;
                if (spAll > 1024) {
                    speeds[chan] = formatSize(Math.round(spAll)) + '/s';
                    emit();
                }
                xhr.abort();
            }
        };
        xhr.onload = function() {
            cleanup(xhr);
            if (xhr.status && xhr.status !== 200 && xhr.status !== 206) return;
            if (!xhr.response) return;
            // 全程平均速度兜底：小文件可能连一次采样窗口都没攒够
            var el = (Date.now() - startTime) / 1000;
            var sp = xhr.response.byteLength / el;
            if (el > 0.05 && sp > 1024) {
                speeds[chan] = formatSize(Math.round(sp)) + '/s';
                emit();
            }
        };
        xhr.onerror = function() { cleanup(xhr); };
        xhr.onabort = function() { cleanup(xhr); };
        xhr.send();
    });
    if (!probes.length && previewProbe === probes) previewProbe = null;
}

// 分片文件合并下载：单独下载时驱动全局进度条（可点 ✕ 中止）；
// 批量下载时经 onProgress(pct, speed) 汇报，由调度器换算字节进度
function downloadMergedFile(parts, fileName, onDone, onProgress) {
    var standalone = !onProgress;
    var handle = fetchMergedBlob(parts, function(blob) {
        if (standalone) hideTaskProgress();
        saveBlobAs(blob, fileName);
        if (onDone) onDone(true);
    }, function() {
        if (standalone) hideTaskProgress();
        showToast('下载失败，请重试');
        setTimeout(hideToast, 2000);
        if (onDone) onDone(false);
    }, function(pct, speed, chanSpeeds, eta) {
        if (onProgress) {
            onProgress(pct, speed);
        } else {
            updateTaskProgress('正在下载: ' + fileName + (speed ? ' · ' + speed : '') + (eta ? ' · 预计剩余 ' + eta : ''), pct);
        }
    }, null, true);
    if (standalone) {
        showTaskProgress('正在下载: ' + fileName, 0, function() { handle.cancel(); });
    }
    return handle;
}

function getFileExtension(fileName) {
    var parts = fileName.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

var AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'aac', 'flac'];
var VIDEO_EXTS = ['mp4', 'webm', 'ogg', 'avi', 'mov'];
var IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'];

// ---- 图片查看器：缩放（按钮/滚轮/双击）、拖拽平移、缩略图条、前后切换 ----
var imgViewer = null; // {stage, img, zoomLabel, posLabel, thumbs, list, index, zoom}

// 收集当前目录的图片列表（分片文件无直链，不参与缩略图条）
function collectImageModels() {
    var list = [];
    entryOrder.forEach(function(k) {
        var rec = entryMap[k];
        if (!rec || rec.model.kind !== 'file' || rec.model.chunked) return;
        if (IMAGE_EXTS.indexOf(getFileExtension(rec.model.name)) === -1) return;
        list.push(rec.model);
    });
    return list;
}

// ---- 音频播放列表：同目录音乐的顺序/随机/单曲循环播放 + 限量预加载 ----
// 播放方式持久化；预加载按播放方式进行（顺序播放预载下一首，单曲循环/随机
// 不预载），且最多同时缓存 1 首、单首超 80MB 不预载——防止目录音频过多
// 时预加载机制过度消耗带宽。分片音频不参与预载（无直链）。
var AUDIO_PL_MODE_KEY = 'cloud_web_audio_pl_mode';
var AUDIO_PL_MODES = ['loop', 'seq', 'rand'];
var AUDIO_PL_MODE_LABELS = { loop: '单曲循环', seq: '顺序播放', rand: '随机播放' };
var AUDIO_PRELOAD_MAX = 1;
var AUDIO_PRELOAD_SIZE_MAX = 80 * 1024 * 1024;
var audioPl = null;   // {list, index, mode, audio, rateTag, cache, preloadXhr, listEl, modeBtn}

function collectAudioModels() {
    var list = [];
    entryOrder.forEach(function(k) {
        var rec = entryMap[k];
        if (!rec || rec.model.kind !== 'file') return;
        if (AUDIO_EXTS.indexOf(getFileExtension(rec.model.name)) === -1) return;
        list.push(rec.model);
    });
    return list;
}

function audioPlModeLoad() {
    var m = 'loop';
    try {
        var saved = localStorage.getItem(AUDIO_PL_MODE_KEY);
        if (saved && AUDIO_PL_MODES.indexOf(saved) !== -1) m = saved;
    } catch (e) {}
    return m;
}

// 关闭预览/切换预览时清理播放列表：中止预载与分片合并，释放缓存 ObjectURL
function teardownAudioPlaylist() {
    if (!audioPl) return;
    if (audioPl.preloadXhr) {
        try { audioPl.preloadXhr.abort(); } catch (e) {}
        audioPl.preloadXhr = null;
    }
    for (var p in audioPl.cache) {
        try { URL.revokeObjectURL(audioPl.cache[p]); } catch (e) {}
    }
    audioPl = null;
}

function audioPlRefreshHighlight() {
    if (!audioPl || !audioPl.listEl) return;
    var items = audioPl.listEl.children;
    for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle('active', i === audioPl.index);
    }
}

// 限量预加载：仅顺序播放模式预载下一首（单曲循环重播当前、随机无法预测，
// 均不预载）；最多缓存 1 首，分片/超大文件跳过
function audioPlMaybePreload() {
    if (!audioPl || audioPl.mode !== 'seq') return;
    var next = audioPl.list[audioPl.index + 1];
    if (!next || next.chunked) return;
    if ((next.size || 0) > AUDIO_PRELOAD_SIZE_MAX) return;
    if (audioPl.cache[next.path] || audioPl.preloadXhr) return;
    var cachedCount = 0;
    for (var p in audioPl.cache) cachedCount++;
    if (cachedCount >= AUDIO_PRELOAD_MAX) return;
    var xhr = new XMLHttpRequest();
    audioPl.preloadXhr = xhr;
    xhr.open('GET', rawUrlFor(next.path), true);
    xhr.responseType = 'blob';
    xhr.onload = function() {
        if (audioPl && audioPl.preloadXhr === xhr) audioPl.preloadXhr = null;
        if (xhr.status === 200 && audioPl) {
            audioPl.cache[next.path] = URL.createObjectURL(xhr.response);
        }
    };
    var clear = function() {
        if (audioPl && audioPl.preloadXhr === xhr) audioPl.preloadXhr = null;
    };
    xhr.onerror = clear;
    xhr.onabort = clear;
    xhr.send();
}

// 切换播放指定曲目；autoplay=true 切换后立即播放
function audioPlPlay(idx, autoplay) {
    if (!audioPl || idx < 0 || idx >= audioPl.list.length) return;
    var m = audioPl.list[idx];
    audioPl.index = idx;
    audioPlRefreshHighlight();
    previewFileInfo = { path: m.path, name: m.name, ext: getFileExtension(m.name) };
    document.getElementById('previewTitle').textContent = '预览: ' + m.name;
    var audioEl = audioPl.audio;
    // 中止进行中的分片合并与旧源
    if (previewMerge) {
        previewMerge.cancel();
        previewMerge = null;
    }
    try { audioEl.pause(); } catch (e) {}
    var startPlay = function() {
        if (autoplay) {
            var p = audioEl.play();
            if (p && p.catch) p.catch(function() {});
        }
    };
    if (m.chunked && m.parts) {
        // 分片音频：合并拉取后整体播放
        if (audioPl.rateTag) audioPl.rateTag.textContent = '加载中...';
        previewMerge = fetchMergedBlob(m.parts, function(blob) {
            previewMerge = null;
            if (!audioPl) return;
            var u = URL.createObjectURL(blob);
            setPreviewBlobUrl(u);
            audioEl.src = u;
            if (audioPl.rateTag) setTimeout(function() { if (audioPl && audioPl.rateTag) audioPl.rateTag.textContent = ''; }, 1500);
            startPlay();
        }, function() {
            previewMerge = null;
            if (audioPl && audioPl.rateTag) audioPl.rateTag.textContent = '加载失败';
        }, function(pct, speed, chanSpeeds) {
            if (audioPl && audioPl.rateTag) {
                audioPl.rateTag.textContent = '加载中 ' + (pct !== null ? pct + '%' : '...') + (chanSpeeds || speed ? ' · ' + (chanSpeeds || speed) : '');
            }
        }, null, true);
    } else {
        // 优先消费预加载缓存（命中即免等待），否则直链边下边播
        var cached = audioPl.cache[m.path];
        if (cached) {
            delete audioPl.cache[m.path];   // 移交播放器使用，不再由缓存管理
            setPreviewBlobUrl(cached);
            audioEl.src = cached;
        } else {
            audioEl.src = rawUrlFor(m.path);
        }
        startPlay();
    }
    audioPlMaybePreload();
}

// 为音频预览构建播放列表 UI（同目录少于 2 首音频时不显示，返回 null）
function setupAudioPlaylist(audioEl, currentPath, rateTag) {
    var list = collectAudioModels();
    if (list.length < 2) return null;
    var index = -1;
    for (var i = 0; i < list.length; i++) {
        if (list[i].path === currentPath) {
            index = i;
            break;
        }
    }
    if (index === -1) return null;
    audioPl = {
        list: list,
        index: index,
        mode: audioPlModeLoad(),
        audio: audioEl,
        rateTag: rateTag,
        cache: {},
        preloadXhr: null,
        listEl: null,
        modeBtn: null
    };
    audioEl.loop = audioPl.mode === 'loop';

    var wrap = document.createElement('div');
    wrap.className = 'audio-pl';
    var bar = document.createElement('div');
    bar.className = 'audio-pl-bar';
    var modeBtn = document.createElement('button');
    modeBtn.type = 'button';
    modeBtn.className = 'audio-pl-btn';
    modeBtn.title = '切换播放方式';
    modeBtn.textContent = AUDIO_PL_MODE_LABELS[audioPl.mode];
    audioPl.modeBtn = modeBtn;
    modeBtn.addEventListener('click', function() {
        if (!audioPl) return;
        var i = (AUDIO_PL_MODES.indexOf(audioPl.mode) + 1) % AUDIO_PL_MODES.length;
        audioPl.mode = AUDIO_PL_MODES[i];
        try { localStorage.setItem(AUDIO_PL_MODE_KEY, audioPl.mode); } catch (e) {}
        modeBtn.textContent = AUDIO_PL_MODE_LABELS[audioPl.mode];
        audioEl.loop = audioPl.mode === 'loop';
        audioPlMaybePreload();
    });
    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'audio-pl-btn';
    toggleBtn.textContent = '列表';
    var countSpan = document.createElement('span');
    countSpan.className = 'audio-pl-count';
    countSpan.textContent = (index + 1) + '/' + list.length + ' 首';
    var listEl = document.createElement('div');
    listEl.className = 'audio-pl-list';
    audioPl.listEl = listEl;
    list.forEach(function(m, i2) {
        var item = document.createElement('div');
        item.className = 'audio-pl-item' + (i2 === index ? ' active' : '');
        item.textContent = displayName(m.name);
        item.title = displayName(m.name);
        item.addEventListener('click', function() {
            audioPlPlay(i2, true);
        });
        listEl.appendChild(item);
    });
    toggleBtn.addEventListener('click', function() {
        listEl.classList.toggle('show');
    });
    bar.appendChild(modeBtn);
    bar.appendChild(toggleBtn);
    bar.appendChild(countSpan);
    wrap.appendChild(bar);
    wrap.appendChild(listEl);

    // 播放结束按播放方式推进：loop 由 audio.loop 自动重播；
    // seq 顺序到尾停止；rand 随机抽下一首（不重复当前）
    audioEl.addEventListener('ended', function() {
        if (!audioPl || audioEl !== audioPl.audio) return;
        if (audioPl.mode === 'loop') return;
        if (audioPl.mode === 'seq') {
            if (audioPl.index + 1 < audioPl.list.length) {
                audioPlPlay(audioPl.index + 1, true);
                countSpan.textContent = (audioPl.index + 1) + '/' + audioPl.list.length + ' 首';
            }
            return;
        }
        if (audioPl.list.length > 1) {
            var n;
            do { n = Math.floor(Math.random() * audioPl.list.length); } while (n === audioPl.index);
            audioPlPlay(n, true);
            countSpan.textContent = (audioPl.index + 1) + '/' + audioPl.list.length + ' 首';
        }
    });
    // 点击列表切换后同步计数显示
    listEl.addEventListener('click', function() {
        setTimeout(function() {
            if (audioPl) countSpan.textContent = (audioPl.index + 1) + '/' + audioPl.list.length + ' 首';
        }, 0);
    });
    audioPlMaybePreload();
    return wrap;
}

function buildImageViewer() {
    var wrap = document.createElement('div');
    wrap.className = 'img-viewer';

    var toolbar = document.createElement('div');
    toolbar.className = 'img-viewer-toolbar';
    var mkBtn = function(text, title, fn) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn';
        b.textContent = text;
        b.title = title;
        b.addEventListener('click', fn);
        return b;
    };
    var zoomLabel = document.createElement('span');
    zoomLabel.className = 'img-viewer-zoom-label';
    var prevBtn = mkBtn('◀', '上一张 (←)', function() { imgViewerGo(imgViewer.index - 1); });
    var nextBtn = mkBtn('▶', '下一张 (→)', function() { imgViewerGo(imgViewer.index + 1); });
    var posLabel = document.createElement('span');
    posLabel.className = 'img-viewer-pos';
    toolbar.appendChild(mkBtn('－', '缩小', function() { imgViewerSetZoom(imgViewer.zoom / 1.25); }));
    toolbar.appendChild(zoomLabel);
    toolbar.appendChild(mkBtn('＋', '放大', function() { imgViewerSetZoom(imgViewer.zoom * 1.25); }));
    toolbar.appendChild(mkBtn('适应', '适应窗口', function() { imgViewerSetZoom(1); }));
    toolbar.appendChild(mkBtn('1:1', '实际大小', function() { imgViewerActualSize(); }));
    toolbar.appendChild(prevBtn);
    toolbar.appendChild(nextBtn);
    toolbar.appendChild(posLabel);
    wrap.appendChild(toolbar);

    // stage-wrap 不滚动：鸟瞰图相对它定位，拖动/缩放时始终固定在右下角
    var stageWrap = document.createElement('div');
    stageWrap.className = 'img-viewer-stage-wrap';
    var stage = document.createElement('div');
    stage.className = 'img-viewer-stage';
    var img = document.createElement('img');
    img.alt = '';
    stage.appendChild(img);
    // 鸟瞰图：放大后显示整张图与当前视口位置，拖动可快速定位
    var minimap = document.createElement('canvas');
    minimap.className = 'img-viewer-minimap';
    stageWrap.appendChild(stage);
    stageWrap.appendChild(minimap);
    wrap.appendChild(stageWrap);

    var thumbs = document.createElement('div');
    thumbs.className = 'img-thumbs';

    imgViewer = {
        wrap: wrap,
        stage: stage,
        img: img,
        minimap: minimap,
        zoomLabel: zoomLabel,
        posLabel: posLabel,
        prevBtn: prevBtn,
        nextBtn: nextBtn,
        thumbs: thumbs,
        thumbsLoaded: false,
        list: [],
        index: -1,
        zoom: 1
    };
    bindImageViewerEvents();
    return wrap;
}

// 重绘图片鸟瞰图：整张图缩小显示，叠加当前视口矩形；仅放大后显示
function imgViewerUpdateMinimap() {
    var v = imgViewer;
    if (!v || !v.minimap) return;
    var mm = v.minimap;
    var img = v.img;
    var dispW = img.clientWidth;
    var dispH = img.clientHeight;
    if (v.zoom <= 1 || !dispW || !dispH || !img.naturalWidth) {
        mm.style.display = 'none';
        return;
    }
    // 同源 EO / blob 图片，canvas 绘制不会被污染
    try {
        var mapW = 120;
        var mapH = Math.round(mapW * dispH / dispW);
        if (mapH > 100) {
            mapH = 100;
            mapW = Math.round(mapH * dispW / dispH);
        }
        if (mm.width !== mapW || mm.height !== mapH) {
            mm.width = mapW;
            mm.height = mapH;
        }
        var ctx = mm.getContext('2d');
        ctx.clearRect(0, 0, mapW, mapH);
        ctx.drawImage(img, 0, 0, mapW, mapH);
        var stage = v.stage;
        var rx = stage.scrollLeft / dispW * mapW;
        var ry = stage.scrollTop / dispH * mapH;
        var rw = Math.min(mapW, stage.clientWidth / dispW * mapW);
        var rh = Math.min(mapH, stage.clientHeight / dispH * mapH);
        ctx.fillStyle = 'rgba(44, 130, 201, 0.15)';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = 'rgba(44, 130, 201, 0.7)';
        ctx.lineWidth = 1;
        ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
        mm.style.display = 'block';
    } catch (e) {
        mm.style.display = 'none';
    }
}

function bindImageViewerEvents() {
    var v = imgViewer;
    var img = v.img;
    var stage = v.stage;
    // 滚轮缩放
    stage.addEventListener('wheel', function(e) {
        e.preventDefault();
        imgViewerSetZoom(v.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    }, { passive: false });
    // 双击在“适应”与“实际大小”之间切换
    img.addEventListener('dblclick', function() {
        if (v.zoom === 1) imgViewerActualSize();
        else imgViewerSetZoom(1);
    });
    // 拖拽平移（拖动滚动条区域）；document 监听临时注册，抬起即移除
    img.addEventListener('mousedown', function(e) {
        if (v.zoom <= 1) return;
        e.preventDefault();
        img.classList.add('dragging');
        var startX = e.clientX;
        var startY = e.clientY;
        var startLeft = stage.scrollLeft;
        var startTop = stage.scrollTop;
        var move = function(ev) {
            if (imgViewer !== v) return;
            stage.scrollLeft = startLeft - (ev.clientX - startX);
            stage.scrollTop = startTop - (ev.clientY - startY);
        };
        var up = function() {
            img.classList.remove('dragging');
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
    });
    // 鸟瞰图交互与随滚动刷新
    var mm = v.minimap;
    var mmJump = function(e) {
        var rect = mm.getBoundingClientRect();
        var dispW = img.clientWidth || 1;
        var dispH = img.clientHeight || 1;
        stage.scrollLeft = (e.clientX - rect.left) / rect.width * dispW - stage.clientWidth / 2;
        stage.scrollTop = (e.clientY - rect.top) / rect.height * dispH - stage.clientHeight / 2;
    };
    mm.addEventListener('mousedown', function(e) {
        e.preventDefault();
        e.stopPropagation();
        mmJump(e);
        var move = function(ev) {
            if (imgViewer === v) mmJump(ev);
        };
        var up = function() {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
    });
    stage.addEventListener('scroll', imgViewerUpdateMinimap);
    img.addEventListener('load', function() {
        setTimeout(imgViewerUpdateMinimap, 0);
        imgViewerLoadThumbs();
    });
}

// 应用缩放：以“适应宽度”为基准按倍数设定显示宽度，平移由容器滚动承担
function imgViewerApply() {
    var v = imgViewer;
    if (!v) return;
    var fitW = v.stage.clientWidth - 4;
    if (fitW < 50) fitW = 50;
    if (Math.abs(v.zoom - 1) < 0.001) {
        v.img.style.width = '';
        v.img.style.maxWidth = '100%';
        v.zoomLabel.textContent = '适应';
    } else {
        v.img.style.maxWidth = 'none';
        v.img.style.width = Math.round(fitW * v.zoom) + 'px';
        v.zoomLabel.textContent = Math.round(v.zoom * 100) + '%';
    }
    // 等布局应用后再量取显示尺寸重绘鸟瞰图
    setTimeout(imgViewerUpdateMinimap, 0);
}

function imgViewerSetZoom(z) {
    var v = imgViewer;
    if (!v) return;
    v.zoom = Math.max(0.2, Math.min(8, z));
    imgViewerApply();
}

function imgViewerActualSize() {
    var v = imgViewer;
    if (!v) return;
    var fitW = v.stage.clientWidth - 4;
    var natW = v.img.naturalWidth || fitW;
    v.zoom = Math.max(0.2, Math.min(8, natW / Math.max(50, fitW)));
    imgViewerApply();
}

// 填充缩略图条并同步前后切换按钮与位置显示
function imgViewerSetList(models, currentPath) {
    var v = imgViewer;
    if (!v) return;
    v.list = models.map(function(m) {
        return { name: m.displayName || m.name, url: rawUrlFor(m.path) };
    });
    v.index = -1;
    for (var i = 0; i < v.list.length; i++) {
        if (models[i].path === currentPath) {
            v.index = i;
            break;
        }
    }
    v.thumbs.innerHTML = '';
    v.thumbsLoaded = false;
    if (v.list.length > 1) {
        v.list.forEach(function(item, i) {
            var t = document.createElement('img');
            // 缩略图延后加载：主图首次成功解码后才设置 src，
            // 保证带宽优先供给当前查看的图片
            t.dataset.src = item.url;
            t.alt = item.name;
            t.title = item.name;
            t.loading = 'lazy';
            if (i === v.index) t.className = 'active';
            t.addEventListener('click', function() { imgViewerGo(i); });
            v.thumbs.appendChild(t);
        });
        if (v.thumbs.parentNode !== v.wrap) {
            v.wrap.appendChild(v.thumbs);
        }
    } else if (v.thumbs.parentNode) {
        v.thumbs.parentNode.removeChild(v.thumbs);
    }
    imgViewerSyncNav();
}

// 主图加载成功后再加载缩略图条（幂等）
function imgViewerLoadThumbs() {
    var v = imgViewer;
    if (!v || v.thumbsLoaded) return;
    v.thumbsLoaded = true;
    var thumbs = v.thumbs.children;
    for (var i = 0; i < thumbs.length; i++) {
        if (thumbs[i].dataset.src) thumbs[i].src = thumbs[i].dataset.src;
    }
}

function imgViewerSyncNav() {
    var v = imgViewer;
    if (!v) return;
    var hasNav = v.index !== -1 && v.list.length > 1;
    v.prevBtn.style.display = hasNav ? '' : 'none';
    v.nextBtn.style.display = hasNav ? '' : 'none';
    v.posLabel.textContent = hasNav ? (v.index + 1) + ' / ' + v.list.length : '';
    var thumbs = v.thumbs.children;
    for (var i = 0; i < thumbs.length; i++) {
        thumbs[i].className = (i === v.index) ? 'active' : '';
    }
    if (hasNav && thumbs[v.index] && thumbs[v.index].scrollIntoView) {
        thumbs[v.index].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
}

// 切换图片（缩略图/前后按钮/方向键）：中断当前流式加载，直接换源（直链可走浏览器缓存）
function imgViewerGo(i) {
    var v = imgViewer;
    if (!v || i < 0 || i >= v.list.length || i === v.index) return;
    if (previewAbort) {
        try { previewAbort.abort(); } catch (e) {}
        previewAbort = null;
    }
    v.index = i;
    v.zoom = 1;
    imgViewerApply();
    v.img.src = v.list[i].url;
    document.getElementById('previewTitle').textContent = '预览: ' + v.list[i].name;
    imgViewerSyncNav();
}

function destroyImageViewer() {
    imgViewer = null;
}

// 预览打开期间 ← → 切换图片
document.addEventListener('keydown', function(e) {
    if (!imgViewer || imgViewer.index === -1 || imgViewer.list.length < 2) return;
    if (!document.getElementById('previewModal').classList.contains('show')) return;
    if (e.key === 'ArrowLeft') {
        e.preventDefault();
        imgViewerGo(imgViewer.index - 1);
    } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        imgViewerGo(imgViewer.index + 1);
    }
});

// ---- Lightweight syntax highlighting for text preview/edit ----
var LANG_KEYWORDS = {
    js: 'const let var function return if else for while class new typeof instanceof import export from async await try catch finally throw switch case break continue default this null undefined true false of in do extends super static get set yield delete void',
    json: 'true false null',
    py: 'def return if elif else for while class import from as try except finally raise with lambda pass break continue True False None and or not in is global nonlocal yield async await print self del assert',
    c: 'int char float double void return if else for while do switch case break continue default struct typedef const static unsigned signed long short sizeof enum union extern register volatile include define auto inline restrict bool'
};

function detectLang(ext) {
    if (['js', 'mjs', 'jsx', 'ts', 'tsx', 'vue'].indexOf(ext) !== -1) return 'js';
    if (ext === 'json') return 'json';
    if (ext === 'py') return 'py';
    if (['c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'java', 'cs', 'go'].indexOf(ext) !== -1) return 'c';
    return null;
}

// Keyword lookup tables are built once per language and reused on every
// keystroke of the overlay editor.
var LANG_KW_CACHE = {};

function highlightCode(code, lang) {
    var kw = LANG_KW_CACHE[lang];
    if (!kw) {
        kw = {};
        (LANG_KEYWORDS[lang] || '').split(' ').forEach(function(w) { kw[w] = true; });
        LANG_KW_CACHE[lang] = kw;
    }
    var re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;
    var out = '';
    var last = 0;
    var m;
    while ((m = re.exec(code)) !== null) {
        out += escapeHtml(code.slice(last, m.index));
        var cls = null;
        if (m[1] !== undefined) cls = 'tok-c';
        else if (m[2] !== undefined) cls = 'tok-s';
        else if (m[3] !== undefined) cls = 'tok-n';
        else if (m[4] !== undefined && kw[m[4]]) cls = 'tok-k';
        out += cls ? '<span class="' + cls + '">' + escapeHtml(m[0]) + '</span>' : escapeHtml(m[0]);
        last = m.index + m[0].length;
    }
    out += escapeHtml(code.slice(last));
    return out;
}

// ---- Lightweight Markdown rendering ----
// escapeHtml() does not escape quotes, so values interpolated into HTML
// attributes must be sanitized separately. URLs are additionally restricted
// to safe schemes (javascript:/data:/vbscript: are rejected).
function safeUrl(url) {
    var u = String(url).replace(/[\s"'`\\]/g, '');
    var low = u.toLowerCase();
    if (low.indexOf('javascript:') === 0 || low.indexOf('data:') === 0 || low.indexOf('vbscript:') === 0) {
        return '#';
    }
    return u;
}

function safeAttr(text) {
    return String(text).replace(/["'`\\]/g, '');
}

function mdInline(text) {
    var s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function(m, alt, url) {
        return '<img alt="' + safeAttr(alt) + '" src="' + safeUrl(url) + '" style="max-width: 100%; border-radius: 6px;">';
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function(m, label, url) {
        return '<a href="' + safeUrl(url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s;
}

// GFM 表格行拆分：去掉首尾竖线后按 | 切分并 trim
function splitMdRow(line) {
    var t = line.trim();
    if (t.charAt(0) === '|') t = t.slice(1);
    if (t.charAt(t.length - 1) === '|') t = t.slice(0, -1);
    return t.split('|').map(function(c) { return c.trim(); });
}

// 分隔行：| --- | :---: | ---: |（可省略首尾竖线），必须含 -
function isMdTableDelim(line) {
    return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.indexOf('-') !== -1;
}

function markdownToHtml(src) {
    var lines = src.split('\n');
    var html = '';
    var inCode = false;
    var codeBuf = [];
    var listType = null;
    var para = [];
    var skip = 0;   // 表格已消费的后续行数

    function flushPara() {
        if (para.length) {
            html += '<p>' + para.map(mdInline).join('<br>') + '</p>';
            para = [];
        }
    }
    function flushList() {
        if (listType) {
            html += '</' + listType + '>';
            listType = null;
        }
    }
    function flushAll() {
        flushPara();
        flushList();
    }

    lines.forEach(function(line, idx) {
        if (skip > 0) {
            skip--;
            return;
        }
        if (/^\s*```/.test(line)) {
            if (inCode) {
                html += '<pre class="code-view">' + escapeHtml(codeBuf.join('\n')) + '</pre>';
                codeBuf = [];
                inCode = false;
            } else {
                flushAll();
                inCode = true;
            }
            return;
        }
        if (inCode) {
            codeBuf.push(line);
            return;
        }
        var m;
        // GFM 表格：表头行以 | 开头，下一行是分隔行
        if (/^\s*\|/.test(line) && idx + 1 < lines.length && isMdTableDelim(lines[idx + 1])) {
            flushAll();
            var header = splitMdRow(line);
            var aligns = splitMdRow(lines[idx + 1]).map(function(c) {
                var l = c.charAt(0) === ':';
                var r = c.charAt(c.length - 1) === ':';
                return l && r ? 'center' : (r ? 'right' : (l ? 'left' : ''));
            });
            var rows = [];
            var j = idx + 2;
            while (j < lines.length && /^\s*\|/.test(lines[j])) {
                rows.push(splitMdRow(lines[j]));
                j++;
            }
            skip = j - idx - 1;
            var alignAttr = function(ci) {
                return aligns[ci] ? ' style="text-align: ' + aligns[ci] + ';"' : '';
            };
            html += '<table><thead><tr>';
            header.forEach(function(cell, ci) {
                html += '<th' + alignAttr(ci) + '>' + mdInline(cell) + '</th>';
            });
            html += '</tr></thead><tbody>';
            rows.forEach(function(row) {
                html += '<tr>';
                for (var ci = 0; ci < header.length; ci++) {
                    html += '<td' + alignAttr(ci) + '>' + mdInline(row[ci] || '') + '</td>';
                }
                html += '</tr>';
            });
            html += '</tbody></table>';
            return;
        }
        if ((m = line.match(/^(#{1,6})\s+(.*)/))) {
            flushAll();
            var lvl = m[1].length;
            html += '<h' + lvl + '>' + mdInline(m[2]) + '</h' + lvl + '>';
            return;
        }
        if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
            flushAll();
            html += '<hr>';
            return;
        }
        if ((m = line.match(/^>\s?(.*)/))) {
            flushAll();
            html += '<blockquote>' + mdInline(m[1]) + '</blockquote>';
            return;
        }
        if ((m = line.match(/^\s*[-*+]\s+(.*)/))) {
            flushPara();
            if (listType !== 'ul') {
                flushList();
                html += '<ul>';
                listType = 'ul';
            }
            html += '<li>' + mdInline(m[1]) + '</li>';
            return;
        }
        if ((m = line.match(/^\s*\d+\.\s+(.*)/))) {
            flushPara();
            if (listType !== 'ol') {
                flushList();
                html += '<ol>';
                listType = 'ol';
            }
            html += '<li>' + mdInline(m[1]) + '</li>';
            return;
        }
        if (/^\s*$/.test(line)) {
            flushAll();
            return;
        }
        para.push(line);
    });
    if (inCode) {
        html += '<pre class="code-view">' + escapeHtml(codeBuf.join('\n')) + '</pre>';
    }
    flushAll();
    return html || '<p style="color: #999;">（空文档）</p>';
}

// ---- 文本预览鸟瞰图（minimap）：右侧缩略条，点击/拖动快速定位 ----
// 静态内容绘制到离屏 canvas 一次，滚动时只重绘视口框，成本极低。
// 代码按行首 token 类型着色（与代码高亮同色板）；
// 行数超过可视高度时按像素行聚合（取桶内最长行宽与代表色、降低透明度），
// 避免高行数时黑压压一片。
var MINIMAP_COLORS = {
    k: '#7c3aed',   // 关键字
    s: '#b45309',   // 字符串
    c: '#6a9955',   // 注释
    n: '#1d4ed8',   // 数字
    d: '#9aa0a6'    // 普通文本
};

// 逐行取首个 token 的类型着色（复用代码高亮的同一套正则与关键字表）
function minimapLineColors(lines, lang) {
    if (!lang || !LANG_KEYWORDS[lang]) return null;
    var kw = LANG_KW_CACHE[lang];
    if (!kw) {
        kw = {};
        (LANG_KEYWORDS[lang] || '').split(' ').forEach(function(w) { kw[w] = true; });
        LANG_KW_CACHE[lang] = kw;
    }
    var re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/;
    var colors = new Array(lines.length);
    for (var i = 0; i < lines.length; i++) {
        var m = lines[i].match(re);
        if (!m) continue;
        if (m[1] !== undefined) colors[i] = MINIMAP_COLORS.c;
        else if (m[2] !== undefined) colors[i] = MINIMAP_COLORS.s;
        else if (m[3] !== undefined) colors[i] = MINIMAP_COLORS.n;
        else if (m[4] !== undefined && kw[m[4]]) colors[i] = MINIMAP_COLORS.k;
        else colors[i] = MINIMAP_COLORS.d;
    }
    return colors;
}

function buildTextMinimap(scroller, text, lang) {
    var canvas = document.createElement('canvas');
    canvas.className = 'text-minimap';
    var off = document.createElement('canvas');
    var W = 56;
    var H = Math.max(80, scroller.clientHeight - 8);
    var dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.height = H + 'px';
    off.width = W * dpr;
    off.height = H * dpr;

    var octx = off.getContext('2d');
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var lines = text.split('\n');
    var n = lines.length;
    var lineH = H / Math.max(n, 1);
    var colors = minimapLineColors(lines, lang);
    var lineW = function(i) { return Math.min(lines[i].length, 100) / 100 * (W - 6); };
    if (lineH >= 1.5) {
        // 行数不多：逐行绘制，行高足够时直接着色
        for (var i = 0; i < n; i++) {
            if (!lines[i].length) continue;
            octx.fillStyle = (colors && colors[i]) || MINIMAP_COLORS.d;
            octx.fillRect(3, i * lineH, lineW(i), Math.max(0.6, Math.min(2, lineH * 0.7)));
        }
    } else {
        // 行数超过像素行数：按像素行聚合，每桶取最长行宽与代表色，
        // 降透明度避免糊成一整片
        var rows = Math.max(1, Math.floor(H));
        octx.globalAlpha = 0.55;
        for (var y = 0; y < rows; y++) {
            var i0 = Math.floor(y * n / rows);
            var i1 = Math.max(i0 + 1, Math.floor((y + 1) * n / rows));
            var maxW = 0;
            var color = null;
            for (var i2 = i0; i2 < i1 && i2 < n; i2++) {
                if (!lines[i2].length) continue;
                var w = lineW(i2);
                if (w > maxW) {
                    maxW = w;
                    color = (colors && colors[i2]) || MINIMAP_COLORS.d;
                }
            }
            if (maxW > 0) {
                octx.fillStyle = color;
                octx.fillRect(3, y, maxW, 1);
            }
        }
        octx.globalAlpha = 1;
    }

    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    function viewport() {
        var sh = scroller.scrollHeight - scroller.clientHeight;
        var ratio = sh > 0 ? scroller.scrollTop / sh : 0;
        var vh = Math.max(12, scroller.clientHeight / Math.max(1, scroller.scrollHeight) * H);
        return { y: ratio * (H - vh), h: vh };
    }
    function redraw() {
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(off, 0, 0, W, H);
        var v = viewport();
        ctx.fillStyle = 'rgba(44, 130, 201, 0.15)';
        ctx.fillRect(0, v.y, W, v.h);
        ctx.strokeStyle = 'rgba(44, 130, 201, 0.55)';
        ctx.strokeRect(0.5, v.y + 0.5, W - 1, v.h - 1);
    }
    redraw();
    scroller.addEventListener('scroll', redraw);

    function jump(clientY) {
        var rect = canvas.getBoundingClientRect();
        var y = clientY - rect.top;
        var v = viewport();
        var ratio = (y - v.h / 2) / Math.max(1, H - v.h);
        ratio = Math.max(0, Math.min(1, ratio));
        scroller.scrollTop = ratio * (scroller.scrollHeight - scroller.clientHeight);
    }
    canvas.addEventListener('mousedown', function(e) {
        e.preventDefault();
        jump(e.clientY);
        // 拖动期间临时注册，抬起即移除，避免每次预览都累积 document 监听
        var move = function(ev) { jump(ev.clientY); };
        var up = function() {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
    });
    canvas.addEventListener('touchstart', function(e) {
        if (e.touches.length === 1) jump(e.touches[0].clientY);
    }, { passive: true });
    canvas.addEventListener('touchmove', function(e) {
        if (e.touches.length === 1) {
            e.preventDefault();
            jump(e.touches[0].clientY);
        }
    }, { passive: false });
    return canvas;
}

// 给滚动容器包一层 relative 外壳并挂鸟瞰图
function withTextMinimap(scroller, text, lang) {
    var wrap = document.createElement('div');
    wrap.className = 'minimap-wrap';
    wrap.appendChild(scroller);
    // 布局完成后再量取高度（此时 wrap 已入文档）
    setTimeout(function() {
        if (!wrap.isConnected) return;
        wrap.appendChild(buildTextMinimap(scroller, text, lang));
    }, 0);
    return wrap;
}

function renderMarkdownView(src) {
    var div = document.createElement('div');
    div.className = 'markdown-view';
    div.innerHTML = markdownToHtml(src);
    return div;
}

// Renders text content with a plain/highlight toggle (auto-detects language).
// editable=true produces an editing surface (highlight via overlay editor).
function renderTextView(text, editable) {
    var content = document.getElementById('previewContent');
    content.innerHTML = '';

    var detected = detectLang(previewFileInfo.ext);
    var isMd = previewFileInfo.ext === 'md' || previewFileInfo.ext === 'markdown';
    var toolbar = document.createElement('div');
    toolbar.style.cssText = 'display: flex; gap: 8px; align-items: center; margin-bottom: 8px; font-size: 13px; color: #666;';
    var label = document.createElement('span');
    label.textContent = '显示方式';
    var select = document.createElement('select');
    select.style.cssText = 'padding: 5px 8px; border: 1px solid #ddd; border-radius: 6px; font-size: 13px; background: white;';
    var options = [['plain', '纯文本'], ['auto', '代码着色(自动)'], ['js', 'JavaScript'], ['json', 'JSON'], ['py', 'Python'], ['c', 'C/C++']];
    if (isMd) {
        options.unshift(['md', 'Markdown 预览']);
    }
    options.forEach(function(opt) {
        var o = document.createElement('option');
        o.value = opt[0];
        o.textContent = opt[1];
        select.appendChild(o);
    });
    select.value = isMd ? 'md' : (detected ? 'auto' : 'plain');
    toolbar.appendChild(label);
    toolbar.appendChild(select);
    content.appendChild(toolbar);

    var viewWrap = document.createElement('div');
    content.appendChild(viewWrap);

    function currentLang() {
        if (select.value === 'plain') return null;
        if (select.value === 'auto') return detected;
        return select.value;
    }

    function makePlainTextarea(readOnly) {
        var ta = document.createElement('textarea');
        ta.className = 'preview-text';
        ta.value = text;
        ta.readOnly = readOnly;
        ta.spellcheck = false;
        return ta;
    }

    function render() {
        var lang = currentLang();
        viewWrap.innerHTML = '';
        if (select.value === 'md') {
            if (!editable) {
                viewWrap.appendChild(renderMarkdownView(text));
            } else {
                // edit surface with a live Markdown preview toggle
                var editWrap = document.createElement('div');
                var toggleBtn = document.createElement('button');
                toggleBtn.className = 'btn';
                toggleBtn.style.cssText = 'padding: 5px 12px; font-size: 13px; margin-bottom: 8px;';
                toggleBtn.textContent = '预览 Markdown';
                var ta = makePlainTextarea(false);
                var mdView = null;
                toggleBtn.addEventListener('click', function() {
                    if (mdView) {
                        editWrap.removeChild(mdView);
                        mdView = null;
                        ta.style.display = '';
                        toggleBtn.textContent = '预览 Markdown';
                    } else {
                        mdView = renderMarkdownView(ta.value);
                        ta.style.display = 'none';
                        editWrap.appendChild(mdView);
                        toggleBtn.textContent = '返回编辑';
                    }
                });
                editWrap.appendChild(toggleBtn);
                editWrap.appendChild(ta);
                viewWrap.appendChild(editWrap);
            }
            return;
        }
        if (!editable) {
            if (lang) {
                var pre = document.createElement('pre');
                pre.className = 'code-view';
                pre.innerHTML = highlightCode(text, lang);
                viewWrap.appendChild(withTextMinimap(pre, text, lang));
            } else {
                viewWrap.appendChild(withTextMinimap(makePlainTextarea(true), text, null));
            }
            return;
        }
        if (lang) {
            var wrap = document.createElement('div');
            wrap.className = 'code-editor-wrap';
            var pre2 = document.createElement('pre');
            pre2.className = 'code-view';
            var ta = document.createElement('textarea');
            ta.className = 'preview-text';
            ta.value = text;
            ta.spellcheck = false;
            var sync = function() {
                pre2.innerHTML = highlightCode(ta.value, lang) + '\n';
                pre2.scrollTop = ta.scrollTop;
                pre2.scrollLeft = ta.scrollLeft;
            };
            ta.addEventListener('input', sync);
            ta.addEventListener('scroll', function() {
                pre2.scrollTop = ta.scrollTop;
                pre2.scrollLeft = ta.scrollLeft;
            });
            wrap.appendChild(pre2);
            wrap.appendChild(ta);
            viewWrap.appendChild(wrap);
            sync();
        } else {
            viewWrap.appendChild(makePlainTextarea(false));
        }
    }

    select.addEventListener('change', render);
    render();
}

function previewFile(filePath, fileName) {
    var ext = getFileExtension(fileName);
    var previewUrl = ghUrl('https://raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME + '/' + DEFAULT_BRANCH + '/' + encodeURI(filePath));

    previewFileInfo = {
        path: filePath,
        name: fileName,
        ext: ext
    };

    document.getElementById('previewTitle').textContent = '预览: ' + fileName;
    var content = document.getElementById('previewContent');
    stopPreviewMedia();
    destroyImageViewer();
    content.innerHTML = '';
    var loadingDiv = document.createElement('div');
    loadingDiv.className = 'loading';
    loadingDiv.textContent = '加载中...';
    content.appendChild(loadingDiv);
    document.getElementById('previewModal').classList.add('show');
    document.getElementById('previewActions').style.display = 'none';
    document.getElementById('previewMessage').className = 'message';
    document.getElementById('previewMessage').textContent = '';
    setPreviewBlobUrl(null);

    if (menuFileInfo.chunked) {
        // 分片音频边下边播：音频元素立即创建，每连续收完一段分片就更新播放源
        // （未播放时换源无感知；一旦开始播放则不再换源，最后完整 blob 恢复进度）
        var isAudioPreview = AUDIO_EXTS.indexOf(ext) !== -1;
        var audioEl = null;
        var audioRateTag = null;
        var tmpAudioUrl = null;
        var startedPlaying = false;
        if (isAudioPreview) {
            content.innerHTML = '';
            content.appendChild(loadingDiv);
            audioEl = document.createElement('audio');
            audioEl.controls = true;
            audioEl.preload = 'auto';
            audioEl.className = 'preview-audio';
            bindAudioVolume(audioEl);
            var audioWrap = document.createElement('div');
            audioWrap.className = 'media-wrap media-wrap-audio';
            audioRateTag = document.createElement('div');
            audioRateTag.className = 'media-rate-below';
            audioWrap.appendChild(audioEl);
            audioWrap.appendChild(audioRateTag);
            var plWrapC = setupAudioPlaylist(audioEl, filePath, audioRateTag);
            if (plWrapC) audioWrap.appendChild(plWrapC);
            content.appendChild(audioWrap);
            audioEl.addEventListener('play', function() { startedPlaying = true; });
            // 用户与控制条任何交互（播放/拖进度/调音量）即停止换源：
            // 换源会重置原生控件状态，关掉正在操作的音量弹层
            ['mousedown', 'touchstart', 'volumechange', 'seeking'].forEach(function(ev) {
                audioEl.addEventListener(ev, function() { startedPlaying = true; });
            });
            // 部分前缀数据可能暂时无法解码（如头部不完整），忽略，等更多分片后重试
            audioEl.addEventListener('error', function() {});
        }
        previewMerge = fetchMergedBlob(menuFileInfo.parts, function(blob) {
            previewMerge = null;
            if (isAudioPreview && audioEl) {
                loadingDiv.style.display = 'none';
                var finalUrl = URL.createObjectURL(blob);
                setPreviewBlobUrl(finalUrl);
                var pos = 0, resume = false, vol = 1, muted = false, rate = 1;
                try {
                    pos = audioEl.currentTime;
                    resume = !audioEl.paused && !audioEl.ended;
                    vol = audioEl.volume;
                    muted = audioEl.muted;
                    rate = audioEl.playbackRate;
                } catch (e) {}
                audioEl.addEventListener('loadedmetadata', function() {
                    // 换源后恢复进度、音量与倍速，避免用户已调节的状态被重置
                    try { audioEl.currentTime = pos; } catch (e) {}
                    try { audioEl.volume = vol; audioEl.muted = muted; audioEl.playbackRate = rate; } catch (e) {}
                    if (resume) audioEl.play();
                }, { once: true });
                audioEl.src = finalUrl;
                if (tmpAudioUrl) {
                    URL.revokeObjectURL(tmpAudioUrl);
                    tmpAudioUrl = null;
                }
                if (audioRateTag) setTimeout(function() { audioRateTag.textContent = ''; }, 3000);
                return;
            }
            var mediaUrl = null;
            if (VIDEO_EXTS.indexOf(ext) !== -1 || IMAGE_EXTS.indexOf(ext) !== -1) {
                mediaUrl = URL.createObjectURL(blob);
                setPreviewBlobUrl(mediaUrl);
                content.innerHTML = '';
            }
            if (VIDEO_EXTS.indexOf(ext) !== -1) {
                var video = document.createElement('video');
                video.src = mediaUrl;
                video.controls = true;
                video.preload = 'auto';
                video.className = 'preview-video';
                content.appendChild(video);
            } else if (IMAGE_EXTS.indexOf(ext) !== -1) {
                var viewerWrapC = buildImageViewer();
                imgViewer.img.src = mediaUrl;
                imgViewer.img.alt = fileName;
                content.appendChild(viewerWrapC);
                imgViewerSetList(collectImageModels(), filePath);
            } else {
                var textReader = new FileReader();
                textReader.onload = function() {
                    renderTextView(textReader.result, false);
                };
                textReader.readAsText(blob);
            }
        }, function() {
            if (previewMerge) previewMerge = null;
            content.innerHTML = '';
            var msgDiv = document.createElement('div');
            msgDiv.className = 'message error';
            msgDiv.textContent = '无法加载文件分片';
            content.appendChild(msgDiv);
        }, function(pct, speed, chanSpeeds, eta) {
            if (pct !== null) {
                loadingDiv.textContent = '加载中 ' + pct + '%' + (speed ? ' · ' + speed : '') + (eta ? ' · 预计剩余 ' + eta : '');
            }
            // 速率标签展示各通道（EO/CF/外部）各自速度
            if (audioRateTag && (chanSpeeds || speed)) audioRateTag.textContent = chanSpeeds || speed;
        }, function onPart(prefix, buffers) {
            if (!isAudioPreview || startedPlaying || !audioEl) return;
            var u = URL.createObjectURL(new Blob(buffers.slice(0, prefix)));
            if (tmpAudioUrl) URL.revokeObjectURL(tmpAudioUrl);
            tmpAudioUrl = u;
            audioEl.src = u;
        });
        return;
    }

    var isImagePreview = IMAGE_EXTS.indexOf(ext) !== -1;
    if (AUDIO_EXTS.indexOf(ext) !== -1 || VIDEO_EXTS.indexOf(ext) !== -1 || isImagePreview) {
        // 流式加载：音/视频 URL 直接交给媒体元素按 Range 边下边播；
        // 图片走 fetch 分块读取，部分数据渐进渲染；角落实时显示加载速度
        content.innerHTML = '';
        content.appendChild(loadingDiv);
        var mediaEl;
        var viewerWrap = null;
        if (AUDIO_EXTS.indexOf(ext) !== -1) {
            mediaEl = document.createElement('audio');
            mediaEl.className = 'preview-audio';
            bindAudioVolume(mediaEl);
        } else if (VIDEO_EXTS.indexOf(ext) !== -1) {
            mediaEl = document.createElement('video');
            mediaEl.className = 'preview-video';
        } else {
            // 图片：查看器（缩放/平移/缩略图），img 由查看器持有
            viewerWrap = buildImageViewer();
            mediaEl = imgViewer.img;
            mediaEl.alt = fileName;
        }
        var rateTag = document.createElement('div');
        // 音频条太矮，叠加标签会遮挡控制按钮，改放在播放器下方右对齐
        rateTag.className = (AUDIO_EXTS.indexOf(ext) !== -1) ? 'media-rate-below' : 'media-rate';
        var rateBox = document.createElement('div');
        rateBox.className = (AUDIO_EXTS.indexOf(ext) !== -1 || isImagePreview) ? 'media-wrap media-wrap-audio' : 'media-wrap';
        rateBox.style.position = 'relative';
        var abortProbe = function() {
            if (previewProbe) {
                var probes = Array.isArray(previewProbe) ? previewProbe.slice() : [previewProbe];
                probes.forEach(function(x) { try { x.abort(); } catch (e) {} });
                previewProbe = null;
            }
        };
        var showMediaError = function() {
            abortProbe(); // 出错后不再测速，避免与错误重试/后续操作争抢带宽
            loadingDiv.className = 'message error';
            loadingDiv.textContent = '加载失败，无法播放该文件';
            rateTag.textContent = '';
        };
        if (isImagePreview) {
            // 首帧部分数据成功解码即隐藏 loading，后续持续渐进刷新
            mediaEl.onload = function() {
                loadingDiv.style.display = 'none';
                imgViewerApply();
            };
            mediaEl.onerror = function() {
                // 部分数据无法解码属正常（图片未收完），仅最终直连失败才报错
                if (!previewAbort) showMediaError();
            };
            var streamed = streamImagePreview(previewUrl, mediaEl, loadingDiv, rateTag, function() {
                // 流式失败回退为浏览器直连加载
                previewAbort = null;
                mediaEl.src = previewUrl;
            }, filePath);
            if (!streamed) mediaEl.src = previewUrl;
        } else {
            mediaEl.addEventListener('canplay', function() { loadingDiv.style.display = 'none'; });
            mediaEl.onerror = showMediaError;
            mediaEl.controls = true;
            mediaEl.preload = 'auto';
            mediaEl.src = previewUrl;

            // 角落标签 = 真实测速 + 缓冲百分比
            var speedText = '';
            var bufferedText = '';
            var updateTag = function() {
                rateTag.textContent = [speedText, bufferedText].filter(function(s) { return s; }).join(' · ');
            };
            probeMediaSpeed(previewUrl, function(s) {
                speedText = s;
                updateTag();
            }, filePath);
            // 开始播放即停止测速探测：探测与播放器同时拉同一文件会争抢带宽，
            // 导致起播卡顿（探测值已拿到或不再需要）
            mediaEl.addEventListener('playing', abortProbe, { once: true });

            // 定时采样缓冲进度：progress 事件在小文件一次缓冲完、浏览器暂停预读时
            // 不会持续触发，无法凑出两次采样，改由定时器驱动
            var getDuration = function() {
                var d = mediaEl.duration;
                if (!isFinite(d) || d <= 0) {
                    try {
                        if (mediaEl.seekable.length) d = mediaEl.seekable.end(mediaEl.seekable.length - 1);
                    } catch (e) {}
                }
                return (isFinite(d) && d > 0) ? d : 0;
            };
            var bufTimer = setInterval(function() {
                var dur = getDuration();
                if (!dur) return;
                var end = mediaEl.buffered.length ? mediaEl.buffered.end(mediaEl.buffered.length - 1) : 0;
                if (end >= dur - 0.5) {
                    clearInterval(bufTimer);
                    // 缓冲完成：保留最终速度 3s 再消失，避免一闪而过
                    setTimeout(function() { rateTag.textContent = ''; }, 3000);
                    return;
                }
                bufferedText = '已缓冲 ' + Math.round(end / dur * 100) + '%';
                updateTag();
            }, 500);
            var clearBufTimer = function() { clearInterval(bufTimer); };
            mediaEl.addEventListener('ended', function() { clearBufTimer(); setTimeout(function() { rateTag.textContent = ''; }, 3000); });
            mediaEl.addEventListener('emptied', clearBufTimer); // stopPreviewMedia 清 src 时触发
            mediaEl.addEventListener('error', clearBufTimer);
        }
        if (viewerWrap) {
            rateBox.appendChild(viewerWrap);
        } else {
            rateBox.appendChild(mediaEl);
        }
        rateBox.appendChild(rateTag);
        // 音频预览：同目录音乐播放列表（顺序/随机/单曲循环 + 限量预加载）
        if (AUDIO_EXTS.indexOf(ext) !== -1) {
            var plWrap = setupAudioPlaylist(mediaEl, filePath, rateTag);
            if (plWrap) rateBox.appendChild(plWrap);
        }
        content.appendChild(rateBox);
        if (viewerWrap) {
            imgViewerSetList(collectImageModels(), filePath);
        }
    } else {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', previewUrl, true);
        xhr.onload = function() {
            if (xhr.status === 200) {
                renderTextView(xhr.responseText, false);
            } else {
                content.innerHTML = '';
                var msgDiv = document.createElement('div');
                msgDiv.className = 'message error';
                msgDiv.textContent = '无法加载文件内容';
                content.appendChild(msgDiv);
            }
        };
        xhr.onerror = function() {
            content.innerHTML = '';
            var msgDiv = document.createElement('div');
            msgDiv.className = 'message error';
            msgDiv.textContent = '网络错误，无法加载文件';
            content.appendChild(msgDiv);
        };
        xhr.send();
    }
}

function editFile(filePath, fileName) {
    var ext = getFileExtension(fileName);
    var previewUrl = ghUrl('https://raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME + '/' + DEFAULT_BRANCH + '/' + encodeURI(filePath));

    previewFileInfo = {
        path: filePath,
        name: fileName,
        ext: ext
    };

    document.getElementById('previewTitle').textContent = '编辑: ' + fileName;
    var content = document.getElementById('previewContent');
    stopPreviewMedia();
    destroyImageViewer();
    content.innerHTML = '';
    var loadingDiv = document.createElement('div');
    loadingDiv.className = 'loading';
    loadingDiv.textContent = '加载中...';
    content.appendChild(loadingDiv);
    document.getElementById('previewModal').classList.add('show');
    document.getElementById('previewActions').style.display = 'none';
    document.getElementById('previewMessage').className = 'message';
    document.getElementById('previewMessage').textContent = '';
    setPreviewBlobUrl(null);

    var xhr = new XMLHttpRequest();
    xhr.open('GET', previewUrl, true);
    xhr.onload = function() {
        if (xhr.status === 200) {
            renderTextView(xhr.responseText, true);
            document.getElementById('previewActions').style.display = 'block';
        } else {
            content.innerHTML = '';
            var msgDiv = document.createElement('div');
            msgDiv.className = 'message error';
            msgDiv.textContent = '无法加载文件内容';
            content.appendChild(msgDiv);
        }
    };
    xhr.onerror = function() {
        content.innerHTML = '';
        var msgDiv = document.createElement('div');
        msgDiv.className = 'message error';
        msgDiv.textContent = '网络错误，无法加载文件';
        content.appendChild(msgDiv);
    };
    xhr.send();
}

function closePreviewModal() {
    document.getElementById('previewModal').classList.remove('show');
    stopPreviewMedia();
    destroyImageViewer();
    setPreviewBlobUrl(null);
}

function savePreviewFile() {
    var textarea = document.querySelector('.preview-text');
    if (!textarea) return;

    var newContent = textarea.value;
    var saveBtn = document.getElementById('savePreviewBtn');

    saveBtn.disabled = true;
    setMsg('previewMessage', '正在获取授权...', 'success');

    var fail = function(text) {
        setMsg('previewMessage', text, 'error');
        saveBtn.disabled = false;
    };

    if (getSavedAuth()) {
        updateFileOnGitHub(previewFileInfo.path, newContent);
        return;
    }

    var username = prompt('请输入用户名:');
    var password = prompt('请输入密码:');
    if (!username || !password) {
        fail('请输入用户名和密码');
        return;
    }
    loginUser(username, password, false, function(err) {
        if (err) {
            fail('获取授权失败: ' + err);
            return;
        }
        updateFileOnGitHub(previewFileInfo.path, newContent);
    });
}

function updateFileOnGitHub(filePath, newContent) {
    var shaUrl = ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + encodeURI(filePath));
    var shaXhr = new XMLHttpRequest();
    shaXhr.open('GET', shaUrl, true);
    shaXhr.onload = function() {
        if (shaXhr.status === 200) {
            try {
                var fileInfo = JSON.parse(shaXhr.responseText);
                var sha = fileInfo.sha;
                var base64Content = btoa(unescape(encodeURIComponent(newContent)));

                var data = {
                    message: 'Update file: ' + filePath,
                    content: base64Content,
                    sha: sha
                };

                var updateXhr = new XMLHttpRequest();
                var updateUrl = ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + encodeURI(filePath));
                updateXhr.open('PUT', updateUrl, true);
                applyEoAuth(updateXhr);
                updateXhr.setRequestHeader('Content-Type', 'application/json');

                updateXhr.onload = function() {
                    if (updateXhr.status === 200 || updateXhr.status === 201) {
                        fileTreeCache = null;
                        bypassHttpCache();
                        setMsg('previewMessage', '保存成功！', 'success');
                        setTimeout(function() {
                            closePreviewModal();
                            loadFileList();
                        }, 1500);
                    } else {
                        try {
                            var error = JSON.parse(updateXhr.responseText);
                            setMsg('previewMessage', '保存失败: ' + (error.message || '未知错误'), 'error');
                        } catch (e) {
                            setMsg('previewMessage', '保存失败，状态码: ' + updateXhr.status, 'error');
                        }
                        document.getElementById('savePreviewBtn').disabled = false;
                    }
                };

                updateXhr.onerror = function() {
                    setMsg('previewMessage', '网络错误，保存失败', 'error');
                    document.getElementById('savePreviewBtn').disabled = false;
                };

                updateXhr.send(JSON.stringify(data));
            } catch (e) {
                setMsg('previewMessage', '获取文件信息失败', 'error');
                document.getElementById('savePreviewBtn').disabled = false;
            }
        } else {
            setMsg('previewMessage', '获取文件信息失败，状态码: ' + shaXhr.status, 'error');
            document.getElementById('savePreviewBtn').disabled = false;
        }
    };
    shaXhr.onerror = function() {
        setMsg('previewMessage', '网络错误，无法获取文件信息', 'error');
        document.getElementById('savePreviewBtn').disabled = false;
    };
    shaXhr.send();
}

function confirmDelete() {
    var deleteBtn = document.getElementById('deleteBtn');
    deleteBtn.disabled = true;
    setMsg('deleteMessage', '正在获取授权...', 'success');

    var runDelete = function() {
        if (deleteFileType === 'dir') {
            deleteFolder(deleteFilePath);
        } else if (deleteFileType === 'chunked' || deleteFileType === 'batch') {
            deleteFolderFiles(deleteParts);
        } else {
            deleteFile(deleteFilePath, deleteFileSha);
        }
    };

    var fail = function(text) {
        setMsg('deleteMessage', text, 'error');
        deleteBtn.disabled = false;
    };

    if (getSavedAuth()) {
        runDelete();
        return;
    }

    var username = document.getElementById('deleteUsername').value;
    var password = document.getElementById('deletePassword').value;
    if (!username || !password) {
        fail('请输入用户名和密码');
        return;
    }
    loginUser(username, password, true, function(err) {
        if (err) {
            fail('获取授权失败: ' + err);
            return;
        }
        runDelete();
    });
}

// Shared contents-API DELETE helper. cb(status, responseText); status 0 = network error.
function ghDeleteFile(filePath, sha, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('DELETE', ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + encodeURI(filePath)), true);
    applyEoAuth(xhr);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function() { cb(xhr.status, xhr.responseText); };
    xhr.onerror = function() { cb(0, ''); };
    xhr.send(JSON.stringify({
        message: 'Delete file: ' + filePath,
        sha: sha
    }));
}

function deleteFile(filePath, sha) {
    setMsg('deleteMessage', '正在删除...', 'success');

    ghDeleteFile(filePath, sha, function(status, responseText) {
        if (status === 0) {
            setMsg('deleteMessage', '网络错误，删除失败', 'error');
            document.getElementById('deleteBtn').disabled = false;
            return;
        }
        if (status === 200 || status === 201) {
            fileTreeCache = null;
            bypassHttpCache();
            setMsg('deleteMessage', '删除成功！', 'success');
            setTimeout(function() {
                closeDeleteModal();
                loadFileList();
            }, 1500);
        } else {
            try {
                var error = JSON.parse(responseText);
                setMsg('deleteMessage', '删除失败: ' + (error.message || '未知错误'), 'error');
            } catch (e) {
                setMsg('deleteMessage', '删除失败，状态码: ' + status, 'error');
            }
            document.getElementById('deleteBtn').disabled = false;
        }
    });
}

function deleteFolderError() {
    setMsg('deleteMessage', '获取文件夹内容失败', 'error');
    document.getElementById('deleteBtn').disabled = false;
}

function deleteFolder(folderPath) {
    setMsg('deleteMessage', '正在获取文件夹内容...', 'success');

    fetchFileTree(function() {
        var prefix = folderPath + '/';
        var files = [];
        fileTreeCache.forEach(function(item) {
            if (item.type === 'blob' && item.path && item.path.indexOf(prefix) === 0) {
                files.push(item);
            }
        });
        if (!files.length) {
            setMsg('deleteMessage', '文件夹为空或不存在', 'error');
            document.getElementById('deleteBtn').disabled = false;
            return;
        }
        deleteFolderFiles(files);
    }, deleteFolderError);
}

// Parallel delete with adaptive concurrency: contents API moves the git ref on
// every delete, so parallel deletes race the ref — each file retries ref
// conflicts (409 / sha mismatch) with jittered backoff, the pool shrinks on
// conflict and grows back on success streaks. 404 (already gone) is idempotent.
var deleteState = null;   // 进行中的批量删除状态（供停止按钮打断调度）

function stopDelete() {
    if (deleteState) {
        deleteState.stopped = true;
        setMsg('deleteMessage', '正在停止（等待当前文件删除完成）...', 'success');
    }
    document.getElementById('deleteStopBtn').style.display = 'none';
}

function deleteFolderFiles(files) {
    if (!files.length) {
        deleteAllDone();
        return;
    }
    // 并发上限跟随下载并行数设置：冲突自动降档（最低 1），连续成功升回
    var delLimit = dlGetLimit();
    var state = {
        next: 0,
        active: 0,
        done: 0,
        limit: delLimit,
        maxLimit: delLimit,
        okStreak: 0,
        failed: false,
        stopped: false,
        errMsg: ''
    };
    deleteState = state;
    document.getElementById('deleteStopBtn').style.display = '';
    setMsg('deleteMessage', '正在删除 (0/' + files.length + ')', 'success');
    setDeleteProgress(0, files.length);

    function settle() {
        if (state.active > 0) return;
        deleteState = null;
        document.getElementById('deleteStopBtn').style.display = 'none';
        if (state.stopped) {
            setMsg('deleteMessage', '已停止（已删除 ' + state.done + '/' + files.length + '），其余文件保留', 'error');
            setTimeout(function() {
                closeDeleteModal();
                clearSelection();
                fileTreeCache = null;
                bypassHttpCache();
                loadFileList();
            }, 1800);
            return;
        }
        if (state.failed) {
            setMsg('deleteMessage', '删除失败: ' + state.errMsg + '（已删除 ' + state.done + '/' + files.length + '）', 'error');
            document.getElementById('deleteBtn').disabled = false;
            return;
        }
        if (state.next >= files.length) {
            deleteAllDone();
        }
    }

    function pump() {
        while (!state.failed && !state.stopped && state.active < state.limit && state.next < files.length) {
            var f = files[state.next++];
            state.active++;
            (function(file) {
                var attempt = function() {
                    ghDeleteFile(file.path, file.sha, function(status, responseText) {
                        if (status === 0) {
                            state.active--;
                            state.failed = true;
                            state.errMsg = '网络错误';
                            settle();
                            return;
                        }
                        // Ref conflict from parallel commits: retry this file with
                        // jittered backoff instead of failing the whole batch;
                        // 冲突说明引用竞争压力大，并发池降一档
                        var isRefConflict = status === 409 || /is at [0-9a-f]{40} but expected/i.test(responseText || '');
                        if (isRefConflict) {
                            if (state.limit > 1) state.limit--;
                            state.okStreak = 0;
                            file._conflicts = (file._conflicts || 0) + 1;
                            if (file._conflicts <= 8) {
                                setMsg('deleteMessage', '提交冲突，重试 (' + file._conflicts + '/8): ' + file.path, 'success');
                                setTimeout(attempt, 1200 * file._conflicts + Math.floor(Math.random() * 800));
                                return;
                            }
                        }
                        state.active--;
                        if (status === 200 || status === 201) {
                            state.done++;
                            // 连续成功说明竞争压力小，并发池升回一档
                            state.okStreak++;
                            if (state.okStreak >= 4 && state.limit < state.maxLimit) {
                                state.limit++;
                                state.okStreak = 0;
                            }
                            setMsg('deleteMessage', '正在删除 (' + state.done + '/' + files.length + '): ' + file.path, 'success');
                            setDeleteProgress(state.done, files.length);
                        } else if (status === 404) {
                            // already gone (e.g. removed by an earlier attempt): count as done
                            state.done++;
                            state.okStreak++;
                            if (state.okStreak >= 4 && state.limit < state.maxLimit) {
                                state.limit++;
                                state.okStreak = 0;
                            }
                            setMsg('deleteMessage', '已不存在，跳过 (' + state.done + '/' + files.length + '): ' + file.path, 'success');
                            setDeleteProgress(state.done, files.length);
                        } else {
                            state.failed = true;
                            try {
                                var error = JSON.parse(responseText);
                                state.errMsg = error.message || ('状态码 ' + status);
                            } catch (e) {
                                state.errMsg = '状态码 ' + status;
                            }
                        }
                        pump();
                        settle();
                    });
                };
                attempt();
            })(f);
        }
    }
    pump();
}

function deleteAllDone() {
    fileTreeCache = null;
    bypassHttpCache();
    setMsg('deleteMessage', '删除成功！', 'success');
    setTimeout(function() {
        closeDeleteModal();
        clearSelection();
        loadFileList();
    }, 1500);
}

function safeDecode(seg) {
    try {
        return decodeURIComponent(seg);
    } catch (e) {
        return seg;
    }
}

// Display-only decode: recover readable text from names that were stored
// percent-encoded by accident (e.g. a folder literally named "%E6%96...").
// The real name is always kept for navigation and API operations.
function displayName(name) {
    var seg = name;
    for (var i = 0; i < 3; i++) {
        if (!/%[0-9A-Fa-f]{2}/.test(seg)) break;
        var decoded = safeDecode(seg);
        if (decoded === seg) break;
        seg = decoded;
    }
    return seg;
}

// Returns the current directory path with each segment decoded exactly once,
// preserving literal names (a segment stored as "%E6..." stays usable).
// Callers must encode it themselves when building URLs.
function getCurrentPath() {
    var path = window.location.pathname;
    if (path.endsWith('/')) {
        path = path.substring(0, path.length - 1);
    }
    if (path === '') {
        return '';
    }
    var parts = path.substring(1).split('/');
    for (var i = 0; i < parts.length; i++) {
        parts[i] = safeDecode(parts[i]);
    }
    if (parts.length > 0 && parts[0] === REPO_NAME) {
        return parts.slice(1).join('/');
    }
    return parts.join('/');
}

function encodePath(path) {
    if (!path) return '';
    return path.split('/').map(encodeURIComponent).join('/');
}

function updateBreadcrumbs() {
    var path = getCurrentPath();
    var crumbs = document.getElementById('breadcrumbs');
    crumbs.innerHTML = '';

    if (path === '') {
        var homeSpan = document.createElement('span');
        homeSpan.style.color = '#666';
        homeSpan.textContent = '当前位置:';
        var homeStrong = document.createElement('strong');
        homeStrong.textContent = ' Home';
        homeSpan.appendChild(homeStrong);
        crumbs.appendChild(homeSpan);
        return;
    }

    var parts = path.split('/');
    var labelSpan = document.createElement('span');
    labelSpan.style.color = '#666';
    labelSpan.textContent = '当前位置: ';
    crumbs.appendChild(labelSpan);

    var homeLink = document.createElement('a');
    homeLink.href = '/';
    homeLink.textContent = 'Home';
    crumbs.appendChild(homeLink);

    var currentPath = '';
    for (var i = 0; i < parts.length; i++) {
        currentPath += '/' + encodeURIComponent(parts[i]);
        var separator = document.createElement('span');
        separator.textContent = ' / ';
        crumbs.appendChild(separator);

        var link = document.createElement('a');
        link.href = currentPath + '/';
        link.textContent = displayName(parts[i]);
        crumbs.appendChild(link);
    }
}

// ---- File list: incremental rendering state ----
var entryMap = {};
var entryOrder = [];
var hasRenderedList = false;
var listLoading = false;
var LIST_RENDER_BATCH = 40;  // 首屏懒加载每批渲染的条目数
var listRenderToken = 0;     // 分批渲染令牌：新一轮渲染使旧批次失效

function showRefreshIndicator() {
    var el = document.getElementById('refreshIndicator');
    if (el) el.classList.add('show');
}

function hideRefreshIndicator() {
    var el = document.getElementById('refreshIndicator');
    if (el) el.classList.remove('show');
}

function loadFileList() {
    if (listLoading) return;
    listLoading = true;

    var path = getCurrentPath();
    var apiUrl = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + encodePath(path);

    var container = document.getElementById('fileListContainer');
    if (!hasRenderedList) {
        container.innerHTML = '<div class="loading">加载中...</div>';
    } else {
        showRefreshIndicator();
    }

    cachedGet(apiUrl, function(status, body, notModified) {
        listLoading = false;
        hideRefreshIndicator();

        if (status === 304) {
            return;
        }

        if (status === 200) {
            try {
                var items = JSON.parse(body);
                var currentPath = getCurrentPath();
                var pageTitle = document.getElementById('pageTitle');
                if (currentPath === '') {
                    pageTitle.textContent = 'Home';
                    document.title = 'Home - boring_student';
                } else {
                    var pathParts = currentPath.split('/');
                    var dirName = displayName(pathParts[pathParts.length - 1]);
                    pageTitle.textContent = dirName;
                    document.title = dirName + ' - boring_student';
                }
                renderFileList(items);
            } catch (e) {
                showListError('解析文件列表失败');
            }
        } else if (status === 403) {
            showListError('API请求受限，请稍后重试');
        } else if (status === 404) {
            showListError('目录不存在', true);
        } else if (status === 0) {
            showListError('网络错误，无法获取文件列表');
        } else {
            showListError('获取文件列表失败，状态码: ' + status);
        }
    });
}

function showListError(text, is404) {
    var container = document.getElementById('fileListContainer');
    if (!hasRenderedList) {
        if (is404) {
            document.getElementById('pageTitle').textContent = '404 - 页面未找到';
            document.title = '404 - 页面未找到 - boring_student';
        }
        container.innerHTML = '<div class="message error">' + text + '</div>';
    } else {
        // Background refresh failed: keep the current list, just notify
        showToast(text);
        setTimeout(hideToast, 2500);
    }
}

function buildEntryModels(items) {
    var dirs = items.filter(function(item) { return item.type === 'dir'; });
    var files = items.filter(function(item) { return item.type === 'file'; });

    dirs.sort(function(a, b) { return a.name.localeCompare(b.name); });
    files.sort(function(a, b) { return a.name.localeCompare(b.name); });

    var partGroups = {};
    var normalFiles = [];
    files.forEach(function(file) {
        if (PART_SUFFIX.test(file.name)) {
            var baseName = file.name.replace(PART_SUFFIX, '');
            if (!partGroups[baseName]) partGroups[baseName] = [];
            partGroups[baseName].push(file);
        } else {
            normalFiles.push(file);
        }
    });
    for (var base in partGroups) {
        var parts = partGroups[base];
        parts.sort(function(a, b) { return getPartNumber(a.name) - getPartNumber(b.name); });
        var totalSize = 0;
        parts.forEach(function(p) { totalSize += (p.size || 0); });
        var dirPrefix = parts[0].path.substring(0, parts[0].path.length - parts[0].name.length);
        normalFiles.push({
            name: base,
            path: dirPrefix + base,
            size: totalSize,
            sha: '',
            type: 'file',
            chunked: true,
            parts: parts
        });
    }
    normalFiles.sort(function(a, b) { return a.name.localeCompare(b.name); });

    var models = [];
    dirs.forEach(function(dir) {
        models.push({
            key: 'd:' + dir.name,
            kind: 'dir',
            name: dir.name,
            displayName: displayName(dir.name),
            path: dir.path,
            sha: dir.sha,
            sizeText: '-'
        });
    });
    normalFiles.forEach(function(file) {
        if (file.name === 'index.html' || file.name === 'info.json' || file.name === 'info.md') {
            return;
        }
        models.push({
            key: 'f:' + file.name,
            kind: 'file',
            name: file.name,
            displayName: displayName(file.name),
            path: file.path,
            sha: file.sha,
            size: file.size,
            chunked: file.chunked || false,
            parts: file.parts || null,
            sizeText: formatSize(file.size)
        });
    });
    // Mark entries whose display names collide (e.g. a folder stored with a
    // percent-encoded literal name alongside the real Chinese-named folder)
    var nameCount = {};
    models.forEach(function(m) {
        var k = m.kind + '|' + m.displayName;
        nameCount[k] = (nameCount[k] || 0) + 1;
    });
    models.forEach(function(m) {
        var k = m.kind + '|' + m.displayName;
        if (nameCount[k] > 1 && m.name !== m.displayName) {
            m.displayName = m.displayName + ' [原名: ' + m.name + ']';
        }
    });
    return models;
}

function createEntryElement(model) {
    var currentPath = getCurrentPath();
    var baseUrl = currentPath ? '/' + encodePath(currentPath) + '/' : '/';

    var entry = document.createElement('a');
    entry.className = 'entry';
    entry._key = model.key;

    var nameSpan = document.createElement('span');
    var infoSpan = document.createElement('span');
    infoSpan.className = 'file-info';
    var sizeSpan = document.createElement('span');

    if (model.kind === 'dir') {
        entry.href = baseUrl + encodeURIComponent(model.name) + '/';
        nameSpan.textContent = model.displayName + '/';
        sizeSpan.className = 'dir-size';
        sizeSpan.setAttribute('data-path', model.path);
        sizeSpan.textContent = '-';
        entry._model = {
            path: model.path,
            sha: model.sha,
            name: model.name,
            displayName: model.displayName,
            type: 'dir'
        };
    } else {
        // Clicking a file card toggles its selection checkbox (batch ops);
        // single-file open/download remains available via the context menu.
        entry.href = 'javascript:void(0);';
        nameSpan.textContent = model.displayName;
        sizeSpan.textContent = model.sizeText;
        entry._model = {
            path: model.path,
            sha: model.sha,
            name: model.name,
            displayName: model.displayName,
            type: 'file',
            size: model.size,
            chunked: model.chunked,
            parts: model.parts
        };
        var nameWrap = document.createElement('span');
        nameWrap.className = 'entry-name';
        nameWrap.appendChild(nameSpan);

        infoSpan.appendChild(sizeSpan);
        entry.appendChild(nameWrap);
        entry.appendChild(infoSpan);
        entry._sizeSpan = sizeSpan;
        bindEntryEvents(entry);
        return entry;
    }

    infoSpan.appendChild(sizeSpan);
    entry.appendChild(nameSpan);
    entry.appendChild(infoSpan);
    entry._sizeSpan = sizeSpan;
    bindEntryEvents(entry);
    return entry;
}

// ---- Multi-select & batch operations ----
var selectedKeys = {};

function toggleSelect(key) {
    var rec = entryMap[key];
    if (!rec || rec.model.kind !== 'file') return;
    if (selectedKeys[key]) {
        delete selectedKeys[key];
    } else {
        selectedKeys[key] = rec.model;
    }
    applySelectionVisual(key);
    updateBatchBar();
}

function applySelectionVisual(key) {
    var rec = entryMap[key];
    if (!rec) return;
    var selected = !!selectedKeys[key];
    if (selected) {
        rec.el.classList.add('entry-selected');
    } else {
        rec.el.classList.remove('entry-selected');
    }
}

function updateBatchBar() {
    var bar = document.getElementById('batchBar');
    if (!bar) return;
    var count = Object.keys(selectedKeys).length;
    if (count) {
        bar.style.display = 'flex';
        document.getElementById('batchCount').textContent = '已选 ' + count + ' 项';
    } else {
        bar.style.display = 'none';
    }
}

function clearSelection() {
    Object.keys(selectedKeys).forEach(function(k) {
        delete selectedKeys[k];
        applySelectionVisual(k);
    });
    updateBatchBar();
}

function selectAllFiles() {
    entryOrder.forEach(function(k) {
        var rec = entryMap[k];
        if (rec && rec.model.kind === 'file' && !selectedKeys[k]) {
            selectedKeys[k] = rec.model;
            applySelectionVisual(k);
        }
    });
    updateBatchBar();
}

function invertSelection() {
    entryOrder.forEach(function(k) {
        var rec = entryMap[k];
        if (!rec || rec.model.kind !== 'file') return;
        if (selectedKeys[k]) {
            delete selectedKeys[k];
        } else {
            selectedKeys[k] = rec.model;
        }
        applySelectionVisual(k);
    });
    updateBatchBar();
}

var batchDownloadState = null;

function batchDownload() {
    var keys = Object.keys(selectedKeys);
    if (!keys.length) return;
    var models = keys.map(function(k) { return selectedKeys[k]; });
    runParallelDownload(models, '');
}

// 文件级并行下载池：poolLimit 个文件并行，池内所有文件共享一个全局连接
// 预算（工作窃取：上限动态取 dlGetLimit()）——不再做"文件数×每文件连接数"
// 的静态分摊，空闲文件让出的连接立即被其他文件抢占；完成一个文件立即补位，
// 文件尾段与批次尾部的并行数同样被吃满。
// hooks: onFileBlob(idx, m, blob) / onFileFail(idx, m) / onFileProgress(idx, m, loaded)
// / onSettle(failCount)；返回 { cancel() }
function runFileDownloadPool(models, poolLimit, hooks) {
    var nextIdx = 0;
    var active = 0;
    var failCount = 0;
    var cancelled = false;
    var handles = {};
    var budget = { active: 0 };   // 池级共享连接预算

    function pump() {
        if (cancelled) return;
        while (active < poolLimit && nextIdx < models.length) {
            (function(idx) {
                var m = models[idx];
                active++;
                var onBlob = function(blob) {
                    if (!cancelled) hooks.onFileBlob(idx, m, blob);
                    oneDone(idx, true);
                };
                var onFail = function() {
                    if (!cancelled) hooks.onFileFail(idx, m);
                    oneDone(idx, false);
                };
                var h;
                if (m.chunked && m.parts) {
                    h = fetchMergedBlob(m.parts, onBlob, onFail, function(pct) {
                        hooks.onFileProgress(idx, m, (m.size && pct) ? m.size * pct / 100 : 0);
                    }, null, true, 0, budget);
                } else {
                    h = fetchFileBlobDual(m.path, m.size, function(loaded) {
                        hooks.onFileProgress(idx, m, loaded);
                    }, onBlob, onFail, 0, budget);
                }
                handles[idx] = h;
            })(nextIdx++);
        }
    }

    function oneDone(idx, ok) {
        active--;
        delete handles[idx];
        if (!ok) failCount++;
        pump();
        if (!cancelled && nextIdx >= models.length && active === 0) {
            hooks.onSettle(failCount);
        }
    }

    pump();
    return {
        cancel: function() {
            cancelled = true;
            for (var k in handles) {
                try { handles[k].cancel(); } catch (e) {}
            }
        }
    };
}

// 通用并行下载管线（批量下载）：文件级并行池 + 池内共享全局连接预算
// （工作窃取），任何文件都能抢占空闲连接，并行数全程吃满；完成的文件经保存
// 队列串行吐出（浏览器对连续自动下载限流）；全局进度条按字节汇总总进度。
function runParallelDownload(models, label) {
    if (batchDownloadState) return;
    if (!models.length) return;
    batchDownloadState = { cancelled: false, pool: null };
    toggleBatchDownloadUI(true);
    var totalBytes = 0;
    models.forEach(function(m) { totalBytes += (m.size || 0); });
    var limit = dlGetLimit();
    var poolLimit = Math.min(models.length, limit);
    var loadedMap = {};
    var doneCount = 0;
    var lastLoaded = 0;
    var lastTime = Date.now();
    var speedText = '';
    var etaText = '';
    var saveQueue = [];
    var saveTimer = null;

    var sumLoaded = function() {
        var s = 0;
        for (var k in loadedMap) s += loadedMap[k];
        return s;
    };
    var report = function() {
        var now = Date.now();
        if (now - lastTime >= 500) {
            var sp = (sumLoaded() - lastLoaded) / ((now - lastTime) / 1000);
            lastLoaded = sumLoaded();
            lastTime = now;
            speedText = sp > 1024 ? formatSize(Math.round(sp)) + '/s' : '';
            // ETA 跟随最近采样速度：多通道开关/通道增减时动态变化
            etaText = totalBytes ? etaTextFromSpeed(totalBytes - sumLoaded(), sp) : '';
        }
        var pct = totalBytes ? Math.min(99, Math.round(sumLoaded() / totalBytes * 100)) : Math.round(doneCount / models.length * 100);
        updateTaskProgress('正在下载 (' + doneCount + '/' + models.length + ')' + (label ? ' · ' + label : '') + (speedText ? ' · ' + speedText : '') + (etaText ? ' · 预计剩余 ' + etaText : ''), pct);
    };
    // 保存队列：浏览器对连续自动下载有限流，串行吐出（间隔 400ms）
    var pumpSave = function() {
        if (saveTimer || !saveQueue.length) return;
        var it = saveQueue.shift();
        saveBlobAs(it.blob, it.name);
        saveTimer = setTimeout(function() {
            saveTimer = null;
            pumpSave();
        }, 400);
    };
    showTaskProgress('正在下载 (0/' + models.length + ')' + (label ? ' · ' + label : ''), 0, stopBatchDownload);
    if (models.length > 1) {
        showToast('已并行下载 ' + poolLimit + ' 个文件；若被浏览器拦截多文件下载，请点击地址栏下载图标允许');
        setTimeout(hideToast, 4000);
    }
    var pool = runFileDownloadPool(models, poolLimit, {
        onFileBlob: function(idx, m, blob) {
            loadedMap[idx] = m.size || blob.size;
            doneCount++;
            saveQueue.push({ blob: blob, name: m.name });
            pumpSave();
            report();
        },
        onFileFail: function(idx, m) {
            doneCount++;
            showToast('下载失败: ' + m.displayName);
            setTimeout(hideToast, 2500);
            report();
        },
        onFileProgress: function(idx, m, loaded) {
            loadedMap[idx] = loaded;
            report();
        },
        onSettle: function(failCount) {
            finishBatchDownload(false, failCount);
        }
    });
    if (batchDownloadState) batchDownloadState.pool = pool;
}

function stopBatchDownload() {
    if (!batchDownloadState) return;
    batchDownloadState.cancelled = true;
    // 中止全部在途传输，而不是等它们传完
    var pool = batchDownloadState.pool;
    batchDownloadState.pool = null;
    if (pool) pool.cancel();
    finishBatchDownload(true);
}

function finishBatchDownload(stopped, failCount) {
    if (!batchDownloadState) return;
    batchDownloadState = null;
    toggleBatchDownloadUI(false);
    hideTaskProgress();
    showToast(stopped ? '已停止下载' : (failCount ? ('下载已完成（' + failCount + ' 个失败）') : '下载已完成'));
    setTimeout(hideToast, 2500);
}

function toggleBatchDownloadUI(downloading) {
    document.getElementById('batchDownloadBtn').style.display = downloading ? 'none' : '';
    document.getElementById('batchStopBtn').style.display = downloading ? '' : 'none';
}

function openBatchDeleteModal() {
    var keys = Object.keys(selectedKeys);
    if (!keys.length) return;
    var files = [];
    keys.forEach(function(k) {
        var m = selectedKeys[k];
        if (m.chunked && m.parts) {
            m.parts.forEach(function(p) { files.push({ path: p.path, sha: p.sha }); });
        } else {
            files.push({ path: m.path, sha: m.sha });
        }
    });
    deleteFilePath = '';
    deleteFileSha = '';
    deleteFileType = 'batch';
    deleteParts = files;
    var deleteBtn = document.getElementById('deleteBtn');
    deleteBtn.disabled = false;
    var deleteMsg = document.getElementById('deleteMessage');
    deleteMsg.className = 'message';
    deleteMsg.textContent = '';
    setDeleteProgress(null);
    var confirmP = document.getElementById('deleteConfirmText');
    confirmP.textContent = '';
    confirmP.appendChild(document.createTextNode('确定要删除选中的 '));
    var nameStrong = document.createElement('strong');
    nameStrong.textContent = keys.length + ' 个文件';
    confirmP.appendChild(nameStrong);
    confirmP.appendChild(document.createTextNode('（共 ' + files.length + ' 个存储文件）吗？此操作不可撤销。'));
    var savedAuth = getSavedAuth();
    document.getElementById('deleteAuthFields').style.display = savedAuth ? 'none' : '';
    document.getElementById('deleteModal').classList.add('show');
}

function renderFileList(items) {
    var models = buildEntryModels(items);
    var container = document.getElementById('fileListContainer');

    if (!models.length) {
        listRenderToken++;   // 中止进行中的分批渲染（tail 已随 innerHTML 移除）
        container.innerHTML = '<div class="loading">此目录为空</div>';
        entryMap = {};
        entryOrder = [];
        hasRenderedList = false;
        return;
    }

    var newOrder = models.map(function(m) { return m.key; });
    var newOrderSet = {};
    newOrder.forEach(function(k) { newOrderSet[k] = true; });
    var listChanged = false;

    if (!hasRenderedList) {
        // 首屏分批懒加载：条目逐个/逐批进入视野即渲染，大目录不再长时间白屏
        container.innerHTML = '';
        entryMap = {};
        entryOrder = [];
        hasRenderedList = true;
        var token = ++listRenderToken;
        var tail = document.createElement('div');
        tail.className = 'loading';
        container.appendChild(tail);
        var idx = 0;
        var renderBatch = function() {
            if (token !== listRenderToken) return;   // 已被新一轮渲染取代
            var end = Math.min(idx + LIST_RENDER_BATCH, models.length);
            for (; idx < end; idx++) {
                var m = models[idx];
                var el = createEntryElement(m);
                el.classList.add('entry-enter');
                container.insertBefore(el, tail);
                entryMap[m.key] = { el: el, model: m, sizeText: m.sizeText };
                entryOrder.push(m.key);
            }
            updateFolderSizes();
            if (idx < models.length) {
                tail.textContent = '正在加载 ' + idx + ' / ' + models.length + ' ...';
                setTimeout(renderBatch, 10);
                return;
            }
            container.removeChild(tail);
            finishRenderFileList(models, newOrder, true);
        };
        if (models.length > LIST_RENDER_BATCH) {
            renderBatch();
            return;
        }
        // 小目录一次性渲染，不走分批
        container.removeChild(tail);
        models.forEach(function(m) {
            var el = createEntryElement(m);
            container.appendChild(el);
            entryMap[m.key] = { el: el, model: m, sizeText: m.sizeText };
        });
        listChanged = true;
    } else {
        listRenderToken++;   // 使进行中的分批渲染失效，由增量逻辑接管
        // removals (animated, only the affected entries)
        // 遍历 entryMap 而非 entryOrder：被取代的分批渲染可能只登记了部分 key
        Object.keys(entryMap).forEach(function(k) {
            if (!newOrderSet[k]) {
                var rec = entryMap[k];
                if (rec) {
                    var el = rec.el;
                    el.style.maxHeight = el.offsetHeight + 'px';
                    requestAnimationFrame(function() {
                        el.classList.add('entry-leave');
                        setTimeout(function() {
                            if (el.parentNode) el.parentNode.removeChild(el);
                        }, 300);
                    });
                }
                listChanged = true;
            }
        });

        // updates & insertions
        models.forEach(function(m, i) {
            var rec = entryMap[m.key];
            if (rec && rec.model.kind === 'file' && !!rec.model.chunked !== !!m.chunked) {
                // storage form changed (chunked <-> normal): rebuild this entry in place
                var freshEl = createEntryElement(m);
                freshEl.classList.add('entry-enter');
                container.replaceChild(freshEl, rec.el);
                entryMap[m.key] = { el: freshEl, model: m, sizeText: m.sizeText };
                listChanged = true;
                return;
            }
            if (rec) {
                if (rec.model.kind === 'file') {
                    rec.el._model = {
                        path: m.path,
                        sha: m.sha,
                        name: m.name,
                        displayName: m.displayName,
                        type: 'file',
                        size: m.size,
                        chunked: m.chunked,
                        parts: m.parts
                    };
                    if (rec.sizeText !== m.sizeText) {
                        rec.el._sizeSpan.textContent = m.sizeText;
                        rec.el._sizeSpan.classList.remove('size-flash');
                        void rec.el._sizeSpan.offsetWidth;
                        rec.el._sizeSpan.classList.add('size-flash');
                        rec.sizeText = m.sizeText;
                        listChanged = true;
                    }
                } else {
                    rec.el._model = {
                        path: m.path,
                        sha: m.sha,
                        name: m.name,
                        displayName: m.displayName,
                        type: 'dir'
                    };
                }
                rec.model = m;
            } else {
                var el = createEntryElement(m);
                el.classList.add('entry-enter');
                var refEl = null;
                for (var j = i + 1; j < models.length; j++) {
                    var later = entryMap[models[j].key];
                    if (later && newOrderSet[models[j].key]) {
                        refEl = later.el;
                        break;
                    }
                }
                container.insertBefore(el, refEl);
                entryMap[m.key] = { el: el, model: m, sizeText: m.sizeText };
                listChanged = true;
            }
        });

        // fix ordering only when it actually changed
        var retainedOld = entryOrder.filter(function(k) { return newOrderSet[k]; });
        var retainedNew = newOrder.filter(function(k) { return !!entryMap[k]; });
        if (retainedOld.join('\n') !== retainedNew.join('\n')) {
            newOrder.forEach(function(k) {
                var rec = entryMap[k];
                if (rec) container.appendChild(rec.el);
            });
        }
    }

    finishRenderFileList(models, newOrder, listChanged);
}

// 渲染收尾：登记顺序、修剪选中态、刷新目录大小（首屏分批渲染完成时也走这里）
function finishRenderFileList(models, newOrder, listChanged) {
    entryOrder = newOrder;
    hasRenderedList = true;

    // prune selections of entries that disappeared, re-apply visuals otherwise
    Object.keys(selectedKeys).forEach(function(k) {
        if (!entryMap[k]) {
            delete selectedKeys[k];
        } else {
            applySelectionVisual(k);
        }
    });
    updateBatchBar();

    if (listChanged) {
        fileTreeCache = null;
    }
    fetchFolderSizes();
}

var pendingFiles = [];
var uploadTasks = [];
var COMMIT_GROUP_SIZE = 40;   // 每个批量提交包含的 blob 数（引用移动次数 = ceil(N/40)）

function buildUploadTasks() {
    var chunkSize = CHUNK_SIZE_LEVELS[chunkSizeLevel];
    var tasks = [];
    pendingFiles.forEach(function(item) {
        var file = item.file;
        if (file.size > chunkSize) {
            var parts = Math.ceil(file.size / chunkSize);
            for (var i = 0; i < parts; i++) {
                tasks.push({
                    blob: file.slice(i * chunkSize, Math.min((i + 1) * chunkSize, file.size)),
                    relativePath: item.relativePath + '.part' + (i + 1),
                    base: item.relativePath,
                    label: item.relativePath + ' (分片 ' + (i + 1) + '/' + parts + ', ' + formatSize(chunkSize) + '/片)'
                });
            }
        } else {
            tasks.push({
                blob: file,
                relativePath: item.relativePath,
                base: item.relativePath,
                label: item.relativePath
            });
        }
    });
    return tasks;
}

function setPendingFiles(list) {
    pendingFiles = list;
    var el = document.getElementById('selectedFiles');
    if (!list.length) {
        el.textContent = '';
        return;
    }
    var names = [];
    for (var i = 0; i < list.length && i < 5; i++) {
        names.push(list[i].relativePath);
    }
    var text = '已选择 ' + list.length + ' 个文件: ' + names.join(', ');
    if (list.length > 5) text += ' 等';
    el.textContent = text;
}

function handleFileInput(input) {
    var list = [];
    for (var i = 0; i < input.files.length; i++) {
        var f = input.files[i];
        list.push({ file: f, relativePath: f.webkitRelativePath || f.name });
    }
    setPendingFiles(list);
}

function traverseEntry(entry, path, list, done) {
    if (entry.isFile) {
        entry.file(function(f) {
            list.push({ file: f, relativePath: path + f.name });
            done();
        }, done);
    } else if (entry.isDirectory) {
        var dirReader = entry.createReader();
        var allEntries = [];
        var readAll = function() {
            dirReader.readEntries(function(entries) {
                if (entries.length === 0) {
                    if (allEntries.length === 0) {
                        done();
                        return;
                    }
                    var remaining = allEntries.length;
                    allEntries.forEach(function(child) {
                        traverseEntry(child, path + entry.name + '/', list, function() {
                            remaining--;
                            if (remaining === 0) done();
                        });
                    });
                } else {
                    for (var i = 0; i < entries.length; i++) {
                        allEntries.push(entries[i]);
                    }
                    readAll();
                }
            }, done);
        };
        readAll();
    } else {
        done();
    }
}

function handleDrop(e) {
    e.preventDefault();
    var dropZone = document.getElementById('dropZone');
    dropZone.style.background = '';
    var items = e.dataTransfer.items;
    if (items && items.length && items[0].webkitGetAsEntry) {
        var entries = [];
        for (var i = 0; i < items.length; i++) {
            var entry = items[i].webkitGetAsEntry();
            if (entry) entries.push(entry);
        }
        if (!entries.length) {
            setPendingFiles([]);
            return;
        }
        var list = [];
        var remaining = entries.length;
        entries.forEach(function(entry) {
            traverseEntry(entry, '', list, function() {
                remaining--;
                if (remaining === 0) {
                    list.sort(function(a, b) { return a.relativePath.localeCompare(b.relativePath); });
                    setPendingFiles(list);
                }
            });
        });
    } else {
        var list = [];
        for (var i = 0; i < e.dataTransfer.files.length; i++) {
            var f = e.dataTransfer.files[i];
            list.push({ file: f, relativePath: f.name });
        }
        setPendingFiles(list);
    }
}

// Detect same-level name collisions between pending uploads and the current listing
function findUploadConflicts() {
    var existing = {};
    entryOrder.forEach(function(k) {
        var rec = entryMap[k];
        if (rec) existing[rec.model.name] = rec.model.kind;
    });
    var conflicts = [];
    var seen = {};
    pendingFiles.forEach(function(item) {
        var top = item.relativePath.split('/')[0];
        if (seen[top]) return;
        seen[top] = true;
        if (existing[top] === 'dir') {
            conflicts.push(top + '（文件夹，将合并内容）');
        } else if (existing[top] === 'file') {
            conflicts.push(top + '（文件，将被覆盖）');
        }
    });
    return conflicts;
}

function uploadFile() {
    var auth = getSavedAuth();
    var uploadBtn = document.getElementById('uploadBtn');

    if (!auth) {
        setMsg('uploadMessage', '请先登录后再上传文件', 'error');
        return;
    }

    if (!pendingFiles.length) {
        setMsg('uploadMessage', '请选择要上传的文件', 'error');
        return;
    }

    var conflicts = findUploadConflicts();
    if (conflicts.length && !confirm('以下同名内容已存在于当前目录：\n' + conflicts.join('\n') + '\n\n是否继续上传？')) {
        return;
    }

    uploadBtn.disabled = true;
    setMsg('uploadMessage', '正在探测加速通道...', 'success');
    // 探测 CF 上传通道（CF 侧有服务端 key 时启用双通道上传），探测完成前不开始；
    // 探测结果明示给用户，通道状态不再是个谜
    probeCfUpload(function(cfOk) {
        if (cfOk) {
            showToast('上传双通道已启用（EO + CF）');
        } else {
            showToast('CF 上传通道不可用（' + (cfUploadHint || 'CF 侧未配置服务端 key 或不可达') + '），本次仅经 EO 上传');
        }
        setTimeout(hideToast, 4000);
        chunkSizeLevel = 0;
        startUpload();
    });
}

// ---- Parallel chunked upload with per-chunk retry and live speed ----
var UPLOAD_MAX_ATTEMPTS = 4;
var UPLOAD_LIMIT_MIN = 1;
var UPLOAD_LIMIT_MAX = 8;
// 分片预读缓存深度：FileReader 读盘/base64 编码发生在网络槽位之外提前完成，
// 槽位空出时下一个任务立即进入传输，读盘延迟不再拉低有效并行数
var UPLOAD_READAHEAD = 2;

// 读取任务内容（优先命中预读缓存）：cb(base64|null, err|null)
function readTaskContent(st, task, cb) {
    var key = task.relativePath;
    var ent = st.readCache[key];
    if (ent) {
        if (ent.error) {
            // 预读失败：丢弃缓存项，任务走自身重读（含错误处理）
            delete st.readCache[key];
            readTaskContent(st, task, cb);
            return;
        }
        if (ent.data !== null) {
            delete st.readCache[key];
            cb(ent.data, null);
        } else {
            ent.cbs.push(cb);   // 预读进行中：挂到完成回调队列
        }
        return;
    }
    ent = st.readCache[key] = { data: null, error: false, cbs: [cb] };
    startTaskRead(st, task, ent);
}

function startTaskRead(st, task, ent) {
    var reader = new FileReader();
    reader.onload = function(e) {
        ent.data = e.target.result.split(',')[1];
        var cbs = ent.cbs;
        ent.cbs = [];
        if (cbs.length) delete st.readCache[task.relativePath];
        cbs.forEach(function(f) { f(ent.data, null); });
        // 无等待者（纯预读）：数据留在缓存中供后续任务直接消费
    };
    reader.onerror = function() {
        ent.error = true;
        var cbs = ent.cbs;
        ent.cbs = [];
        if (cbs.length) delete st.readCache[task.relativePath];
        cbs.forEach(function(f) { f(null, 'read'); });
    };
    reader.readAsDataURL(task.blob);
}

// 让预读游标始终领先调度游标 UPLOAD_READAHEAD 个任务
function prefetchUploadReads(st) {
    if (!st || st.cancelled || st.failedMsg || st.downgrading) return;
    while (st.cacheIdx < uploadTasks.length && st.cacheIdx < st.nextIndex + UPLOAD_READAHEAD) {
        var t = uploadTasks[st.cacheIdx++];
        if (st.readCache[t.relativePath]) continue;   // 已在缓存/读取中
        var ent = st.readCache[t.relativePath] = { data: null, error: false, cbs: [] };
        startTaskRead(st, t, ent);
    }
}
var uploadState = null;
var uploadSpeedHist = { eo: [], cf: [], ext: [], tot: [] };   // 每秒分通道采样的速度（bytes/s）
var SPEED_HISTORY_MAX = 150;

function resetUploadSpeedHist() {
    uploadSpeedHist.eo = [];
    uploadSpeedHist.cf = [];
    uploadSpeedHist.ext = [];
    uploadSpeedHist.tot = [];
}

// ---- 下载并发控制（自适应算法针对下载修改：无提交冲突，按段完成速度升、
// EO 段失败降；CF 失败只熔断通道不降并发） ----
var DL_LIMIT_MIN = 1;
var DL_LIMIT_MAX = 8;
var DL_LIMIT_ADAPTIVE_START = 3;
var dlLimit = { adaptive: true, limit: DL_LIMIT_ADAPTIVE_START };

function dlGetLimit() {
    // 自适应上限 DL_LIMIT_MAX；手动/自定义无上限（过大受浏览器单域名连接数限制）
    var cap = dlLimit.adaptive ? DL_LIMIT_MAX : Infinity;
    return Math.max(DL_LIMIT_MIN, Math.min(cap, dlLimit.limit));
}

// 当前实际并行数实时显示 + 调度器实时补位
var dlSchedulers = [];

function dlRegisterScheduler(fn) {
    if (dlSchedulers.indexOf(fn) === -1) dlSchedulers.push(fn);
}

function dlUnregisterScheduler(fn) {
    var i = dlSchedulers.indexOf(fn);
    if (i !== -1) dlSchedulers.splice(i, 1);
}

function dlNotify() {
    dlUpdateCurUi();
    dlSchedulers.slice().forEach(function(fn) {
        try { fn(); } catch (e) {}
    });
}

function dlUpdateCurUi() {
    var el = document.getElementById('taskDlCur');
    if (el) el.textContent = '×' + dlGetLimit();
}

function dlSetMode(v) {
    if (v === 'auto') {
        dlLimit.adaptive = true;
        dlLimit.limit = DL_LIMIT_ADAPTIVE_START;
    } else {
        dlLimit.adaptive = false;
        dlLimit.limit = parseInt(v, 10) || DL_LIMIT_ADAPTIVE_START;
    }
    dlNotify();
}

// 自适应升档：连续 3 个段快速完成（<3s）说明带宽宽裕
function dlAdaptiveSuccess(durMs) {
    if (!dlLimit.adaptive) return;
    if (durMs < 3000) {
        dlLimit._fast = (dlLimit._fast || 0) + 1;
        if (dlLimit._fast >= 3 && dlLimit.limit < DL_LIMIT_MAX) {
            dlLimit.limit++;
            dlLimit._fast = 0;
            dlNotify();
        }
    } else {
        dlLimit._fast = 0;
    }
}

// 自适应降档：EO 段失败暗示链路饱和
function dlAdaptiveFail() {
    if (!dlLimit.adaptive) return;
    if (dlLimit.limit > DL_LIMIT_MIN) {
        dlLimit.limit--;
        dlNotify();
    }
    dlLimit._fast = 0;
}

// ---- 通道负载分配（下载）：在途均衡优先，再按各通道最近 5 秒实测速率
// 比例加权（带概率地板），无数据时轮询兜底。通道：'eo' / 'cf' / 'ext' ----
var dlActive = { eo: 0, cf: 0, ext: 0 };

function dlChanInc(chan) {
    dlActive[chan] = (dlActive[chan] || 0) + 1;
}

function dlChanDec(chan) {
    dlActive[chan] = Math.max(0, (dlActive[chan] || 0) - 1);
}

function dlRecentRates() {
    var avg = function(arr) {
        var tail = arr.slice(-5);
        if (!tail.length) return 0;
        var sum = 0;
        for (var i = 0; i < tail.length; i++) sum += tail[i];
        return sum / tail.length;
    };
    return { eo: avg(dlTracker.eo), cf: avg(dlTracker.cf), ext: avg(dlTracker.ext) };
}

// 当前可用下载通道（exclude 用于重试换源时排除上次失败的通道）；
// EO/CF 受通道开关控制，外部通道受"多代理"开关与熔断控制
function dlChannels(exclude) {
    var chans = [];
    if (dlChanSwitch.eo && exclude !== 'eo') chans.push('eo');
    if (dlChanSwitch.cf && exclude !== 'cf') chans.push('cf');
    if (exclude !== 'ext' && extDlAvailable()) chans.push('ext');
    if (!chans.length) chans.push('eo');   // 兜底：永远保留 EO
    return chans;
}

// 无速率数据时的轮询兜底：在可用通道间依次轮转而非按段序号奇偶，
// 保证跨文件/跨批次也严格均衡——单段小文件批量下载时各通道同样均衡分到任务
var dlChanRr = 0;

function pickDlFallback(exclude) {
    var chans = dlChannels(exclude);
    dlChanRr = (dlChanRr + 1) % chans.length;
    return chans[dlChanRr];
}

// 外部通道目标并行份额：开启多代理后外部代理承担约 80% 的在途任务，
// EO/CF 保留 20% 兜底（免费镜像扛大头，可靠通道保底）
var DL_EXT_SHARE = 0.8;

// 返回 'eo'/'cf'/'ext' / null=无速率数据（调用方轮询兜底）
function pickDlChannel(exclude) {
    var chans = dlChannels(exclude);
    if (chans.length === 1) return chans[0];
    // 外部通道可用时按目标份额分配（缺口最大者先得）：外部 80%，
    // 其余通道按最近实测速率比例分享剩余 20%（无速率数据时均分）
    if (chans.indexOf('ext') !== -1) {
        var others = [];
        var act = {};
        var total = 1;   // 含即将派发的新任务
        for (var i = 0; i < chans.length; i++) {
            if (chans[i] !== 'ext') others.push(chans[i]);
            act[chans[i]] = dlActive[chans[i]] || 0;
            total += act[chans[i]];
        }
        var r0 = dlRecentRates();
        var orate = 0;
        for (var k = 0; k < others.length; k++) orate += r0[others[k]] || 0;
        var bestChan = null, bestDeficit = -Infinity;
        for (var m = 0; m < chans.length; m++) {
            var c = chans[m], share;
            if (c === 'ext') {
                share = DL_EXT_SHARE;
            } else {
                // 非外部通道保留最低份额地板（各 25%）：零速率通道（如 CF 起步
                // 无数据）也能持续分到探测任务，不会被 EO 的速率优势永久饿死
                var ratio = orate > 0 ? (r0[c] || 0) / orate : 1 / others.length;
                share = (1 - DL_EXT_SHARE) * Math.max(ratio, 0.25);
            }
            var deficit = share * total - act[c];
            if (deficit > bestDeficit) {
                bestDeficit = deficit;
                bestChan = c;
            }
        }
        return bestChan;
    }
    // 无外部通道：在途均衡优先——把新任务补给在途最少的通道（相差 2 以上
    // 才干预），避免起始几段的轻微失衡被加权随机放大成单通道独占
    var minAct = Infinity, maxAct = -1, minChan = chans[0];
    for (var i2 = 0; i2 < chans.length; i2++) {
        var a = dlActive[chans[i2]] || 0;
        if (a < minAct) { minAct = a; minChan = chans[i2]; }
        if (a > maxAct) maxAct = a;
    }
    if (maxAct - minAct >= 2) return minChan;
    var r = dlRecentRates();
    var totalRate = 0, anyRate = false;
    for (var j = 0; j < chans.length; j++) {
        totalRate += r[chans[j]];
        if (r[chans[j]] >= 1024) anyRate = true;
    }
    if (!anyRate) return null;
    // 概率地板：每个通道至少保留约 15% 选中概率——零速率通道也能持续分到
    // 探测任务，打破"分不到段→测不到速率→永远分不到段"的死锁
    var floor = 0.15;
    var weights = [], sum = 0;
    for (var k2 = 0; k2 < chans.length; k2++) {
        var w = Math.max((r[chans[k2]] || 0) / (totalRate || 1), floor);
        weights.push(w);
        sum += w;
    }
    var x = Math.random() * sum;
    for (var m2 = 0; m2 < chans.length; m2++) {
        x -= weights[m2];
        if (x <= 0) return chans[m2];
    }
    return chans[chans.length - 1];
}

// ---- 下载速度跟踪：按通道（EO/CF/外部）分桶统计，每秒采样一次供曲线使用 ----
var DL_HISTORY_MAX = 150;
var dlTracker = { active: 0, timer: null, eoAcc: 0, cfAcc: 0, extAcc: 0, eo: [], cf: [], ext: [], tot: [], lastActive: 0 };

function dlTrackStart() {
    dlTracker.active++;
    if (dlTracker.timer) return;
    // 距离上次下载超过 8 秒才清空历史，批量/连续下载保持曲线连续
    if (Date.now() - dlTracker.lastActive > 8000) {
        dlTracker.eo = [];
        dlTracker.cf = [];
        dlTracker.ext = [];
        dlTracker.tot = [];
    }
    dlTracker.eoAcc = 0;
    dlTracker.cfAcc = 0;
    dlTracker.extAcc = 0;
    dlTracker.timer = setInterval(function() {
        dlTracker.eo.push(dlTracker.eoAcc);
        dlTracker.cf.push(dlTracker.cfAcc);
        dlTracker.ext.push(dlTracker.extAcc);
        dlTracker.tot.push(dlTracker.eoAcc + dlTracker.cfAcc + dlTracker.extAcc);
        dlTracker.eoAcc = 0;
        dlTracker.cfAcc = 0;
        dlTracker.extAcc = 0;
        if (dlTracker.eo.length > DL_HISTORY_MAX) {
            dlTracker.eo.shift();
            dlTracker.cf.shift();
            dlTracker.ext.shift();
            dlTracker.tot.shift();
        }
        drawDlGraph();
    }, 1000);
}

function dlTrackStop() {
    dlTracker.active = Math.max(0, dlTracker.active - 1);
    if (!dlTracker.active) {
        dlTracker.lastActive = Date.now();
        if (dlTracker.timer) {
            clearInterval(dlTracker.timer);
            dlTracker.timer = null;
        }
    }
}

function dlTrackAdd(chan, bytes) {
    if (!dlTracker.active || bytes <= 0) return;
    if (chan === 'cf') dlTracker.cfAcc += bytes;
    else if (chan === 'ext') dlTracker.extAcc += bytes;
    else dlTracker.eoAcc += bytes;
}

// 绘制下载曲线：总（蓝，面积填充）/ EO（绿）/ CF（橙）/ 外部代理（紫），Y 轴带刻度
function drawDlGraph() {
    var canvas = document.getElementById('taskDlGraph');
    if (!canvas || canvas.style.display === 'none') return;
    var ctxBox = prepareGraphCanvas(canvas, 34);
    if (!ctxBox) return;
    var ctx = ctxBox.ctx, W = ctxBox.plotW, H = ctxBox.plotH, x0 = ctxBox.x0;
    var tot = dlTracker.tot, eo = dlTracker.eo, cf = dlTracker.cf, ext = dlTracker.ext;
    var peak = 0;
    for (var p = 0; p < tot.length; p++) {
        if (tot[p] > peak) peak = tot[p];
    }
    drawGraphGrid(ctx, ctxBox, peak);
    if (!tot.length || peak <= 0) {
        updateDlLegend(0, 0, 0, 0);
        return;
    }
    var max = peak * 1.15;
    var n = tot.length;
    var dx = W / Math.max(1, DL_HISTORY_MAX - 1);
    var xStart = x0 + W - (n - 1) * dx;
    var plot = function(series, color, fill) {
        var pts = [];
        for (var i = 0; i < n; i++) {
            pts.push([xStart + i * dx, ctxBox.y0 + H - (series[i] / max) * (H - 4)]);
        }
        if (fill) {
            ctx.beginPath();
            ctx.moveTo(pts[0][0], ctxBox.y0 + H);
            ctx.lineTo(pts[0][0], pts[0][1]);
            traceSmoothPath(ctx, pts);
            ctx.lineTo(pts[pts.length - 1][0], ctxBox.y0 + H);
            ctx.closePath();
            ctx.fillStyle = 'rgba(44, 130, 201, 0.12)';
            ctx.fill();
        }
        ctx.beginPath();
        traceSmoothPath(ctx, pts);
        ctx.strokeStyle = color;
        ctx.lineWidth = color === '#2c82c9' ? 1.8 : 1.2;
        ctx.stroke();
    };
    plot(tot, '#2c82c9', true);
    plot(eo, '#28a745', false);
    plot(cf, '#e67e22', false);
    if (extProxyState.enabled) plot(ext, '#9b59b6', false);
    updateDlLegend(tot[n - 1] || 0, eo[n - 1] || 0, cf[n - 1] || 0, ext[n - 1] || 0);
}

function updateDlLegend(totV, eoV, cfV, extV) {
    var f = function(v) { return v > 1024 ? formatSize(Math.round(v)) + '/s' : '0/s'; };
    var el;
    if ((el = document.getElementById('taskDlLegendTot'))) el.textContent = '总 ' + f(totV);
    // 附带各通道在途段/片数，负载分配一目了然
    if ((el = document.getElementById('taskDlLegendEo'))) el.textContent = 'EO ' + f(eoV) + ' ×' + dlActive.eo;
    if ((el = document.getElementById('taskDlLegendCf'))) el.textContent = 'CF ' + f(cfV) + ' ×' + dlActive.cf;
    if ((el = document.getElementById('taskDlLegendExt'))) el.textContent = '外部 ' + f(extV || 0) + ' ×' + dlActive.ext;
    updateDlLegendExtVisibility();
}

// 外部代理图例只在多代理模式开启时显示（连同前面的色块）
function updateDlLegendExtVisibility() {
    var span = document.getElementById('taskDlLegendExt');
    if (!span) return;
    var icon = span.previousElementSibling;
    var disp = extProxyState.enabled ? '' : 'none';
    span.style.display = disp;
    if (icon && icon.tagName === 'I') icon.style.display = disp;
}

// ---- 曲线图公共：Y 轴刻度 + 网格 + 实时速度 ----
// 平滑曲线路径（中点二次贝塞尔），pts = [[x, y], ...]
function traceSmoothPath(ctx, pts) {
    if (pts.length === 1) {
        ctx.moveTo(pts[0][0] - 0.5, pts[0][1]);
        ctx.lineTo(pts[0][0] + 0.5, pts[0][1]);
        return;
    }
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length - 1; i++) {
        var xc = (pts[i][0] + pts[i + 1][0]) / 2;
        var yc = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], xc, yc);
    }
    ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
}
// 返回 {ctx, x0, y0, plotW, plotH}；左侧 gutter 画 Y 轴刻度
function prepareGraphCanvas(canvas, gutter) {
    var dpr = window.devicePixelRatio || 1;
    var W = canvas.clientWidth;
    var H = canvas.clientHeight;
    if (!W || !H) return null;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    return { ctx: ctx, x0: gutter, y0: 4, plotW: W - gutter - 4, plotH: H - 8, totalW: W, totalH: H };
}

function drawGraphGrid(ctx, box, peak) {
    var x0 = box.x0, y0 = box.y0, W = box.plotW, H = box.plotH;
    // 网格参考线
    ctx.strokeStyle = 'rgba(0,0,0,0.07)';
    ctx.lineWidth = 1;
    for (var g = 1; g <= 3; g++) {
        ctx.beginPath();
        ctx.moveTo(x0, y0 + H * g / 4 + 0.5);
        ctx.lineTo(x0 + W, y0 + H * g / 4 + 0.5);
        ctx.stroke();
    }
    // Y 轴刻度：顶部峰值、中部一半、底部 0
    ctx.fillStyle = '#999';
    ctx.font = '9px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    var maxLabel = peak > 1024 ? formatSize(Math.round(peak * 1.15)) + '/s' : '0/s';
    ctx.fillText(maxLabel, 2, y0);
    if (peak > 1024) {
        ctx.fillText(formatSize(Math.round(peak * 1.15 / 2)) + '/s', 2, y0 + H / 2 - 4);
    }
    ctx.fillText('0', 2, y0 + H - 9);
    // Y 轴基线
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.beginPath();
    ctx.moveTo(x0 - 0.5, y0);
    ctx.lineTo(x0 - 0.5, y0 + H);
    ctx.stroke();
}

// Win10 资源管理器风格速度曲线：总（蓝+面积）/ EO（绿）/ CF（橙）/ 外部（紫），
// 平滑路径 + 网格参考线 + Y 轴刻度，图例实时显示各路速度
function drawSpeedGraph() {
    var canvas = document.getElementById('speedGraph');
    if (!canvas || canvas.style.display === 'none') return;
    var box = prepareGraphCanvas(canvas, 34);
    if (!box) return;
    var ctx = box.ctx, W = box.plotW, H = box.plotH, x0 = box.x0;
    var tot = uploadSpeedHist.tot, eo = uploadSpeedHist.eo, cf = uploadSpeedHist.cf, ext = uploadSpeedHist.ext;
    var peak = 0;
    for (var p = 0; p < tot.length; p++) {
        if (tot[p] > peak) peak = tot[p];
    }
    drawGraphGrid(ctx, box, peak);
    var peakEl = document.getElementById('speedPanelPeak');
    if (peakEl) peakEl.textContent = peak > 1024 ? '峰值 ' + formatSize(Math.round(peak)) + '/s' : '';
    if (!tot.length || peak <= 0) {
        updateUlLegend(0, 0, 0, 0);
        return;
    }
    var max = peak * 1.15;
    var n = tot.length;
    var dx = W / Math.max(1, SPEED_HISTORY_MAX - 1);
    var xStart = x0 + W - (n - 1) * dx;
    var plot = function(series, color, fill, width) {
        var pts = [];
        for (var i = 0; i < n; i++) {
            pts.push([xStart + i * dx, box.y0 + H - (series[i] / max) * (H - 4)]);
        }
        if (fill) {
            ctx.beginPath();
            ctx.moveTo(pts[0][0], box.y0 + H);
            ctx.lineTo(pts[0][0], pts[0][1]);
            traceSmoothPath(ctx, pts);
            ctx.lineTo(pts[pts.length - 1][0], box.y0 + H);
            ctx.closePath();
            ctx.fillStyle = 'rgba(44, 130, 201, 0.15)';
            ctx.fill();
        }
        ctx.beginPath();
        traceSmoothPath(ctx, pts);
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.stroke();
    };
    plot(tot, '#2c82c9', true, 1.8);
    plot(eo, '#28a745', false, 1.2);
    plot(cf, '#e67e22', false, 1.2);
    if (ulChanSwitch.ext) plot(ext, '#9b59b6', false, 1.2);
    updateUlLegend(tot[n - 1] || 0, eo[n - 1] || 0, cf[n - 1] || 0, ext[n - 1] || 0);
}

function updateUlLegend(totV, eoV, cfV, extV) {
    var f = function(v) { return v > 1024 ? formatSize(Math.round(v)) + '/s' : '0/s'; };
    var el;
    if ((el = document.getElementById('ulLegendTot'))) el.textContent = '总 ' + f(totV);
    if ((el = document.getElementById('ulLegendEo'))) el.textContent = 'EO ' + f(eoV);
    if ((el = document.getElementById('ulLegendCf'))) el.textContent = 'CF ' + f(cfV);
    if ((el = document.getElementById('ulLegendExt'))) el.textContent = '外部 ' + f(extV || 0);
    updateUlLegendExtVisibility();
}

// 外部上传图例只在外部上传通道开启时显示（连同前面的色块）
function updateUlLegendExtVisibility() {
    var span = document.getElementById('ulLegendExt');
    if (!span) return;
    var icon = span.previousElementSibling;
    var disp = ulChanSwitch.ext ? '' : 'none';
    span.style.display = disp;
    if (icon && icon.tagName === 'I') icon.style.display = disp;
}

function startUpload(doneBases) {
    uploadTasks = buildUploadTasks().filter(function(t) {
        return !(doneBases && doneBases[t.base]);
    });
    var sel = document.getElementById('concurrencySelect');
    var mode = sel ? sel.value : '3';
    if (mode === 'custom') {
        var customInput = document.getElementById('concurrencyCustom');
        mode = String(customInput ? parseInt(customInput.value, 10) || 3 : 3);
    }
    var adaptive = mode === 'auto';
    if (uploadState && uploadState.adaptive) {
        // keep the learned limit across chunk-size downgrades in adaptive mode
        adaptive = true;
    }
    uploadState = {
        nextIndex: 0,
        active: 0,
        doneCount: 0,
        fractionSum: 0,
        bytesDone: 0,
        lastSampleBytes: 0,
        lastSampleTime: Date.now(),
        speedText: '',
        speedSamples: [],   // 最近 10 秒速度采样窗口（ETA 动态计算用）
        baseTotals: {},
        baseDones: {},
        doneBases: doneBases || {},
        downgrading: false,
        failedMsg: null,
        speedTimer: null,
        activeTasks: {},
        adaptive: adaptive,
        limit: adaptive ? 3 : Math.max(UPLOAD_LIMIT_MIN, parseInt(mode, 10) || 3),
        startTime: Date.now(),
        smallDurSum: 0,
        smallDurCount: 0,
        conflictCount: 0,
        sinceConflict: 0,
        blobs: [],
        eoBytes: 0,
        cfBytes: 0,
        extBytes: 0,
        lastEoBytes: 0,
        lastCfBytes: 0,
        lastExtBytes: 0,
        eoTasks: 0,
        cfTasks: 0,
        extTasks: 0,
        chanRr: 0,
        cancelled: false,
        smallRatio: 0,
        readCache: {},   // 分片预读缓存 relativePath -> {data, error, cbs}
        cacheIdx: 0      // 预读游标（领先 nextIndex 最多 UPLOAD_READAHEAD 个任务）
    };
    var smallCount = 0;
    uploadTasks.forEach(function(t) {
        if (t.blob.size < 1048576) smallCount++;
    });
    uploadState.smallRatio = uploadTasks.length ? smallCount / uploadTasks.length : 0;
    uploadTasks.forEach(function(t) {
        uploadState.baseTotals[t.base] = (uploadState.baseTotals[t.base] || 0) + 1;
    });
    document.querySelector('.progress-container').style.display = 'block';
    document.getElementById('stopUploadBtn').style.display = '';
    // 重置并显示速度曲线面板（保持用户上次的展开/折叠状态）
    resetUploadSpeedHist();
    document.getElementById('speedPanel').style.display = 'block';
    document.getElementById('speedPanelPeak').textContent = '';
    drawSpeedGraph();
    uploadState.speedTimer = setInterval(sampleUploadSpeed, 1000);
    setMsg('uploadMessage', '正在上传 (0/' + uploadTasks.length + ') · 分片大小 ' + currentChunkLabel(), 'success');
    updateUploadProgressUI();
    renderChunkPanel();
    fillUploads();
}

// Apply concurrency select changes to an in-progress upload immediately
function applyConcurrencyChange() {
    var st = uploadState;
    if (!st) return;
    var sel = document.getElementById('concurrencySelect');
    var mode = sel ? sel.value : '3';
    if (mode === 'auto') {
        st.adaptive = true;
    } else {
        st.adaptive = false;
        var v;
        if (mode === 'custom') {
            var customInput = document.getElementById('concurrencyCustom');
            v = customInput ? parseInt(customInput.value, 10) : 3;
        } else {
            v = parseInt(mode, 10);
        }
        st.limit = Math.max(UPLOAD_LIMIT_MIN, v || 3);
    }
    renderChunkPanel();
    fillUploads();
}

// 当前可用上传通道：EO/CF 受开关控制（CF 还需探测可用），外部需开关 +
// 管理员 key + 可用代理；引用类操作不走这里（固定 EO）
function ulChannels(exclude) {
    var chans = [];
    if (ulChanSwitch.eo && exclude !== 'eo') chans.push('eo');
    if (ulChanSwitch.cf && exclude !== 'cf' && cfUploadState === true) chans.push('cf');
    if (ulChanSwitch.ext && exclude !== 'ext' && isAdminUser() && ulGitKey && extUploadProxiesUsable()) chans.push('ext');
    if (!chans.length) chans.push('eo');
    return chans;
}

// 按通道负载分配上传任务：在途任务数均衡优先；尚无速率数据时轮转；
// 有数据后按各通道实测速率比例加权（带概率地板，避免零速率通道被永久饿死），
// 快的通道分得更多任务，并统计各自任务数。noCount=true 时不重复计数（失败换源重挑）
function stAddChanBytes(st, chan, delta) {
    if (chan === 'cf') st.cfBytes += delta;
    else if (chan === 'ext') st.extBytes += delta;
    else st.eoBytes += delta;
}

function pickUploadChannel(size, exclude, noCount) {
    var st = uploadState;
    if (!st) return 'eo';
    var chans = ulChannels(exclude);
    var useChan;
    if (chans.length === 1) {
        useChan = chans[0];
    } else {
        // 在途均衡优先：某通道在途任务明显更多时先补给在途最少通道
        var act = {};
        var i;
        for (i = 0; i < chans.length; i++) act[chans[i]] = 0;
        for (var key in st.activeTasks) {
            var c = st.activeTasks[key].chan || 'eo';
            if (act[c] !== undefined) act[c]++;
        }
        var minAct = Infinity, maxAct = -1, minChan = chans[0];
        for (i = 0; i < chans.length; i++) {
            if (act[chans[i]] < minAct) { minAct = act[chans[i]]; minChan = chans[i]; }
            if (act[chans[i]] > maxAct) maxAct = act[chans[i]];
        }
        if (maxAct - minAct >= 2) {
            useChan = minChan;
        } else {
            var rates = { eo: st._eoRate || 0, cf: st._cfRate || 0, ext: st._extRate || 0 };
            var totalRate = 0, anyRate = false;
            for (i = 0; i < chans.length; i++) {
                totalRate += rates[chans[i]];
                if (rates[chans[i]] >= 1024) anyRate = true;
            }
            if (!anyRate) {
                st.chanRr = ((st.chanRr || 0) + 1) % chans.length;
                useChan = chans[st.chanRr];
            } else {
                // 概率地板：零速率通道保留 15% 机会持续获得探测任务
                var floor = 0.15;
                var weights = [], sum = 0;
                for (i = 0; i < chans.length; i++) {
                    var w = Math.max(rates[chans[i]] / (totalRate || 1), floor);
                    weights.push(w);
                    sum += w;
                }
                var x = Math.random() * sum;
                useChan = chans[chans.length - 1];
                for (i = 0; i < chans.length; i++) {
                    x -= weights[i];
                    if (x <= 0) {
                        useChan = chans[i];
                        break;
                    }
                }
            }
        }
    }
    if (!noCount) st[useChan + 'Tasks']++;
    return useChan;
}

// Keep the pipeline filled up to the current concurrency limit.
// The limit may change at runtime in adaptive mode.
function fillUploads() {
    var st = uploadState;
    if (!st) return;
    // blob 上传不移动引用，无需提交阶段限流，全速并行
    while (!st.failedMsg && !st.downgrading && st.active < st.limit && st.nextIndex < uploadTasks.length) {
        var task = uploadTasks[st.nextIndex++];
        // 按通道负载（在途均衡 + 实测速率比例）分配任务通道
        task.chan = pickUploadChannel(task.blob.size);
        st.active++;
        st.activeTasks[task.relativePath] = task;
        renderChunkPanel();
        (function(t) {
            runUploadTask(t, function(ok) {
                var st2 = uploadState;
                if (!st2) return;
                st2.active--;
                delete st2.activeTasks[t.relativePath];
                renderChunkPanel();
                if (ok) {
                    st2.doneCount++;
                    st2.sinceConflict++;
                    st2.baseDones[t.base] = (st2.baseDones[t.base] || 0) + 1;
                    if (st2.baseDones[t.base] === st2.baseTotals[t.base]) {
                        st2.doneBases[t.base] = true;
                    }
                    // adaptive: fast chunks -> scale up, slow chunks -> scale down
                    if (t.startTime) {
                        var dur = Date.now() - t.startTime;
                        if (t.blob.size < 1048576) {
                            st2.smallDurSum += dur;
                            st2.smallDurCount++;
                        }
                        if (st2.adaptive) {
                            // 激进策略：更快的升档阈值与更高的上限，
                            // 只在明确拥堵（超慢分片/失败/冲突）时才降档
                            if (dur < 15000 && st2.limit < UPLOAD_LIMIT_MAX) {
                                st2.limit++;
                            } else if (dur > 45000 && st2.limit > UPLOAD_LIMIT_MIN) {
                                st2.limit--;
                            }
                            // 低冲突率奖励：连续 8 个任务无提交冲突，说明引用竞争
                            // 压力小，自动提高并发进一步提速
                            if (st2.sinceConflict >= 8 && st2.limit < UPLOAD_LIMIT_MAX) {
                                st2.limit++;
                                st2.sinceConflict = 0;
                            }
                        }
                    }
                    setMsg('uploadMessage', '正在上传 (' + st2.doneCount + '/' + uploadTasks.length + ') · 分片大小 ' + currentChunkLabel(), 'success');
                }
                updateUploadProgressUI();
                fillUploads();
            });
        })(task);
    }
    prefetchUploadReads(st);   // 预读游标保持领先，下一批任务数据提前就绪
    checkUploadSettled();
}

function checkUploadSettled() {
    var st = uploadState;
    if (!st || st.active > 0) return;
    if (st.failedMsg) {
        failUpload(st.failedMsg);
        return;
    }
    if (st.downgrading) {
        var doneBases = st.doneBases;
        setMsg('uploadMessage', '分片过大，已自动减小分片大小（当前 ' + currentChunkLabel() + '），正在重新上传...', 'success');
        stopUploadTimer();
        uploadState = null;
        // blob 未提交不产生任何仓库变更，无需清理，直接重传
        startUpload(doneBases);
        return;
    }
    if (st.nextIndex >= uploadTasks.length) {
        finishUpload();
    }
}

function runUploadTask(task, done) {
    var st = uploadState;
    var attempt = 0;

    var tryOnce = function() {
        if (!uploadState || st.cancelled) {
            done(false);
            return;
        }
        attempt++;
        task.loadedBytes = 0;
        task.startTime = Date.now();
        task._lastProgAt = Date.now();
        // 读盘阶段无网络句柄：清空旧 xhr 引用与看门狗标记，防止误中止/误重试
        task.xhr = null;
        task._wdAbort = false;
        // 优先消费预读缓存：读盘/base64 已提前完成，槽位全程用于网络传输
        readTaskContent(st, task, function(base64Content, readErr) {
            if (st.cancelled) {
                done(false);
                return;
            }
            if (readErr) {
                if (attempt < UPLOAD_MAX_ATTEMPTS) {
                    setTimeout(tryOnce, 1000 * attempt);
                } else {
                    if (!st.failedMsg) {
                        st.failedMsg = '读取文件失败: ' + task.label;
                    }
                    done(false);
                }
                return;
            }
            var currentPath = getCurrentPath();
            var filePath = currentPath ? currentPath + '/' + task.relativePath : task.relativePath;

            // 以 blob 对象上传内容：不移动 git 引用，任意并行零提交冲突；
            // 引用只在全部传完后的批量提交阶段移动（每 40 个 blob 一次）
            task.xhr = putBlobToGitHub(base64Content,
                function(blobSha) {
                    if (st.cancelled) {
                        done(false);
                        return;
                    }
                    st.blobs.push({ path: filePath, sha: blobSha, base: task.base });
                    st.fractionSum -= (task.fraction || 0);
                    task.fraction = 0;
                    var doneDelta = task.blob.size - (task.loadedBytes || 0);
                    st.bytesDone += doneDelta;
                    stAddChanBytes(st, task.chan, doneDelta);
                    done(true);
                },
                function(status, responseText) {
                    if (st.cancelled) {
                        done(false);
                        return;
                    }
                    st.fractionSum -= (task.fraction || 0);
                    task.fraction = 0;
                    st.bytesDone -= (task.loadedBytes || 0);
                    stAddChanBytes(st, task.chan, -(task.loadedBytes || 0));
                    task.loadedBytes = 0;

                    if (/too large/i.test(responseText || '') && chunkSizeLevel < CHUNK_SIZE_LEVELS.length - 1) {
                        if (!st.downgrading) {
                            st.downgrading = true;
                            chunkSizeLevel++;
                            setMsg('uploadMessage', '分片过大，已自动减小分片大小（当前 ' + currentChunkLabel() + '），等待进行中的任务完成后重传...', 'success');
                        }
                        done(false);
                        return;
                    }

                    // 外部代理失败按代理熔断，并在失败通道之外换源重试；
                    // 404 已在 putBlobToGitHub 按代理累计（API 不支持不代表
                    // raw 下载也不可用），不再计入下载熔断
                    if (task.chan === 'ext' && status !== 404) extNoteFail(task._extBase);
                    if (attempt < UPLOAD_MAX_ATTEMPTS) {
                        task.chan = pickUploadChannel(task.blob.size, task.chan, true);
                        // adaptive: failures hint the network is saturated, back off
                        if (st.adaptive && st.limit > UPLOAD_LIMIT_MIN) {
                            st.limit--;
                        }
                        setMsg('uploadMessage', '分片上传失败(状态码 ' + status + ')，正在重试 (' + attempt + '/' + (UPLOAD_MAX_ATTEMPTS - 1) + '): ' + task.label, 'success');
                        setTimeout(tryOnce, 1000 * attempt);
                        return;
                    }

                    var errMsg = status === 0 ? '网络连接中断，可能是文件过大或网络不稳定' : ('状态码: ' + status);
                    try {
                        var error = JSON.parse(responseText);
                        if (error.message) errMsg = error.message;
                    } catch (e2) {}
                    if (!st.failedMsg) {
                        st.failedMsg = '上传失败 (' + task.relativePath + '): ' + errMsg;
                    }
                    done(false);
                },
                function(fraction) {
                    st.fractionSum += fraction - (task.fraction || 0);
                    task.fraction = fraction;
                    var loaded = Math.round(task.blob.size * fraction);
                    var delta = loaded - (task.loadedBytes || 0);
                    st.bytesDone += delta;
                    stAddChanBytes(st, task.chan, delta);
                    task.loadedBytes = loaded;
                    task._lastProgAt = Date.now();
                    updateUploadProgressUI();
                },
                undefined, task.chan, task);
        });
    };
    tryOnce();
}

function stopUploadTimer() {
    if (uploadState && uploadState.speedTimer) {
        clearInterval(uploadState.speedTimer);
        uploadState.speedTimer = null;
    }
}

// 全部 blob 传完后进入批量提交阶段：每 COMMIT_GROUP_SIZE 个 blob 合成
// 一个 tree + commit，引用移动次数从任务数降到组数，冲突概率趋近于零；
// 组间以 sessionRef 链式推进（上一组的新引用直接作为下一组基点），
// 杜绝组间读到过期引用导致的非快进失败
function finishUpload() {
    stopUploadTimer();
    document.getElementById('stopUploadBtn').style.display = 'none';
    var st = uploadState;
    var blobs = st ? st.blobs.slice() : [];
    uploadState = null;
    renderChunkPanel();
    clearBgTask();

    var groups = [];
    for (var i = 0; i < blobs.length; i += COMMIT_GROUP_SIZE) {
        groups.push(blobs.slice(i, i + COMMIT_GROUP_SIZE));
    }
    var gi = 0;
    var sessionRef = null;   // 上一组提交成功后的新引用，作为下一组的链式基点
    var commitNext = function() {
        if (gi >= groups.length) {
            fileTreeCache = null;
            bypassHttpCache();
            updateUploadProgressText(100, '');
            setMsg('uploadMessage', '全部上传成功！（' + blobs.length + ' 个文件分片，' + groups.length + ' 个提交）', 'success');
            setTimeout(function() {
                closeUploadModal();
                document.getElementById('uploadBtn').disabled = false;
                loadFileList();
            }, 1500);
            return;
        }
        setMsg('uploadMessage', '传输完成，正在批量提交 (' + (gi + 1) + '/' + groups.length + ')...', 'success');
        commitBlobGroup(groups[gi], 'Upload ' + groups[gi].length + ' file(s) via cloud-web', sessionRef, function(ok, err, newRef) {
            if (!ok) {
                fileTreeCache = null;
                bypassHttpCache();
                setMsg('uploadMessage', '提交失败: ' + err + '（已提交 ' + gi + '/' + groups.length + ' 组，其余未写入仓库）', 'error');
                document.getElementById('uploadBtn').disabled = false;
                loadFileList();
                return;
            }
            sessionRef = newRef || sessionRef;
            gi++;
            commitNext();
        });
    };
    if (!groups.length) {
        // 没有内容需要提交（理论上不会发生）
        setMsg('uploadMessage', '全部上传成功！', 'success');
        setTimeout(function() {
            closeUploadModal();
            document.getElementById('uploadBtn').disabled = false;
            loadFileList();
        }, 1500);
        return;
    }
    commitNext();
}

// 停止上传：中止全部在途传输。blob 上传不移动引用，未提交的内容不会
// 写入仓库（悬空 blob 由 GitHub 自动回收），无需回退清理
function stopUploadRollback() {
    var st = uploadState;
    if (!st) return;
    st.cancelled = true;
    stopUploadTimer();
    uploadState = null;
    for (var key in st.activeTasks) {
        var t = st.activeTasks[key];
        if (t.xhr) {
            try { t.xhr.abort(); } catch (e) {}
        }
    }
    renderChunkPanel();
    clearBgTask();
    document.getElementById('stopUploadBtn').style.display = 'none';
    setMsg('uploadMessage', '已停止上传：未产生任何提交，仓库保持不变（已传输的内容随悬空 blob 自动回收）', 'error');
    document.getElementById('uploadBtn').disabled = false;
}

function failUpload(finalMsg) {
    stopUploadTimer();
    uploadState = null;
    renderChunkPanel();
    clearBgTask();
    document.getElementById('stopUploadBtn').style.display = 'none';
    // blob 管线：传输阶段失败时尚未产生任何提交，仓库保持不变
    setMsg('uploadMessage', finalMsg + '（未写入任何提交，仓库保持不变）', 'error');
    document.getElementById('uploadBtn').disabled = false;
}

function sampleUploadSpeed() {
    var st = uploadState;
    if (!st) return;
    var now = Date.now();
    var dt = (now - st.lastSampleTime) / 1000;
    if (dt <= 0) return;
    var speed = (st.bytesDone - st.lastSampleBytes) / dt;
    var eoSpeed = (st.eoBytes - st.lastEoBytes) / dt;
    var cfSpeed = (st.cfBytes - st.lastCfBytes) / dt;
    var extSpeed = (st.extBytes - st.lastExtBytes) / dt;
    st.lastSampleBytes = st.bytesDone;
    st.lastEoBytes = st.eoBytes;
    st.lastCfBytes = st.cfBytes;
    st.lastExtBytes = st.extBytes;
    st.lastSampleTime = now;
    // 记录通道实测速率，供任务按负载比例分配
    st._eoRate = eoSpeed;
    st._cfRate = cfSpeed;
    st._extRate = extSpeed;
    st.speedText = speed > 1024 ? formatSize(Math.round(speed)) + '/s' : '';
    // 维护最近 10 秒速度采样窗口，ETA 随多通道吞吐变化动态调整
    if (!st.speedSamples) st.speedSamples = [];
    st.speedSamples.push(speed);
    if (st.speedSamples.length > 10) st.speedSamples.shift();
    // 速度曲线采样：总/EO/CF/外部 序列（保留最近 SPEED_HISTORY_MAX 秒）
    uploadSpeedHist.tot.push(speed);
    uploadSpeedHist.eo.push(eoSpeed);
    uploadSpeedHist.cf.push(cfSpeed);
    uploadSpeedHist.ext.push(extSpeed);
    if (uploadSpeedHist.tot.length > SPEED_HISTORY_MAX) {
        uploadSpeedHist.tot.shift();
        uploadSpeedHist.eo.shift();
        uploadSpeedHist.cf.shift();
        uploadSpeedHist.ext.shift();
    }
    drawSpeedGraph();
    // per-chunk speeds
    for (var key in st.activeTasks) {
        var t = st.activeTasks[key];
        var chunkSpeed = ((t.loadedBytes || 0) - (t.sampledBytes || 0)) / dt;
        t.sampledBytes = t.loadedBytes || 0;
        t.speedText = chunkSpeed > 1024 ? formatSize(Math.round(chunkSpeed)) + '/s' : '';
    }
    // 停滞看门狗：12 秒无任何上传进度即中止换源——部分外部代理对 POST
    // 只接不发（连接挂起不报错），在途槽位会被长期占住，表现为"分到了
    // 任务却迟迟不上传"；中止后按失败重试逻辑换代理/通道重传
    for (var key2 in st.activeTasks) {
        var t2 = st.activeTasks[key2];
        if (!t2.xhr) continue;
        var lastProg = t2._lastProgAt || t2.startTime || now;
        if (now - lastProg > 12000) {
            t2._wdAbort = true;
            if (t2.chan === 'ext') extNoteFail(t2._extBase);
            try { t2.xhr.abort(); } catch (e) {}
            t2._lastProgAt = now;   // 避免每秒重复中止同一任务
        }
    }
    updateUploadProgressUI();
    renderChunkPanel();
}

function renderChunkPanel() {
    var panel = document.getElementById('chunkPanel');
    if (!panel) return;
    var st = uploadState;
    if (!st) {
        panel.style.display = 'none';
        return;
    }
    panel.style.display = 'block';
    var activeList = [];
    for (var key in st.activeTasks) {
        activeList.push(st.activeTasks[key]);
    }
    var chanText = '';
    if (cfUploadState === true || ulChanSwitch.ext) {
        chanText = ' · EO×' + (st.eoTasks || 0) + ' CF×' + (st.cfTasks || 0);
        if (ulChanSwitch.ext) chanText += ' 外部×' + (st.extTasks || 0);
    }
    document.getElementById('chunkPanelSummary').textContent =
        '· 并行 ' + st.limit + (st.adaptive ? '(自适应)' : '') + ' · 进行中 ' + activeList.length + ' · 已完成 ' + st.doneCount + '/' + uploadTasks.length + chanText;
    var list = document.getElementById('chunkList');
    if (!activeList.length) {
        list.innerHTML = '<div style="padding: 6px 8px; color: #999;">等待分片调度...</div>';
        return;
    }
    var html = '';
    activeList.forEach(function(t) {
        var percent = Math.round((t.fraction || 0) * 100);
        html += '<div style="padding: 6px 8px; border-bottom: 1px solid #f0f0f0;">' +
            '<div style="word-break: break-all;">' + escapeHtml(t.label) + '</div>' +
            '<div style="display: flex; justify-content: space-between; margin-top: 2px; color: #2c82c9;">' +
            '<span>' + percent + '%</span><span>' + (t.speedText || '计算中...') + '</span>' +
            '</div></div>';
    });
    list.innerHTML = html;
}

// ETA from measured aggregate speed, per-small-task latency (small/large ratio
// weighted), remaining task count and the observed ref-conflict rate.
function estimateEtaText() {
    var st = uploadState;
    if (!st || !st.doneCount) return '';
    // 优先用最近 10 秒采样窗口的实测速度：多通道开关/通道增减时吞吐会
    // 动态变化，全程平均会让 ETA 严重滞后；窗口无数据时回退全程平均
    var speed = 0;
    if (st.speedSamples && st.speedSamples.length) {
        var sum = 0;
        for (var i = 0; i < st.speedSamples.length; i++) sum += st.speedSamples[i];
        speed = sum / st.speedSamples.length;
    }
    if (speed <= 0) {
        var elapsed = (Date.now() - st.startTime) / 1000;
        if (elapsed <= 0) return '';
        speed = st.bytesDone / elapsed;
    }
    var totalBytes = 0;
    uploadTasks.forEach(function(t) { totalBytes += t.blob.size; });
    var remainingBytes = Math.max(0, totalBytes - st.bytesDone);
    var remainingTasks = uploadTasks.length - st.doneCount;
    var transferTime = speed > 0 ? remainingBytes / speed : 0;
    var avgSmallLatency = st.smallDurCount ? (st.smallDurSum / st.smallDurCount / 1000) : 2;
    var conflictRate = st.conflictCount / Math.max(1, st.doneCount);
    var eta = transferTime
        + remainingTasks * avgSmallLatency * st.smallRatio / Math.max(1, st.limit)
        + conflictRate * remainingTasks * 3;
    return formatEtaText(eta);
}

function updateUploadProgressUI() {
    var st = uploadState;
    if (!st) return;
    var total = uploadTasks.length;
    var percent = total ? Math.min(100, Math.round(((st.doneCount + st.fractionSum) / total) * 100)) : 100;
    updateUploadProgressText(percent, st.speedText, estimateEtaText());
}

function updateUploadProgressText(percent, speedText, etaText) {
    var text = percent + '%';
    if (speedText) text += ' · ' + speedText;
    if (etaText) text += ' · 预计剩余 ' + etaText;
    document.getElementById('progressFill').style.width = percent + '%';
    document.getElementById('progressText').textContent = text;
    // 后台浮泡与持久化快照同步（供刷新后提示）
    if (uploadState) {
        updateBgTask('上传中 ' + text);
        persistBgTask('upload', '上传中 ' + percent + '%');
    }
}

// ---- Git 数据 API 上传管线（根治提交冲突） ----
// contents API 每次写都立即移动 git 引用，并行写必然竞争 409。
// 改为 git 对象模型（与 git 本身一致）：文件内容先以 blob 对象上传
// （POST /git/blobs 不移动引用，任意并行零冲突），全部就绪后用一个
// tree + commit 批量落盘并一次性移动引用——引用竞争点从 N 次降到每批 1 次。
// 未提交的 blob 是悬空对象（不被任何 tree 引用，列表不可见，GitHub 定期回收），
// 停止/失败天然无副作用，无需回退清理。
function gitApiUrl(apiPath, useCf) {
    var p = 'api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + apiPath;
    return useCf ? (CF_PROXY_BASE + p) : ghUrl('https://' + p);
}

// chan：'eo'（同源，EO 注入 key）/ 'cf'（CF 服务端 key）/ 'ext'（外部代理，
// 管理员 key 直传——外部代理不注入鉴权；blob 创建不移动引用，任意并行零冲突）
function putBlobToGitHub(base64Content, onSuccess, onError, onProgress, retries, chan, task) {
    if (retries === undefined) retries = 3;
    if (chan === 'ext') {
        var base = extPickUploadBase();
        if (!base) chan = 'eo';   // 外部代理全部熔断/404 封禁时兜底 EO
        else if (task) task._extBase = base;
    }
    var url;
    if (chan === 'ext') {
        url = task._extBase + 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/git/blobs';
    } else {
        url = gitApiUrl('/git/blobs', chan === 'cf');
    }
    var xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    if (chan === 'eo') applyEoAuth(xhr);
    if (chan === 'ext') xhr.setRequestHeader('Authorization', 'token ' + ulGitKey);
    xhr.setRequestHeader('Content-Type', 'application/json');
    // 部分外部代理对 POST 只接不发（连接挂起）：超时兜底，避免任务永久卡住
    xhr.timeout = 60000;
    xhr.upload.onprogress = function(e) {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = function() {
        if (xhr.status === 201) {
            var sha = null;
            try { sha = JSON.parse(xhr.responseText).sha; } catch (e) {}
            if (sha) {
                onSuccess(sha);
                return;
            }
            onError(xhr.status, xhr.responseText);
            return;
        }
        // 外部代理 404：该镜像大概率不代理 api.github.com，按代理累计计数，
        // 满 5 次永久移出上传通道（只计上传 404，raw 下载 404 不影响）
        if (chan === 'ext' && xhr.status === 404 && task && task._extBase) {
            extNoteUpload404(task._extBase);
        }
        // 5xx/429 等服务端临时错误按网络错误重试；4xx 直接失败
        if ((xhr.status >= 500 || xhr.status === 429) && retries > 0) {
            setTimeout(function() {
                retryInPlace();
            }, 1000);
            return;
        }
        onError(xhr.status, xhr.responseText);
    };
    // 重试产生的新 xhr 挂回 task.xhr：停滞看门狗与停止上传才能中止后续重试
    var retryInPlace = function() {
        var x2 = putBlobToGitHub(base64Content, onSuccess, onError, onProgress, retries - 1, chan, task);
        if (task && x2) task.xhr = x2;
    };
    xhr.onerror = function() {
        if (retries > 0) {
            setTimeout(retryInPlace, 1000 * (4 - retries));
            return;
        }
        onError(0, '');
    };
    xhr.ontimeout = function() {
        // 代理挂起导致的超时按网络错误换源重试
        if (retries > 0) {
            setTimeout(retryInPlace, 1000 * (4 - retries));
            return;
        }
        onError(0, '');
    };
    xhr.onabort = function() {
        // 停滞看门狗主动中止：按网络错误换源重试；用户停止上传时不重试
        if (task && task._wdAbort) {
            task._wdAbort = false;
            if (retries > 0) {
                setTimeout(retryInPlace, 800);
                return;
            }
        }
        onError(0, '');
    };
    xhr.send(JSON.stringify({ content: base64Content, encoding: 'base64' }));
    return xhr;
}

// 批量提交：把一组 {path, sha} blob 作为一个 tree + commit 落盘并移动分支引用。
// 同一批上传的多个组之间链式推进：knownBase 传入上一组提交成功后的新引用，
// 直接以其为基点建树，跳过重新读引用——彻底消除"上一组刚移动引用、下一组
// 却读到旧引用"导致的非快进（non-fast-forward）失败。
// 仅在与其他写入者发生真实竞争（422/409）时才重新读最新引用重来，最多 8 次——
// 每轮重新读取 base tree 再建树，不会丢失他人的并发提交（与 git rebase 同理）。
// 引用类操作固定走 EO（最可靠通道）。onDone(ok, errMsg, newCommitSha)
function commitBlobGroup(blobs, message, knownBase, onDone) {
    var MAX_ATTEMPTS = 8;
    var attempt = 0;
    // 链式基点只用一次：任何失败后的重试都重新读最新引用，保证不基于过期基点空转
    var baseOverride = knownBase || null;

    function api(method, apiPath, body, cb) {
        var xhr = new XMLHttpRequest();
        xhr.open(method, gitApiUrl(apiPath, false), true);
        applyEoAuth(xhr);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function() { cb(xhr.status, xhr.responseText); };
        xhr.onerror = function() { cb(0, ''); };
        xhr.send(body ? JSON.stringify(body) : null);
    }

    function tryOnce() {
        attempt++;
        if (baseOverride) {
            var chained = baseOverride;
            baseOverride = null;
            withBase(chained);
            return;
        }
        // 1. 读最新分支引用（追加时间戳参数，防止任何中间缓存返回过期引用）
        api('GET', '/git/ref/heads/' + DEFAULT_BRANCH + '?_=' + Date.now(), null, function(st1, body1) {
            if (st1 !== 200) return retry(st1, body1, '读取分支引用失败');
            var baseCommit;
            try { baseCommit = JSON.parse(body1).object.sha; } catch (e) {}
            if (!baseCommit) return retry(st1, body1, '解析分支引用失败');
            withBase(baseCommit);
        });
    }

    function withBase(baseCommit) {
        // 2. 读该提交的 base tree
        api('GET', '/git/commits/' + baseCommit, null, function(st2, body2) {
            if (st2 !== 200) return retry(st2, body2, '读取提交失败');
            var baseTree;
            try { baseTree = JSON.parse(body2).tree.sha; } catch (e) {}
            if (!baseTree) return retry(st2, body2, '解析提交失败');
            // 3. 基于最新 tree 建树（同路径自动覆盖旧 blob）
            var treeEntries = blobs.map(function(b) {
                return { path: b.path, mode: '100644', type: 'blob', sha: b.sha };
            });
            api('POST', '/git/trees', { base_tree: baseTree, tree: treeEntries }, function(st3, body3) {
                if (st3 !== 201) return retry(st3, body3, '创建 tree 失败');
                var newTree;
                try { newTree = JSON.parse(body3).sha; } catch (e) {}
                if (!newTree) return retry(st3, body3, '解析 tree 失败');
                // 4. 创建提交
                api('POST', '/git/commits', { message: message, tree: newTree, parents: [baseCommit] }, function(st4, body4) {
                    if (st4 !== 201) return retry(st4, body4, '创建提交失败');
                    var newCommit;
                    try { newCommit = JSON.parse(body4).sha; } catch (e) {}
                    if (!newCommit) return retry(st4, body4, '解析提交失败');
                    // 5. 移动分支引用（全程唯一的引用竞争点）
                    api('PATCH', '/git/refs/heads/' + DEFAULT_BRANCH, { sha: newCommit }, function(st5, body5) {
                        if (st5 === 200) {
                            onDone(true, null, newCommit);
                            return;
                        }
                        retry(st5, body5, '更新分支引用失败');
                    });
                });
            });
        });
    }

    function retry(status, body, stepLabel) {
        var refMoved = status === 422 || status === 409;
        if ((refMoved || status === 0 || status >= 500) && attempt < MAX_ATTEMPTS) {
            setTimeout(tryOnce, 1000 * attempt + Math.floor(Math.random() * 800));
            return;
        }
        var msg = stepLabel + '（状态码 ' + status + '）';
        try {
            var err = JSON.parse(body);
            if (err.message) msg = stepLabel + ': ' + err.message;
        } catch (e) {}
        onDone(false, msg);
    }

    tryOnce();
}

document.addEventListener('DOMContentLoaded', function() {
    // Set the title from the URL immediately so a subfolder page never
    // flashes a generic/404 title while the file list is loading.
    var initPath = getCurrentPath();
    var pageTitleEl = document.getElementById('pageTitle');
    if (initPath === '') {
        pageTitleEl.textContent = 'Home';
        document.title = 'Home - boring_student';
    } else {
        var initName = displayName(initPath.split('/').pop());
        pageTitleEl.textContent = initName;
        document.title = initName + ' - boring_student';
    }

    updateBreadcrumbs();
    updateAuthBtn();
    initPwdEyes();

    // 后台任务浮泡：点击恢复任务界面；✕ 仅关闭提示（不中断任务）
    document.getElementById('bgTaskBubble').addEventListener('click', function(e) {
        if (e.target.id === 'bgTaskClose') return;
        if (bgTaskRestore) {
            var fn = bgTaskRestore;
            document.getElementById('bgTaskBubble').style.display = 'none';
            fn();
        }
    });
    document.getElementById('bgTaskClose').addEventListener('click', function(e) {
        e.stopPropagation();
        clearBgTask();
    });
    restoreBgTaskHint();
    dlUpdateCurUi();

    // 点击服务状态角标立即重新检测（检测中再点则中止当前轮重新检测）
    document.getElementById('svcStatus').addEventListener('click', function() {
        checkSvcStatus(true);
    });

    // 全部资源与请求同源，无需预取配置/凭据，直接首屏加载与服务检测
    loadFileList();
    checkSvcStatus();

    var dropZone = document.getElementById('dropZone');
    dropZone.addEventListener('click', function() {
        document.getElementById('fileInput').click();
    });
    dropZone.addEventListener('dragover', function(e) {
        e.preventDefault();
        dropZone.style.background = 'rgba(44, 130, 201, 0.1)';
    });
    dropZone.addEventListener('dragleave', function(e) {
        e.preventDefault();
        dropZone.style.background = '';
    });
    dropZone.addEventListener('drop', handleDrop);
    document.getElementById('pickFileBtn').addEventListener('click', function() {
        document.getElementById('fileInput').click();
    });
    document.getElementById('pickFolderBtn').addEventListener('click', function() {
        document.getElementById('folderInput').click();
    });
    document.getElementById('fileInput').addEventListener('change', function() {
        handleFileInput(this);
    });
    document.getElementById('folderInput').addEventListener('change', function() {
        handleFileInput(this);
    });
    document.getElementById('chunkPanelToggle').addEventListener('click', function() {
        var list = document.getElementById('chunkList');
        var open = list.style.display !== 'none';
        list.style.display = open ? 'none' : 'block';
        document.getElementById('chunkPanelArrow').textContent = open ? '▸' : '▾';
    });
    document.getElementById('speedPanelToggle').addEventListener('click', function() {
        var graph = document.getElementById('speedGraph');
        var legend = document.getElementById('speedLegend');
        var open = graph.style.display !== 'none';
        graph.style.display = open ? 'none' : 'block';
        legend.style.display = open ? 'none' : 'flex';
        document.getElementById('speedPanelArrow').textContent = open ? '▸' : '▾';
        if (!open) drawSpeedGraph();
    });
    document.getElementById('taskProgressCancel').addEventListener('click', function() {
        if (taskProgressCancelFn) taskProgressCancelFn();
    });
    // 点击页面其他位置关闭用户头像二级菜单
    document.addEventListener('click', function(e) {
        var w = document.getElementById('userMenuWrap');
        if (w && !w.contains(e.target)) closeUserMenu();
    });
    document.getElementById('taskDlConc').addEventListener('change', function() {
        var custom = this.value === 'custom';
        document.getElementById('taskDlConcCustom').style.display = custom ? '' : 'none';
        dlSetMode(custom ? document.getElementById('taskDlConcCustom').value : this.value);
    });
    document.getElementById('taskDlConcCustom').addEventListener('input', function() {
        dlSetMode(this.value);
    });
    // 外部多代理开关：开启时从 /api/proxies 拉取可用代理列表（只含探测可用的），
    // 状态持久化，下次打开自动恢复
    document.getElementById('taskDlExtBtn').addEventListener('click', function() {
        var btn = this;
        if (extProxyState.enabled) {
            extProxySetEnabled(false);
            btn.classList.remove('active');
            showToast('已关闭外部多代理下载');
            setTimeout(hideToast, 2000);
            return;
        }
        btn.classList.add('active');
        showToast('正在获取可用外部代理...');
        setTimeout(hideToast, 2000);
        extProxySetEnabled(true);
    });
    extProxyRestore();
    // EO/CF 下载通道开关：与并行数一样实时生效（新调度立即避开已关闭通道），
    // 状态持久化；最后一个可用通道不允许关闭
    dlChanSwitchLoad();
    dlChanBtnRefresh();
    [['taskDlEoBtn', 'eo'], ['taskDlCfBtn', 'cf']].forEach(function(pair) {
        document.getElementById(pair[0]).addEventListener('click', function() {
            if (!dlChanToggle(pair[1])) {
                showToast('至少保留一个下载通道');
                setTimeout(hideToast, 2000);
                return;
            }
            dlChanBtnRefresh();
        });
    });
    // 上传通道开关（EO/CF/外部）：实时生效（新任务立即避开已关闭通道）；
    // 外部通道仅管理员可开（需取得 /api/gitkey 下发的 key 与可用代理列表）
    ulChanSwitchLoad();
    ulChanBtnRefresh();
    [['ulEoBtn', 'eo'], ['ulCfBtn', 'cf'], ['ulExtBtn', 'ext']].forEach(function(pair) {
        document.getElementById(pair[0]).addEventListener('click', function() {
            var ok = ulChanToggle(pair[1], function(success, msg) {
                if (msg) {
                    showToast(msg);
                    setTimeout(hideToast, 3000);
                }
                ulChanBtnRefresh();
                updateUlLegendExtVisibility();
            });
            if (!ok) {
                showToast('至少保留一个上传通道');
                setTimeout(hideToast, 2000);
            }
        });
    });
    document.getElementById('taskDlGraphToggle').addEventListener('click', function() {
        var graph = document.getElementById('taskDlGraph');
        var legend = document.getElementById('taskDlLegend');
        var open = graph.style.display !== 'none';
        graph.style.display = open ? 'none' : 'block';
        legend.style.display = open ? 'none' : 'flex';
        this.classList.toggle('active', !open);
        if (!open) drawDlGraph();
    });
    document.getElementById('batchSelectAllBtn').addEventListener('click', selectAllFiles);
    document.getElementById('batchInvertBtn').addEventListener('click', invertSelection);
    document.getElementById('batchDownloadBtn').addEventListener('click', batchDownload);
    document.getElementById('batchStopBtn').addEventListener('click', stopBatchDownload);
    document.getElementById('concurrencySelect').addEventListener('change', function() {
        document.getElementById('concurrencyCustom').style.display = this.value === 'custom' ? '' : 'none';
        // apply immediately to an in-progress upload
        applyConcurrencyChange();
    });
    document.getElementById('concurrencyCustom').addEventListener('input', function() {
        applyConcurrencyChange();
    });
    document.getElementById('batchDeleteBtn').addEventListener('click', openBatchDeleteModal);
    document.getElementById('batchCancelBtn').addEventListener('click', clearSelection);
});
