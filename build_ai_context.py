# build_ai_context.py —— 生成 AI-CONTEXT.yaml（AI 专用项目理解文件）
#
# 目的：让其他 AI 系统仅读本文件即可获取项目核心架构、模块、数据流、接口、
# 配置、依赖与业务规则，无需重新扫描源码。
#
# 构成 = 静态章节（本脚本内 dict，业务规则变化时改这里）+ 自动扫描章节
# （路由/函数/常量/文件清单/git commit，实时从仓库提取）。
#
# 用法：
#   python build_ai_context.py     # 重建 AI-CONTEXT.yaml 并自校验（回读 + 必备键检查）
# 依赖：Python 3 + pyyaml（pip install pyyaml）

import datetime
import hashlib
import os
import re
import subprocess

import yaml

SCHEMA_VERSION = 1
OUT_FILE = 'AI-CONTEXT.yaml'


class Lit(str):
    """多行字符串按 YAML 字面块（|）输出，保持 ASCII 图可读"""


def lit_representer(dumper, data):
    return dumper.represent_scalar('tag:yaml.org,2002:str', data, style='|')


yaml.add_representer(Lit, lit_representer)


# ==================== 静态章节 ====================

PROJECT = {
    'name': 'cloud-web',
    'summary': '基于 GitHub 仓库作存储后端的网页版网盘；全站一体部署于腾讯云 EdgeOne（EO）边缘函数：'
               'eo.js 单文件同时提供前端页面、静态资源、认证用户 API、GitHub 代理与下载中转；'
               '浏览器一切请求与站点同源，GitHub key 只存于 EO 服务端永不下发',
    'tech_stack': '零依赖、零框架、零 npm：前端原生 JS+CSS+单 HTML 模板；后端 EO 边缘函数 JS；'
                  '构建脚本 Python 3；可选 CF Worker 加速通道',
    'repos': {
        'code': 'boringstudent/cloud-web（本仓库）',
        'storage': 'boringstudent/cloud-storage（网盘文件存储，构建时 CLOUD 环境变量可覆盖）',
        'user_data': 'boringstudent/cloud-user（user.json 用户数据，代理白名单永久拒绝 403）',
    },
}

ARCHITECTURE = {
    'modules': [
        {'name': 'build_eo.py', 'role': 'EO 一体化构建脚本：后端模板(BACKEND 字符串)+前端资源烘焙为单文件 eo.js，生成后自动 node --check 并同步 404.html'},
        {'name': 'eo.js', 'role': '构建产物（gitignore）：EdgeOne 边缘函数，页面/资源/API/代理全同源提供'},
        {'name': 'template.html', 'role': '唯一 HTML 模板（Python str.format，内联启动参数需双大括号转义）'},
        {'name': '404.html', 'role': 'template.html 的构建时同步副本'},
        {'name': 'static/app.js', 'role': '全部前端逻辑（普通 JS，无模板转义）'},
        {'name': 'static/style.css', 'role': '全部样式（背景图浏览器直连图床，不经 EO）'},
        {'name': 'cf-worker.js', 'role': 'CF 加速通道源码（部署 cloud-ecr.pages.dev）：GitHub 全站反向代理 + 服务端 GITHUB_TOKEN 注入 + /ip 出口 IP'},
        {'name': 'test_eo_smoke.js', 'role': 'eo.js 本地冒烟测试（Node 模拟 fetch 事件，44 项断言，不触网）'},
        {'name': 'test_eo_server.js', 'role': 'eo.js 本地模拟服务器（端到端预览）'},
        {'name': 'API.md / README.md', 'role': '人类文档：接口全集 / 功能与算法说明'},
    ],
    'dataflow_ascii': Lit(
        '浏览器\n'
        '  |-- 同源 --> EO eo.js --+-- /api/login|users|change-*  --> GitHub boringstudent/cloud-user user.json\n'
        '  |                       +-- /api.github.com/ | /raw.githubusercontent.com/ | /github.com/（白名单代理，服务端注入 key）--> GitHub boringstudent/cloud-storage\n'
        '  |                       +-- /api/hash|proxies|my-ip|cf-ip|bg（公开接口）--> cip.cc / api.ip.sb / ipinfo.io / 图床\n'
        '  |-- CF 加速通道 --> cloud-ecr.pages.dev (cf-worker.js，注入 GITHUB_TOKEN) --> GitHub\n'
        '  |-- 外部多代理（仅下载）--> 28 个公共 ghproxy 镜像（浏览器侧实测可用性）\n'
        '  +-- 背景图直连 loliapi 图床（不经 EO）'
    ),
}

