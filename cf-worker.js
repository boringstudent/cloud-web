'use strict'

// 基础屏蔽的爬虫 UA（不会再被反复追加，避免内存泄漏）
const BASE_BLOCK_UA = ['netcraft'];

// 前缀，如果自定义路由为example.com/gh/*，将PREFIX改为 '/gh/'，注意，少一个杠都会错！
const PREFIX = '/' // 路由前缀
// 分支文件使用jsDelivr镜像的开关，0为关闭，默认关闭
const Config = {
	jsdelivr: 0
}

const whiteList = [] // 白名单，路径中包含白名单字符的请求才会通过，例如 ['/username/']

// ============================================================
// ========== 服务端 GitHub Token 注入（写操作鉴权） ==========
// ============================================================
// 在 CF Worker / Pages 的环境变量中配置 GITHUB_TOKEN（或 TOKEN）后，
// 所有经本代理转发到 api.github.com 的请求都会在服务端注入
// Authorization: Bearer <token> 头——写操作（创建 blob 等）因此可经
// CF 通道完成。Token 只存在于 CF 服务端，客户端永远不接触；
// 未配置时行为与原来一致（匿名代理，写请求会被 GitHub 返回 401）。
// 注入成功时响应带 x-cf-auth-injected: 1 标记头（不含 key 本身），
// 调用方据此区分"CF 未配置/未部署新版"与"key 无效或无权限"（后者 401 但带标记）。
function injectGithubToken(reqHdrNew, urlStr, env) {
	const tk = env && (env.GITHUB_TOKEN || env.TOKEN);
	if (!tk) return false;
	if (/^https?:\/\/api\.github\.com(?:\/|$)/i.test(urlStr)) {
		reqHdrNew.set('authorization', 'Bearer ' + tk);
		return true;
	}
	return false;
}

/** @type {ResponseInit} */
const PREFLIGHT_INIT = {
	status: 204,
	headers: new Headers({
		'access-control-allow-origin': '*',
		'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
		'access-control-allow-headers': '*',
		'access-control-max-age': '1728000',
	}),
}

// ===== 原有：GitHub 下载 / 源码等路径 =====
const exp1 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:releases|archive)\/.*$/i
const exp2 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:blob|raw)\/.*$/i
const exp3 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:info|git-).*$/i
const exp4 = /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i
const exp5 = /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+$/i
const exp6 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/tags.*$/i

// ===== 新增：覆盖 GitHub API 与全站资源 =====
// GitHub REST API
const exp7  = /^(?:https?:\/\/)?api\.github\.com(?:\/.*)?$/i
// codeload（源码压缩包下载）
const exp8  = /^(?:https?:\/\/)?codeload\.github\.com\/.*$/i
// Gist 网页
const exp9  = /^(?:https?:\/\/)?gist\.github\.com\/.*$/i
// githubusercontent.com 的所有子域（raw / objects / avatars / camo / user-images / media / private-user-images / pipelines ...）
const exp10 = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*githubusercontent\.com\/.*$/i
// GitHub 静态资源 / 收集 / 上传 / S3 资源
const exp11 = /^(?:https?:\/\/)?(?:github\.githubassets\.com|collector\.github\.com|uploads\.github\.com|github-cloud\.s3\.amazonaws\.com|github-production-[a-z0-9-]+\.s3\.amazonaws\.com)\/.*$/i
// github.com 任意路径（兜底：主页、issues、pull、actions、settings...）
const exp12 = /^(?:https?:\/\/)?github\.com(?:\/.*)?$/i

// 命中任一即代理
const PROXY_RES = [exp1, exp2, exp3, exp4, exp5, exp6, exp7, exp8, exp9, exp10, exp11, exp12]

/** 创建响应对象 */
function makeRes(body, status = 200, headers = {}) {
	headers['access-control-allow-origin'] = '*'
	return new Response(body, { status, headers })
}

/** 创建 URL 对象 */
function newUrl(urlStr) {
	try {
		return new URL(urlStr)
	} catch (err) {
		return null
	}
}

/** 检查 URL 是否匹配代理规则 */
function checkUrl(u) {
	for (const re of PROXY_RES) {
		if (u.search(re) === 0) return true
	}
	return false
}

