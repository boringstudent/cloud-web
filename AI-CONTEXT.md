<!--AI_CTX_SCHEMA=cloud-web/v1-->
<!--AI_CTX_GENERATED=2026-09-30T20:25:02+08:00-->
<!--AI_CTX_SOURCE=build_eo.py-->
<!--AI_CTX_BUILD_TOOL=build_eo.py-->

[PROJECT]
name=cloud-web
description=基于GitHub仓库作为存储后端的网页版网盘，全站一体部署在腾讯云EdgeOne边缘函数
primary_language=zh-CN
license=未指定
repo_url=https://github.com/boringstudent/cloud-web

[ARCHITECTURE]
deploy_target=腾讯云EdgeOne边缘函数(EO)
backend_type=单文件边缘函数 eo.js
frontend_type=单页应用 SPA(vanilla JS，无框架)
storage_backend=GitHub仓库(contents API + git data API)
auth_backend=GitHub私有仓库 user.json(仅服务端访问)
acceleration=Cloudflare Workers/Pages 通道(cloud-ecr.pages.dev)

[FILES]
build_eo.py=构建脚本：将前后端打包为单文件 eo.js，含语法自验
static/app.js=前端逻辑(~408KB)：文件浏览/上传/下载/预览/搜索/用户管理/主题/多语言
static/style.css=前端样式(~53KB)：浅色卡片风格，明暗主题适配
cf-worker.js=CF Workers代理(~21KB)：GitHub全站反向代理，可选服务端key注入
template.html=HTML模板(Python str.format渲染，含内联启动参数)
404.html=template.html 同步副本(构建时自动覆盖)
API.md=eo.js HTTP接口完整文档
test_eo_smoke.js=冒烟测试：Node模拟fetch事件，28项断言，不触网
test_eo_server.js=本地模拟服务器：Node HTTP包装fetch处理器，端到端预览
eo.js=构建产物(gitignore)：EdgeOne边缘函数部署文件，内含GITHUB_KEY(仅本地)
xxx.json=外部代理连通性探测目标文件

[MODULES]
module=eo-backend
  file=eo.js(生成物)
  runtime=EdgeOne边缘函数
  entry=handleRequest(request)
  features=页面托管,静态资源,认证API,GitHub代理,下载中转,背景图中转
  security=服务端注入GITHUB_KEY,仓库白名单,密码SHA-512校验,CSP头
  cors=全局放行

module=frontend-app
  file=static/app.js
  framework=无(vanilla JavaScript)
  size=~408KB
  globals=window.__APP__, API_BASE, REPO_OWNER, REPO_NAME, DEFAULT_BRANCH
  features=文件浏览(增量渲染/懒加载),上传(分片/并行/自适应/多通道),下载(分段/多代理/聚合带宽),预览(图片/音视频/文本/Markdown),搜索(目录范围),用户管理,主题(浅色/深色/跟随系统),多语言(简/繁/英/日)

module=cf-worker
  file=cf-worker.js
  runtime=Cloudflare Workers/Pages
  features=GitHub全站反向代理,服务端GITHUB_TOKEN注入(可选),出口IP查询(/ip)
  config=GITHUB_TOKEN环境变量
  url=https://cloud-ecr.pages.dev

[DATA_FLOW]
flow=文件上传
  step1=浏览器选择文件(支持多文件/文件夹拖拽)
  step2=前端分片(CHUNK_SIZE_LEVELS两档，按base64后不超过GitHub单文件限制反算)
  step3=并行POST /api.github.com/repos/.../git/blobs(零冲突，不动引用)
  step4=每100个blob合成tree+commit(引用移动是唯——冲突点)
  step5=组间链式推进(上一组新commit SHA作为下一组base_tree)
  step6=引用冲突(422/409)时校验是否实际成功(读最新ref指向本提交则视为成功)
  step7=否则从最新ref重建tree重试，最多12次，指数退避封顶5s+随机抖动
  step8=停止/失败时未提交blob为悬空对象(天然无副作用，GitHub自动回收)
  channel=EO(同源，服务端注入key，默认) + CF(可选，需CF侧配置GITHUB_TOKEN)

flow=文件下载
  step1=浏览器请求同源代理路径(/raw.githubusercontent.com/...)
  step2=EO服务端注入key转发GitHub raw
  step3=大文件(>2MB)分段并行下载(DUAL_DL_PARTS=12段，最小1MB/段)
  step4=段在EO/CF/外部代理间按在途均衡+实测速率加权分配
  step5=段失败自动换源续传(Range断点续传)，CF连续失败2次熔断
  step6=聚合为Blob，ObjectURL保存(规避跨域download属性被忽略)
  external_proxy=公共ghproxy镜像候选池(28个)，浏览器侧实测可用性

flow=用户认证
  step1=浏览器本地crypto.subtle计算SHA-512哈希(128位hex)
  step2=POST /api/login 校验(实时读取user.json，无缓存)
  step3=成功返回{success, username, role, avatar}
  step4=localStorage持久化凭据(v2格式base64 JSON)
  step5=写操作请求头携带X-Auth-User/X-Auth-Pass，EO逐请求实时校验后代为写GitHub