DATAFLOW = {
    'auth': [
        '浏览器 crypto.subtle 计算密码 SHA-512（128hex），明文不出浏览器',
        'POST /api/login（强制实时读 user.json 比对，无缓存）→ 返回 {success, username, role, avatar}',
        'localStorage cloud_web_auth 存 {用户名,哈希,角色,头像}，会话始终持久化',
        '写操作请求头携带 X-Auth-User / X-Auth-Pass（缓存哈希），EO 逐请求实时校验（鉴权读 60s 实例级缓存，写后即时刷新）',
        'admin 接口用 admin_user/admin_pass（同哈希），服务端校验 role=admin',
    ],
    'upload': [
        '文件按 CHUNK_SIZE_LEVELS（45MB/30MB，按 base64 后不超 GitHub 单文件限制反算）分片，too large 自动降档续传',
        '传输阶段：POST /git/blobs 纯对象创建（不动引用，任意并行零冲突）；分片预读缓存领先调度 2 个任务',
        '提交阶段：每 COMMIT_GROUP_SIZE=100 个 blob 合成 tree+commit 批量落盘；组间链式推进（上一组新引用直接作下一组基点）',
        '引用被抢先（422/409）：先读最新引用校验是否实际已成功（响应丢失），否则从最新引用重建 tree 重试，最多 12 次（300ms 快重试→1.6 倍退避封顶 5s+抖动）',
        '通道：EO/CF 双通道按在途均衡+实测速率加权分配（15% 概率地板）；开始前探测 CF 写能力（仅 400/422 视为可写）',
        '自适应并行：初始 3 上限 8；分片 <15s 升档 >45s 降档；每 2 次提交冲突降档，连续 8 个无冲突升档',
        '停止/失败无副作用：未提交 blob 为悬空对象，GitHub 自动回收，无需回退',
    ],
    'download': [
        '大文件 >2MB 分段滚动调度（段数不少于并发限制、最小 1MB/段），EO/CF 间在途均衡+速率加权分配，失败换源从已收位置 Range 续传，CF 连续失败 2 次熔断回退 EO',
        '外部多代理（可选，默认载体）：/api/proxies?all=1 拿 28 候选后浏览器侧逐个实测（探测本仓库 raw 文件 xxx.json，简单 GET 防 CORS 预检，要求 2xx 且内容匹配防劫持假 200）；承担约 80% 任务，EO/CF 各保 25% 份额地板；EO/CF 默认关闭且外部可用时各限 ×3 在途',
        '代理熔断：连续失败 2 次轮换，成功即清零+2 分钟未失败自愈；站点级异常慢 3 次冷却 30 秒；单分段外部尝试封顶 2 次后回 EO/CF 保底；416 从 Content-Range 自我修正',
        '批量下载：文件级并行池+池内共享全局连接预算（工作窃取），完成经保存队列串行吐出（间隔 400ms 规避浏览器限流）',
        '文件夹打包：git tree 收集（分片归并）→ 并行池拉取 → 前端 zip（store 不压缩，UTF-8 文件名，8MB 切片算 CRC 并让出主线程）',
        '护栏：下载在途字节 >256MB / 上传 >300MB 暂停派发；15 秒停滞看门狗中止换源',
    ],
    'preview': [
        '视频/音频：URL 直接交媒体元素 Range 边下边播；打开时三通道按 1MB 分段连续探测测速（每通道上限 8MB），播放或出错即停止',
        '分片音视频：合并管线逐片就绪即以前缀 blob 起播（moov 在尾无法解码则等完整合并），完成自动切完整文件恢复进度/音量/倍速；>16MB 分片按 8MB 子段拆分；>2MB 未分片走 4MB 虚拟分片同管线',
        '图片：fetch 流式渐进渲染；>512KB 且支持 206 切 4 段并行（EO/CF/外部加权，失败续传≤3 次），只渲染已连续前缀',
        '文本：透明 textarea 叠加高亮层在线编辑；右侧鸟瞰图（行密度缩略+视口框）',
        'Markdown：默认渲染预览（标题/列表/引用/代码块/GFM 表格/链接/图片），可切纯文本',
    ],
    'search': [
        '搜索范围=当前目录（含子目录，根目录即全盘），切换目录保留词并重搜',
        '复用 git 全量文件树缓存按路径子串匹配（不区分大小写，≤200 条），分片按基名归并',
        '350ms 防抖或搜索按钮立即搜；有词时 45s 轮询改为刷新搜索结果',
        '清空恢复目录列表：检测视图为搜索结果即强制用缓存体全量重渲染（修 304 跳过渲染卡搜索页）',
    ],
    'auto_refresh': [
        '每 REFRESH_INTERVAL=45s 自动刷新文件列表，标题右侧倒计时；标签页隐藏暂停、恢复立即刷新',
        '增量渲染：按 key diff 仅更新变化项（大小文本高亮闪烁、增删带过渡动画）；首屏分批渲染 LIST_RENDER_BATCH=40 条/批（逐条 appendChild，见 constraints）',
        'ETag 条件请求（304 不占速率限制）；变更操作后 15s 缓存穿透窗口附加时间戳',
    ],
    'share': [
        'makeShareUrl：{v:1, items:[{p:路径,n:名称,t:类型,s:大小}], ts} JSON → b64url 编码 → {origin}/s/<b64url>，纯前端无服务端存储',
        '复制外链=copyShareLink 直复制不弹窗（copyTextToClipboard+toast）；二维码=openQrModal 只显示二维码（qrMakeCanvas 本地生成）；右键菜单/批量栏（复制链接+二维码按钮）均可发起',
        'isSharePage（路径 /s/ 前缀）→ renderSharePage：b64url 解码还原清单，隐藏网盘 UI 展示无图标下载页（loadFileList 已守卫 isSharePage 防自动刷新冲突）；损坏链接显示错误提示',
        '分享页下载：访客无通道偏好，renderSharePage 自动启用 EO/CF/外部多代理（仅内存态不写偏好）；下载前先 fetchFileTree——单文件分片走 downloadMergedFile 合并还原、普通文件走 downloadFile 多通道 blob 保存（手机端不再变在线预览）；多文件/文件夹经 shareCollectZipModels 展开目录+归并分片后 downloadFolderZip 打包',
        'QR 码前端零依赖生成（qrGenerate：byte 模式/级别 M/版本 1-40/8 掩码惩罚评估），不经服务端',
    ],
}

