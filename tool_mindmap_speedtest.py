# tool_mindmap_speedtest.py —— 手动运行工具：项目运行结构思维导图生成 + 外部代理站点测速
#
# 不进入 build_eo.py 自动化链，由用户按需手动运行：
#   python tool_mindmap_speedtest.py             # 全部执行（思维导图 + 站点测速）
#   python tool_mindmap_speedtest.py mindmap     # 仅生成思维导图 mindmap.md / mindmap.html
#   python tool_mindmap_speedtest.py speedtest   # 仅站点可用性/测速并输出 Excel
#
# speedtest 可选参数：
#   --size-mb N     下载测试字节量（默认 20MB，达到即断开计算速度）
#   --timeout N     首页可用性/连接超时秒数（默认 10；超时的站点跳过下载测试）
#   --overall N     单站下载总时限秒数（默认 120，超时按已收字节结算并标注）
#   --url URL       覆盖下载测试目标文件（默认一个 >20MB 的 GitHub 发行版文件）
#
# 依赖：Python 3 + pyyaml（思维导图读取 AI-CONTEXT.yaml）+ openpyxl（Excel 输出，
#       缺失时自动回退输出 CSV）：pip install pyyaml openpyxl

import argparse
import csv
import datetime
import os
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# ==================== 测速目标与默认配置 ====================

SPEED_TARGETS = [
    {'name': 'github.qqday.com', 'url': 'https://github.qqday.com/'},
    {'name': 'github.akams.cn', 'url': 'https://github.akams.cn/'},
    {'name': 'moretools GitHub Proxy', 'url': 'https://www.moretools.app/zh-CN/github-proxy'},
]

# 默认下载测试文件：Git for Windows 发行版安装包（约 65MB，远超 20MB 测试量，
# 收到指定字节量即断开，不会下载完整文件）；ghproxy 类站点按 "站点 + 完整 GitHub URL" 拼接
DEFAULT_TEST_FILE = ('https://github.com/git-for-windows/git/releases/download/'
                     'v2.47.0.windows.1/Git-2.47.0-64-bit.exe')

USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) cloud-web-speedtest/1.0'
CTX_FILE = 'AI-CONTEXT.yaml'
MINDMAP_MD = 'mindmap.md'
MINDMAP_HTML = 'mindmap.html'


# ==================== 思维导图生成 ====================

def _cut(text, limit=70):
    """思维导图节点文本截断，保持图面简洁"""
    text = ' '.join(str(text).split())
    return text if len(text) <= limit else text[:limit - 1] + '…'


def build_mindmap_md(ctx):
    """从 AI-CONTEXT.yaml 提取大体运行结构，生成 Markdown 层级大纲"""
    L = ['# cloud-web 运行结构思维导图', '']

    proj = ctx.get('project', {})
    L.append('## 项目概览')
    L.append('- %s' % _cut(proj.get('summary', ''), 90))
    L.append('- 技术栈：%s' % _cut(proj.get('tech_stack', ''), 80))
    for k, v in (proj.get('repos') or {}).items():
        L.append('- 仓库 %s：%s' % (k, _cut(v, 60)))
    L.append('')

    L.append('## 模块架构')
    for m in (ctx.get('architecture', {}).get('modules') or []):
        L.append('- `%s`：%s' % (m.get('name', '?'), _cut(m.get('role', ''), 60)))
    L.append('')

    dataflow_names = {
        'auth': '认证', 'upload': '上传', 'download': '下载', 'preview': '预览',
        'search': '搜索', 'auto_refresh': '自动刷新', 'share': '分享',
    }
    L.append('## 运行数据流')
    for key, cn in dataflow_names.items():
        items = ctx.get('dataflow', {}).get(key)
        if not items:
            continue
        L.append('- **%s**' % cn)
        for it in items:
            L.append('  - %s' % _cut(it, 80))
    L.append('')

    api = ctx.get('api', {})
    L.append('## 接口结构')
    L.append('- 页面路由')
    for it in api.get('page_routes') or []:
        L.append('  - %s' % _cut(it, 70))
    L.append('- 公开接口')
    for it in api.get('public_apis') or []:
        L.append('  - %s' % _cut(it, 70))
    L.append('- 管理接口')
    for it in api.get('admin_apis') or []:
        L.append('  - %s' % _cut(it, 70))
    L.append('- 代理路径')
    for it in api.get('proxy_paths') or []:
        L.append('  - %s' % _cut(it, 70))
    L.append('')

    groups = ctx.get('frontend', {}).get('function_groups') or {}
    L.append('## 前端功能组')
    for pat, desc in groups.items():
        L.append('- `%s`：%s' % (pat, _cut(desc, 60)))
    L.append('')

    wf = ctx.get('workflow', {})
    L.append('## 构建与工作流')
    L.append('- 自动链：%s' % _cut(wf.get('auto_pipeline', ''), 100))
    for it in wf.get('manual_steps') or []:
        L.append('- %s' % _cut(it, 70))
    L.append('')

    L.append('## 外部依赖')
    for it in ctx.get('dependencies', {}).get('runtime_external') or []:
        L.append('- %s' % _cut(it, 70))
    L.append('')
    return '\n'.join(L)