flow=目录列表
  step1=GET /api.github.com/repos/.../contents/<path> 经EO代理
  step2=返回目录项数组(文件/文件夹)
  step3=文件夹大小走git trees API递归统计
  step4=增量渲染：按key做diff，仅更新变化项(带高亮闪烁/过渡动画)
  step5=懒加载：首屏按每批40条分批渲染，逐条appendChild挂载

[KEY_FUNCTIONS]
func=handleRequest
  file=eo.js
  role=HTTP请求入口分发
  routes=OPTIONS预检, /api/*业务接口, /static/*静态资源, /api.github.com/*代理, /raw.githubusercontent.com/*下载中转, /github.com/*/archive/*打包, SPA兜底

func=handleGithubProxy
  file=eo.js
  role=GitHub代理与下载中转核心
  security=白名单仓库校验,写操作X-Auth-User/X-Auth-Pass鉴权,状态码/ETag/Content-Range原样透传
  stream=请求/响应体流式转发不落地

func=requireLogin
  file=eo.js
  role=代理写操作鉴权
  input=请求头X-Auth-User/X-Auth-Pass
  logic=实时读取user.json比对SHA-512哈希

func=requireAdmin
  file=eo.js
  role=管理员接口鉴权
  logic=校验用户存在且role===admin

func=readUsersFile
  file=eo.js
  role=读取用户数据
  cache=60秒实例级缓存(分片上传高频鉴权不重复回源)
  refresh=写操作后即时刷新

func=mutateUsers
  file=eo.js
  role=原子修改user.json
  conflict=409冲突自动重读重试(最多3次)
  commit_msg=操作描述作为Git提交信息

func=probeExtProxiesApi
  file=eo.js
  role=服务端视角探测外部代理可用性
  target=EXT_PROBE_TARGET(raw小文件)
  timeout=9秒，快速失败复测一次
  cache=5分钟实例级

func=ghUrl
  file=static/app.js
  role=统一改写GitHub URL为同源代理路径

func=startUpload
  file=static/app.js
  role=上传调度入口
  features=多文件,文件夹递归,分片,并行调度,自适应并发,多通道分配

func=fillUploads
  file=static/app.js
  role=上传任务调度器
  features=在途均衡,速率加权分配,内存保护(UL_MAX_INFLIGHT_BYTES=300MB),分拍派发(UL_DISPATCH_BURST=6),停滞看门狗(12秒无进度换源),慢速换源(低于峰值30%判定)

func=commitBatch
  file=static/app.js
  role=blob提交阶段
  logic=每100个blob合成tree+commit，链式推进，冲突重试最多12次

func=fetchFileBlobDual
  file=static/app.js
  role=双/三通道下载核心
  features=分段并行,在途均衡+速率加权,失败换源续传,熔断,416自我修正,慢速换源,停滞看门狗(15秒)

func=downloadFolderZip
  file=static/app.js
  role=文件夹打包下载
  logic=git tree收集文件->文件级并行池拉取->前端zip打包(store模式)->保存

func=fetchFileTree
  file=static/app.js
  role=获取目录文件树
  cache=ETag条件请求(304不占速率限制)

func=renderSearchResults
  file=static/app.js
  role=目录范围搜索
  logic=复用git全量文件树缓存，按路径子串匹配(不区分大小写，最多200条)

func=previewFile
  file=static/app.js
  role=文件预览分发
  branches=图片(渐进渲染/多段Range/查看器),音视频(流式加载/多通道测速/播放列表),文本(代码高亮/文本/编辑),Markdown(渲染/源码)

func=buildImageViewer
  file=static/app.js
  role=图片查看器
  features=缩放/平移/鸟瞰图/缩略图条/前后切换

func=setupAudioPlaylist
  file=static/app.js
  role=音频播放列表
  features=单曲循环/顺序播放/随机播放,多通道渐进播放,预载下一首,频谱动画

func=highlightCode
  file=static/app.js
  role=代码语法高亮
  cache=LANG_KW_CACHE按语言缓存关键词字典

func=markdownToHtml
  file=static/app.js
  role=Markdown渲染
  security=safeUrl协议白名单+safeAttr引号过滤

[CONFIG]
GITHUB_KEY=GitHub个人访问令牌(环境变量GITHUB_KEY或.eo-key文件)
USER_REPO=用户数据仓库(默认boringstudent/cloud-user，禁止代理访问)
STORAGE_REPO=网盘存储仓库(默认boringstudent/cloud-storage)
BRANCH=默认分支(默认main)
CF_WORKER_BASE=CF加速通道(默认https://cloud-ecr.pages.dev)
EXT_PROBE_TARGET=外部代理探测目标(raw文件URL)
EXT_PROXY_CANDIDATES=28个公共ghproxy镜像域名列表
CSP=default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https://cloud-ecr.pages.dev https:; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'

[CONSTANTS]
REFRESH_INTERVAL=45000(目录自动刷新间隔ms)
DUAL_DL_MIN=2097152(启用分段下载阈值2MB)
DUAL_DL_PARTS=12(分段数)
DUAL_SEG_MAX_ATTEMPTS=5(单段最大尝试次数)
CHUNK_SIZE_LEVELS=[35389440,23592960](分片大小两档，base64后字节)
UL_MAX_INFLIGHT_BYTES=314572800(上传在途字节上限300MB)
UL_DISPATCH_BURST=6(单tick最大派发任务数)
EXT_FAIL_RECOVER_MS=120000(代理熔断自愈时间2分钟)
GRAPH_PEAK_WINDOW=30(速度曲线Y轴峰值窗口30秒)

[API_ENDPOINTS]
GET / = SPA主页面(不缓存，CSP头)
GET /static/app.js?v={version} = 前端JS(immutable长缓存)
GET /static/style.css?v={version} = 前端CSS(immutable长缓存)
GET /favicon.ico = 站点图标
GET/POST /api/hash?type=password|key&value=xxx = SHA-512哈希计算
GET/HEAD /api/my-ip = 服务器出口IP及归属地(cip.cc)
GET/HEAD /api/cf-ip = CF通道出口IP及归属地(5分钟缓存)
GET/HEAD /api/proxies = 外部代理候选列表(?all=1全量 ?probe=api诊断)
GET/POST /api/login?username=xxx&password=<sha512> = 用户登录
POST /api/change-password = 自助改密(旧密+新密均为sha512)
POST /api/change-avatar = 自助改头像(URL最长300字符)
POST /api/delete-account = 自助注销(密码确认)
GET /api/users?admin_user=xxx&admin_pass=<sha512> = 用户列表(密码脱敏为***)
POST /api/users = 添加用户(admin)
PUT/PATCH /api/users/:username = 修改用户密码/角色/头像(admin)
DELETE /api/users/:username = 删除用户(admin)
GET /api/bg = 背景图中转(跟随302，仅放行image/*)
* /api.github.com/repos/<owner>/<repo>/<path> = GitHub REST API代理(读公开/写鉴权)
* /raw.githubusercontent.com/<owner>/<repo>/<branch>/<path> = raw下载中转(支持206)
* /github.com/<owner>/<repo>/archive/<ref>.zip = 整仓打包下载中转

[DEPENDENCIES]
build=Python 3.x(构建脚本)
test=Node.js(语法校验+冒烟测试)
runtime_edgeone=腾讯云EdgeOne边缘函数环境
runtime_cfworker=Cloudflare Workers/Pages环境(cf-worker.js)
external_api=GitHub REST API(contents,git data,raw)
external_ip1=cip.cc(服务器IP归属地，8秒超时)
external_ip2=api.ip.sb(IP查询，CF IP回退)
external_ip3=ipinfo.io(IP查询，cip.cc不支持指定IP时回退)
external_img=loliapi.com(背景图，浏览器直连)

[SECURITY]
password_hash=客户端crypto.subtle.SHA-512(128位hex)，明文不出浏览器
key_isolation=GITHUB_KEY仅存在于EO服务端和CF Worker服务端，永不下发浏览器
proxy_whitelist=仅STORAGE_REPOS白名单仓库可代理，其余403
user_repo_block=用户数据仓库(REPO)永久403，任何后端数据不泄漏到用户端
response_mask=用户列表密码字段脱敏为***，任何接口不返回密码哈希
csp=完整内容安全策略头(见CONFIG)
xss_prevention=文件名textContent渲染; Markdown URL经safeUrl协议白名单(javascript:/data:/vbscript:拒绝)+safeAttr引号过滤; 错误提示textContent渲染
innerhtml_ban=服务端错误文本禁止拼接进innerHTML
nosniff=X-Content-Type-Options: nosniff
frame_options=X-Frame-Options: DENY
referrer=Referrer-Policy: strict-origin-when-cross-origin

[BUILD]
command=python build_eo.py
env_override=CLOUD=owner/repo BRANCH=main USER_REPO=owner/user-repo
key_source=GITHUB_KEY环境变量 或 .eo-key文件(已gitignore)
output=eo.js(单文件，含key，仅本地)
post_build=node --check eo.js(语法校验)
auto_copy=404.html <- template.html
last_version=1790771101
last_eo_size=723KB
last_app_size=415KB
last_css_size=53KB
last_cf_size=21KB

[TEST]
smoke=test_eo_smoke.js(28项断言：路由/资源/安全/代理/用户)
server=test_eo_server.js(本地HTTP模拟服务器，端到端预览)
run_smoke=node test_eo_smoke.js(要求eo.js已生成)
run_server=node test_eo_server.js [port]

[CHANGELOG]
2026-09-30=创建AI-CONTEXT.md，构建流程集成自动生成与验证