CONFIG = {
    'build': {
        'GITHUB_KEY': '环境变量，GitHub 写 key（优先级 1）',
        '.eo-key': '项目根目录文件（gitignore，优先级 2）；都没有则生成脱敏版（占位符 key）',
        'USER_REPO': '用户数据仓库，默认 boringstudent/cloud-user',
        'CLOUD': '网盘存储仓库，默认 boringstudent/cloud-storage',
        'BRANCH': '分支，默认 main',
    },
    'localstorage_keys': {
        'cloud_web_auth': '登录会话 {username,hash,role,avatar}（始终持久化）',
        'cloud_web_remember': '记住密码（默认勾选，只存 SHA-512 哈希，旧版明文自动迁移）',
        'cloud_web_theme': '主题 auto/light/dark',
        'cloud_web_lang': '语言 zh-CN/zh-TW/en/ja',
        'cloud_web_ext_proxy': '外部多代理下载开关',
        'cloud_web_dl_chans_v2': '下载通道开关 eo/cf（默认均 false）',
        'cloud_web_ul_chans': '上传通道开关 eo/cf',
        'cloud_web_bgtask': '后台任务快照（刷新后提示已中断）',
        'cloud_web_audio_pl_mode': '音频播放列表模式 single/sequence/shuffle',
    },
    'security_headers': {
        'CSP': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
               "img-src 'self' data: blob: https:; media-src 'self' blob: https:; "
               "connect-src 'self' https://cloud-ecr.pages.dev https:; font-src 'self' data:; "
               "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
        'cache': '页面不缓存；JS/CSS 按构建时间戳 ?v= 长缓存 immutable',
    },
    'user_json_format': '{ "<username>": { "password": "<sha512>", "role": "admin|user", "avatar": "<可选URL>" } }',
}