/** 是否是需要走 raw / jsDelivr 重写的 blob|raw 路径 */
function isBlobOrRaw(u) {
	return u.search(exp2) === 0
}

/** 是否命中任意代理规则 */
function matchAnyProxy(u) {
	return PROXY_RES.some(re => u.search(re) === 0)
}

// ============================================================
// ========== 通用 CORS 预检响应（修复 /ip 预检失败） ==========
// ============================================================

/**
 * 统一的 OPTIONS 预检响应
 * 会把浏览器请求的头（access-control-request-headers）原样回显，
 * 这样 cache-control、authorization、content-type 等自定义头都不会被拦。
 */
function makePreflightResponse(req) {
	const headers = new Headers(PREFLIGHT_INIT.headers)
	const reqAllowHeaders = req.headers.get('access-control-request-headers')
	if (reqAllowHeaders) {
		headers.set('access-control-allow-headers', reqAllowHeaders)
	}
	// 预检结果不要缓存，避免不同来源互相干扰
	headers.set('vary', 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method')
	return new Response(null, { status: 204, headers })
}

// ============================================================
// ========== 服务器自身 IP 信息（JSON 返回） ==========
// ============================================================

/**
 * 解析 cip.cc 返回的文本 / HTML，整理成 JSON 对象
 * 支持以下两种格式：
 *   1) 命令行纯文本（curl cip.cc）
 *      IP	: 8.8.8.8
 *      地址	: 美国 加利福尼亚州 圣克拉拉
 *      运营商	: 谷歌公司DNS服务器
 *      数据二	: ...
 *      数据三	: ...
 *   2) 网页 HTML（<pre> 中同上内容）
 */
function parseCipInfo(raw) {
	const out = {
		ip: '',
		location: '',
		isp: '',
		data2: '',
		data3: '',
	}

	let text = raw || ''

	// 若是 HTML，仅截取 <pre> 内的内容
	const pre = text.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)
	if (pre) text = pre[1]

	// 反转义常见 HTML 实体
	text = text
		.replace(/&nbsp;/gi, ' ')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&amp;/gi, '&')

	// 字段名 -> JSON 键名
	const keyMap = {
		'IP': 'ip',
		'地址': 'location',
		'运营商': 'isp',
		'数据二': 'data2',
		'数据三': 'data3',
	}

	for (const line of text.split(/\r?\n/)) {
		const m = line.match(/^\s*([^\s:：]+)\s*[:：]\s*(.*?)\s*$/)
		if (!m) continue
		const field = keyMap[m[1]]
		if (field) out[field] = m[2]
	}

	return out
}

/**
 * 请求 cip.cc 并返回 JSON（仅查询服务器自身 IP）
 */
async function ipInfoResponse() {
	const apiUrl = 'https://cip.cc/'

	let raw = ''
	try {
		const res = await fetch(apiUrl, {
			headers: {
				// 用 curl 的 UA 让 cip.cc 直接返回纯文本，省去解析 HTML
				'User-Agent': 'curl/7.68.0',
				'Accept': 'text/plain, text/html, */*',
			},
			redirect: 'follow',
		})
		raw = await res.text()
	} catch (e) {
		return makeRes(
			JSON.stringify({ error: '请求 cip.cc 失败', message: String(e) }),
			502,
			{
				'content-type': 'application/json; charset=utf-8',
				'cache-control': 'no-store',
			}
		)
	}

	const info = parseCipInfo(raw)

	if (!info.ip) {
		return makeRes(
			JSON.stringify({ error: '解析 cip.cc 返回内容失败', raw: raw.slice(0, 800) }),
			502,
			{
				'content-type': 'application/json; charset=utf-8',
				'cache-control': 'no-store',
			}
		)
	}

	return makeRes(JSON.stringify(info), 200, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
	})
}

// ============================================================

