import os
import shutil

STORAGE_REPO = os.environ.get('CLOUD', 'boringstudent/new-cloud')
REPO_OWNER = STORAGE_REPO.split('/')[0]
REPO_NAME = STORAGE_REPO.split('/')[1] if '/' in STORAGE_REPO else STORAGE_REPO
DEFAULT_BRANCH = os.environ.get('BRANCH', 'main')

template = """
<html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>{title} - boring_student</title>
        <link rel="icon" href="./favicon.ico" type="image/x-icon">
        <link rel="shortcut icon" href="./favicon.ico" type="image/x-icon">
        <style>
            html, body {{
                margin: 0;
                padding: 0;
                height: 100%;
                min-height: 100vh;
                background-size: cover;
                background-position: center;
            }}
            body {{
                background: url('https://www.loliapi.com/acg') fixed;
                font-family: Arial, sans-serif;
            }}
            .container {{
                max-width: 800px;
                margin: 20px auto;
                background: rgba(255, 255, 255, 0.9);
                border-radius: 15px;
                padding: 30px;
                box-shadow: 0 0 20px rgba(0,0,0,0.2);
            }}
            .entry {{
                text-decoration: none !important;
                color: #333 !important;
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px;
                margin: 8px 0;
                background: rgba(245, 245, 245, 0.9);
                border-radius: 8px;
                transition: all 0.3s;
            }}
            .entry:hover {{
                transform: translateX(10px);
                box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                background: rgba(235, 245, 255, 0.9);
            }}
            .file-info {{
                display: flex;
                gap: 15px;
                color: #666;
                font-size: 0.9em;
            }}
            h1 {{
                color: #333;
                border-bottom: 2px solid #eee;
                padding-bottom: 10px;
            }}
            a {{
                color: #2c82c9;
                text-decoration: none;
            }}
            a:hover {{
                text-decoration: underline;
            }}
            .btn {{
                background: #2c82c9;
                color: white;
                border: none;
                padding: 10px 20px;
                border-radius: 8px;
                cursor: pointer;
                font-size: 14px;
                transition: background 0.3s;
            }}
            .btn:hover {{
                background: #1a5a8a;
            }}
            .btn:disabled {{
                background: #ccc;
                cursor: not-allowed;
            }}
            .modal-overlay {{
                display: none;
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.5);
                z-index: 1000;
                justify-content: center;
                align-items: center;
            }}
            .modal-overlay.show {{
                display: flex;
            }}
            .modal-content {{
                background: rgba(255, 255, 255, 0.95);
                border-radius: 15px;
                padding: 30px;
                width: 90%;
                max-width: 400px;
                box-shadow: 0 0 30px rgba(0, 0, 0, 0.3);
                position: relative;
            }}
            .modal-close {{
                position: absolute;
                top: 15px;
                right: 15px;
                font-size: 24px;
                cursor: pointer;
                color: #666;
            }}
            .modal-close:hover {{
                color: #333;
            }}
            .form-group {{
                margin-bottom: 15px;
            }}
            .form-group label {{
                display: block;
                margin-bottom: 5px;
                color: #333;
            }}
            .form-group input[type="text"],
            .form-group input[type="password"],
            .form-group input[type="file"] {{
                width: 100%;
                padding: 10px;
                border: 1px solid #ddd;
                border-radius: 8px;
                box-sizing: border-box;
                font-size: 14px;
            }}
            .form-group input[type="file"] {{
                padding: 5px;
            }}
            .progress-container {{
                margin: 15px 0;
            }}
            .progress-bar {{
                width: 100%;
                height: 20px;
                background: #eee;
                border-radius: 10px;
                overflow: hidden;
            }}
            .progress-fill {{
                height: 100%;
                background: #2c82c9;
                width: 0%;
                transition: width 0.3s;
                border-radius: 10px;
            }}
            .progress-text {{
                text-align: center;
                margin-top: 5px;
                font-size: 14px;
                color: #666;
            }}
            .message {{
                margin-top: 15px;
                padding: 10px;
                border-radius: 8px;
                font-size: 14px;
            }}
            .message.success {{
                background: #d4edda;
                color: #155724;
            }}
            .message.error {{
                background: #f8d7da;
                color: #721c24;
            }}
            .loading {{
                text-align: center;
                color: #666;
                padding: 20px;
            }}
            .delete-btn {{
                background: #dc3545;
                color: white;
                border: none;
                padding: 5px 10px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                margin-left: 10px;
                transition: background 0.3s;
            }}
            .delete-btn:hover {{
                background: #c82333;
            }}
            .menu-btn {{
                background: transparent;
                color: #666;
                border: none;
                padding: 5px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 16px;
                margin-left: 10px;
                transition: all 0.3s;
            }}
            .menu-btn:hover {{
                background: rgba(0,0,0,0.1);
            }}
            .context-menu {{
                display: none;
                position: fixed;
                background: white;
                border: 1px solid #ddd;
                border-radius: 8px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.2);
                z-index: 2000;
                min-width: 120px;
            }}
            .context-menu.show {{
                display: block;
            }}
            .context-menu-item {{
                padding: 8px 12px;
                cursor: pointer;
                font-size: 14px;
                color: #333;
            }}
            .context-menu-item:hover {{
                background: #f0f0f0;
            }}
            .context-menu-item.danger {{
                color: #dc3545;
            }}
            .toast {{
                display: none;
                position: fixed;
                bottom: 90px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(51, 51, 51, 0.9);
                color: white;
                padding: 10px 20px;
                border-radius: 8px;
                font-size: 14px;
                z-index: 3000;
            }}
            .toast.show {{
                display: block;
            }}
            .props-list {{
                font-family: 'Segoe UI', 'Microsoft YaHei', Arial, sans-serif;
                font-size: 14px;
            }}
            .prop-row {{
                display: flex;
                padding: 10px 5px;
                border-bottom: 1px solid #f0f0f0;
                line-height: 1.6;
                align-items: baseline;
            }}
            .prop-row:last-child {{
                border-bottom: none;
            }}
            .prop-label {{
                width: 110px;
                flex-shrink: 0;
                color: #999;
                font-weight: 500;
            }}
            .prop-value {{
                color: #333;
                word-break: break-all;
                min-width: 0;
            }}
            .prop-value.mono {{
                font-family: Consolas, 'Courier New', monospace;
                font-size: 12px;
                background: #f6f8fa;
                padding: 2px 6px;
                border-radius: 4px;
            }}
            .preview-modal-content {{
                max-width: 700px;
                max-height: 80vh;
                overflow-y: auto;
            }}
            .preview-audio, .preview-video {{
                width: 100%;
                max-width: 640px;
                margin: 10px 0;
            }}
            .preview-text {{
                width: 100%;
                height: 300px;
                padding: 10px;
                border: 1px solid #ddd;
                border-radius: 8px;
                font-family: monospace;
                font-size: 14px;
                resize: none;
                background: #f8f8f8;
            }}
            .entry > span:first-child {{
                word-break: break-all;
                min-width: 0;
            }}
            @media (max-width: 700px) {{
                .container {{
                    margin: 75px 10px 20px 10px;
                    padding: 20px 15px;
                }}
                .auth-bar {{
                    left: 10px;
                    right: 10px;
                    justify-content: flex-end;
                }}
                .modal-content {{
                    padding: 20px;
                }}
                .preview-text {{
                    height: 200px;
                }}
                .entry {{
                    padding: 10px;
                }}
            }}
        </style>
    </head>
    <body>
        <div class="container">
            <h1 id="pageTitle">Home</h1>
            <div id="breadcrumbs" style="margin: 20px 0; font-size: 1.1em;"></div>
            <div id="fileListContainer" class="loading">加载中...</div>
        </div>
        <button class="btn" onclick="openUploadModal()" style="position: fixed; bottom: 30px; right: 30px; z-index: 100;">上传文件</button>
        <div class="auth-bar" style="position: fixed; top: 20px; right: 30px; z-index: 100; display: flex; align-items: center; gap: 10px;">
            <span id="authUser" style="display: none; background: rgba(255, 255, 255, 0.9); padding: 10px 15px; border-radius: 8px; color: #333; font-size: 14px; box-shadow: 0 0 10px rgba(0,0,0,0.1);"></span>
            <button class="btn" id="authBtn" onclick="handleAuthBtnClick()">登录</button>
        </div>

        <div id="loginModal" class="modal-overlay">
            <div class="modal-content">
                <span class="modal-close" onclick="closeLoginModal()">&times;</span>
                <h2>登录</h2>
                <div class="form-group">
                    <label>用户名</label>
                    <input type="text" id="loginUsername" placeholder="请输入用户名">
                </div>
                <div class="form-group">
                    <label>密码</label>
                    <input type="password" id="loginPassword" placeholder="请输入密码">
                </div>
                <button class="btn" onclick="doLogin()" id="loginBtn" style="width: 100%;">登录</button>
                <div id="loginMessage" class="message"></div>
            </div>
        </div>

        <div id="uploadModal" class="modal-overlay">
            <div class="modal-content">
                <span class="modal-close" onclick="closeUploadModal()">&times;</span>
                <h2>上传文件</h2>
                <div id="dropZone" style="border: 2px dashed #2c82c9; border-radius: 8px; padding: 30px 15px; text-align: center; color: #666; cursor: pointer; transition: background 0.3s; line-height: 1.8;">
                    拖拽文件或文件夹到此处<br>或点击选择文件
                </div>
                <input type="file" id="fileInput" multiple style="display: none;">
                <input type="file" id="folderInput" webkitdirectory style="display: none;">
                <div style="display: flex; gap: 10px; margin-top: 10px;">
                    <button class="btn" id="pickFileBtn" style="flex: 1;">选择文件</button>
                    <button class="btn" id="pickFolderBtn" style="flex: 1;">选择文件夹</button>
                </div>
                <div id="selectedFiles" style="margin-top: 10px; font-size: 13px; color: #666; max-height: 80px; overflow-y: auto; word-break: break-all;"></div>
                <div class="progress-container" style="display: none;">
                    <div class="progress-bar">
                        <div class="progress-fill" id="progressFill"></div>
                    </div>
                    <div class="progress-text" id="progressText">0%</div>
                </div>
                <button class="btn" onclick="uploadFile()" id="uploadBtn" style="width: 100%; margin-top: 15px;">开始上传</button>
                <div id="uploadMessage" class="message"></div>
            </div>
        </div>

        <div id="deleteModal" class="modal-overlay">
            <div class="modal-content">
                <span class="modal-close" onclick="closeDeleteModal()">&times;</span>
                <h2>删除文件</h2>
                <p style="color: #666; margin-bottom: 15px;" id="deleteConfirmText"></p>
                <div id="deleteAuthFields">
                    <div class="form-group">
                        <label>用户名</label>
                        <input type="text" id="deleteUsername" placeholder="请输入用户名">
                    </div>
                    <div class="form-group">
                        <label>密码</label>
                        <input type="password" id="deletePassword" placeholder="请输入密码">
                    </div>
                    <div class="form-group" style="display: flex; align-items: center; gap: 8px; margin-bottom: 5px;">
                        <input type="checkbox" id="deleteRememberMe" style="width: auto; margin: 0;">
                        <label for="deleteRememberMe" style="margin: 0;">保持登录</label>
                    </div>
                </div>
                <button class="btn" onclick="confirmDelete()" id="deleteBtn" style="width: 100%;">确认删除</button>
                <div id="deleteMessage" class="message"></div>
            </div>
        </div>

        <div id="previewModal" class="modal-overlay">
            <div class="modal-content preview-modal-content">
                <span class="modal-close" onclick="closePreviewModal()">&times;</span>
                <h2 id="previewTitle">预览文件</h2>
                <div id="previewContent"></div>
                <div id="previewActions" style="margin-top: 15px; display: none;">
                    <button class="btn" onclick="savePreviewFile()" id="savePreviewBtn" style="width: 100%;">保存修改</button>
                    <div id="previewMessage" class="message"></div>
                </div>
            </div>
        </div>

        <div id="propertiesModal" class="modal-overlay">
            <div class="modal-content preview-modal-content">
                <span class="modal-close" onclick="document.getElementById('propertiesModal').classList.remove('show')">&times;</span>
                <h2 id="propertiesTitle">属性</h2>
                <div id="propertiesContent"></div>
            </div>
        </div>

        <div id="toast" class="toast"></div>

        <div id="contextMenu" class="context-menu">
            <div class="context-menu-item" id="menuProperties" onclick="handleMenuAction('properties')">属性</div>
            <div class="context-menu-item" id="menuPreview" onclick="handleMenuAction('preview')">预览</div>
            <div class="context-menu-item" id="menuEdit" onclick="handleMenuAction('edit')">修改</div>
            <div class="context-menu-item" id="menuDownload" onclick="handleMenuAction('download')">下载</div>
            <div class="context-menu-item danger" id="menuDelete" onclick="handleMenuAction('delete')">删除</div>
        </div>

        <script>
            var REPO_OWNER = '{repo_owner}';
            var REPO_NAME = '{repo_name}';
            var DEFAULT_BRANCH = '{default_branch}';
            var PROXY_BASE = '';

            function ghUrl(url) {{
                if (PROXY_BASE) {{
                    return PROXY_BASE + '/' + url.replace(/^https?:\\/\\//, '');
                }}
                return url;
            }}

            var ghApiKey = null;
            var ghApiKeyFetching = false;

            function applyGhAuth(xhr) {{
                if (ghApiKey) {{
                    xhr.setRequestHeader('Authorization', 'Bearer ' + ghApiKey);
                }}
            }}

            function fetchGhKey(done) {{
                var finish = function() {{
                    ghApiKeyFetching = false;
                    if (done) done();
                }};
                if (ghApiKey || ghApiKeyFetching) {{ finish(); return; }}
                var saved = getSavedAuth();
                if (!saved) {{ finish(); return; }}
                ghApiKeyFetching = true;
                var params = 'username=' + encodeURIComponent(saved.u) + '&password=' + encodeURIComponent(saved.p);
                var xhr = new XMLHttpRequest();
                xhr.open('GET', 'https://api.boring-student.cn/?' + params, true);
                xhr.onload = function() {{
                    if (xhr.status === 200) {{
                        try {{
                            var response = JSON.parse(xhr.responseText);
                            if (response.success && response.key) ghApiKey = response.key;
                        }} catch (e) {{}}
                    }}
                    finish();
                }};
                xhr.onerror = finish;
                xhr.send();
            }}

            function loadConfig(done) {{
                var xhr = new XMLHttpRequest();
                xhr.open('GET', '/config.json', true);
                xhr.onload = function() {{
                    if (xhr.status === 200) {{
                        try {{
                            var cfg = JSON.parse(xhr.responseText);
                            if (cfg && cfg.proxy) {{
                                PROXY_BASE = String(cfg.proxy).replace(/\\/+$/, '');
                            }}
                        }} catch (e) {{}}
                    }}
                    done();
                }};
                xhr.onerror = function() {{ done(); }};
                xhr.send();
            }}

            var menuFileInfo = {{}};
            var previewFileInfo = {{}};
            var fileTreeCache = null;
            var menuOpenedAt = 0;

            var CHUNK_SIZE_LEVELS = [
                Math.floor((104857600 - 4096) * 3 / 4),
                Math.floor((73400320 - 4096) * 3 / 4),
                Math.floor((41943040 - 4096) * 3 / 4),
                Math.floor((20971520 - 4096) * 3 / 4)
            ];
            var chunkSizeLevel = 0;
            var PART_SUFFIX = /\\.part(\\d+)$/;

            function getPartNumber(name) {{
                var m = name.match(PART_SUFFIX);
                return m ? parseInt(m[1], 10) : 0;
            }}

            var AUTH_STORAGE_KEY = 'cloud_web_auth';

            function saveAuth(username, password) {{
                try {{
                    localStorage.setItem(AUTH_STORAGE_KEY, btoa(unescape(encodeURIComponent(JSON.stringify({{ u: username, p: password }})))));
                }} catch (e) {{}}
            }}

            function getSavedAuth() {{
                try {{
                    var data = localStorage.getItem(AUTH_STORAGE_KEY);
                    if (!data) return null;
                    var obj = JSON.parse(decodeURIComponent(escape(atob(data))));
                    if (obj && obj.u && obj.p) return obj;
                    return null;
                }} catch (e) {{
                    return null;
                }}
            }}

            function clearAuth() {{
                try {{
                    localStorage.removeItem(AUTH_STORAGE_KEY);
                }} catch (e) {{}}
            }}

            function handleRememberAuth(username, password, remember) {{
                if (remember) {{
                    saveAuth(username, password);
                }} else {{
                    clearAuth();
                }}
                updateAuthBtn();
            }}

            function fillAuthInputs(usernameId, passwordId, checkboxId) {{
                var saved = getSavedAuth();
                if (saved) {{
                    document.getElementById(usernameId).value = saved.u;
                    document.getElementById(passwordId).value = saved.p;
                    document.getElementById(checkboxId).checked = true;
                }}
            }}

            function updateAuthBtn() {{
                var btn = document.getElementById('authBtn');
                var user = document.getElementById('authUser');
                var saved = getSavedAuth();
                if (btn) {{
                    btn.textContent = saved ? '退出登录' : '登录';
                }}
                if (user) {{
                    if (saved) {{
                        user.textContent = '当前用户: ' + saved.u;
                        user.style.display = 'block';
                    }} else {{
                        user.style.display = 'none';
                    }}
                }}
            }}

            function handleAuthBtnClick() {{
                if (getSavedAuth()) {{
                    logout();
                }} else {{
                    openLoginModal();
                }}
            }}

            function openLoginModal() {{
                document.getElementById('loginMessage').className = 'message';
                document.getElementById('loginMessage').textContent = '';
                document.getElementById('loginModal').classList.add('show');
            }}

            function closeLoginModal() {{
                document.getElementById('loginModal').classList.remove('show');
            }}

            function showLoginMessage(text, type) {{
                var msg = document.getElementById('loginMessage');
                msg.className = 'message ' + type;
                msg.textContent = text;
            }}

            function doLogin() {{
                var username = document.getElementById('loginUsername').value;
                var password = document.getElementById('loginPassword').value;
                var loginBtn = document.getElementById('loginBtn');

                if (!username || !password) {{
                    showLoginMessage('请输入用户名和密码', 'error');
                    return;
                }}

                loginBtn.disabled = true;
                showLoginMessage('正在登录...', 'success');

                var params = 'username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(password);
                var keyUrl = 'https://api.boring-student.cn/?' + params;

                var xhr = new XMLHttpRequest();
                xhr.open('GET', keyUrl, true);
                xhr.onload = function() {{
                    if (xhr.status === 200) {{
                        try {{
                            var response = JSON.parse(xhr.responseText);
                            if (response.success && response.key) {{
                                ghApiKey = response.key;
                                saveAuth(username, password);
                                updateAuthBtn();
                                showLoginMessage('登录成功！', 'success');
                                setTimeout(function() {{
                                    closeLoginModal();
                                    document.getElementById('loginBtn').disabled = false;
                                }}, 1000);
                            }} else {{
                                showLoginMessage('用户名或密码错误', 'error');
                                loginBtn.disabled = false;
                            }}
                        }} catch (e) {{
                            showLoginMessage('解析响应失败', 'error');
                            loginBtn.disabled = false;
                        }}
                    }} else {{
                        showLoginMessage('登录失败，状态码: ' + xhr.status, 'error');
                        loginBtn.disabled = false;
                    }}
                }};
                xhr.onerror = function() {{
                    showLoginMessage('网络错误，登录失败', 'error');
                    loginBtn.disabled = false;
                }};
                xhr.send();
            }}

            function logout() {{
                ghApiKey = null;
                clearAuth();
                updateAuthBtn();
                document.getElementById('deleteUsername').value = '';
                document.getElementById('deletePassword').value = '';
                document.getElementById('deleteRememberMe').checked = false;
                document.getElementById('loginUsername').value = '';
                document.getElementById('loginPassword').value = '';
            }}

            setInterval(function() {{
                loadFileList();
            }}, 60000);

            function openUploadModal() {{
                if (!getSavedAuth()) {{
                    openLoginModal();
                    showLoginMessage('请先登录后再上传文件', 'error');
                    return;
                }}
                document.getElementById('uploadModal').classList.add('show');
            }}

            function closeUploadModal() {{
                document.getElementById('uploadModal').classList.remove('show');
                document.getElementById('uploadMessage').className = 'message';
                document.getElementById('uploadMessage').textContent = '';
                document.querySelector('.progress-container').style.display = 'none';
                document.getElementById('progressFill').style.width = '0%';
                document.getElementById('progressText').textContent = '0%';
                pendingFiles = [];
                document.getElementById('selectedFiles').textContent = '';
                document.getElementById('fileInput').value = '';
                document.getElementById('folderInput').value = '';
            }}

            function showMessage(text, type) {{
                var msg = document.getElementById('uploadMessage');
                msg.className = 'message ' + type;
                msg.textContent = text;
            }}

            function formatSize(size) {{
                if (size === undefined || size === null) return '0B';
                for (var unit of ['B', 'KB', 'MB', 'GB', 'TB']) {{
                    if (size < 1024.0) {{
                        return size.toFixed(1) + unit;
                    }}
                    size /= 1024.0;
                }}
                return size.toFixed(1) + 'PB';
            }}

            function fetchFolderSizes() {{
                if (fileTreeCache) {{
                    updateFolderSizes();
                    return;
                }}
                var xhr = new XMLHttpRequest();
                xhr.open('GET', ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/commits/' + DEFAULT_BRANCH), true);
                applyGhAuth(xhr);
                xhr.onload = function() {{
                    if (xhr.status === 200) {{
                        try {{
                            var commitData = JSON.parse(xhr.responseText);
                            var treeSha = commitData.commit.tree.sha;
                            var treeXhr = new XMLHttpRequest();
                            treeXhr.open('GET', ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/git/trees/' + treeSha + '?recursive=1'), true);
                            applyGhAuth(treeXhr);
                            treeXhr.onload = function() {{
                                if (treeXhr.status === 200) {{
                                    try {{
                                        var data = JSON.parse(treeXhr.responseText);
                                        fileTreeCache = data.tree || [];
                                        updateFolderSizes();
                                    }} catch (e) {{}}
                                }}
                            }};
                            treeXhr.send();
                        }} catch (e) {{}}
                    }}
                }};
                xhr.send();
            }}

            function updateFolderSizes() {{
                if (!fileTreeCache) return;
                var sizeSpans = document.querySelectorAll('.dir-size');
                sizeSpans.forEach(function(span) {{
                    var dirPath = span.getAttribute('data-path');
                    if (!dirPath) return;
                    var totalSize = 0;
                    var prefix = dirPath + '/';
                    fileTreeCache.forEach(function(item) {{
                        if (item.type === 'blob' && item.path && item.path.indexOf(prefix) === 0) {{
                            totalSize += (item.size || 0);
                        }}
                    }});
                    span.textContent = formatSize(totalSize);
                }});
            }}

            function escapeHtml(text) {{
                var div = document.createElement('div');
                div.textContent = text;
                return div.innerHTML;
            }}

            function propRow(label, value, mono) {{
                return '<div class="prop-row"><span class="prop-label">' + label + '</span><span class="prop-value' + (mono ? ' mono' : '') + '">' + value + '</span></div>';
            }}

            function showProperties(filePath, fileName, fileType) {{
                document.getElementById('propertiesTitle').textContent = '属性: ' + fileName;
                var content = document.getElementById('propertiesContent');
                var propsHtml = '<div class="props-list">';
                propsHtml += propRow('名称', escapeHtml(fileName));
                propsHtml += propRow('类型', fileType === 'dir' ? '文件夹' : (menuFileInfo.chunked ? '文件（分片存储）' : '文件'));
                propsHtml += propRow('路径', escapeHtml(filePath), true);
                if (fileType === 'dir') {{
                    var fileCount = 0, dirCount = 0, totalSize = 0;
                    if (fileTreeCache) {{
                        var prefix = filePath + '/';
                        fileTreeCache.forEach(function(item) {{
                            if (item.path && item.path.indexOf(prefix) === 0) {{
                                if (item.type === 'blob') {{ fileCount++; totalSize += (item.size || 0); }}
                                else if (item.type === 'tree') {{ dirCount++; }}
                            }}
                        }});
                    }}
                    propsHtml += propRow('包含文件', fileCount + ' 个');
                    propsHtml += propRow('包含子文件夹', dirCount + ' 个');
                    propsHtml += propRow('总大小', formatSize(totalSize));
                }} else if (menuFileInfo.chunked) {{
                    propsHtml += propRow('分片数量', (menuFileInfo.parts ? menuFileInfo.parts.length : 0) + ' 个');
                    propsHtml += propRow('总大小', formatSize(menuFileInfo.size));
                }} else {{
                    propsHtml += propRow('大小', formatSize(menuFileInfo.size));
                    propsHtml += propRow('SHA', menuFileInfo.sha || 'N/A', true);
                }}
                propsHtml += '</div>';
                content.innerHTML = propsHtml;
                document.getElementById('propertiesModal').classList.add('show');
            }}

            function downloadFolder(filePath, fileName) {{
                var url = ghUrl('https://github.com/' + REPO_OWNER + '/' + REPO_NAME + '/archive/refs/heads/' + DEFAULT_BRANCH + '.zip');
                window.open(url, '_blank');
            }}

            var deleteFilePath = '';
            var deleteFileSha = '';
            var deleteFileType = 'file';
            var deleteParts = null;

            function openDeleteModal(filePath, fileSha, fileName, fileType) {{
                deleteFilePath = filePath;
                deleteFileSha = fileSha;
                deleteFileType = fileType || 'file';
                deleteParts = deleteFileType === 'chunked' ? (menuFileInfo.parts || []) : null;
                var deleteBtn = document.getElementById('deleteBtn');
                deleteBtn.disabled = false;
                var deleteMsg = document.getElementById('deleteMessage');
                deleteMsg.className = 'message';
                deleteMsg.textContent = '';
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
            }}

            function closeDeleteModal() {{
                document.getElementById('deleteModal').classList.remove('show');
                document.getElementById('deleteMessage').className = 'message';
                document.getElementById('deleteMessage').textContent = '';
                document.getElementById('deleteUsername').value = '';
                document.getElementById('deletePassword').value = '';
            }}

            function showDeleteMessage(text, type) {{
                var msg = document.getElementById('deleteMessage');
                msg.className = 'message ' + type;
                msg.textContent = text;
            }}

            function bindEntryEvents(entry, fileInfo) {{
                entry.addEventListener('contextmenu', function(e) {{
                    e.preventDefault();
                    e.stopPropagation();
                    openContextMenu(e.clientX, e.clientY, fileInfo);
                }});
                entry.addEventListener('click', function(e) {{
                    if (Date.now() - menuOpenedAt < 400) {{
                        e.preventDefault();
                        e.stopPropagation();
                    }}
                }});
                var touchTimer = null;
                var touchX = 0;
                var touchY = 0;
                entry.addEventListener('touchstart', function(e) {{
                    if (e.touches.length !== 1) return;
                    touchX = e.touches[0].clientX;
                    touchY = e.touches[0].clientY;
                    touchTimer = setTimeout(function() {{
                        touchTimer = null;
                        openContextMenu(touchX, touchY, fileInfo);
                    }}, 500);
                }});
                entry.addEventListener('touchmove', function() {{
                    if (touchTimer) {{
                        clearTimeout(touchTimer);
                        touchTimer = null;
                    }}
                }});
                entry.addEventListener('touchend', function() {{
                    if (touchTimer) {{
                        clearTimeout(touchTimer);
                        touchTimer = null;
                    }}
                }});
            }}

            function openContextMenu(x, y, fileInfo) {{
                menuFileInfo = fileInfo;
                menuOpenedAt = Date.now();

                document.getElementById('menuPreview').style.display = fileInfo.type === 'dir' ? 'none' : '';
                document.getElementById('menuEdit').style.display = (fileInfo.type === 'dir' || fileInfo.chunked) ? 'none' : '';
                document.getElementById('menuDownload').style.display = fileInfo.type === 'dir' ? 'none' : '';
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
            }}

            function closeContextMenu() {{
                var menu = document.getElementById('contextMenu');
                menu.classList.remove('show');
                document.removeEventListener('click', closeContextMenuHandler);
            }}

            function closeContextMenuHandler(e) {{
                if (Date.now() - menuOpenedAt < 400) return;
                var menu = document.getElementById('contextMenu');
                if (!menu.contains(e.target)) {{
                    closeContextMenu();
                }}
            }}

            function handleMenuAction(action) {{
                closeContextMenu();
                var filePath = menuFileInfo.path;
                var fileSha = menuFileInfo.sha;
                var fileName = menuFileInfo.name;
                var fileType = menuFileInfo.type;

                if (action === 'properties') {{
                    showProperties(filePath, fileName, fileType);
                }} else if (action === 'preview') {{
                    previewFile(filePath, fileName);
                }} else if (action === 'edit') {{
                    editFile(filePath, fileName);
                }} else if (action === 'download') {{
                    if (fileType === 'dir') {{
                        downloadFolder(filePath, fileName);
                    }} else if (menuFileInfo.chunked) {{
                        downloadMergedFile(menuFileInfo.parts, fileName);
                    }} else {{
                        downloadFile(filePath, fileName);
                    }}
                }} else if (action === 'delete') {{
                    openDeleteModal(filePath, fileSha, fileName, menuFileInfo.chunked ? 'chunked' : fileType);
                }}
            }}

            function downloadFile(filePath, fileName) {{
                var url = ghUrl('https://raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME + '/' + DEFAULT_BRANCH + '/' + encodeURI(filePath));
                var link = document.createElement('a');
                link.href = url;
                link.download = fileName;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            }}

            function showToast(text) {{
                var toast = document.getElementById('toast');
                toast.textContent = text;
                toast.classList.add('show');
            }}

            function hideToast() {{
                document.getElementById('toast').classList.remove('show');
            }}

            function fetchMergedBlob(parts, onDone, onFail) {{
                var buffers = [];
                var index = 0;
                showToast('正在加载 0/' + parts.length + ' ...');

                var fail = function() {{
                    hideToast();
                    if (onFail) onFail();
                }};

                var next = function() {{
                    if (index >= parts.length) {{
                        hideToast();
                        onDone(new Blob(buffers));
                        return;
                    }}
                    var url = ghUrl('https://raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME + '/' + DEFAULT_BRANCH + '/' + encodeURI(parts[index].path));
                    var xhr = new XMLHttpRequest();
                    xhr.open('GET', url, true);
                    xhr.responseType = 'arraybuffer';
                    xhr.onload = function() {{
                        if (xhr.status === 200) {{
                            buffers.push(xhr.response);
                            index++;
                            showToast('正在加载 ' + index + '/' + parts.length + ' ...');
                            next();
                        }} else {{
                            fail();
                        }}
                    }};
                    xhr.onerror = fail;
                    xhr.send();
                }};
                next();
            }}

            function downloadMergedFile(parts, fileName) {{
                fetchMergedBlob(parts, function(blob) {{
                    var url = URL.createObjectURL(blob);
                    var link = document.createElement('a');
                    link.href = url;
                    link.download = fileName;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    setTimeout(function() {{ URL.revokeObjectURL(url); }}, 10000);
                }}, function() {{
                    showToast('下载失败，请重试');
                    setTimeout(hideToast, 2000);
                }});
            }}

            function getFileExtension(fileName) {{
                var parts = fileName.split('.');
                return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
            }}

            function previewFile(filePath, fileName) {{
                var ext = getFileExtension(fileName);
                var previewUrl = ghUrl('https://raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME + '/' + DEFAULT_BRANCH + '/' + encodeURI(filePath));
                
                previewFileInfo = {{
                    path: filePath,
                    name: fileName,
                    ext: ext
                }};
                
                document.getElementById('previewTitle').textContent = '预览: ' + fileName;
                var content = document.getElementById('previewContent');
                content.innerHTML = '';
                var loadingDiv = document.createElement('div');
                loadingDiv.className = 'loading';
                loadingDiv.textContent = '加载中...';
                content.appendChild(loadingDiv);
                document.getElementById('previewModal').classList.add('show');
                document.getElementById('previewActions').style.display = 'none';
                document.getElementById('previewMessage').className = 'message';
                document.getElementById('previewMessage').textContent = '';

                if (menuFileInfo.chunked) {{
                    fetchMergedBlob(menuFileInfo.parts, function(blob) {{
                        if (['mp3', 'wav', 'ogg', 'aac', 'flac'].indexOf(ext) !== -1) {{
                            content.innerHTML = '';
                            var audio = document.createElement('audio');
                            audio.src = URL.createObjectURL(blob);
                            audio.controls = true;
                            audio.className = 'preview-audio';
                            content.appendChild(audio);
                        }} else if (['mp4', 'webm', 'ogg', 'avi', 'mov'].indexOf(ext) !== -1) {{
                            content.innerHTML = '';
                            var video = document.createElement('video');
                            video.src = URL.createObjectURL(blob);
                            video.controls = true;
                            video.className = 'preview-video';
                            content.appendChild(video);
                        }} else if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'].indexOf(ext) !== -1) {{
                            content.innerHTML = '';
                            var img = document.createElement('img');
                            img.src = URL.createObjectURL(blob);
                            img.alt = fileName;
                            img.style.maxWidth = '100%';
                            img.style.maxHeight = '60vh';
                            img.style.borderRadius = '8px';
                            content.appendChild(img);
                        }} else {{
                            var textReader = new FileReader();
                            textReader.onload = function() {{
                                var textarea = document.createElement('textarea');
                                textarea.className = 'preview-text';
                                textarea.value = textReader.result;
                                textarea.readOnly = true;
                                content.innerHTML = '';
                                content.appendChild(textarea);
                            }};
                            textReader.readAsText(blob);
                        }}
                    }}, function() {{
                        content.innerHTML = '';
                        var msgDiv = document.createElement('div');
                        msgDiv.className = 'message error';
                        msgDiv.textContent = '无法加载文件分片';
                        content.appendChild(msgDiv);
                    }});
                    return;
                }}

                if (['mp3', 'wav', 'ogg', 'aac', 'flac'].indexOf(ext) !== -1) {{
                    content.innerHTML = '';
                    var audio = document.createElement('audio');
                    audio.src = previewUrl;
                    audio.controls = true;
                    audio.className = 'preview-audio';
                    content.appendChild(audio);
                }} else if (['mp4', 'webm', 'ogg', 'avi', 'mov'].indexOf(ext) !== -1) {{
                    content.innerHTML = '';
                    var video = document.createElement('video');
                    video.src = previewUrl;
                    video.controls = true;
                    video.className = 'preview-video';
                    content.appendChild(video);
                }} else if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'].indexOf(ext) !== -1) {{
                    content.innerHTML = '';
                    var img = document.createElement('img');
                    img.src = previewUrl;
                    img.alt = fileName;
                    img.style.maxWidth = '100%';
                    img.style.maxHeight = '60vh';
                    img.style.borderRadius = '8px';
                    content.appendChild(img);
                }} else {{
                    var xhr = new XMLHttpRequest();
                    xhr.open('GET', previewUrl, true);
                    xhr.onload = function() {{
                        if (xhr.status === 200) {{
                            var textarea = document.createElement('textarea');
                            textarea.className = 'preview-text';
                            textarea.value = xhr.responseText;
                            textarea.readOnly = true;
                            content.innerHTML = '';
                            content.appendChild(textarea);
                        }} else {{
                            content.innerHTML = '';
                            var msgDiv = document.createElement('div');
                            msgDiv.className = 'message error';
                            msgDiv.textContent = '无法加载文件内容';
                            content.appendChild(msgDiv);
                        }}
                    }};
                    xhr.onerror = function() {{
                        content.innerHTML = '';
                        var msgDiv = document.createElement('div');
                        msgDiv.className = 'message error';
                        msgDiv.textContent = '网络错误，无法加载文件';
                        content.appendChild(msgDiv);
                    }};
                    xhr.send();
                }}
            }}

            function editFile(filePath, fileName) {{
                var ext = getFileExtension(fileName);
                var previewUrl = ghUrl('https://raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME + '/' + DEFAULT_BRANCH + '/' + encodeURI(filePath));
                
                previewFileInfo = {{
                    path: filePath,
                    name: fileName,
                    ext: ext
                }};
                
                document.getElementById('previewTitle').textContent = '编辑: ' + fileName;
                var content = document.getElementById('previewContent');
                content.innerHTML = '';
                var loadingDiv = document.createElement('div');
                loadingDiv.className = 'loading';
                loadingDiv.textContent = '加载中...';
                content.appendChild(loadingDiv);
                document.getElementById('previewModal').classList.add('show');
                document.getElementById('previewActions').style.display = 'none';
                document.getElementById('previewMessage').className = 'message';
                document.getElementById('previewMessage').textContent = '';
                
                var xhr = new XMLHttpRequest();
                xhr.open('GET', previewUrl, true);
                xhr.onload = function() {{
                    if (xhr.status === 200) {{
                        var textarea = document.createElement('textarea');
                        textarea.className = 'preview-text';
                        textarea.value = xhr.responseText;
                        textarea.readOnly = false;
                        content.innerHTML = '';
                        content.appendChild(textarea);
                        document.getElementById('previewActions').style.display = 'block';
                    }} else {{
                        content.innerHTML = '';
                        var msgDiv = document.createElement('div');
                        msgDiv.className = 'message error';
                        msgDiv.textContent = '无法加载文件内容';
                        content.appendChild(msgDiv);
                    }}
                }};
                xhr.onerror = function() {{
                    content.innerHTML = '';
                    var msgDiv = document.createElement('div');
                    msgDiv.className = 'message error';
                    msgDiv.textContent = '网络错误，无法加载文件';
                    content.appendChild(msgDiv);
                }};
                xhr.send();
            }}

            function closePreviewModal() {{
                document.getElementById('previewModal').classList.remove('show');
            }}

            function showPreviewMessage(text, type) {{
                var msg = document.getElementById('previewMessage');
                msg.className = 'message ' + type;
                msg.textContent = text;
            }}

            function savePreviewFile() {{
                var textarea = document.querySelector('.preview-text');
                if (!textarea) return;
                
                var newContent = textarea.value;
                var saveBtn = document.getElementById('savePreviewBtn');
                
                saveBtn.disabled = true;
                showPreviewMessage('正在获取授权...', 'success');
                
                var savedAuth = getSavedAuth();
                var username, password;
                if (savedAuth) {{
                    username = savedAuth.u;
                    password = savedAuth.p;
                }} else {{
                    username = prompt('请输入用户名:');
                    password = prompt('请输入密码:');
                }}
                
                if (!username || !password) {{
                    showPreviewMessage('请输入用户名和密码', 'error');
                    saveBtn.disabled = false;
                    return;
                }}
                
                var params = 'username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(password);
                var keyUrl = 'https://api.boring-student.cn/?' + params;
                
                var xhr = new XMLHttpRequest();
                xhr.open('GET', keyUrl, true);
                xhr.onload = function() {{
                    if (xhr.status === 200) {{
                        try {{
                            var response = JSON.parse(xhr.responseText);
                            if (response.success && response.key) {{
                                updateFileOnGitHub(response.key, previewFileInfo.path, newContent);
                            }} else {{
                                showPreviewMessage('获取授权失败', 'error');
                                saveBtn.disabled = false;
                            }}
                        }} catch (e) {{
                            showPreviewMessage('解析授权响应失败', 'error');
                            saveBtn.disabled = false;
                        }}
                    }} else {{
                        showPreviewMessage('获取授权失败，状态码: ' + xhr.status, 'error');
                        saveBtn.disabled = false;
                    }}
                }};
                xhr.onerror = function() {{
                    showPreviewMessage('网络错误，无法获取授权', 'error');
                    saveBtn.disabled = false;
                }};
                xhr.send();
            }}

            function updateFileOnGitHub(key, filePath, newContent) {{
                var shaUrl = ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + encodeURI(filePath));
                var shaXhr = new XMLHttpRequest();
                shaXhr.open('GET', shaUrl, true);
                shaXhr.setRequestHeader('Authorization', 'Bearer ' + key);
                shaXhr.onload = function() {{
                    if (shaXhr.status === 200) {{
                        try {{
                            var fileInfo = JSON.parse(shaXhr.responseText);
                            var sha = fileInfo.sha;
                            var base64Content = btoa(unescape(encodeURIComponent(newContent)));
                            
                            var data = {{
                                message: 'Update file: ' + filePath,
                                content: base64Content,
                                sha: sha
                            }};
                            
                            var updateXhr = new XMLHttpRequest();
                            var updateUrl = ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + encodeURI(filePath));
                            updateXhr.open('PUT', updateUrl, true);
                            updateXhr.setRequestHeader('Authorization', 'Bearer ' + key);
                            updateXhr.setRequestHeader('Content-Type', 'application/json');
                            
                            updateXhr.onload = function() {{
                                if (updateXhr.status === 200 || updateXhr.status === 201) {{
                                    fileTreeCache = null;
                                    showPreviewMessage('保存成功！', 'success');
                                    setTimeout(function() {{
                                        closePreviewModal();
                                        loadFileList();
                                    }}, 1500);
                                }} else {{
                                    try {{
                                        var error = JSON.parse(updateXhr.responseText);
                                        showPreviewMessage('保存失败: ' + (error.message || '未知错误'), 'error');
                                    }} catch (e) {{
                                        showPreviewMessage('保存失败，状态码: ' + updateXhr.status, 'error');
                                    }}
                                    document.getElementById('savePreviewBtn').disabled = false;
                                }}
                            }};
                            
                            updateXhr.onerror = function() {{
                                showPreviewMessage('网络错误，保存失败', 'error');
                                document.getElementById('savePreviewBtn').disabled = false;
                            }};
                            
                            updateXhr.send(JSON.stringify(data));
                        }} catch (e) {{
                            showPreviewMessage('获取文件信息失败', 'error');
                            document.getElementById('savePreviewBtn').disabled = false;
                        }}
                    }} else {{
                        showPreviewMessage('获取文件信息失败，状态码: ' + shaXhr.status, 'error');
                        document.getElementById('savePreviewBtn').disabled = false;
                    }}
                }};
                shaXhr.onerror = function() {{
                    showPreviewMessage('网络错误，无法获取文件信息', 'error');
                    document.getElementById('savePreviewBtn').disabled = false;
                }};
                shaXhr.send();
            }}

            function confirmDelete() {{
                var savedAuth = getSavedAuth();
                var username, password;
                if (savedAuth) {{
                    username = savedAuth.u;
                    password = savedAuth.p;
                }} else {{
                    username = document.getElementById('deleteUsername').value;
                    password = document.getElementById('deletePassword').value;
                }}
                var deleteBtn = document.getElementById('deleteBtn');

                if (!username || !password) {{
                    showDeleteMessage('请输入用户名和密码', 'error');
                    return;
                }}

                deleteBtn.disabled = true;
                showDeleteMessage('正在获取授权...', 'success');

                var params = 'username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(password);
                var keyUrl = 'https://api.boring-student.cn/?' + params;

                var xhr = new XMLHttpRequest();
                xhr.open('GET', keyUrl, true);
                xhr.onload = function() {{
                    if (xhr.status === 200) {{
                        try {{
                            var response = JSON.parse(xhr.responseText);
                            if (response.success && response.key) {{
                                if (!savedAuth) {{
                                    handleRememberAuth(username, password, document.getElementById('deleteRememberMe').checked);
                                }}
                                if (deleteFileType === 'dir') {{
                                    deleteFolder(response.key, deleteFilePath);
                                }} else if (deleteFileType === 'chunked') {{
                                    deleteFolderFiles(response.key, deleteParts, 0);
                                }} else {{
                                    deleteFile(response.key, deleteFilePath, deleteFileSha);
                                }}
                            }} else {{
                                showDeleteMessage('获取授权失败', 'error');
                                deleteBtn.disabled = false;
                            }}
                        }} catch (e) {{
                            showDeleteMessage('解析授权响应失败', 'error');
                            deleteBtn.disabled = false;
                        }}
                    }} else {{
                        showDeleteMessage('获取授权失败，状态码: ' + xhr.status, 'error');
                        deleteBtn.disabled = false;
                    }}
                }};
                xhr.onerror = function() {{
                    showDeleteMessage('网络错误，无法获取授权', 'error');
                    deleteBtn.disabled = false;
                }};
                xhr.send();
            }}

            function deleteFile(key, filePath, sha) {{
                showDeleteMessage('正在删除...', 'success');

                var data = {{
                    message: 'Delete file: ' + filePath,
                    sha: sha
                }};

                var deleteXhr = new XMLHttpRequest();
                var deleteUrl = ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + encodeURI(filePath));
                deleteXhr.open('DELETE', deleteUrl, true);
                deleteXhr.setRequestHeader('Authorization', 'Bearer ' + key);
                deleteXhr.setRequestHeader('Content-Type', 'application/json');

                deleteXhr.onload = function() {{
                    if (deleteXhr.status === 200 || deleteXhr.status === 201) {{
                        fileTreeCache = null;
                        showDeleteMessage('删除成功！', 'success');
                        setTimeout(function() {{
                            closeDeleteModal();
                            loadFileList();
                        }}, 1500);
                    }} else {{
                        try {{
                            var error = JSON.parse(deleteXhr.responseText);
                            showDeleteMessage('删除失败: ' + (error.message || '未知错误'), 'error');
                        }} catch (e) {{
                            showDeleteMessage('删除失败，状态码: ' + deleteXhr.status, 'error');
                        }}
                        document.getElementById('deleteBtn').disabled = false;
                    }}
                }};

                deleteXhr.onerror = function() {{
                    showDeleteMessage('网络错误，删除失败', 'error');
                    document.getElementById('deleteBtn').disabled = false;
                }};

                deleteXhr.send(JSON.stringify(data));
            }}

            function deleteFolderError() {{
                showDeleteMessage('获取文件夹内容失败', 'error');
                document.getElementById('deleteBtn').disabled = false;
            }}

            function deleteFolder(key, folderPath) {{
                showDeleteMessage('正在获取文件夹内容...', 'success');

                var doDelete = function() {{
                    var prefix = folderPath + '/';
                    var files = [];
                    fileTreeCache.forEach(function(item) {{
                        if (item.type === 'blob' && item.path && item.path.indexOf(prefix) === 0) {{
                            files.push(item);
                        }}
                    }});
                    if (!files.length) {{
                        showDeleteMessage('文件夹为空或不存在', 'error');
                        document.getElementById('deleteBtn').disabled = false;
                        return;
                    }}
                    deleteFolderFiles(key, files, 0);
                }};

                if (fileTreeCache) {{
                    doDelete();
                    return;
                }}

                var xhr = new XMLHttpRequest();
                xhr.open('GET', ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/commits/' + DEFAULT_BRANCH), true);
                applyGhAuth(xhr);
                xhr.onload = function() {{
                    if (xhr.status === 200) {{
                        try {{
                            var commitData = JSON.parse(xhr.responseText);
                            var treeXhr = new XMLHttpRequest();
                            treeXhr.open('GET', ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/git/trees/' + commitData.commit.tree.sha + '?recursive=1'), true);
                            applyGhAuth(treeXhr);
                            treeXhr.onload = function() {{
                                if (treeXhr.status === 200) {{
                                    try {{
                                        var data = JSON.parse(treeXhr.responseText);
                                        fileTreeCache = data.tree || [];
                                        doDelete();
                                    }} catch (e) {{
                                        deleteFolderError();
                                    }}
                                }} else {{
                                    deleteFolderError();
                                }}
                            }};
                            treeXhr.onerror = deleteFolderError;
                            treeXhr.send();
                        }} catch (e) {{
                            deleteFolderError();
                        }}
                    }} else {{
                        deleteFolderError();
                    }}
                }};
                xhr.onerror = deleteFolderError;
                xhr.send();
            }}

            function deleteFolderFiles(key, files, index) {{
                if (index >= files.length) {{
                    fileTreeCache = null;
                    showDeleteMessage('删除成功！', 'success');
                    setTimeout(function() {{
                        closeDeleteModal();
                        loadFileList();
                    }}, 1500);
                    return;
                }}

                showDeleteMessage('正在删除 (' + (index + 1) + '/' + files.length + '): ' + files[index].path, 'success');

                var data = {{
                    message: 'Delete file: ' + files[index].path,
                    sha: files[index].sha
                }};

                var deleteXhr = new XMLHttpRequest();
                var deleteUrl = ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + encodeURI(files[index].path));
                deleteXhr.open('DELETE', deleteUrl, true);
                deleteXhr.setRequestHeader('Authorization', 'Bearer ' + key);
                deleteXhr.setRequestHeader('Content-Type', 'application/json');

                deleteXhr.onload = function() {{
                    if (deleteXhr.status === 200 || deleteXhr.status === 201) {{
                        deleteFolderFiles(key, files, index + 1);
                    }} else {{
                        try {{
                            var error = JSON.parse(deleteXhr.responseText);
                            showDeleteMessage('删除失败: ' + (error.message || '未知错误'), 'error');
                        }} catch (e) {{
                            showDeleteMessage('删除失败，状态码: ' + deleteXhr.status, 'error');
                        }}
                        document.getElementById('deleteBtn').disabled = false;
                    }}
                }};

                deleteXhr.onerror = function() {{
                    showDeleteMessage('网络错误，删除失败', 'error');
                    document.getElementById('deleteBtn').disabled = false;
                }};

                deleteXhr.send(JSON.stringify(data));
            }}

            function getCurrentPath() {{
                var path = window.location.pathname;
                if (path.endsWith('/')) {{
                    path = path.substring(0, path.length - 1);
                }}
                if (path === '') {{
                    return '';
                }}
                var parts = path.split('/');
                if (parts.length > 0 && parts[0] === REPO_NAME) {{
                    return parts.slice(1).join('/');
                }}
                return path.substring(1);
            }}

            function updateBreadcrumbs() {{
                var path = getCurrentPath();
                var crumbs = document.getElementById('breadcrumbs');
                crumbs.innerHTML = '';

                if (path === '') {{
                    var homeSpan = document.createElement('span');
                    homeSpan.style.color = '#666';
                    homeSpan.textContent = '当前位置:';
                    var homeStrong = document.createElement('strong');
                    homeStrong.textContent = ' Home';
                    homeSpan.appendChild(homeStrong);
                    crumbs.appendChild(homeSpan);
                    return;
                }}

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
                for (var i = 0; i < parts.length; i++) {{
                    currentPath += '/' + parts[i];
                    var separator = document.createElement('span');
                    separator.textContent = ' / ';
                    crumbs.appendChild(separator);

                    var link = document.createElement('a');
                    link.href = currentPath + '/';
                    link.textContent = decodeURIComponent(parts[i]);
                    crumbs.appendChild(link);
                }}
            }}

            function loadFileList(retried) {{
                var path = getCurrentPath();
                var apiUrl = ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + path);

                var container = document.getElementById('fileListContainer');
                container.innerHTML = '<div class="loading">加载中...</div>';

                var xhr = new XMLHttpRequest();
                xhr.open('GET', apiUrl, true);
                applyGhAuth(xhr);

                xhr.onload = function() {{
                    if (xhr.status === 200) {{
                        try {{
                            var items = JSON.parse(xhr.responseText);
                            var currentPath = getCurrentPath();
                            var pageTitle = document.getElementById('pageTitle');
                            if (currentPath === '') {{
                                pageTitle.textContent = 'Home';
                                document.title = 'Home - boring_student';
                            }} else {{
                                var pathParts = currentPath.split('/');
                                var dirName = decodeURIComponent(pathParts[pathParts.length - 1]);
                                pageTitle.textContent = dirName;
                                document.title = dirName + ' - boring_student';
                            }}
                            renderFileList(items);
                        }} catch (e) {{
                            container.innerHTML = '<div class="message error">解析文件列表失败</div>';
                        }}
                    }} else if (xhr.status === 403) {{
                        if (!retried && !ghApiKey && getSavedAuth()) {{
                            fetchGhKey(function() {{ loadFileList(true); }});
                            return;
                        }}
                        container.innerHTML = '<div class="message error">API请求受限，请稍后重试</div>';
                    }} else if (xhr.status === 404) {{
                        container.innerHTML = '<div class="message error">目录不存在</div>';
                    }} else {{
                        container.innerHTML = '<div class="message error">获取文件列表失败，状态码: ' + xhr.status + '</div>';
                    }}
                }};

                xhr.onerror = function() {{
                    container.innerHTML = '<div class="message error">网络错误，无法获取文件列表</div>';
                }};

                xhr.send();
            }}

            function renderFileList(items) {{
                var container = document.getElementById('fileListContainer');
                container.innerHTML = '';

                var dirs = items.filter(function(item) {{ return item.type === 'dir'; }});
                var files = items.filter(function(item) {{ return item.type === 'file'; }});

                dirs.sort(function(a, b) {{ return a.name.localeCompare(b.name); }});
                files.sort(function(a, b) {{ return a.name.localeCompare(b.name); }});

                var partGroups = {{}};
                var normalFiles = [];
                files.forEach(function(file) {{
                    if (PART_SUFFIX.test(file.name)) {{
                        var baseName = file.name.replace(PART_SUFFIX, '');
                        if (!partGroups[baseName]) partGroups[baseName] = [];
                        partGroups[baseName].push(file);
                    }} else {{
                        normalFiles.push(file);
                    }}
                }});
                for (var base in partGroups) {{
                    var parts = partGroups[base];
                    parts.sort(function(a, b) {{ return getPartNumber(a.name) - getPartNumber(b.name); }});
                    var totalSize = 0;
                    parts.forEach(function(p) {{ totalSize += (p.size || 0); }});
                    var dirPrefix = parts[0].path.substring(0, parts[0].path.length - parts[0].name.length);
                    normalFiles.push({{
                        name: base,
                        path: dirPrefix + base,
                        size: totalSize,
                        sha: '',
                        type: 'file',
                        chunked: true,
                        parts: parts
                    }});
                }}
                normalFiles.sort(function(a, b) {{ return a.name.localeCompare(b.name); }});

                var currentPath = getCurrentPath();
                var baseUrl = currentPath ? '/' + currentPath + '/' : '/';

                dirs.forEach(function(dir) {{
                    var entry = document.createElement('a');
                    entry.href = baseUrl + encodeURIComponent(dir.name) + '/';
                    entry.className = 'entry';
                    var nameSpan = document.createElement('span');
                    nameSpan.textContent = dir.name + '/';
                    var infoSpan = document.createElement('span');
                    infoSpan.className = 'file-info';
                    var sizeSpan = document.createElement('span');
                    sizeSpan.className = 'dir-size';
                    sizeSpan.setAttribute('data-path', dir.path);
                    sizeSpan.textContent = '-';

                    infoSpan.appendChild(sizeSpan);
                    entry.appendChild(nameSpan);
                    entry.appendChild(infoSpan);
                    bindEntryEvents(entry, {{
                        path: dir.path,
                        sha: dir.sha,
                        name: dir.name,
                        type: 'dir'
                    }});
                    container.appendChild(entry);
                }});

                normalFiles.forEach(function(file) {{
                    if (file.name === 'index.html' || file.name === 'info.json' || file.name === 'info.md') {{
                        return;
                    }}
                    var entry = document.createElement('a');
                    if (file.chunked) {{
                        entry.href = 'javascript:void(0);';
                        entry.onclick = function() {{
                            downloadMergedFile(file.parts, file.name);
                        }};
                    }} else {{
                        entry.href = ghUrl('https://raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME + '/' + DEFAULT_BRANCH + '/' + encodeURI(file.path));
                        entry.target = '_blank';
                    }}
                    entry.className = 'entry';
                    var nameSpan = document.createElement('span');
                    nameSpan.textContent = file.name;
                    var infoSpan = document.createElement('span');
                    infoSpan.className = 'file-info';
                    var sizeSpan = document.createElement('span');
                    sizeSpan.textContent = formatSize(file.size);
                    
                    infoSpan.appendChild(sizeSpan);
                    entry.appendChild(nameSpan);
                    entry.appendChild(infoSpan);
                    bindEntryEvents(entry, {{
                        path: file.path,
                        sha: file.sha,
                        name: file.name,
                        type: 'file',
                        size: file.size,
                        chunked: file.chunked || false,
                        parts: file.parts || null
                    }});
                    container.appendChild(entry);
                }});

                if (dirs.length === 0 && files.length === 0) {{
                    container.innerHTML = '<div class="loading">此目录为空</div>';
                }}

                fetchFolderSizes();
            }}

            var pendingFiles = [];
            var uploadTasks = [];
            var uploadedParts = [];

            function buildUploadTasks() {{
                var chunkSize = CHUNK_SIZE_LEVELS[chunkSizeLevel];
                var tasks = [];
                pendingFiles.forEach(function(item) {{
                    var file = item.file;
                    if (file.size > chunkSize) {{
                        var parts = Math.ceil(file.size / chunkSize);
                        for (var i = 0; i < parts; i++) {{
                            tasks.push({{
                                blob: file.slice(i * chunkSize, Math.min((i + 1) * chunkSize, file.size)),
                                relativePath: item.relativePath + '.part' + (i + 1),
                                base: item.relativePath,
                                label: item.relativePath + ' (分片 ' + (i + 1) + '/' + parts + ', ' + formatSize(chunkSize) + '/片)'
                            }});
                        }}
                    }} else {{
                        tasks.push({{
                            blob: file,
                            relativePath: item.relativePath,
                            base: item.relativePath,
                            label: item.relativePath
                        }});
                    }}
                }});
                return tasks;
            }}

            function setPendingFiles(list) {{
                pendingFiles = list;
                var el = document.getElementById('selectedFiles');
                if (!list.length) {{
                    el.textContent = '';
                    return;
                }}
                var names = [];
                for (var i = 0; i < list.length && i < 5; i++) {{
                    names.push(list[i].relativePath);
                }}
                var text = '已选择 ' + list.length + ' 个文件: ' + names.join(', ');
                if (list.length > 5) text += ' 等';
                el.textContent = text;
            }}

            function handleFileInput(input) {{
                var list = [];
                for (var i = 0; i < input.files.length; i++) {{
                    var f = input.files[i];
                    list.push({{ file: f, relativePath: f.webkitRelativePath || f.name }});
                }}
                setPendingFiles(list);
            }}

            function traverseEntry(entry, path, list, done) {{
                if (entry.isFile) {{
                    entry.file(function(f) {{
                        list.push({{ file: f, relativePath: path + f.name }});
                        done();
                    }}, done);
                }} else if (entry.isDirectory) {{
                    var dirReader = entry.createReader();
                    var allEntries = [];
                    var readAll = function() {{
                        dirReader.readEntries(function(entries) {{
                            if (entries.length === 0) {{
                                if (allEntries.length === 0) {{
                                    done();
                                    return;
                                }}
                                var remaining = allEntries.length;
                                allEntries.forEach(function(child) {{
                                    traverseEntry(child, path + entry.name + '/', list, function() {{
                                        remaining--;
                                        if (remaining === 0) done();
                                    }});
                                }});
                            }} else {{
                                for (var i = 0; i < entries.length; i++) {{
                                    allEntries.push(entries[i]);
                                }}
                                readAll();
                            }}
                        }}, done);
                    }};
                    readAll();
                }} else {{
                    done();
                }}
            }}

            function handleDrop(e) {{
                e.preventDefault();
                var dropZone = document.getElementById('dropZone');
                dropZone.style.background = '';
                var items = e.dataTransfer.items;
                if (items && items.length && items[0].webkitGetAsEntry) {{
                    var entries = [];
                    for (var i = 0; i < items.length; i++) {{
                        var entry = items[i].webkitGetAsEntry();
                        if (entry) entries.push(entry);
                    }}
                    if (!entries.length) {{
                        setPendingFiles([]);
                        return;
                    }}
                    var list = [];
                    var remaining = entries.length;
                    entries.forEach(function(entry) {{
                        traverseEntry(entry, '', list, function() {{
                            remaining--;
                            if (remaining === 0) {{
                                list.sort(function(a, b) {{ return a.relativePath.localeCompare(b.relativePath); }});
                                setPendingFiles(list);
                            }}
                        }});
                    }});
                }} else {{
                    var list = [];
                    for (var i = 0; i < e.dataTransfer.files.length; i++) {{
                        var f = e.dataTransfer.files[i];
                        list.push({{ file: f, relativePath: f.name }});
                    }}
                    setPendingFiles(list);
                }}
            }}

            function uploadFile() {{
                var auth = getSavedAuth();
                var uploadBtn = document.getElementById('uploadBtn');

                if (!auth) {{
                    showMessage('请先登录后再上传文件', 'error');
                    return;
                }}

                if (!pendingFiles.length) {{
                    showMessage('请选择要上传的文件', 'error');
                    return;
                }}

                uploadBtn.disabled = true;
                showMessage('正在获取授权...', 'success');

                var params = 'username=' + encodeURIComponent(auth.u) + '&password=' + encodeURIComponent(auth.p);
                var keyUrl = 'https://api.boring-student.cn/?' + params;

                var xhr = new XMLHttpRequest();
                xhr.open('GET', keyUrl, true);
                xhr.onload = function() {{
                    if (xhr.status === 200) {{
                        try {{
                            var response = JSON.parse(xhr.responseText);
                            if (response.success && response.key) {{
                                uploadTasks = buildUploadTasks();
                                uploadedParts = [];
                                chunkSizeLevel = 0;
                                uploadNextFile(response.key, 0);
                            }} else {{
                                showMessage('获取授权失败', 'error');
                                uploadBtn.disabled = false;
                            }}
                        }} catch (e) {{
                            showMessage('解析授权响应失败', 'error');
                            uploadBtn.disabled = false;
                        }}
                    }} else {{
                        showMessage('获取授权失败，状态码: ' + xhr.status, 'error');
                        uploadBtn.disabled = false;
                    }}
                }};
                xhr.onerror = function() {{
                    showMessage('网络错误，无法获取授权', 'error');
                    uploadBtn.disabled = false;
                }};
                xhr.send();
            }}

            function uploadNextFile(key, index) {{
                var total = uploadTasks.length;
                if (index >= total) {{
                    fileTreeCache = null;
                    showMessage('全部上传成功！', 'success');
                    setTimeout(function() {{
                        closeUploadModal();
                        document.getElementById('uploadBtn').disabled = false;
                        loadFileList();
                    }}, 1500);
                    return;
                }}

                var item = uploadTasks[index];
                var progressContainer = document.querySelector('.progress-container');
                progressContainer.style.display = 'block';
                showMessage('正在上传 (' + (index + 1) + '/' + total + '): ' + item.label, 'success');

                var reader = new FileReader();
                reader.onload = function(e) {{
                    var base64Content = e.target.result.split(',')[1];
                    var currentPath = getCurrentPath();
                    var filePath = currentPath ? currentPath + '/' + item.relativePath : item.relativePath;

                    putFileToGitHub(key, filePath, base64Content, null,
                        function(newSha) {{
                            if (PART_SUFFIX.test(item.relativePath) && newSha) {{
                                uploadedParts.push({{ path: filePath, sha: newSha, base: item.base }});
                            }}
                            updateUploadProgress(index + 1, total, 0);
                            uploadNextFile(key, index + 1);
                        }},
                        function(status, responseText) {{
                            var errMsg = status === 0 ? '网络连接中断，可能是文件过大或网络不稳定' : ('状态码: ' + status);
                            try {{
                                var error = JSON.parse(responseText);
                                if (error.message) errMsg = error.message;
                            }} catch (e) {{}}

                            var base = item.base;
                            var j = index;
                            while (j > 0 && uploadTasks[j - 1].base === base) j--;
                            var doneBases = {{}};
                            for (var k = 0; k < j; k++) doneBases[uploadTasks[k].base] = true;
                            var staleParts = uploadedParts.filter(function(p) {{ return !doneBases[p.base]; }});
                            uploadedParts = uploadedParts.filter(function(p) {{ return doneBases[p.base]; }});

                            if (/too large/i.test(responseText || '') && chunkSizeLevel < CHUNK_SIZE_LEVELS.length - 1) {{
                                chunkSizeLevel++;
                                showMessage('分片过大，已自动减小分片大小，正在重新上传...', 'success');
                                deletePartsQuietly(key, staleParts, 0, function() {{
                                    fileTreeCache = null;
                                    uploadTasks = buildUploadTasks().filter(function(t) {{ return !doneBases[t.base]; }});
                                    uploadNextFile(key, 0);
                                }});
                                return;
                            }}

                            var finalMsg = '上传失败 (' + item.relativePath + '): ' + errMsg;
                            if (staleParts.length > 0) {{
                                uploadedParts = staleParts;
                                cleanupUploadedParts(key, finalMsg);
                            }} else {{
                                showMessage(finalMsg, 'error');
                                document.getElementById('uploadBtn').disabled = false;
                            }}
                        }},
                        function(fraction) {{
                            updateUploadProgress(index, total, fraction);
                        }}
                    );
                }};
                reader.readAsDataURL(item.blob);
            }}

            function updateUploadProgress(index, total, fraction) {{
                var percent = Math.round(((index + fraction) / total) * 100);
                document.getElementById('progressFill').style.width = percent + '%';
                document.getElementById('progressText').textContent = percent + '%';
            }}

            function putFileToGitHub(key, filePath, base64Content, sha, onSuccess, onError, onProgress, retries) {{
                if (retries === undefined) retries = 2;

                var data = {{
                    message: 'Upload file: ' + filePath,
                    content: base64Content
                }};
                if (sha) data.sha = sha;

                var uploadXhr = new XMLHttpRequest();
                var uploadUrl = ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + encodeURI(filePath));
                uploadXhr.open('PUT', uploadUrl, true);
                uploadXhr.setRequestHeader('Authorization', 'Bearer ' + key);
                uploadXhr.setRequestHeader('Content-Type', 'application/json');

                uploadXhr.upload.onprogress = function(e) {{
                    if (e.lengthComputable && onProgress) {{
                        onProgress(e.loaded / e.total);
                    }}
                }};

                uploadXhr.onload = function() {{
                    if (uploadXhr.status === 200 || uploadXhr.status === 201) {{
                        var newSha = null;
                        try {{
                            newSha = JSON.parse(uploadXhr.responseText).content.sha;
                        }} catch (e) {{}}
                        onSuccess(newSha);
                        return;
                    }}
                    if (uploadXhr.status === 422 && !sha) {{
                        var shaXhr = new XMLHttpRequest();
                        shaXhr.open('GET', uploadUrl, true);
                        shaXhr.setRequestHeader('Authorization', 'Bearer ' + key);
                        shaXhr.onload = function() {{
                            if (shaXhr.status === 200) {{
                                try {{
                                    var info = JSON.parse(shaXhr.responseText);
                                    putFileToGitHub(key, filePath, base64Content, info.sha, onSuccess, onError, onProgress);
                                    return;
                                }} catch (e) {{}}
                            }}
                            onError(uploadXhr.status, uploadXhr.responseText);
                        }};
                        shaXhr.onerror = function() {{
                            onError(uploadXhr.status, uploadXhr.responseText);
                        }};
                        shaXhr.send();
                        return;
                    }}
                    onError(uploadXhr.status, uploadXhr.responseText);
                }};

                uploadXhr.onerror = function() {{
                    if (retries > 0) {{
                        putFileToGitHub(key, filePath, base64Content, sha, onSuccess, onError, onProgress, retries - 1);
                        return;
                    }}
                    onError(0, '');
                }};

                uploadXhr.send(JSON.stringify(data));
            }}

            function cleanupUploadedParts(key, finalMsg) {{
                showMessage('上传失败，正在清理已上传的分片...', 'error');
                deletePartsQuietly(key, uploadedParts, 0, function() {{
                    fileTreeCache = null;
                    uploadedParts = [];
                    showMessage(finalMsg + '（残留分片已清理）', 'error');
                    document.getElementById('uploadBtn').disabled = false;
                }});
            }}

            function deletePartsQuietly(key, parts, index, done) {{
                if (index >= parts.length) {{
                    done();
                    return;
                }}
                var data = {{
                    message: 'Delete file: ' + parts[index].path,
                    sha: parts[index].sha
                }};
                var xhr = new XMLHttpRequest();
                xhr.open('DELETE', ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + encodeURI(parts[index].path)), true);
                xhr.setRequestHeader('Authorization', 'Bearer ' + key);
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.onload = function() {{
                    deletePartsQuietly(key, parts, index + 1, done);
                }};
                xhr.onerror = function() {{
                    deletePartsQuietly(key, parts, index + 1, done);
                }};
                xhr.send(JSON.stringify(data));
            }}

            document.addEventListener('DOMContentLoaded', function() {{
                updateBreadcrumbs();
                updateAuthBtn();
                loadConfig(function() {{
                    fetchGhKey(function() {{ loadFileList(); }});
                }});

                var dropZone = document.getElementById('dropZone');
                dropZone.addEventListener('click', function() {{
                    document.getElementById('fileInput').click();
                }});
                dropZone.addEventListener('dragover', function(e) {{
                    e.preventDefault();
                    dropZone.style.background = 'rgba(44, 130, 201, 0.1)';
                }});
                dropZone.addEventListener('dragleave', function(e) {{
                    e.preventDefault();
                    dropZone.style.background = '';
                }});
                dropZone.addEventListener('drop', handleDrop);
                document.getElementById('pickFileBtn').addEventListener('click', function() {{
                    document.getElementById('fileInput').click();
                }});
                document.getElementById('pickFolderBtn').addEventListener('click', function() {{
                    document.getElementById('folderInput').click();
                }});
                document.getElementById('fileInput').addEventListener('change', function() {{
                    handleFileInput(this);
                }});
                document.getElementById('folderInput').addEventListener('change', function() {{
                    handleFileInput(this);
                }});
            }});
        </script>
    </body>
</html>
"""

def copy_static_files(output_dir):
    static_files = ['favicon.ico', 'CNAME', 'config.json']
    for filename in static_files:
        src = os.path.join('.', filename)
        dst = os.path.join(output_dir, filename)
        if os.path.exists(src):
            shutil.copy2(src, dst)

if __name__ == "__main__":
    output_dir = 'build'

    if os.path.exists(output_dir):
        shutil.rmtree(output_dir)
    os.makedirs(output_dir, exist_ok=True)

    copy_static_files(output_dir)

    index_content = template.format(
        title='Home',
        repo_owner=REPO_OWNER,
        repo_name=REPO_NAME,
        default_branch=DEFAULT_BRANCH
    )
    with open(os.path.join(output_dir, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(index_content)

    with open('404.html', 'r', encoding='utf-8') as f:
        template_404 = f.read()
    html_404 = template_404.format(
        title='404 - 页面未找到',
        repo_owner=REPO_OWNER,
        repo_name=REPO_NAME,
        default_branch=DEFAULT_BRANCH
    )
    with open(os.path.join(output_dir, '404.html'), 'w', encoding='utf-8') as f:
        f.write(html_404)

    print(f'Build completed. Storage repo: {REPO_OWNER}/{REPO_NAME}')