API = {
    'full_doc': 'API.md（完整接口文档）',
    'base': '与站点同源（EO 边缘函数绑定域名），统一 JSON 返回，支持 CORS',
    'password_rule': '只接受前端算好的 SHA-512（128hex），明文一律 400；存储仅哈希不可逆',
    'page_routes': [
        'GET / 及任意未命中子路径 → SPA 主页面（路径即目录），带 CSP，不缓存',
        'GET /static/app.js | /static/style.css → 构建时嵌入资源（?v= 版本戳，immutable 长缓存）',
        'GET /favicon.ico → 站点图标',
    ],
    'public_apis': [
        'GET/POST /api/hash → SHA-512 哈希（type=password|key & value=）',
        'GET/HEAD /api/my-ip（别名 /ip）→ 服务器出口 IP/归属地（cip.cc，8s 超时）',
        'GET/HEAD /api/cf-ip → CF 通道出口 IP/归属地（EO 经 CF /ip 取 IP 再查 api.ip.sb→ipinfo.io，缓存 5min）',
        'GET/HEAD /api/proxies → 可用外部代理（服务端探测，缓存 5min）；?all=1 全量候选 28 个不触网；?probe=api EO 视角全量诊断',
        'GET/POST /api/login → 登录（实时比对，返回 role/avatar，不返回任何 key）',
        'POST /api/change-password → 自助改密（旧/新哈希）',
        'POST /api/change-avatar → 自助改头像 URL（http/https ≤300 字符，空串清除）',
        'POST /api/delete-account → 自助注销（验哈希后永久删除）',
        'GET /api/bg → 背景图中转（仅 image/*，10s 超时，短缓存 300s；前端实际直连图床）',
    ],
    'admin_apis': [
        'GET /api/users → 全部用户（密码脱敏 ***）',
        'POST /api/users → 添加用户（哈希直存，avatar 可选）',
        'PUT/PATCH /api/users/:username → 改密码/角色/头像（至少一项）',
        'DELETE /api/users/:username → 删除用户（参数放 body）',
    ],
    'proxy_paths': [
        '* /api.github.com/repos/<owner>/<repo>/<path> → GitHub REST API 代理（读公开，写需 X-Auth-*）',
        'GET /raw.githubusercontent.com/<owner>/<repo>/<branch>/<path> → raw 下载中转（206 断点续传）',
        'GET /github.com/<owner>/<repo>/archive/<ref>.zip → 整仓打包中转（跟随 codeload）',
    ],
    'proxy_rules': [
        '仅放行白名单 STORAGE_REPOS，其余 403；用户数据仓库永久 403',
        'Authorization: Bearer <key> 服务端注入；仅转发必要头；状态码/ETag/Content-Range 原样透传；流式不落地',
        '错误统一 {"error": "英文描述"}，前端 API_ERROR_MAP 映射中文；400 参数 · 401 凭据 · 403 权限 · 404 不存在 · 405 方法 · 409 已存在 · 502 上游',
    ],
}