/** 处理 HTTP 请求 */
function httpHandler(req, pathname, env) {
	const reqHdrRaw = req.headers

	// 预检：所有 OPTIONS 请求统一处理，回显浏览器请求的头，兼容性最好
	if (req.method === 'OPTIONS') {
		return makePreflightResponse(req)
	}

	const reqHdrNew = new Headers(reqHdrRaw)

	// 修改 Accept-Language
	if (reqHdrNew.has('accept-language')) {
		const acceptLanguage = reqHdrNew.get('accept-language')
		reqHdrNew.set('accept-language', acceptLanguage.replace('zh-CN', 'zh-SG'))
	}

	// 转发时清掉这些头，避免被目标站点校验
	reqHdrNew.delete('referer')
	reqHdrNew.delete('host')

	let urlStr = pathname
	let flag = !Boolean(whiteList.length)
	for (const i of whiteList) {
		if (urlStr.includes(i)) {
			flag = true
			break
		}
	}
	if (!flag) {
		return new Response("blocked", { status: 403 })
	}
	if (urlStr.search(/^https?:\/\//) !== 0) {
		urlStr = 'https://' + urlStr
	}

	// 服务端 Token 注入：配置 GITHUB_TOKEN 环境变量后，api.github.com
	// 请求在服务端附加鉴权头（写操作可经 CF 通道完成，客户端不接触 Token）
	const authInjected = injectGithubToken(reqHdrNew, urlStr, env)

	const urlObj = newUrl(urlStr)
	if (!urlObj) return new Response('bad url', { status: 400 })

	/** @type {RequestInit} */
	const reqInit = {
		method: req.method,
		headers: reqHdrNew,
		redirect: 'manual',
		body: req.body
	}
	if (authInjected) reqInit._authInjected = true
	return proxy(urlObj, reqInit)
}

/** 反向代理 */
async function proxy(urlObj, reqInit) {
	const res = await fetch(urlObj.href, reqInit)
	const resHdrOld = res.headers
	const resHdrNew = new Headers(resHdrOld)

	const status = res.status

	if (resHdrNew.has('location')) {
		let _location = resHdrNew.get('location')
		// ★ 关键：把相对重定向补全为绝对地址，否则 checkUrl 无法命中
		try {
			_location = new URL(_location, urlObj.href).href
		} catch (e) { /* ignore */ }

		if (checkUrl(_location)) {
			resHdrNew.set('location', PREFIX + _location)
		} else if (reqInit.body == null) {
			// 只有无 body 的请求才能安全地自动跟随重定向
			// （带 body 的请求流已被消费，重复发送会报错）
			reqInit.redirect = 'follow'
			return proxy(newUrl(_location), reqInit)
		}
		// 带 body 的请求遇到外部重定向时，直接透传重定向响应给客户端处理
	}
	resHdrNew.set('access-control-expose-headers', '*')
	resHdrNew.set('access-control-allow-origin', '*')
	// 注入标记回显（不含 key 本身），供调用方诊断 401 是"未注入"还是"key 无效"
	if (reqInit._authInjected) resHdrNew.set('x-cf-auth-injected', '1')

	resHdrNew.delete('content-security-policy')
	resHdrNew.delete('content-security-policy-report-only')
	resHdrNew.delete('clear-site-data')

	return new Response(res.body, {
		status,
		headers: resHdrNew,
	})
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url)
		const urlStr = request.url
		const urlObj = new URL(urlStr)

		// ★ 关键修复：CORS 预检必须放在最前面，
		// 否则 /ip、favicon、首页等路径的 OPTIONS 请求拿不到
		// access-control-allow-headers，浏览器会直接报
		// "Request header field cache-control is not allowed by
		//  Access-Control-Allow-Headers in preflight response."
		if (request.method === 'OPTIONS') {
			return makePreflightResponse(request)
		}

		// 每次都基于基础列表重新构建，避免模块级数组被无限追加
		let 屏蔽爬虫UA = BASE_BLOCK_UA.slice()
		if (env.UA) 屏蔽爬虫UA = 屏蔽爬虫UA.concat(await ADD(env.UA));

		const userAgentHeader = request.headers.get('User-Agent');
		const userAgent = userAgentHeader ? userAgentHeader.toLowerCase() : "null";
		if (屏蔽爬虫UA.some(fxxk => userAgent.includes(fxxk)) && 屏蔽爬虫UA.length > 0) {
			return new Response(await nginx(), {
				headers: {
					'Content-Type': 'text/html; charset=UTF-8',
				},
			});
		}

		// ===== /ip 返回 JSON 格式的服务器自身 IP 信息 =====
		const IP_PATH = PREFIX + 'ip'
		if (url.pathname === IP_PATH || url.pathname === IP_PATH + '/') {
			return ipInfoResponse()
		}

		let path = urlObj.searchParams.get('q')
		if (path) {
			return Response.redirect('https://' + urlObj.host + PREFIX + path, 301)
		} else if (url.pathname.toLowerCase() == '/favicon.ico') {
			const iconData = 'iVBORw0KGgoAAAANSUhEUgAABAAAAAQACAYAAAB/HSuDAAAAAXNSR0IArs4c6QAAIABJREFUeF7s3QmcHHWZ//HvUz0TcnAJKJccggqCgAoKZKZqJhyyIN7iKrje67kokOkJyKLjCZmeEJRddNkV11tBV/2ruCiQmepOAmi8uRQRRA7lhiSETHc9/1eHsKIgmaN7uo5Pv155caTq93u+76dy9NPd1SYeCCCAAAIIIIAAAggggAACCCCQewHLfUICIIAAAggggAACCCCAAAIIIICAGABwESCAAAIIIIAAAggggAACCCBQAAEGAAVoMhERQAABBBBAAAEEEEAAAQQQYADANYAAAggggAACCCCAAAIIIIBAAQQYABSgyUREAAEEEEAAAQQQQAABBBBAgAEA1wACCCCAAAIIIIAAAgggUAABBgAFaDIREUAAAQQQQAABBBBAAAEEEGAAwDWAAAIIIIAAAggggAACCCCAQAEEDAJqN1k9CwAAAABJRU5ErkJggg==';
			const binaryData = atob(iconData);
			const uint8Array = new Uint8Array(binaryData.length);
			for (let i = 0; i < binaryData.length; i++) {
				uint8Array[i] = binaryData.charCodeAt(i);
			}
			return new Response(uint8Array, {
				headers: {
					'Content-Type': 'image/png',
					'Cache-Control': 'public, max-age=86400',
					'access-control-allow-origin': '*',
				},
			});
		}

		// cfworker 会把路径中的 `//` 合并成 `/`
		path = urlObj.href.substr(urlObj.origin.length + PREFIX.length).replace(/^https?:\/+/, 'https://')

		// ★ 优先处理 blob/raw（需要特殊重写）
		if (isBlobOrRaw(path)) {
			if (Config.jsdelivr) {
				const newUrl = path.replace('/blob/', '@').replace(/^(?:https?:\/\/)?github\.com/, 'https://cdn.jsdelivr.net/gh')
				return Response.redirect(newUrl, 302)
			} else {
				path = path.replace('/blob/', '/raw/')
				return httpHandler(request, path, env)
			}
		}

		// ★ 其余所有命中规则的（GitHub 全站 + API + CDN）统一走代理
		if (matchAnyProxy(path)) {
			return httpHandler(request, path, env)
		}

		// 未命中规则时的默认行为
		if (env.URL302) {
			return Response.redirect(env.URL302, 302);
		} else if (env.URL) {
			if (env.URL.toLowerCase() == 'nginx') {
				return new Response(await nginx(), {
					headers: {
						'Content-Type': 'text/html; charset=UTF-8',
					},
				});
			} else return fetch(new Request(env.URL, request));
		} else {
			return new Response(await githubInterface(), {
				headers: {
					'Content-Type': 'text/html; charset=UTF-8',
				},
			});
		}
	}
}

