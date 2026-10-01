#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_proxy_ui.py —— GitHub 下载代理站点测速的本地 Web UI（用户手动运行，不接入自动化）

复用 test_proxy_sites.py 的抓取/测速/Excel 逻辑，在浏览器中提供：
  - 一键抓取三个来源站点并去重
  - 实时进度条 + 逐站点结果表格（状态彩色标记、速度条形图、可排序）
  - 可停止测试、完成后导出 Excel

用法：
  python test_proxy_ui.py            # 默认 http://127.0.0.1:8765
  python test_proxy_ui.py 9000       # 指定端口
仅依赖标准库 + test_proxy_sites.py 的 requests/openpyxl。
"""

import json
import os
import sys
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from test_proxy_sites import (
    DEFAULT_TEST_FILE, collect_sites, test_site, write_excel, log,
)

# ---------------------------------------------------------------------------
# 全局测试状态
# ---------------------------------------------------------------------------

_state_lock = threading.Lock()
_stop_event = threading.Event()
STATE = {
    'running': False,
    'phase': 'idle',        # idle / fetching / testing / done / stopped
    'total': 0,
    'done': 0,
    'ok': 0, 'timeout': 0, 'error': 0,
    'results': [],          # 每元素同 test_site 返回 + sources
    'excel': '',            # 生成的 xlsx 文件名
    'started_at': 0.0,
    'size_mb': 20,
    'test_file': DEFAULT_TEST_FILE,
    'message': '',
}


def _reset_state(size_mb, test_file):
    with _state_lock:
        STATE.update({
            'running': True, 'phase': 'fetching', 'total': 0, 'done': 0,
            'ok': 0, 'timeout': 0, 'error': 0, 'results': [], 'excel': '',
            'started_at': time.time(), 'size_mb': size_mb,
            'test_file': test_file, 'message': '',
        })


def _snapshot():
    with _state_lock:
        snap = dict(STATE)
        snap['results'] = sorted(
            STATE['results'],
            key=lambda r: ({'ok': 0, 'timeout': 1, 'error': 2}[r['status']],
                           -r['speed_mbps']),
        )
        snap['elapsed'] = round(time.time() - STATE['started_at'], 1) if STATE['started_at'] else 0
        return snap


def run_test(size_mb, workers, limit, test_file):
    """后台线程：抓取 → 逐站测速 → 生成 Excel。"""
    try:
        _reset_state(size_mb, test_file)
        _stop_event.clear()

        site_sources = collect_sites()
        if limit > 0:
            site_sources = dict(list(site_sources.items())[:limit])
        with _state_lock:
            STATE['total'] = len(site_sources)
            STATE['phase'] = 'testing'
        if not site_sources:
            raise RuntimeError('三个来源均未抓取到站点')

        max_bytes = size_mb * 1024 * 1024
        pool = ThreadPoolExecutor(max_workers=workers)
        futs = {pool.submit(test_site, h, test_file, max_bytes): h for h in site_sources}
        stopped = False
        try:
            for fut in as_completed(futs):
                if _stop_event.is_set():
                    stopped = True
                    break
                h = futs[fut]
                try:
                    r = fut.result()
                except Exception as e:
                    r = {'host': h, 'status': 'error', 'http': '', 'ttfb_ms': '',
                         'bytes': 0, 'elapsed_s': '', 'speed_mbps': 0.0,
                         'note': f'{type(e).__name__}: {e}'}
                r['sources'] = sorted(site_sources[h])
                with _state_lock:
                    STATE['results'].append(r)
                    STATE['done'] += 1
                    STATE[r['status']] += 1
        finally:
            if stopped:
                pool.shutdown(wait=False, cancel_futures=True)
            else:
                pool.shutdown(wait=True)

        # 生成 Excel（有部分结果就生成）
        snap = _snapshot()
        excel_name = ''
        if snap['results']:
            excel_name = f'github_proxy_test_{datetime.now():%Y%m%d_%H%M%S}.xlsx'
            out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), excel_name)
            write_excel(snap['results'], test_file, size_mb, out_path)
        with _state_lock:
            STATE['excel'] = excel_name
            STATE['phase'] = 'stopped' if stopped else 'done'
            STATE['running'] = False
            STATE['message'] = '已手动停止，结果为部分数据' if stopped else ''
    except Exception as e:
        with _state_lock:
            STATE['running'] = False
            STATE['phase'] = 'done'
            STATE['message'] = f'出错: {e}'
        log(f'[UI] 测试线程异常: {e}')


# ---------------------------------------------------------------------------
# 页面（内嵌单文件前端）
# ---------------------------------------------------------------------------

PAGE = r'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GitHub 代理测速</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>">
<style>
:root{
  --bg:#0b0f1a; --card:rgba(255,255,255,.045); --border:rgba(255,255,255,.09);
  --txt:#e5e9f2; --dim:#8b93a7; --accent1:#6366f1; --accent2:#22d3ee;
  --ok:#34d399; --warn:#fbbf24; --err:#f87171;
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
  background:var(--bg); color:var(--txt); min-height:100vh; padding:28px 18px 60px;
  background-image:
    radial-gradient(600px 300px at 15% -5%, rgba(99,102,241,.22), transparent 60%),
    radial-gradient(700px 350px at 90% 0%, rgba(34,211,238,.14), transparent 60%);
}
.wrap{max-width:1180px;margin:0 auto}
h1{font-size:26px;font-weight:700;letter-spacing:.5px;
  background:linear-gradient(90deg,var(--accent1),var(--accent2));
  -webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:var(--dim);font-size:13px;margin-top:4px}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;
  padding:18px 20px;backdrop-filter:blur(10px);margin-top:18px}
.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}
.field{display:flex;flex-direction:column;gap:6px}
.field label{font-size:12px;color:var(--dim)}
.field input,.field select{
  background:rgba(255,255,255,.06);border:1px solid var(--border);color:var(--txt);
  border-radius:10px;padding:9px 12px;font-size:13px;outline:none;min-width:120px}
.field input:focus,.field select:focus{border-color:var(--accent1)}
.field input[type=text]{min-width:380px}
select option{background:#141a2b}
.btn{
  border:none;border-radius:10px;padding:10px 22px;font-size:14px;font-weight:600;
  cursor:pointer;color:#fff;transition:transform .12s,box-shadow .12s,opacity .12s;
  background:linear-gradient(90deg,var(--accent1),var(--accent2))}
.btn:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(99,102,241,.35)}
.btn:disabled{opacity:.45;cursor:not-allowed;transform:none;box-shadow:none}
.btn.ghost{background:rgba(255,255,255,.08);border:1px solid var(--border)}
.btn.danger{background:linear-gradient(90deg,#ef4444,#f97316)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-top:18px}
.stat{background:var(--card);border:1px solid var(--border);border-radius:14px;
  padding:14px 16px;text-align:center}
.stat .num{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}
.stat .lbl{font-size:12px;color:var(--dim);margin-top:2px}
.stat.ok .num{color:var(--ok)} .stat.warn .num{color:var(--warn)} .stat.err .num{color:var(--err)}
.progress{height:10px;background:rgba(255,255,255,.07);border-radius:99px;
  overflow:hidden;margin-top:16px;position:relative}
.progress>i{display:block;height:100%;width:0%;border-radius:99px;
  background:linear-gradient(90deg,var(--accent1),var(--accent2));
  transition:width .4s ease;position:relative}
.progress.run>i::after{content:"";position:absolute;inset:0;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);
  animation:shimmer 1.2s infinite}
@keyframes shimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
.meta{display:flex;justify-content:space-between;color:var(--dim);font-size:12px;margin-top:8px}
table{width:100%;border-collapse:collapse;margin-top:6px;font-size:13px}
th,td{padding:9px 10px;text-align:left;border-bottom:1px solid rgba(255,255,255,.06);white-space:nowrap}
th{color:var(--dim);font-size:12px;font-weight:600;position:sticky;top:0;
  background:#12172a;cursor:pointer;user-select:none;z-index:1}
th:hover{color:var(--txt)}
tbody tr{animation:fadein .3s ease}
tbody tr:hover{background:rgba(255,255,255,.04)}
@keyframes fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.host{font-family:Consolas,Menlo,monospace;font-size:12.5px}
.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:12px;font-weight:600}
.pill.ok{background:rgba(52,211,153,.15);color:var(--ok)}
.pill.timeout{background:rgba(251,191,36,.15);color:var(--warn)}
.pill.error{background:rgba(248,113,113,.15);color:var(--err)}
.speedcell{display:flex;align-items:center;gap:8px;min-width:150px}
.sbar{flex:1;height:6px;background:rgba(255,255,255,.08);border-radius:99px;overflow:hidden}
.sbar>i{display:block;height:100%;background:linear-gradient(90deg,var(--accent1),var(--accent2));border-radius:99px}
.note{color:var(--dim);font-size:12px;max-width:260px;overflow:hidden;text-overflow:ellipsis}
.src{color:var(--dim);font-size:11.5px}
.tbl-wrap{max-height:56vh;overflow:auto;border-radius:12px;margin-top:8px}
.empty{color:var(--dim);text-align:center;padding:36px 0;font-size:14px}
.toolbar{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.msg{color:var(--warn);font-size:13px}
a.dl{color:var(--accent2);text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <h1>⚡ GitHub 下载代理测速</h1>
  <div class="sub">抓取 github.qqday.com · github.akams.cn · moretools.app 三来源站点，去重后下载同一文件测速</div>

  <div class="card">
    <div class="controls">
      <div class="field"><label>测速文件 URL</label>
        <input type="text" id="file"></div>
      <div class="field"><label>下载量上限</label>
        <select id="size"><option>10</option><option selected>20</option><option>50</option></select></div>
      <div class="field"><label>并发线程</label>
        <select id="workers"><option>4</option><option selected>8</option><option>16</option><option>32</option></select></div>
      <div class="field"><label>站点上限（0=全部）</label>
        <input type="number" id="limit" value="0" min="0" style="width:110px"></div>
      <button class="btn" id="startBtn">开始测速</button>
      <button class="btn danger" id="stopBtn" disabled>停止</button>
      <button class="btn ghost" id="excelBtn" disabled>导出 Excel</button>
    </div>
    <div class="progress" id="pbar"><i></i></div>
    <div class="meta"><span id="phase">就绪</span><span id="elapsed"></span></div>
  </div>

  <div class="stats">
    <div class="stat"><div class="num" id="sTotal">0</div><div class="lbl">站点总数</div></div>
    <div class="stat"><div class="num" id="sDone">0</div><div class="lbl">已测</div></div>
    <div class="stat ok"><div class="num" id="sOk">0</div><div class="lbl">可用</div></div>
    <div class="stat warn"><div class="num" id="sTmo">0</div><div class="lbl">超时跳过</div></div>
    <div class="stat err"><div class="num" id="sErr">0</div><div class="lbl">失败</div></div>
  </div>

  <div class="card">
    <div class="toolbar">
      <span class="sub">点击表头可排序</span>
      <span class="msg" id="msg"></span>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr>
          <th data-k="_rank">#</th><th data-k="host">站点</th><th data-k="_src">来源</th>
          <th data-k="_st">状态</th><th data-k="http">HTTP</th><th data-k="ttfb_ms">延迟(ms)</th>
          <th data-k="_mb">下载量(MB)</th><th data-k="speed_mbps">速度(MB/s)</th><th>备注</th>
        </tr></thead>
        <tbody id="tb"></tbody>
      </table>
      <div class="empty" id="empty">点击「开始测速」运行测试</div>
    </div>
  </div>
</div>
<script>
const $ = id => document.getElementById(id);
$('file').value = '';
let sortKey = null, sortAsc = false, lastData = null;

const PHASE = {idle:'就绪', fetching:'正在抓取三个来源的站点列表…',
  testing:'测速中…', done:'测试完成', stopped:'已停止（部分结果）'};

async function api(path, opts){
  const r = await fetch(path, opts);
  return r.json();
}

$('startBtn').onclick = async () => {
  const body = {
    size: +$('size').value, workers: +$('workers').value, limit: +$('limit').value || 0,
    file: $('file').value.trim() || undefined,
  };
  const r = await api('/api/start', {method:'POST',
    headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  if (!r.ok) alert(r.error || '启动失败');
};

$('stopBtn').onclick = () => api('/api/stop', {method:'POST'});

$('excelBtn').onclick = () => {
  if (lastData && lastData.excel) location.href = '/api/excel';
};

function esc(s){return String(s ?? '').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
const STXT = {ok:'可用', timeout:'超时', error:'失败'};

function render(d){
  lastData = d;
  $('sTotal').textContent = d.total; $('sDone').textContent = d.done;
  $('sOk').textContent = d.ok; $('sTmo').textContent = d.timeout; $('sErr').textContent = d.error;
  $('phase').textContent = PHASE[d.phase] || d.phase;
  $('elapsed').textContent = d.started_at ? `用时 ${d.elapsed}s` : '';
  $('msg').textContent = d.message || '';
  const pct = d.total ? Math.round(d.done / d.total * 100) : 0;
  $('pbar').className = 'progress' + (d.running ? ' run' : '');
  $('pbar').firstElementChild.style.width = pct + '%';
  $('startBtn').disabled = d.running;
  $('stopBtn').disabled = !d.running;
  $('excelBtn').disabled = !d.excel;

  let rows = d.results.map((r, i) => ({...r, _rank: i + 1,
    _src: (r.sources || []).join('、'), _st: r.status,
    _mb: r.bytes ? +(r.bytes/1048576).toFixed(2) : 0}));
  if (sortKey){
    rows.sort((a, b) => {
      let x = a[sortKey], y = b[sortKey];
      if (typeof x === 'string') x = x || '\uffff';
      if (typeof y === 'string') y = y || '\uffff';
      return (x > y ? 1 : x < y ? -1 : 0) * (sortAsc ? 1 : -1);
    });
  }
  const maxSp = Math.max(1, ...rows.map(r => r.speed_mbps || 0));
  $('tb').innerHTML = rows.map(r => `<tr>
    <td>${r._rank}</td>
    <td class="host">${esc(r.host)}</td>
    <td class="src">${esc(r._src)}</td>
    <td><span class="pill ${r.status}">${STXT[r.status]||r.status}</span></td>
    <td>${esc(r.http)}</td>
    <td>${r.ttfb_ms === '' ? '' : r.ttfb_ms}</td>
    <td>${r._mb || ''}</td>
    <td><div class="speedcell"><span style="min-width:52px">${r.status==='ok' ? r.speed_mbps.toFixed(2) : ''}</span>
      <span class="sbar"><i style="width:${Math.round((r.speed_mbps||0)/maxSp*100)}%"></i></span></div></td>
    <td class="note" title="${esc(r.note)}">${esc(r.note)}</td>
  </tr>`).join('');
  $('empty').style.display = rows.length ? 'none' : '';
}

document.querySelectorAll('th[data-k]').forEach(th => th.onclick = () => {
  const k = th.dataset.k;
  if (sortKey === k) sortAsc = !sortAsc; else { sortKey = k; sortAsc = false; }
  if (lastData) render(lastData);
});

(async function poll(){
  try {
    const d = await api('/api/state');
    if (d.test_file && !$('file').value) $('file').value = d.test_file;
    render(d);
  } catch(e) {}
  setTimeout(poll, 800);
})();
</script>
</body>
</html>
'''


# ---------------------------------------------------------------------------
# HTTP 服务
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = 'ProxyTestUI/1.0'

    def log_message(self, *a):
        pass

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send(self, body, ctype, code=200, extra=None):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/':
            self._send(PAGE.encode('utf-8'), 'text/html; charset=utf-8')
        elif path == '/api/state':
            self._send_json(_snapshot())
        elif path == '/api/excel':
            self._serve_excel()
        else:
            self._send_json({'error': 'not found'}, 404)

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        if path == '/api/start':
            self._handle_start()
        elif path == '/api/stop':
            _stop_event.set()
            self._send_json({'ok': True})
        else:
            self._send_json({'error': 'not found'}, 404)

    def _handle_start(self):
        with _state_lock:
            if STATE['running']:
                self._send_json({'ok': False, 'error': '测试正在进行中'}, 409)
                return
        try:
            length = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(length) or b'{}')
        except Exception:
            body = {}
        size = max(1, min(200, int(body.get('size') or 20)))
        workers = max(1, min(64, int(body.get('workers') or 8)))
        limit = max(0, int(body.get('limit') or 0))
        test_file = (body.get('file') or DEFAULT_TEST_FILE).strip()
        if not test_file.startswith('https://github.com/'):
            self._send_json({'ok': False, 'error': '测速文件必须是 https://github.com/ 开头的 URL'}, 400)
            return
        t = threading.Thread(target=run_test, args=(size, workers, limit, test_file), daemon=True)
        t.start()
        self._send_json({'ok': True})

    def _serve_excel(self):
        with _state_lock:
            name = STATE['excel']
        if not name:
            self._send_json({'error': '尚无测试结果'}, 404)
            return
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), name)
        try:
            with open(path, 'rb') as f:
                data = f.read()
        except OSError:
            self._send_json({'error': '文件不存在'}, 404)
            return
        self._send(data,
                   'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                   extra={'Content-Disposition': f'attachment; filename="{name}"'})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    url = f'http://127.0.0.1:{port}'
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'GitHub 代理测速 UI 已启动: {url}  (Ctrl+C 退出)')
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n已退出')


if __name__ == '__main__':
    main()