DEPENDENCIES = {
    'build_tools': [
        'Python 3（build_eo.py / build_ai_context.py）',
        'pyyaml（pip install pyyaml，AI-CONTEXT 生成与校验）',
        'Node.js（node --check 构建校验 + 冒烟测试）',
    ],
    'runtime_external': [
        'GitHub REST API（api.github.com / raw.githubusercontent.com / codeload）——存储后端',
        'Cloudflare Workers/Pages（cloud-ecr.pages.dev）——可选下载/上传加速通道',
        '公共 ghproxy 镜像池 28 个——可选外部多代理下载（仅匿名下载，写操作永不经过）',
        'loliapi 图床——页面背景图（浏览器直连）',
        'cip.cc / api.ip.sb / ipinfo.io / cloudflare cdn-cgi/trace——IP 与归属地查询',
    ],
    'browser_requirements': [
        'crypto.subtle（SHA-512，需 HTTPS/localhost）',
        'fetch / XHR / localStorage / matchMedia / Pointer Events',
        'WebAudio AnalyserNode（音频 EQ 动画，可选，缺时回退 CSS 动画）',
    ],
    'version_notes': '无 package.json / requirements.txt：运行时零第三方依赖，兼容所有现代浏览器（ES2017+）',
}

I18N_THEME = {
    'i18n': {
        'langs': ['zh-CN', 'zh-TW', 'en', 'ja'],
        'mechanism': '以简体中文源码字符串为 key 的词典（I18N）；静态文案经 I18N_BINDINGS 绑定表批量应用；'
                     '动态消息在 setMsg/toast/后台浮泡三个出口统一翻译；未收录的拼接文案回退中文',
        'detect': 'langDetect 按浏览器语言自动识别（zh-HK/TW/Hant→繁体、ja→日语、en→英语、其余→简体）',
        'persist': 'localStorage cloud_web_lang；切换即时刷新面包屑/服务状态/按钮标题等动态渲染区',
    },
    'theme': {
        'modes': ['auto(跟随系统，默认)', 'light', 'dark'],
        'mechanism': 'data-theme 属性 + CSS 变量整套暗色覆盖；<head> 内联脚本在样式表加载前确定明暗防首屏闪烁；'
                     'auto 模式监听 prefers-color-scheme 实时切换',
        'persist': 'localStorage cloud_web_theme',
    },
}

CONSTRAINTS = [
    '首屏列表必须逐条 appendChild 挂载，禁止 DocumentFragment 一次挂载',
    '前端数据请求禁止使用缓存（变更后 15s 穿透窗口附加时间戳）',
    '密码明文不出浏览器：一律前端 SHA-512 后传输；记住密码只存哈希不存明文',
    '会话始终持久化（无 UI 开关）；记住密码默认勾选',
    '密码输入框必须有眼睛显隐切换：隐藏时闭眼划线图标(title=显示密码)，可见时睁眼图标(title=隐藏密码)；记住密码占位符状态下眼睛自动隐藏',
    '弹窗文本统一属性面板字体体系：Segoe UI/雅黑、13px 灰标签+14px 正文、标题加底部分隔线、章节标题大写字距',
    '用户管理需刷新按钮且每次操作后自动刷新列表',
    'UI 风格与原有界面统一，不使用 emoji 图标（媒体控制用内联 SVG）',
    '功能仅支持文件上传方式（无文本创建入口）',
]

PITFALLS = [
    'Markdown XSS：mdInline 的 [文字](url) 与 ![alt](url) 必须经 safeUrl()（协议白名单：拒绝 javascript:/data:/vbscript:）+ safeAttr()（引号过滤），禁直接插 href/src',
    'innerHTML 注入：服务端返回的错误文本一律 textContent 渲染，禁拼接进 innerHTML',
    'ObjectURL 内存泄漏：预览音/视频/图片的 Blob URL 关闭/重开弹窗时必须经 setPreviewBlobUrl() 释放',
    '代码高亮性能：关键词字典必须按语言缓存（LANG_KW_CACHE），禁每次按键重建',
    'CRLF 一致性：工作区 git autocrlf 产生 CRLF，而 eo.js 按 LF 嵌入——build_eo.py 读源文件已统一 replace \\r\\n→\\n，冒烟测试比较前同样归一化',
]