async function githubInterface() {
	// 保持原样即可，如需添加 API 示例可参考：
	//   https://你的worker/https://api.github.com/repos/hunshcn/project
	const html = `<!DOCTYPE html>
	<html lang="zh-CN">
	<head>
		<title>GitHub 文件加速</title>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<style>
			:root {
				--primary-color: #0d1117;
				--secondary-color: #161b22;
				--text-color: #f0f6fc;
				--accent-color: #58a6ff;
				--gradient-start: #24292e;
				--gradient-end: #0d1117;
				--shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
				--border-color: rgba(255, 255, 255, 0.1);
				--github-corner-bg: #f0f6fc;
				--github-corner-fg: rgb(21,26,31);
			}
			* { box-sizing: border-box; margin: 0; padding: 0; }
			body {
				font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
				min-height: 100vh;
				background: linear-gradient(135deg, var(--gradient-start) 0%, var(--gradient-end) 100%);
				color: var(--text-color);
				display: flex;
				justify-content: center;
				align-items: center;
				padding: 20px;
			}
			.container { width: 100%; max-width: 800px; padding: 40px 20px; text-align: center; }
			.title { font-size: 2.5rem; font-weight: 600; margin-bottom: 1.5rem; letter-spacing: -0.5px; }
			.title .emoji { display: inline-block; color: #f1fa8c; margin-right: 8px; }
			.tips a { color: var(--accent-color); text-decoration: none; border-bottom: 1px dashed rgba(88, 166, 255, 0.5); }
			.search-container { position: relative; max-width: 600px; margin: 2rem auto; }
			.search-input {
				width: 100%; height: 56px; padding: 0 60px 0 24px; font-size: 1rem; color: #1f2937;
				background: rgba(255, 255, 255, 0.95); border: 2px solid transparent; border-radius: 12px;
				box-shadow: var(--shadow); transition: all 0.3s ease;
			}
			.search-input:focus { border-color: var(--accent-color); background: white; outline: none; }
			.search-button {
				position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
				width: 44px; height: 44px; border: none; border-radius: 8px;
				background: var(--accent-color); color: white; cursor: pointer;
			}
			.search-button:hover { background: #4187d7; }
			.tips { margin-top: 2rem; color: rgba(240, 246, 252, 0.8); line-height: 1.6; text-align: left; padding-left: 1.8rem; }
			.example { margin-top: 2.5rem; padding: 1.8rem; background: rgba(255, 255, 255, 0.05);
				border-radius: 12px; text-align: left; border: 1px solid var(--border-color); overflow-x: auto; }
			.example-title { color: var(--accent-color); margin-bottom: 1.5rem; font-size: 1.1rem; font-weight: 600;
				padding-bottom: 0.8rem; border-bottom: 1px solid var(--border-color); }
			.example p { margin: 0.9rem 0; font-family: "SFMono-Regular", Consolas, monospace;
				font-size: 0.95rem; padding-left: 1.5rem; word-break: break-all; }
			.url-part { color: var(--accent-color); }
			.github-corner { position: fixed; top: 0; right: 0; z-index: 999; }
			.github-corner svg { fill: var(--github-corner-bg); color: var(--github-corner-fg); position: absolute;
				top: 0; border: 0; right: 0; width: 80px; height: 80px; }
			.github-corner .octo-body, .github-corner .octo-arm { fill: var(--github-corner-fg); }
			.github-corner:hover .octo-arm { animation: octocat-wave 560ms ease-in-out; }
			@keyframes octocat-wave {
				0%, 100% { transform: rotate(0); }
				20%, 60% { transform: rotate(-25deg); }
				40%, 80% { transform: rotate(10deg); }
			}
			@media (max-width: 640px) {
				.title { font-size: 2rem; }
				.search-input { height: 50px; font-size: 0.9rem; }
				.example p { font-size: 0.85rem; padding-left: 0.8rem; }
			}
		</style>
	</head>
	<body>
		<a href="https://github.com/cmliu/CF-Workers-GitHub" target="_blank" class="github-corner" aria-label="View source on Github">
			<svg viewBox="0 0 250 250" aria-hidden="true">
				<path d="M0,0 L115,115 L130,115 L142,142 L250,250 L250,0 Z"></path>
				<path d="M128.3,109.0 C113.8,99.7 119.0,89.6 119.0,89.6 C122.0,82.7 120.5,78.6 120.5,78.6 C119.2,72.0 123.4,76.3 123.4,76.3 C127.3,80.9 125.5,87.3 125.5,87.3 C122.9,97.6 130.6,101.9 134.4,103.2" fill="currentColor" class="octo-arm"></path>
				<path d="M115.0,115.0 C114.9,115.1 118.7,116.5 119.8,115.4 L133.7,101.6 C136.9,99.2 139.9,98.4 142.2,98.6 C133.8,88.0 127.5,74.4 143.8,58.0 C148.5,53.4 154.0,51.2 159.7,51.0 C160.3,49.4 163.2,43.6 171.4,40.1 C171.4,40.1 176.1,42.5 178.8,56.2 C183.1,58.6 187.2,61.8 190.9,65.4 C194.5,69.0 197.7,73.2 200.1,77.6 C213.8,80.2 216.3,84.9 216.3,84.9 C212.7,93.1 206.9,96.0 205.4,96.6 C205.1,102.4 203.0,107.8 198.3,112.5 C181.9,128.9 168.3,122.5 157.7,114.1 C157.9,116.9 156.7,120.9 152.7,124.9 L141.0,136.5 C139.8,137.7 141.6,141.9 141.8,141.8 Z" fill="currentColor" class="octo-body"></path>
			</svg>
		</a>
		<div class="container">
			<h1 class="title"><span class="emoji">📦</span>GitHub 文件加速</h1>
			<form onsubmit="toSubmit(event)" class="search-container">
				<input type="text" class="search-input" name="q"
					placeholder="请输入 GitHub 文件或 API 链接"
					pattern="^((https|http):\/\/)?((github\.com\/.+?\/.+?\/(?:releases|archive|blob|raw|suites|issues|pull|tree|commit))|((?:raw|gist)\.(?:githubusercontent|github)\.com)|api\.github\.com)\/.+$"
					required>
				<button type="submit" class="search-button">
					<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
						<path d="M13 5l7 7-7 7M5 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
				</button>
			</form>
			<div class="tips">
				<p>✨ 支持带协议头(https://)或不带的 GitHub 链接，以及 api.github.com 的 REST API</p>
				<p>🚀 release、archive 使用 cf 加速，blob/raw 走 raw 或 JsDelivr</p>
				<p>🌐 查询服务器 IP 信息：<span class="url-part">/ip</span></p>
				<p>🔑 配置 GITHUB_TOKEN 环境变量后，api.github.com 请求在服务端注入鉴权（支持写操作）</p>
				<p>⚠️ 注意：暂不支持文件夹下载</p>
			</div>
			<div class="example">
				<div class="example-title">📃 合法输入示例：</div>
				<p>📄 分支源码：<span class="url-part">github.com/hunshcn/project/archive/master.zip</span></p>
				<p>📂 release文件：<span class="url-part">github.com/hunshcn/project/releases/download/v0.1.0/example.zip</span></p>
				<p>💾 commit文件：<span class="url-part">github.com/hunshcn/project/blob/123/filename</span></p>
				<p>🖨️ gist：<span class="url-part">gist.githubusercontent.com/cielpy/123/raw/cmd.py</span></p>
				<p>🔌 API：<span class="url-part">api.github.com/repos/hunshcn/project</span></p>
				<p>🔌 API：<span class="url-part">api.github.com/users/hunshcn</span></p>
			</div>
		</div>
		<script>
			function toSubmit(e) {
				e.preventDefault();
				const input = document.getElementsByName('q')[0];
				const baseUrl = location.href.substr(0, location.href.lastIndexOf('/') + 1);
				window.open(baseUrl + input.value);
			}
		</script>
	</body>
	</html>`;
	return html;
}

async function ADD(envadd) {
	var addtext = envadd.replace(/[	 |"'\r\n]+/g, ',').replace(/,+/g, ',');
	if (addtext.charAt(0) == ',') addtext = addtext.slice(1);
	if (addtext.charAt(addtext.length - 1) == ',') addtext = addtext.slice(0, addtext.length - 1);
	return addtext.split(',');
}

async function nginx() {
	const text = `
	<!DOCTYPE html>
	<html>
	<head>
	<title>Welcome to nginx!</title>
	<style>
		body { width: 35em; margin: 0 auto; font-family: Tahoma, Verdana, Arial, sans-serif; }
	</style>
	</head>
	<body>
	<h1>Welcome to nginx!</h1>
	<p>If you see this page, the nginx web server is successfully installed and
	working. Further configuration is required.</p>
	<p>For online documentation and support please refer to
	<a href="http://nginx.org/">nginx.org</a>.<br/>
	Commercial support is available at
	<a href="http://nginx.com/">nginx.com</a>.</p>
	<p><em>Thank you for using nginx.</em></p>
	</body>
	</html>
	`
	return text;
}