MINDMAP_HTML_TPL = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>cloud-web 运行结构思维导图</title>
<style>
  html, body { margin: 0; height: 100%; }
  #mm { width: 100vw; height: 100vh; }
  .tip { position: fixed; left: 10px; bottom: 8px; font: 12px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif;
         color: #888; background: rgba(255,255,255,.85); padding: 2px 8px; border-radius: 6px; }
</style>
</head>
<body>
<div class="markmap" id="mm">
<script type="text/template">
__MARKDOWN__
</script>
</div>
<div class="tip">cloud-web 运行结构思维导图 · 由 tool_mindmap_speedtest.py 生成 · 渲染依赖 jsdelivr CDN（需联网）</div>
<script src="https://cdn.jsdelivr.net/npm/markmap-autoloader@0.18"></script>
</body>
</html>
'''


def gen_mindmap():
    import yaml  # pyyaml，项目构建链同款依赖

    if not os.path.exists(CTX_FILE):
        print('[思维导图] 未找到 %s，请先运行 python build_ai_context.py' % CTX_FILE)
        return False
    with open(CTX_FILE, 'r', encoding='utf-8') as f:
        ctx = yaml.safe_load(f.read())

    md = build_mindmap_md(ctx)
    with open(MINDMAP_MD, 'w', encoding='utf-8', newline='\n') as f:
        f.write(md)

    # markmap-autoloader 按 <script type="text/template"> 内 Markdown 渲染为可缩放思维导图；
    # 内容中不可能出现 </script>，直接嵌入即可
    html = MINDMAP_HTML_TPL.replace('__MARKDOWN__', md)
    with open(MINDMAP_HTML, 'w', encoding='utf-8', newline='\n') as f:
        f.write(html)

    print('[思维导图] 已生成 %s 与 %s（浏览器打开 HTML 查看可交互导图，需联网加载 markmap）'
          % (MINDMAP_MD, MINDMAP_HTML))
    return True


# ==================== 站点测速 ====================

class SkipTest(Exception):
    """超时/去重等需跳过下载测试的情形"""


def _resolve_ips(host):
    try:
        infos = socket.getaddrinfo(host, 443, socket.AF_UNSPEC, socket.SOCK_STREAM)
        return sorted({i[4][0] for i in infos})
    except Exception:
        return []


def check_homepage(url, timeout):
    """首页可用性检测：返回 dict(final_url, status, elapsed_ms, html)；超时抛 SkipTest。
    html 保留前 512KB，用于聚合页/导航页自动发现真实代理端点（form action）"""
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            html = resp.read(524288)
            elapsed = (time.monotonic() - t0) * 1000
            return {'final_url': resp.geturl(), 'status': resp.status,
                    'elapsed_ms': round(elapsed), 'html': html}
    except (socket.timeout, TimeoutError):
        raise SkipTest('首页连接超时（>%ds），跳过本站全部测试' % timeout)
    except urllib.error.HTTPError as e:
        # 工具页返回 404/403 也算"站点可达"，记录状态继续后续判定
        elapsed = (time.monotonic() - t0) * 1000
        return {'final_url': url, 'status': e.code, 'elapsed_ms': round(elapsed), 'html': b''}
    except urllib.error.URLError as e:
        reason = str(e.reason)
        if 'timed out' in reason or 'timeout' in reason.lower():
            raise SkipTest('首页连接超时（%s），跳过本站全部测试' % reason)
        raise SkipTest('首页不可达：%s' % reason)


def discover_endpoints(home_html, final_url):
    """从首页 HTML 的 <form action> 发现真实代理端点（绝对 http(s) URL）。
    导航/聚合类站点（如 github.qqday.com）本身不直链，表单提交目标才是代理端点"""
    out, seen = [], set()
    try:
        text = home_html.decode('utf-8', 'replace')
    except Exception:
        return out
    for m in re.findall(r'<form[^>]+action=["\']([^"\']+)', text, re.IGNORECASE):
        u = urllib.parse.urljoin(final_url, m)
        p = urllib.parse.urlparse(u)
        if p.scheme in ('http', 'https') and p.netloc:
            base = '%s://%s/' % (p.scheme, p.netloc)
            if base not in seen:
                seen.add(base)
                out.append(base)
    return out


def download_test(url, max_bytes, connect_timeout, overall_timeout):
    """经代理站点下载测试文件，收到 max_bytes 即断开。
    返回 dict(ttfb_ms, got_bytes, elapsed_s, speed_mbps)；超时/失败抛 SkipTest"""
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    t0 = time.monotonic()
    try:
        resp = urllib.request.urlopen(req, timeout=connect_timeout)
    except (socket.timeout, TimeoutError):
        raise SkipTest('下载连接超时（>%ds）' % connect_timeout)
    except urllib.error.HTTPError as e:
        raise SkipTest('下载请求被拒绝：HTTP %d（该站点可能非 ghproxy 直链形式或不支持此文件）' % e.code)
    except urllib.error.URLError as e:
        raise SkipTest('下载连接失败：%s' % e.reason)

    with resp:
        ctype = (resp.headers.get('Content-Type') or '').lower()
        if 'text/html' in ctype:
            raise SkipTest('返回 HTML 页面而非文件（非直链代理形式），跳过')
        ttfb_ms = round((time.monotonic() - t0) * 1000)
        got = 0
        while got < max_bytes:
            if time.monotonic() - t0 > overall_timeout:
                raise SkipTest('下载总时限超 %ds（已收 %.1fMB，按超时处理跳过）'
                               % (overall_timeout, got / 1048576))
            try:
                chunk = resp.read(min(262144, max_bytes - got))
            except (socket.timeout, TimeoutError):
                raise SkipTest('下载中途读取超时（已收 %.1fMB）' % (got / 1048576))
            except (ConnectionError, ssl.SSLError) as e:
                raise SkipTest('下载中断：%s（已收 %.1fMB）' % (e, got / 1048576))
            if not chunk:
                break  # 文件不足测试量，以实际收到量结算
            got += len(chunk)
        elapsed = time.monotonic() - t0
        if got < 1048576:  # 不足 1MB 视为无效测速（可能是错误页）
            raise SkipTest('收到内容过少（%.1fKB），疑似非文件内容，跳过' % (got / 1024))
        return {
            'ttfb_ms': ttfb_ms,
            'got_bytes': got,
            'elapsed_s': round(elapsed, 2),
            'speed_mbps': round(got / elapsed / 1048576, 2),
        }


def run_speedtest(size_mb, timeout, overall, test_file):
    max_bytes = size_mb * 1048576
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    out_xlsx = '站点测速结果_%s.xlsx' % stamp

    print('[测速] 目标 %d 个站点，下载测试量 %dMB，连接超时 %ds，单站总时限 %ds'
          % (len(SPEED_TARGETS), size_mb, timeout, overall))
    print('[测速] 测试文件：%s' % test_file)

    rows = []
    seen_hosts = {}   # 去重键：重定向后最终 host -> 首个站点名
    seen_ipsets = {}  # 去重键：解析 IP 集合 -> 首个站点名

    for idx, t in enumerate(SPEED_TARGETS, 1):
        name, url = t['name'], t['url']
        row = {'序号': idx, '站点': name, '站点URL': url, '最终URL': '', '解析IP': '',
               '首页状态': '', '首页耗时ms': '', '去重结果': '唯一', '下载端点': '',
               '下载状态': '', '首字节延时ms': '', '下载量MB': '',
               '用时s': '', '平均速度MB/s': '', '备注': ''}
        print('[%d/%d] %s ...' % (idx, len(SPEED_TARGETS), name))

        try:
            home = check_homepage(url, timeout)
        except SkipTest as e:
            row['首页状态'] = '超时/不可达'
            row['下载状态'] = '跳过'
            row['备注'] = str(e)
            print('       首页不可达，跳过：%s' % e)
            rows.append(row)
            continue

        row['最终URL'] = home['final_url']
        row['首页状态'] = 'HTTP %d' % home['status']
        row['首页耗时ms'] = home['elapsed_ms']

        # 去重：按重定向后 host + IP 集合双重判定
        final_host = urllib.parse.urlparse(home['final_url']).netloc.lower()
        ips = _resolve_ips(final_host)
        row['解析IP'] = ', '.join(ips)
        dup_of = seen_hosts.get(final_host)
        if not dup_of and ips:
            dup_of = seen_ipsets.get(tuple(ips))
        if dup_of:
            row['去重结果'] = '与「%s」重复' % dup_of
            row['下载状态'] = '跳过'
            row['备注'] = '重定向后主机/IP 与前序站点相同，去重跳过下载测试'
            print('       与 %s 重复，跳过下载' % dup_of)
            rows.append(row)
            continue
        seen_hosts.setdefault(final_host, name)
        if ips:
            seen_ipsets.setdefault(tuple(ips), name)

        # 首页 2xx/3xx 视为可用；其他状态仍尝试下载但标注
        if home['status'] >= 400:
            row['备注'] = '首页返回 %d，下载测试可能不可用' % home['status']

        # 候选下载端点：站点自身直拼 + 首页表单发现的真实代理端点（去重后依次尝试）
        candidates = [home['final_url'].rstrip('/') + '/']
        for ep in discover_endpoints(home.get('html', b''), home['final_url']):
            if ep not in candidates:
                candidates.append(ep)

        errors = []
        for base in candidates:
            ep_host = urllib.parse.urlparse(base).netloc.lower()
            if ep_host != final_host:  # 站点自身直拼不做去重；仅发现的第三方端点参与去重
                ep_dup = seen_hosts.get(ep_host)
                if ep_dup:
                    errors.append('端点 %s 与「%s」重复，跳过' % (ep_host, ep_dup))
                    continue
            try:
                r = download_test(base + test_file, max_bytes, timeout, overall)
            except SkipTest as e:
                errors.append('%s -> %s' % (ep_host, e))
                continue
            seen_hosts.setdefault(ep_host, name)
            row['下载端点'] = base
            row['下载状态'] = '成功'
            row['首字节延时ms'] = r['ttfb_ms']
            row['下载量MB'] = round(r['got_bytes'] / 1048576, 1)
            row['用时s'] = r['elapsed_s']
            row['平均速度MB/s'] = r['speed_mbps']
            print('       成功（端点 %s）：延时 %dms，%.2f MB/s' % (ep_host, r['ttfb_ms'], r['speed_mbps']))
            break
        else:
            row['下载状态'] = '跳过'
            note = '；'.join(errors) if errors else '无可用下载端点'
            row['备注'] = (row['备注'] + '；' if row['备注'] else '') + note
            print('       下载测试跳过：%s' % note)
        rows.append(row)

    out = write_excel(rows, out_xlsx, test_file, size_mb, timeout, overall)
    print('[测速] 结果已输出：%s' % out)
    return True


# ==================== Excel / CSV 输出 ====================

HEADERS = ['序号', '站点', '站点URL', '最终URL', '解析IP', '首页状态', '首页耗时ms',
           '去重结果', '下载端点', '下载状态', '首字节延时ms', '下载量MB', '用时s', '平均速度MB/s', '备注']


def write_excel(rows, out_xlsx, test_file, size_mb, timeout, overall):
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
        from openpyxl.utils import get_column_letter
    except ImportError:
        out_csv = out_xlsx[:-5] + '.csv'
        with open(out_csv, 'w', encoding='utf-8-sig', newline='') as f:
            w = csv.DictWriter(f, fieldnames=HEADERS)
            w.writeheader()
            w.writerows(rows)
        print('[测速] 未安装 openpyxl（pip install openpyxl），已回退输出 CSV')
        return out_csv

    wb = Workbook()
    ws = wb.active
    ws.title = '测速结果'

    thin = Border(*[Side(style='thin', color='B0B0B0')] * 4)
    head_fill = PatternFill('solid', fgColor='2F5597')
    ok_fill = PatternFill('solid', fgColor='C6EFCE')
    skip_fill = PatternFill('solid', fgColor='D9D9D9')
    warn_fill = PatternFill('solid', fgColor='FFEB9C')

    ws.append(HEADERS)
    for c in ws[1]:
        c.font = Font(bold=True, color='FFFFFF')
        c.fill = head_fill
        c.alignment = Alignment(horizontal='center', vertical='center')
        c.border = thin

    for r in rows:
        ws.append([r[h] for h in HEADERS])

    for i, r in enumerate(rows, start=2):
        fill = None
        if r['下载状态'] == '成功':
            fill = ok_fill
        elif r['下载状态'] == '跳过':
            fill = skip_fill if r['首页状态'] in ('超时/不可达', '') or '重复' in r['去重结果'] else warn_fill
        for j in range(1, len(HEADERS) + 1):
            c = ws.cell(row=i, column=j)
            c.border = thin
            c.alignment = Alignment(vertical='center', wrap_text=(j in (3, 4, 5, 9, 15)))
            if fill and j in (2, 10, 11, 14):
                c.fill = fill

    widths = [5, 22, 40, 40, 30, 14, 11, 16, 28, 9, 12, 10, 8, 14, 50]
    for j, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(j)].width = w
    ws.freeze_panes = 'A2'
    ws.auto_filter.ref = 'A1:%s%d' % (get_column_letter(len(HEADERS)), len(rows) + 1)

    ws2 = wb.create_sheet('测试说明')
    info = [
        ('测试时间', datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')),
        ('测试文件', test_file),
        ('下载测试量', '%d MB（收到即断开，不下完整文件）' % size_mb),
        ('连接超时', '%d 秒（首页超时的站点跳过全部测试）' % timeout),
        ('单站下载总时限', '%d 秒（超时按跳过处理）' % overall),
        ('去重规则', '按首页重定向后主机名与解析 IP 集合双重判定，重复站点跳过下载测试'),
        ('速度口径', '平均速度 = 已收字节 / 全程耗时（含建连与首字节延时）'),
        ('生成工具', 'tool_mindmap_speedtest.py（手动运行，不属于自动化构建链）'),
    ]
    for k, v in info:
        ws2.append([k, v])
    ws2.column_dimensions['A'].width = 16
    ws2.column_dimensions['B'].width = 90
    for row in ws2.iter_rows(min_row=1, max_row=len(info), max_col=2):
        row[0].font = Font(bold=True)
        row[1].alignment = Alignment(wrap_text=True, vertical='center')

    wb.save(out_xlsx)
    return out_xlsx


# ==================== 入口 ====================

def main():
    ap = argparse.ArgumentParser(description='项目思维导图生成 + 外部代理站点测速（手动运行工具）')
    ap.add_argument('mode', nargs='?', default='all', choices=['all', 'mindmap', 'speedtest'],
                    help='all=全部（默认）；mindmap=仅思维导图；speedtest=仅站点测速')
    ap.add_argument('--size-mb', type=int, default=20, help='下载测试字节量 MB（默认 20）')
    ap.add_argument('--timeout', type=int, default=10, help='连接/首页超时秒数（默认 10）')
    ap.add_argument('--overall', type=int, default=120, help='单站下载总时限秒数（默认 120）')
    ap.add_argument('--url', default=DEFAULT_TEST_FILE, help='下载测试目标文件 URL')
    args = ap.parse_args()

    ok = True
    if args.mode in ('all', 'mindmap'):
        ok = gen_mindmap() and ok
    if args.mode in ('all', 'speedtest'):
        ok = run_speedtest(args.size_mb, args.timeout, args.overall, args.url) and ok
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