WORKFLOW = {
    'trigger': '任何代码更新/文件结构调整/功能变更后',
    'auto_pipeline': 'python build_eo.py 构建时自动执行完整链：重建 eo.js → node --check 语法校验 → '
                     '重建本文件（update_ai_context 调用 build_ai_context.py）→ node test_eo_smoke.js 冒烟测试 → '
                     'git commit + push（仅白名单文件，排除 eo.js/.eo-key 等机密）',
    'manual_steps': [
        '业务规则/章节内容变化时：先改 build_ai_context.py 内对应静态章节，再运行构建',
        '仅同步本文件：python build_ai_context.py（重建 + 自校验）',
        '手动验证：node test_eo_smoke.js；git add -A && git commit && git push origin HEAD',
    ],
    'validate_cmd': 'python -c "import yaml; d=yaml.safe_load(open(\'AI-CONTEXT.yaml\',encoding=\'utf-8\')); '
                    'req=[\'meta\',\'project\',\'files\',\'architecture\',\'backend\',\'frontend\',\'cf_worker\',\'dataflow\',\'config\',\'api\',\'dependencies\',\'i18n_theme\',\'constraints\',\'pitfalls\',\'workflow\']; '
                    'missing=[k for k in req if k not in d]; assert not missing, missing; print(\'OK\', len(d), \'sections\')"',
    'requires': 'Python 3 + pyyaml（pip install pyyaml）、Node.js（语法校验与冒烟测试）、git',
}

CF_WORKER = {
    'file': 'cf-worker.js',
    'deploy': 'Cloudflare Workers/Pages → https://cloud-ecr.pages.dev',
    'role': 'CF 加速通道：GitHub 全站反向代理（下载/上传加速）',
    'features': [
        'PROXY_RES 12 条正则覆盖 github.com/gist/codeload/githubusercontent 全子域/githubassets/S3 等',
        '环境变量 GITHUB_TOKEN（或 TOKEN）配置后，转发 api.github.com 时服务端注入 Authorization: Bearer（客户端永不接触）；成功时响应带 x-cf-auth-injected: 1 标记头（据此区分未配置与 key 无效）',
        'GET /ip 只回纯文本出口 IP（优先 cloudflare.com/cdn-cgi/trace，回退 api.ip.sb/ip）；归属地由 EO /api/cf-ip 另行查询',
        'CORS：OPTIONS 预检回显浏览器请求头；转发时删 referer/host；accept-language zh-CN→zh-SG',
        'whiteList 为空即全放行；Config.jsdelivr=0 默认关闭 jsDelivr 重写',
    ],
}

BACKEND_STATIC = {
    'file': 'build_eo.py（BACKEND 模板字符串，构建时替换 __XXX__ 占位符后写入 eo.js）',
    'key_security': 'GITHUB_KEY 仅存在于 EO 服务端；代理白名单永久拒绝用户数据仓库；用户列表密码字段脱敏 ***',
    'auth_model': '读操作公开；写操作（PUT/DELETE/POST/PATCH 代理 + 用户 API）需 X-Auth-User/X-Auth-Pass（SHA-512 哈希）逐请求实时校验；'
                  '鉴权读有 60s 实例级缓存，写后即时刷新；Contents API 写操作仅变更目标字段，409 冲突自动重读重试（≤3 次）',
    'user_json': CONFIG['user_json_format'],
}

FRONTEND_STATIC = {
    'file': 'static/app.js（全部前端逻辑，9668 行普通 JS，无框架）',
    'template': 'template.html（Python str.format 模板，内联 JS 需双大括号转义）；404.html 为构建同步副本',
    'boot': 'window.__APP__ 注入 {title, repoOwner, repoName, defaultBranch}；app.js 按 location.pathname 解析当前目录（SPA 兜底）',
    'function_groups': {
        'ext*': '外部多代理下载（候选池/浏览器侧探测/熔断与自愈/站点级慢速冷却）',
        'dl*': '下载调度（通道加权分配/自适应并发/慢速换源/速度曲线/图例）',
        'ul*/upload*/fill*/startTask*/prefetch*': '上传调度（通道选择/预读缓存/分拍发布/在途字节护栏）',
        'commit*/putBlob*/gitApiUrl': 'Git 数据 API 上传管线（blob→tree→commit→ref，链式推进+冲突重试）',
        'audio*': '音频播放列表（单曲/顺序/随机模式、预载下一首、WebAudio EQ 动画）',
        'img*': '图片查看器（缩放/拖拽/缩略图条限流加载/鸟瞰图）',
        'preview*/stream*/probe*Media/buildMediaControls': '预览（媒体流式/图片渐进/三通道测速/自定义控制条）',
        'md*/markdown*/safe*/highlight*/detectLang/minimap*/buildText*/render*': 'Markdown 与代码渲染（XSS 防护/高亮/鸟瞰图）',
        'search*/triggerSearch/locate*': '目录范围搜索（防抖/归并分片/定位/304 视图恢复）',
        'delete*/batch*/toggleSelect/*Selection*': '删除与批量操作（并行删除冲突自适应/批量下载池）',
        'task*/showBgTask/updateBgTask/*BgTask*': '全局任务管理器（同类互斥/后台浮泡/快照持久化）',
        'admin*/withAdminCreds/openAdminUserMenu': '用户管理（仅 admin；用户右键菜单 adminUserMenu、独立添加弹窗 adminAddModal，凭据复用缓存哈希）',
        'switchAccountTab/changeOwn*/deleteOwnAccount': '我的账户（用户菜单三级子菜单+弹窗标签页：头像/密码/注销，openAccountModal(tab) 直达对应页）',
        'share*/makeShareUrl/b64url*/isSharePage/renderSharePage/copyShareLink/openQrModal/qr*/copyTextToClipboard': '分享链接（b64url 编码 /s/ URL、本地 QR 生成、分享页渲染，纯前端无服务端存储）',
        'svc*/check*/measureRtt': '服务状态三路检测（EO/Git外部/CF，10min 自动刷新）',
        'login/logout/saveAuth/getSavedAuth/*Remember': '认证会话（SHA-512/持久化/记住密码哈希迁移）',
        'theme*/applyTheme': '主题切换（auto/light/dark）',
        'lang*/initLang/applyI18n*/t': '多语言（4 语言词典翻译）',
        '*BgTask*/showTaskProgress/updateTaskProgress': '进度卡片与后台浮泡 UI',
    },
}

FILE_ROLES = {
    'build_eo.py': 'EO 一体化构建脚本（后端模板+前端资源烘焙→eo.js）',
    'build_ai_context.py': '本生成器：重建 AI-CONTEXT.yaml',
    'AI-CONTEXT.yaml': 'AI 专用项目理解文件（本生成器产物，勿手改）',
    'template.html': '唯一 HTML 模板',
    '404.html': 'template.html 构建同步副本',
    'static/app.js': '全部前端逻辑',
    'static/style.css': '全部样式',
    'cf-worker.js': 'CF 加速通道源码',
    'API.md': '人类用接口文档',
    'README.md': '人类用功能/算法说明',
    'test_eo_smoke.js': 'eo.js 冒烟测试（Node 模拟 fetch 事件，不触网）',
    'test_eo_server.js': 'eo.js 本地模拟服务器',
    'favicon.ico': '站点图标（构建时 base64 嵌入）',
    'xxx.json': '外部代理浏览器侧探测目标文件（raw 小文件）',
    'eo.js': 'EO 部署产物（gitignore，含 key 属服务端机密）',
    '.eo-key': '本地 GitHub key（gitignore）',
    '.gitignore': '忽略 eo.js/.eo-key/build 等',
}

GITIGNORED = {'eo.js', '.eo-key', 'build'}


# ==================== 自动扫描 ====================

def git_commit():
    try:
        full = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
        short = subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'], text=True).strip()
        return full, short
    except Exception:
        return '', ''


def scan_files():
    out = []
    for name, role in FILE_ROLES.items():
        if not os.path.exists(name):
            continue
        with open(name, 'rb') as f:
            data = f.read()
        entry = {
            'name': name,
            'role': role,
            'bytes': len(data),
            'sha1': hashlib.sha1(data).hexdigest()[:8],
        }
        if name.endswith(('.py', '.js', '.html', '.css', '.md', '.json')):
            entry['lines'] = data.decode('utf-8', 'replace').count('\n') + 1
        if name in GITIGNORED:
            entry['gitignored'] = True
        out.append(entry)
    return out


def scan_backend():
    with open('build_eo.py', 'r', encoding='utf-8', newline='') as f:
        lines = f.read().replace('\r\n', '\n').split('\n')
    routes, functions = [], []
    seen = set()
    re_route = re.compile(r"path\s*===\s*'([^']+)'|path\.startsWith\('([^']+)'\)")
    re_pyfn = re.compile(r'^def\s+(\w+)\s*\(')
    re_jsfn = re.compile(r'^(?:async\s+)?function\s+([\w$]+)\s*\(')
    for i, line in enumerate(lines, 1):
        for m in re_route.finditer(line):
            p = m.group(1) or m.group(2)
            kind = 'exact' if m.group(1) else 'prefix'
            if (kind, p) not in seen:
                seen.add((kind, p))
                routes.append({'line': i, 'match': kind, 'path': p})
        m = re_pyfn.match(line)
        if m:
            functions.append({'line': i, 'name': m.group(1), 'lang': 'python'})
        m = re_jsfn.match(line)
        if m:
            functions.append({'line': i, 'name': m.group(1), 'lang': 'js-template'})
    return routes, functions


def scan_frontend():
    with open('static/app.js', 'r', encoding='utf-8', newline='') as f:
        lines = f.read().replace('\r\n', '\n').split('\n')
    functions, constants = [], []
    re_fn = re.compile(r'^(?:async\s+)?function\s+([\w$]+)\s*\(')
    re_const = re.compile(r'^(?:const|let|var)\s+([A-Z_][A-Z0-9_]{3,})\s*=')
    for i, line in enumerate(lines, 1):
        m = re_fn.match(line)
        if m:
            functions.append({'line': i, 'name': m.group(1)})
        m = re_const.match(line)
        if m:
            constants.append({'line': i, 'name': m.group(1)})
    return functions, constants


# ==================== 构建 ====================

REQUIRED_KEYS = ['meta', 'project', 'files', 'architecture', 'backend', 'frontend', 'cf_worker',
                 'dataflow', 'config', 'api', 'dependencies', 'i18n_theme', 'constraints', 'pitfalls', 'workflow']


def build():
    full, short = git_commit()
    routes, backend_fns = scan_backend()
    frontend_fns, frontend_consts = scan_frontend()

    doc = {
        'meta': {
            'schema': SCHEMA_VERSION,
            'generated_at': datetime.datetime.now().isoformat(timespec='seconds'),
            'git_commit': full,
            'git_commit_short': short,
            'build_version': os.environ.get('AI_CTX_BUILD_VERSION', ''),
            'generator': 'build_ai_context.py（本文件由其自动重建，勿手改；python build_eo.py 构建时自动调用）',
        },
        'project': PROJECT,
        'files': scan_files(),
        'architecture': ARCHITECTURE,
        'backend': dict(BACKEND_STATIC, routes=routes, functions=backend_fns),
        'frontend': dict(FRONTEND_STATIC, functions=frontend_fns, constants=frontend_consts),
        'cf_worker': CF_WORKER,
        'dataflow': DATAFLOW,
        'config': CONFIG,
        'api': API,
        'dependencies': DEPENDENCIES,
        'i18n_theme': I18N_THEME,
        'constraints': CONSTRAINTS,
        'pitfalls': PITFALLS,
        'workflow': WORKFLOW,
    }

    text = yaml.dump(doc, allow_unicode=True, sort_keys=False, width=120)
    with open(OUT_FILE, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)

    # 自校验：回读 + 必备顶级键
    with open(OUT_FILE, 'r', encoding='utf-8') as f:
        loaded = yaml.safe_load(f.read())
    missing = [k for k in REQUIRED_KEYS if k not in loaded]
    assert not missing, 'missing sections: %s' % missing
    print('OK %s: %d sections, %d backend routes, %d backend functions, %d frontend functions, %d constants'
          % (OUT_FILE, len(loaded), len(routes), len(backend_fns), len(frontend_fns), len(frontend_consts)))


if __name__ == '__main__':
    build()
