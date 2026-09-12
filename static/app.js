var APP = window.__APP__ || {};
var REPO_OWNER = APP.repoOwner || '';
var REPO_NAME = APP.repoName || '';
var DEFAULT_BRANCH = APP.defaultBranch || 'main';
var PROXY_BASE = '';

function ghUrl(url) {
    if (PROXY_BASE) {
        return PROXY_BASE + '/' + url.replace(/^https?:\/\//, '');
    }
    return url;
}

var ghApiKey = null;
var ghApiKeyFetching = false;

function applyGhAuth(xhr) {
    if (ghApiKey) {
        xhr.setRequestHeader('Authorization', 'Bearer ' + ghApiKey);
    }
}

function fetchGhKey(done, force) {
    var finish = function() {
        ghApiKeyFetching = false;
        if (done) done();
    };
    if (ghApiKeyFetching) { finish(); return; }
    if (ghApiKey && !force) { finish(); return; }
    var saved = getSavedAuth();
    if (!saved) { finish(); return; }
    if (saved.key && !force) {
        ghApiKey = saved.key;
        finish();
        return;
    }
    // Re-login requires the plaintext password, only available in this tab session
    if (!sessionPlain) { finish(); return; }
    if (force) {
        ghApiKey = null;
    }
    ghApiKeyFetching = true;
    var persisted = !sessionAuth;
    loginAndGetKey(saved.u, sessionPlain, persisted, function() {
        finish();
    });
}

function loadConfig(done) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/config.json', true);
    xhr.onload = function() {
        if (xhr.status === 200) {
            try {
                var cfg = JSON.parse(xhr.responseText);
                if (cfg && cfg.proxy) {
                    PROXY_BASE = String(cfg.proxy).replace(/\/+$/, '');
                }
            } catch (e) {}
        }
        done();
    };
    xhr.onerror = function() { done(); };
    xhr.send();
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

function cachedGet(url, auth, cb) {
    var bypass = Date.now() < noCacheUntil;
    var reqUrl = bypass
        ? url + (url.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now()
        : url;
    var cached = httpCache[url];
    var xhr = new XMLHttpRequest();
    xhr.open('GET', ghUrl(reqUrl), true);
    if (auth) applyGhAuth(xhr);
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

function invalidateHttpCache() {
    bypassHttpCache();
}

var menuFileInfo = {};
var previewFileInfo = {};
var fileTreeCache = null;
var menuOpenedAt = 0;

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

function saveAuth(username, hash, role, key) {
    try {
        localStorage.setItem(AUTH_STORAGE_KEY, btoa(unescape(encodeURIComponent(JSON.stringify({
            v: 2, u: username, h: hash, role: role || 'user', key: key || null
        })))));
    } catch (e) {}
}

function getSavedAuth() {
    if (sessionAuth) return sessionAuth;
    try {
        var data = localStorage.getItem(AUTH_STORAGE_KEY);
        if (!data) return null;
        var obj = JSON.parse(decodeURIComponent(escape(atob(data))));
        if (obj && obj.v === 2 && obj.u && (obj.h || obj.key)) return obj;
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

function saveRemember(username, password) {
    try {
        localStorage.setItem(REMEMBER_STORAGE_KEY, btoa(unescape(encodeURIComponent(JSON.stringify({ u: username, p: password })))));
    } catch (e) {}
}

function getRemember() {
    try {
        var data = localStorage.getItem(REMEMBER_STORAGE_KEY);
        if (!data) return null;
        var obj = JSON.parse(decodeURIComponent(escape(atob(data))));
        if (obj && obj.u && obj.p) return obj;
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

// ---- auth API (https://api.boring-student.cn) ----
var API_BASE = 'https://api.boring-student.cn';

// Known API error messages shown in Chinese
var API_ERROR_MAP = {
    'Invalid credentials': '账号或密码错误',
    'Admin auth required (admin_user / admin_pass)': '需要管理员身份验证',
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

// Full login flow: /api/login (plaintext over HTTPS) -> /api/redeem-key -> real key.
// The API only accepts plaintext passwords; after a successful login the
// server-returned password_sha512 and the real key are cached locally, so
// the key is not requested again on subsequent visits.
// persist=true stores {u, hash, role, key} in localStorage ("保持登录");
// otherwise the auth is kept for this tab session only.
var sessionPlain = null;

function loginAndGetKey(username, password, persist, cb) {
    apiGetJson(API_BASE + '/api/login?username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(password), function(err, data) {
        if (err || !data || !data.success || !data.key_sha512) {
            cb(err || '用户名或密码错误');
            return;
        }
        apiGetJson(API_BASE + '/api/redeem-key?key_sha512=' + encodeURIComponent(data.key_sha512), function(err2, data2) {
            if (err2 || !data2 || !data2.key) { cb(err2 || '兑换密钥失败'); return; }
            ghApiKey = data2.key;
            sessionPlain = password;
            var hash = data.password_sha512 || '';
            var role = data.role || 'user';
            var auth = { v: 2, u: username, h: hash, role: role, key: ghApiKey };
            if (persist) {
                saveAuth(username, hash, role, ghApiKey);
            } else {
                sessionAuth = auth;
            }
            updateAuthBtn();
            cb(null, ghApiKey);
        });
    });
}

// Resolve a usable GitHub key without re-requesting it every time:
// memory -> key cached in storage -> re-login with session plaintext.
function ensureGhKey(cb) {
    if (ghApiKey) { cb(ghApiKey); return; }
    var saved = getSavedAuth();
    if (saved && saved.key) {
        ghApiKey = saved.key;
        cb(ghApiKey);
        return;
    }
    if (saved && sessionPlain) {
        loginAndGetKey(saved.u, sessionPlain, !sessionAuth, function(err, key) {
            cb(err ? null : key);
        });
        return;
    }
    cb(null);
}

function fillAuthInputs(usernameId, passwordId, checkboxId) {
    var remembered = getRemember();
    if (remembered) {
        document.getElementById(usernameId).value = remembered.u;
        document.getElementById(passwordId).value = remembered.p;
        if (checkboxId) document.getElementById(checkboxId).checked = true;
    }
}

function updateAuthBtn() {
    var btn = document.getElementById('authBtn');
    var user = document.getElementById('authUser');
    var adminBtn = document.getElementById('adminBtn');
    var saved = getSavedAuth();
    if (btn) {
        btn.textContent = saved ? '退出登录' : '登录';
    }
    if (user) {
        if (saved) {
            user.textContent = '当前用户: ' + saved.u + (saved.role === 'admin' ? '（管理员）' : '');
            user.style.display = 'block';
        } else {
            user.style.display = 'none';
        }
    }
    if (adminBtn) {
        adminBtn.style.display = saved && saved.role === 'admin' ? '' : 'none';
    }
    var accountBtn = document.getElementById('accountBtn');
    if (accountBtn) {
        accountBtn.style.display = saved ? '' : 'none';
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

function showLoginMessage(text, type) {
    var msg = document.getElementById('loginMessage');
    msg.className = 'message ' + type;
    msg.textContent = text;
}

function doLogin() {
    var username = document.getElementById('loginUsername').value;
    var password = document.getElementById('loginPassword').value;
    var keepLogin = document.getElementById('loginKeepLogged').checked;
    var rememberPwd = document.getElementById('loginRememberPwd').checked;
    var loginBtn = document.getElementById('loginBtn');

    if (!username || !password) {
        showLoginMessage('请输入用户名和密码', 'error');
        return;
    }

    loginBtn.disabled = true;
    showLoginMessage('正在登录...', 'success');

    loginAndGetKey(username, password, keepLogin, function(err) {
        if (err) {
            showLoginMessage('登录失败: ' + err, 'error');
            loginBtn.disabled = false;
            return;
        }
        if (rememberPwd) {
            saveRemember(username, password);
        } else {
            clearRemember();
        }
        showLoginMessage('登录成功！', 'success');
        setTimeout(function() {
            closeLoginModal();
            document.getElementById('loginBtn').disabled = false;
        }, 1000);
    });
}

function logout() {
    ghApiKey = null;
    sessionPlain = null;
    clearAuth();
    updateAuthBtn();
    document.getElementById('deleteUsername').value = '';
    document.getElementById('deletePassword').value = '';
    document.getElementById('deleteRememberMe').checked = false;
    document.getElementById('loginUsername').value = '';
    document.getElementById('loginPassword').value = '';
    document.getElementById('loginKeepLogged').checked = false;
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

function showAccountMessage(text, type) {
    var msg = document.getElementById('accountMessage');
    msg.className = 'message ' + type;
    msg.textContent = text;
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
        showAccountMessage('请先登录', 'error');
        return;
    }
    var current = document.getElementById('cpCurrent').value;
    var newPwd = document.getElementById('cpNew').value;
    var confirmPwd = document.getElementById('cpConfirm').value;
    if (!current || !newPwd) {
        showAccountMessage('请输入当前密码和新密码', 'error');
        return;
    }
    if (newPwd !== confirmPwd) {
        showAccountMessage('两次输入的新密码不一致', 'error');
        return;
    }
    var ruleErr = validateNewPassword(newPwd);
    if (ruleErr) {
        showAccountMessage(ruleErr, 'error');
        return;
    }
    var btn = document.getElementById('cpBtn');
    btn.disabled = true;
    showAccountMessage('正在修改...', 'success');
    apiSendJson('POST', API_BASE + '/api/change-password', {
        username: auth.u,
        password: current,
        new_password: newPwd
    }, function(err, data) {
        if (err) {
            showAccountMessage('修改失败: ' + err, 'error');
            btn.disabled = false;
            return;
        }
        // refresh stored credentials with the server-returned new password hash
        var newHash = (data && data.password_sha512) || auth.h;
        if (sessionAuth) {
            sessionAuth = { v: 2, u: auth.u, h: newHash, role: auth.role, key: auth.key };
        } else {
            saveAuth(auth.u, newHash, auth.role, auth.key);
        }
        sessionPlain = newPwd;
        if (getRemember()) {
            saveRemember(auth.u, newPwd);
        }
        showAccountMessage('密码修改成功！', 'success');
        btn.disabled = false;
        document.getElementById('cpCurrent').value = '';
        document.getElementById('cpNew').value = '';
        document.getElementById('cpConfirm').value = '';
    });
}

function deleteOwnAccount() {
    var auth = getSavedAuth();
    if (!auth) {
        showAccountMessage('请先登录', 'error');
        return;
    }
    var password = document.getElementById('daPassword').value;
    if (!password) {
        showAccountMessage('请输入密码以确认注销', 'error');
        return;
    }
    if (!confirm('确定要永久注销账户 ' + auth.u + ' 吗？此操作不可撤销！')) {
        return;
    }
    var btn = document.getElementById('daBtn');
    btn.disabled = true;
    showAccountMessage('正在注销...', 'success');
    apiSendJson('POST', API_BASE + '/api/delete-account', {
        username: auth.u,
        password: password
    }, function(err) {
        btn.disabled = false;
        if (err) {
            showAccountMessage('注销失败: ' + err, 'error');
            return;
        }
        ghApiKey = null;
        sessionPlain = null;
        clearAuth();
        clearRemember();
        updateAuthBtn();
        closeAccountModal();
        showToast('账户已注销');
        setTimeout(hideToast, 2500);
    });
}

// ---- Admin user management (role=admin only) ----
// Admin endpoints validate the admin's plaintext password. When the session
// was restored from local storage the plaintext is no longer in memory, so it
// is re-asked once and verified via /api/login.
function withAdminCreds(cb) {
    var a = getSavedAuth();
    if (!a || a.role !== 'admin') { cb(null); return; }
    if (sessionPlain) {
        cb({ admin_user: a.u, admin_pass: sessionPlain });
        return;
    }
    var pwd = prompt('请输入管理员 ' + a.u + ' 的密码以验证身份:');
    if (!pwd) { cb(null); return; }
    apiGetJson(API_BASE + '/api/login?username=' + encodeURIComponent(a.u) + '&password=' + encodeURIComponent(pwd), function(err, data) {
        if (err || !data || !data.success) { cb(null); return; }
        sessionPlain = pwd;
        cb({ admin_user: a.u, admin_pass: pwd });
    });
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

function showAdminMessage(text, type) {
    var msg = document.getElementById('adminMessage');
    msg.className = 'message ' + type;
    msg.textContent = text;
}

function loadAdminUsers() {
    withAdminCreds(function(creds) {
        if (!creds) {
            document.getElementById('adminUserList').innerHTML = '<div class="message error">需要管理员权限或身份验证失败</div>';
            return;
        }
        apiGetJson(API_BASE + '/api/users?admin_user=' + encodeURIComponent(creds.admin_user) + '&admin_pass=' + encodeURIComponent(creds.admin_pass), function(err, data) {
            if (err || !data || !data.users) {
                document.getElementById('adminUserList').innerHTML = '<div class="message error">加载失败: ' + (err || '响应异常') + '</div>';
                return;
            }
            renderAdminUserList(data.users);
        });
    });
}

function renderAdminUserList(users) {
    var container = document.getElementById('adminUserList');
    container.innerHTML = '';
    var names = Object.keys(users).sort();
    if (!names.length) {
        container.innerHTML = '<div class="loading">暂无用户</div>';
        return;
    }
    var me = getSavedAuth();
    names.forEach(function(name) {
        var role = users[name].role || 'user';
        var row = document.createElement('div');
        row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 8px 4px; border-bottom: 1px solid #f0f0f0; font-size: 14px; gap: 8px;';

        var info = document.createElement('span');
        info.style.cssText = 'min-width: 0; word-break: break-all; color: #333;';
        info.textContent = name + ' ';
        var roleTag = document.createElement('span');
        roleTag.style.cssText = 'font-size: 12px; padding: 1px 8px; border-radius: 8px; color: white; background: ' + (role === 'admin' ? '#6c5ce7' : '#95a5a6') + ';';
        roleTag.textContent = role;
        info.appendChild(roleTag);
        row.appendChild(info);

        var ops = document.createElement('span');
        ops.style.cssText = 'display: flex; gap: 6px; flex-shrink: 0;';

        var mkBtn = function(text, bg, fn) {
            var b = document.createElement('button');
            b.className = 'btn';
            b.style.cssText = 'padding: 4px 10px; font-size: 12px; background: ' + bg + ';';
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
        showAdminMessage('请输入用户名和密码', 'error');
        return;
    }
    var btn = document.getElementById('adminAddBtn');
    btn.disabled = true;
    showAdminMessage('正在添加...', 'success');
    withAdminCreds(function(creds) {
        if (!creds) {
            showAdminMessage('需要管理员权限或身份验证失败', 'error');
            btn.disabled = false;
            return;
        }
        // plaintext password: the server stores it as sha512 automatically
        var body = {
            admin_user: creds.admin_user,
            admin_pass: creds.admin_pass,
            username: username,
            password: password,
            role: role
        };
        apiSendJson('POST', API_BASE + '/api/users', body, function(err) {
            btn.disabled = false;
            if (err) {
                showAdminMessage('添加失败: ' + err, 'error');
                return;
            }
            showAdminMessage('添加成功: ' + username, 'success');
            document.getElementById('adminNewUsername').value = '';
            document.getElementById('adminNewPassword').value = '';
            loadAdminUsers();
        });
    });
}

function adminResetPassword(username) {
    var password = prompt('为用户 ' + username + ' 设置新密码（明文，服务端将加密存储）:');
    if (!password) return;
    withAdminCreds(function(creds) {
        if (!creds) {
            showAdminMessage('需要管理员权限或身份验证失败', 'error');
            return;
        }
        var body = {
            admin_user: creds.admin_user,
            admin_pass: creds.admin_pass,
            password: password
        };
        apiSendJson('PUT', API_BASE + '/api/users/' + encodeURIComponent(username), body, function(err) {
            if (err) {
                showAdminMessage('修改失败: ' + err, 'error');
                return;
            }
            showAdminMessage('已重置 ' + username + ' 的密码', 'success');
        });
    });
}

function adminChangeRole(username, newRole) {
    withAdminCreds(function(creds) {
        if (!creds) {
            showAdminMessage('需要管理员权限或身份验证失败', 'error');
            return;
        }
        var body = {
            admin_user: creds.admin_user,
            admin_pass: creds.admin_pass,
            role: newRole
        };
        apiSendJson('PUT', API_BASE + '/api/users/' + encodeURIComponent(username), body, function(err) {
            if (err) {
                showAdminMessage('修改失败: ' + err, 'error');
                return;
            }
            showAdminMessage('已将 ' + username + ' 调整为 ' + newRole, 'success');
            loadAdminUsers();
        });
    });
}

function adminDeleteUser(username) {
    if (!confirm('确定要删除用户 ' + username + ' 吗？此操作不可撤销。')) return;
    withAdminCreds(function(creds) {
        if (!creds) {
            showAdminMessage('需要管理员权限或身份验证失败', 'error');
            return;
        }
        apiSendJson('DELETE', API_BASE + '/api/users/' + encodeURIComponent(username), {
            admin_user: creds.admin_user,
            admin_pass: creds.admin_pass
        }, function(err) {
            if (err) {
                showAdminMessage('删除失败: ' + err, 'error');
                return;
            }
            showAdminMessage('已删除用户: ' + username, 'success');
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

function openUploadModal() {
    if (!getSavedAuth()) {
        openLoginModal();
        showLoginMessage('请先登录后再上传文件', 'error');
        return;
    }
    document.getElementById('uploadModal').classList.add('show');
}

function closeUploadModal() {
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
    pendingFiles = [];
    document.getElementById('selectedFiles').textContent = '';
    document.getElementById('fileInput').value = '';
    document.getElementById('folderInput').value = '';
}

function showMessage(text, type) {
    var msg = document.getElementById('uploadMessage');
    msg.className = 'message ' + type;
    msg.textContent = text;
}

function formatSize(size) {
    if (size === undefined || size === null) return '0B';
    for (var unit of ['B', 'KB', 'MB', 'GB', 'TB']) {
        if (size < 1024.0) {
            return size.toFixed(1) + unit;
        }
        size /= 1024.0;
    }
    return size.toFixed(1) + 'PB';
}

function fetchFileTree(onDone, onFail) {
    if (fileTreeCache) {
        onDone();
        return;
    }
    var commitUrl = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/commits/' + DEFAULT_BRANCH;
    cachedGet(commitUrl, true, function(status, body) {
        if (status !== 200 && status !== 304) {
            if (onFail) onFail();
            return;
        }
        try {
            var commitData = JSON.parse(body);
            var treeUrl = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/git/trees/' + commitData.commit.tree.sha + '?recursive=1';
            cachedGet(treeUrl, true, function(status2, body2) {
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
    fileTreeCache.forEach(function(item) {
        if (item.type !== 'blob' || !item.path) return;
        var size = item.size || 0;
        var p = item.path;
        var idx = p.lastIndexOf('/');
        while (idx > 0) {
            p = p.substring(0, idx);
            dirSizes[p] = (dirSizes[p] || 0) + size;
            idx = p.lastIndexOf('/');
        }
    });
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
    propsHtml += '</div>';
    content.innerHTML = propsHtml;
    document.getElementById('propertiesModal').classList.add('show');
}

function downloadFolder(filePath, fileName) {
    var url = ghUrl('https://github.com/' + REPO_OWNER + '/' + REPO_NAME + '/archive/refs/heads/' + DEFAULT_BRANCH + '.zip');
    window.open(url, '_blank', 'noopener');
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
}

function showDeleteMessage(text, type) {
    var msg = document.getElementById('deleteMessage');
    msg.className = 'message ' + type;
    msg.textContent = text;
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
            downloadFile(filePath, fileName);
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
function downloadFile(filePath, fileName) {
    var url = ghUrl('https://raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME + '/' + DEFAULT_BRANCH + '/' + encodeURI(filePath));
    showToast('正在下载: ' + fileName);
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'blob';
    xhr.onload = function() {
        if (xhr.status === 200) {
            hideToast();
            saveBlobAs(xhr.response, fileName);
        } else {
            showToast('下载失败(状态码 ' + xhr.status + '): ' + fileName);
            setTimeout(hideToast, 2500);
        }
    };
    xhr.onerror = function() {
        showToast('网络错误，下载失败: ' + fileName);
        setTimeout(hideToast, 2500);
    };
    xhr.send();
}

function showToast(text) {
    var toast = document.getElementById('toast');
    toast.textContent = text;
    toast.classList.add('show');
}

function hideToast() {
    document.getElementById('toast').classList.remove('show');
}

// Parallel chunk downloading (limited concurrency) for faster preview/download
var MERGE_CONCURRENCY = 6;

function fetchMergedBlob(parts, onDone, onFail, onProgress) {
    var buffers = new Array(parts.length);
    var nextIndex = 0;
    var doneCount = 0;
    var failed = false;
    var totalBytes = 0;
    parts.forEach(function(p) { totalBytes += p.size || 0; });
    var loadedBytes = 0;
    var lastSampleLoaded = 0;
    var lastSampleTime = Date.now();
    var speedText = '';

    var progressText = function() {
        var pct = totalBytes ? Math.min(99, Math.round(loadedBytes / totalBytes * 100)) : 0;
        return '正在加载 ' + doneCount + '/' + parts.length + ' · ' + pct + '%' + (speedText ? ' · ' + speedText : '');
    };

    var report = function() {
        showToast(progressText());
        if (onProgress) {
            onProgress(totalBytes ? Math.min(99, Math.round(loadedBytes / totalBytes * 100)) : null, speedText);
        }
    };

    var sample = function() {
        var now = Date.now();
        if (now - lastSampleTime >= 500) {
            var sp = (loadedBytes - lastSampleLoaded) / ((now - lastSampleTime) / 1000);
            lastSampleLoaded = loadedBytes;
            lastSampleTime = now;
            speedText = sp > 1024 ? formatSize(Math.round(sp)) + '/s' : '';
        }
    };

    showToast('正在加载 0/' + parts.length + ' ...');

    var fail = function() {
        if (failed) return;
        failed = true;
        hideToast();
        if (onFail) onFail();
    };

    var next = function() {
        if (failed) return;
        if (doneCount >= parts.length) {
            hideToast();
            if (onProgress) onProgress(100, '');
            onDone(new Blob(buffers));
            return;
        }
        if (nextIndex >= parts.length) return;
        var i = nextIndex++;
        var url = ghUrl('https://raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME + '/' + DEFAULT_BRANCH + '/' + encodeURI(parts[i].path));
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onprogress = function(e) {
            var delta = e.loaded - (parts[i]._loaded || 0);
            parts[i]._loaded = e.loaded;
            loadedBytes += delta;
            sample();
            report();
        };
        xhr.onload = function() {
            if (xhr.status === 200) {
                buffers[i] = xhr.response;
                loadedBytes += (parts[i].size || 0) - (parts[i]._loaded || 0);
                doneCount++;
                report();
                next();
            } else {
                fail();
            }
        };
        xhr.onerror = fail;
        xhr.send();
    };

    var starters = Math.min(MERGE_CONCURRENCY, parts.length);
    for (var k = 0; k < starters; k++) {
        next();
    }
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

function downloadMergedFile(parts, fileName) {
    fetchMergedBlob(parts, function(blob) {
        saveBlobAs(blob, fileName);
    }, function() {
        showToast('下载失败，请重试');
        setTimeout(hideToast, 2000);
    });
}

function getFileExtension(fileName) {
    var parts = fileName.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

var AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'aac', 'flac'];
var VIDEO_EXTS = ['mp4', 'webm', 'ogg', 'avi', 'mov'];
var IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'];

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

function highlightCode(code, lang) {
    var kw = {};
    (LANG_KEYWORDS[lang] || '').split(' ').forEach(function(w) { kw[w] = true; });
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
function mdInline(text) {
    var s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2" style="max-width: 100%; border-radius: 6px;">');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s;
}

function markdownToHtml(src) {
    var lines = src.split('\n');
    var html = '';
    var inCode = false;
    var codeBuf = [];
    var listType = null;
    var para = [];

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

    lines.forEach(function(line) {
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
                viewWrap.appendChild(pre);
            } else {
                viewWrap.appendChild(makePlainTextarea(true));
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
    content.innerHTML = '';
    var loadingDiv = document.createElement('div');
    loadingDiv.className = 'loading';
    loadingDiv.textContent = '加载中...';
    content.appendChild(loadingDiv);
    document.getElementById('previewModal').classList.add('show');
    document.getElementById('previewActions').style.display = 'none';
    document.getElementById('previewMessage').className = 'message';
    document.getElementById('previewMessage').textContent = '';

    if (menuFileInfo.chunked) {
        fetchMergedBlob(menuFileInfo.parts, function(blob) {
            if (AUDIO_EXTS.indexOf(ext) !== -1) {
                content.innerHTML = '';
                var audio = document.createElement('audio');
                audio.src = URL.createObjectURL(blob);
                audio.controls = true;
                audio.preload = 'auto';
                audio.className = 'preview-audio';
                content.appendChild(audio);
            } else if (VIDEO_EXTS.indexOf(ext) !== -1) {
                content.innerHTML = '';
                var video = document.createElement('video');
                video.src = URL.createObjectURL(blob);
                video.controls = true;
                video.preload = 'auto';
                video.className = 'preview-video';
                content.appendChild(video);
            } else if (IMAGE_EXTS.indexOf(ext) !== -1) {
                content.innerHTML = '';
                var img = document.createElement('img');
                img.src = URL.createObjectURL(blob);
                img.alt = fileName;
                img.style.maxWidth = '100%';
                img.style.maxHeight = '60vh';
                img.style.borderRadius = '8px';
                content.appendChild(img);
            } else {
                var textReader = new FileReader();
                textReader.onload = function() {
                    renderTextView(textReader.result, false);
                };
                textReader.readAsText(blob);
            }
        }, function() {
            content.innerHTML = '';
            var msgDiv = document.createElement('div');
            msgDiv.className = 'message error';
            msgDiv.textContent = '无法加载文件分片';
            content.appendChild(msgDiv);
        }, function(pct, speed) {
            if (pct !== null) {
                loadingDiv.textContent = '加载中 ' + pct + '%' + (speed ? ' · ' + speed : '');
            }
        });
        return;
    }

    if (AUDIO_EXTS.indexOf(ext) !== -1 || VIDEO_EXTS.indexOf(ext) !== -1 || IMAGE_EXTS.indexOf(ext) !== -1) {
        loadMediaWithRate(previewUrl, menuFileInfo.size, loadingDiv, function(blob) {
            content.innerHTML = '';
            var mediaUrl = URL.createObjectURL(blob);
            if (AUDIO_EXTS.indexOf(ext) !== -1) {
                var audio = document.createElement('audio');
                audio.src = mediaUrl;
                audio.controls = true;
                audio.preload = 'auto';
                audio.className = 'preview-audio';
                content.appendChild(audio);
            } else if (VIDEO_EXTS.indexOf(ext) !== -1) {
                var video = document.createElement('video');
                video.src = mediaUrl;
                video.controls = true;
                video.preload = 'auto';
                video.className = 'preview-video';
                content.appendChild(video);
            } else {
                var img = document.createElement('img');
                img.src = mediaUrl;
                img.alt = fileName;
                img.style.maxWidth = '100%';
                img.style.maxHeight = '60vh';
                img.style.borderRadius = '8px';
                content.appendChild(img);
            }
        }, function(status) {
            content.innerHTML = '';
            var msgDiv = document.createElement('div');
            msgDiv.className = 'message error';
            msgDiv.textContent = status ? '加载失败，状态码: ' + status : '网络错误，无法加载文件';
            content.appendChild(msgDiv);
        });
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
}

function showPreviewMessage(text, type) {
    var msg = document.getElementById('previewMessage');
    msg.className = 'message ' + type;
    msg.textContent = text;
}

function savePreviewFile() {
    var textarea = document.querySelector('.preview-text');
    if (!textarea) return;

    var newContent = textarea.value;
    var saveBtn = document.getElementById('savePreviewBtn');

    saveBtn.disabled = true;
    showPreviewMessage('正在获取授权...', 'success');

    var fail = function(text) {
        showPreviewMessage(text, 'error');
        saveBtn.disabled = false;
    };

    if (getSavedAuth()) {
        ensureGhKey(function(key) {
            if (!key) {
                fail('获取授权失败，请重新登录');
                return;
            }
            updateFileOnGitHub(key, previewFileInfo.path, newContent);
        });
        return;
    }

    var username = prompt('请输入用户名:');
    var password = prompt('请输入密码:');
    if (!username || !password) {
        fail('请输入用户名和密码');
        return;
    }
    loginAndGetKey(username, password, false, function(err, key) {
        if (err) {
            fail('获取授权失败: ' + err);
            return;
        }
        updateFileOnGitHub(key, previewFileInfo.path, newContent);
    });
}

function updateFileOnGitHub(key, filePath, newContent) {
    var shaUrl = ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + encodeURI(filePath));
    var shaXhr = new XMLHttpRequest();
    shaXhr.open('GET', shaUrl, true);
    shaXhr.setRequestHeader('Authorization', 'Bearer ' + key);
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
                updateXhr.setRequestHeader('Authorization', 'Bearer ' + key);
                updateXhr.setRequestHeader('Content-Type', 'application/json');

                updateXhr.onload = function() {
                    if (updateXhr.status === 200 || updateXhr.status === 201) {
                        fileTreeCache = null;
                        invalidateHttpCache();
                        showPreviewMessage('保存成功！', 'success');
                        setTimeout(function() {
                            closePreviewModal();
                            loadFileList();
                        }, 1500);
                    } else {
                        try {
                            var error = JSON.parse(updateXhr.responseText);
                            showPreviewMessage('保存失败: ' + (error.message || '未知错误'), 'error');
                        } catch (e) {
                            showPreviewMessage('保存失败，状态码: ' + updateXhr.status, 'error');
                        }
                        document.getElementById('savePreviewBtn').disabled = false;
                    }
                };

                updateXhr.onerror = function() {
                    showPreviewMessage('网络错误，保存失败', 'error');
                    document.getElementById('savePreviewBtn').disabled = false;
                };

                updateXhr.send(JSON.stringify(data));
            } catch (e) {
                showPreviewMessage('获取文件信息失败', 'error');
                document.getElementById('savePreviewBtn').disabled = false;
            }
        } else {
            showPreviewMessage('获取文件信息失败，状态码: ' + shaXhr.status, 'error');
            document.getElementById('savePreviewBtn').disabled = false;
        }
    };
    shaXhr.onerror = function() {
        showPreviewMessage('网络错误，无法获取文件信息', 'error');
        document.getElementById('savePreviewBtn').disabled = false;
    };
    shaXhr.send();
}

function confirmDelete() {
    var deleteBtn = document.getElementById('deleteBtn');
    deleteBtn.disabled = true;
    showDeleteMessage('正在获取授权...', 'success');

    var runDelete = function(key) {
        if (deleteFileType === 'dir') {
            deleteFolder(key, deleteFilePath);
        } else if (deleteFileType === 'chunked' || deleteFileType === 'batch') {
            deleteFolderFiles(key, deleteParts, 0);
        } else {
            deleteFile(key, deleteFilePath, deleteFileSha);
        }
    };

    var fail = function(text) {
        showDeleteMessage(text, 'error');
        deleteBtn.disabled = false;
    };

    if (getSavedAuth()) {
        ensureGhKey(function(key) {
            if (!key) {
                fail('获取授权失败，请重新登录');
                return;
            }
            runDelete(key);
        });
        return;
    }

    var username = document.getElementById('deleteUsername').value;
    var password = document.getElementById('deletePassword').value;
    if (!username || !password) {
        fail('请输入用户名和密码');
        return;
    }
    loginAndGetKey(username, password, document.getElementById('deleteRememberMe').checked, function(err, key) {
        if (err) {
            fail('获取授权失败: ' + err);
            return;
        }
        runDelete(key);
    });
}

function deleteFile(key, filePath, sha) {
    showDeleteMessage('正在删除...', 'success');

    var data = {
        message: 'Delete file: ' + filePath,
        sha: sha
    };

    var deleteXhr = new XMLHttpRequest();
    var deleteUrl = ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + encodeURI(filePath));
    deleteXhr.open('DELETE', deleteUrl, true);
    deleteXhr.setRequestHeader('Authorization', 'Bearer ' + key);
    deleteXhr.setRequestHeader('Content-Type', 'application/json');

    deleteXhr.onload = function() {
        if (deleteXhr.status === 200 || deleteXhr.status === 201) {
            fileTreeCache = null;
            invalidateHttpCache();
            showDeleteMessage('删除成功！', 'success');
            setTimeout(function() {
                closeDeleteModal();
                loadFileList();
            }, 1500);
        } else {
            try {
                var error = JSON.parse(deleteXhr.responseText);
                showDeleteMessage('删除失败: ' + (error.message || '未知错误'), 'error');
            } catch (e) {
                showDeleteMessage('删除失败，状态码: ' + deleteXhr.status, 'error');
            }
            document.getElementById('deleteBtn').disabled = false;
        }
    };

    deleteXhr.onerror = function() {
        showDeleteMessage('网络错误，删除失败', 'error');
        document.getElementById('deleteBtn').disabled = false;
    };

    deleteXhr.send(JSON.stringify(data));
}

function deleteFolderError() {
    showDeleteMessage('获取文件夹内容失败', 'error');
    document.getElementById('deleteBtn').disabled = false;
}

function deleteFolder(key, folderPath) {
    showDeleteMessage('正在获取文件夹内容...', 'success');

    fetchFileTree(function() {
        var prefix = folderPath + '/';
        var files = [];
        fileTreeCache.forEach(function(item) {
            if (item.type === 'blob' && item.path && item.path.indexOf(prefix) === 0) {
                files.push(item);
            }
        });
        if (!files.length) {
            showDeleteMessage('文件夹为空或不存在', 'error');
            document.getElementById('deleteBtn').disabled = false;
            return;
        }
        deleteFolderFiles(key, files, 0);
    }, deleteFolderError);
}

// Sequential delete (single-threaded) to avoid git ref conflicts;
// per-file conflict retry still applies when the ref moves unexpectedly.
function deleteFolderFiles(key, files) {
    if (!files.length) {
        deleteAllDone();
        return;
    }
    var state = {
        next: 0,
        active: 0,
        done: 0,
        limit: 1,
        failed: false,
        errMsg: ''
    };
    showDeleteMessage('正在删除 (0/' + files.length + ')', 'success');

    function settle() {
        if (state.active > 0) return;
        if (state.failed) {
            showDeleteMessage('删除失败: ' + state.errMsg + '（已删除 ' + state.done + '/' + files.length + '）', 'error');
            document.getElementById('deleteBtn').disabled = false;
            return;
        }
        if (state.next >= files.length) {
            deleteAllDone();
        }
    }

    function pump() {
        while (!state.failed && state.active < state.limit && state.next < files.length) {
            var f = files[state.next++];
            state.active++;
            (function(file) {
                var attempt = function() {
                    var data = {
                        message: 'Delete file: ' + file.path,
                        sha: file.sha
                    };
                    var xhr = new XMLHttpRequest();
                    xhr.open('DELETE', ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + encodeURI(file.path)), true);
                    xhr.setRequestHeader('Authorization', 'Bearer ' + key);
                    xhr.setRequestHeader('Content-Type', 'application/json');
                    xhr.onload = function() {
                        // Ref conflict from parallel commits: retry this file with
                        // jittered backoff instead of failing the whole batch.
                        var isRefConflict = xhr.status === 409 || /is at [0-9a-f]{40} but expected/i.test(xhr.responseText || '');
                        if (isRefConflict) {
                            file._conflicts = (file._conflicts || 0) + 1;
                            if (file._conflicts <= 8) {
                                showDeleteMessage('提交冲突，重试 (' + file._conflicts + '/8): ' + file.path, 'success');
                                setTimeout(attempt, 1200 * file._conflicts + Math.floor(Math.random() * 800));
                                return;
                            }
                        }
                        state.active--;
                        if (xhr.status === 200 || xhr.status === 201) {
                            state.done++;
                            showDeleteMessage('正在删除 (' + state.done + '/' + files.length + '): ' + file.path, 'success');
                        } else if (xhr.status === 404) {
                            // already gone (e.g. removed by an earlier attempt): count as done
                            state.done++;
                            showDeleteMessage('已不存在，跳过 (' + state.done + '/' + files.length + '): ' + file.path, 'success');
                        } else {
                            state.failed = true;
                            try {
                                var error = JSON.parse(xhr.responseText);
                                state.errMsg = error.message || ('状态码 ' + xhr.status);
                            } catch (e) {
                                state.errMsg = '状态码 ' + xhr.status;
                            }
                        }
                        pump();
                        settle();
                    };
                    xhr.onerror = function() {
                        state.active--;
                        state.failed = true;
                        state.errMsg = '网络错误';
                        settle();
                    };
                    xhr.send(JSON.stringify(data));
                };
                attempt();
            })(f);
        }
    }
    pump();
}

function deleteAllDone() {
    fileTreeCache = null;
    invalidateHttpCache();
    showDeleteMessage('删除成功！', 'success');
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

function showRefreshIndicator() {
    var el = document.getElementById('refreshIndicator');
    if (el) el.classList.add('show');
}

function hideRefreshIndicator() {
    var el = document.getElementById('refreshIndicator');
    if (el) el.classList.remove('show');
}

function loadFileList(retried) {
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

    cachedGet(apiUrl, true, function(status, body, notModified) {
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
            if (!retried && getSavedAuth()) {
                // cached key may be stale/rate-limited: force a fresh login
                fetchGhKey(function() { loadFileList(true); }, true);
                return;
            }
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
    if (batchDownloadState) return;
    var keys = Object.keys(selectedKeys);
    if (!keys.length) return;
    var models = keys.map(function(k) { return selectedKeys[k]; });
    batchDownloadState = { cancelled: false };
    toggleBatchDownloadUI(true);
    var i = 0;
    var next = function() {
        if (!batchDownloadState || batchDownloadState.cancelled) {
            finishBatchDownload(true);
            return;
        }
        if (i >= models.length) {
            finishBatchDownload(false);
            return;
        }
        var m = models[i++];
        showToast('正在下载 (' + i + '/' + models.length + '): ' + m.displayName);
        if (m.chunked && m.parts) {
            downloadMergedFile(m.parts, m.name);
        } else {
            downloadFile(m.path, m.name);
        }
        setTimeout(next, 800);
    };
    next();
}

function stopBatchDownload() {
    if (batchDownloadState) {
        batchDownloadState.cancelled = true;
    }
}

function finishBatchDownload(stopped) {
    batchDownloadState = null;
    toggleBatchDownloadUI(false);
    showToast(stopped ? '已停止批量下载' : '批量下载已全部开始');
    setTimeout(hideToast, 2000);
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
        container.innerHTML = '';
        models.forEach(function(m) {
            var el = createEntryElement(m);
            container.appendChild(el);
            entryMap[m.key] = { el: el, model: m, sizeText: m.sizeText };
        });
        listChanged = true;
    } else {
        // removals (animated, only the affected entries)
        entryOrder.forEach(function(k) {
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
var uploadedParts = [];

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
        showMessage('请先登录后再上传文件', 'error');
        return;
    }

    if (!pendingFiles.length) {
        showMessage('请选择要上传的文件', 'error');
        return;
    }

    var conflicts = findUploadConflicts();
    if (conflicts.length && !confirm('以下同名内容已存在于当前目录：\n' + conflicts.join('\n') + '\n\n是否继续上传？')) {
        return;
    }

    uploadBtn.disabled = true;
    showMessage('正在获取授权...', 'success');

    ensureGhKey(function(key) {
        if (!key) {
            showMessage('获取授权失败，请重新登录', 'error');
            uploadBtn.disabled = false;
            return;
        }
        chunkSizeLevel = 0;
        startUpload(key);
    });
}

// ---- Parallel chunked upload with per-chunk retry and live speed ----
var UPLOAD_MAX_ATTEMPTS = 4;
var UPLOAD_LIMIT_MIN = 1;
var UPLOAD_LIMIT_MAX = 6;
var uploadState = null;

function startUpload(key, doneBases) {
    uploadTasks = buildUploadTasks().filter(function(t) {
        return !(doneBases && doneBases[t.base]);
    });
    uploadedParts = uploadedParts.filter(function(p) {
        return !doneBases || doneBases[p.base];
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
        key: key,
        nextIndex: 0,
        active: 0,
        doneCount: 0,
        fractionSum: 0,
        bytesDone: 0,
        lastSampleBytes: 0,
        lastSampleTime: Date.now(),
        speedText: '',
        baseTotals: {},
        baseDones: {},
        doneBases: doneBases || {},
        downgrading: false,
        failedMsg: null,
        speedTimer: null,
        activeTasks: {},
        adaptive: adaptive,
        limit: adaptive ? 2 : Math.min(10, Math.max(UPLOAD_LIMIT_MIN, parseInt(mode, 10) || 3)),
        startTime: Date.now(),
        smallDurSum: 0,
        smallDurCount: 0,
        conflictCount: 0,
        smallRatio: 0
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
    uploadState.speedTimer = setInterval(sampleUploadSpeed, 1000);
    showMessage('正在上传 (0/' + uploadTasks.length + ') · 分片大小 ' + currentChunkLabel(), 'success');
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
        st.limit = Math.min(10, Math.max(UPLOAD_LIMIT_MIN, v || 3));
    }
    renderChunkPanel();
    fillUploads();
}

// Keep the pipeline filled up to the current concurrency limit.
// The limit may change at runtime in adaptive mode.
function fillUploads() {
    var st = uploadState;
    if (!st) return;
    while (!st.failedMsg && !st.downgrading && st.active < st.limit && st.nextIndex < uploadTasks.length) {
        var task = uploadTasks[st.nextIndex++];
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
                            if (dur < 10000 && st2.limit < UPLOAD_LIMIT_MAX) {
                                st2.limit++;
                            } else if (dur > 30000 && st2.limit > UPLOAD_LIMIT_MIN) {
                                st2.limit--;
                            }
                        }
                    }
                    showMessage('正在上传 (' + st2.doneCount + '/' + uploadTasks.length + ') · 分片大小 ' + currentChunkLabel(), 'success');
                }
                updateUploadProgressUI();
                fillUploads();
            });
        })(task);
    }
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
        var key = st.key;
        var doneBases = st.doneBases;
        var staleParts = uploadedParts.filter(function(p) { return !doneBases[p.base]; });
        showMessage('分片过大，已自动减小分片大小（当前 ' + currentChunkLabel() + '），正在重新上传...', 'success');
        stopUploadTimer();
        uploadState = null;
        deletePartsQuietly(key, staleParts, 0, function() {
            fileTreeCache = null;
            startUpload(key, doneBases);
        });
        return;
    }
    if (st.nextIndex >= uploadTasks.length) {
        finishUpload();
    }
}

function runUploadTask(task, done) {
    var st = uploadState;
    var attempt = 0;
    var conflicts = 0;

    var tryOnce = function() {
        if (!uploadState) {
            done(false);
            return;
        }
        attempt++;
        task.loadedBytes = 0;
        task.startTime = Date.now();
        var reader = new FileReader();
        reader.onload = function(e) {
            var base64Content = e.target.result.split(',')[1];
            var currentPath = getCurrentPath();
            var filePath = currentPath ? currentPath + '/' + task.relativePath : task.relativePath;

            putFileToGitHub(st.key, filePath, base64Content, null,
                function(newSha) {
                    if (PART_SUFFIX.test(task.relativePath) && newSha) {
                        uploadedParts.push({ path: filePath, sha: newSha, base: task.base });
                    }
                    st.fractionSum -= (task.fraction || 0);
                    task.fraction = 0;
                    st.bytesDone += task.blob.size - (task.loadedBytes || 0);
                    done(true);
                },
                function(status, responseText) {
                    st.fractionSum -= (task.fraction || 0);
                    task.fraction = 0;
                    st.bytesDone -= (task.loadedBytes || 0);
                    task.loadedBytes = 0;

                    if (/too large/i.test(responseText || '') && chunkSizeLevel < CHUNK_SIZE_LEVELS.length - 1) {
                        if (!st.downgrading) {
                            st.downgrading = true;
                            chunkSizeLevel++;
                            showMessage('分片过大，已自动减小分片大小（当前 ' + currentChunkLabel() + '），等待进行中的任务完成后重传...', 'success');
                        }
                        done(false);
                        return;
                    }

                    // Ref conflicts (409, or "is at <sha> but expected <sha>"): concurrent
                    // commits race on the same git ref. Retry separately with longer
                    // jittered backoff; does not consume normal attempts.
                    var isRefConflict = status === 409 || /is at [0-9a-f]{40} but expected/i.test(responseText || '');
                    if (isRefConflict) {
                        conflicts++;
                        st.conflictCount++;
                        // frequent conflicts mean too much parallel pressure: back off
                        if (st.adaptive && st.limit > UPLOAD_LIMIT_MIN && st.conflictCount % 2 === 0) {
                            st.limit--;
                        }
                        if (conflicts <= 10) {
                            showMessage('提交冲突，等待其他分片完成后重试 (' + conflicts + '/10): ' + task.label, 'success');
                            setTimeout(tryOnce, 1500 * conflicts + Math.floor(Math.random() * 1000));
                            return;
                        }
                    }

                    if (attempt < UPLOAD_MAX_ATTEMPTS) {
                        // adaptive: failures hint the network is saturated, back off
                        if (st.adaptive && st.limit > UPLOAD_LIMIT_MIN) {
                            st.limit--;
                        }
                        showMessage('分片上传失败(状态码 ' + status + ')，正在重试 (' + attempt + '/' + (UPLOAD_MAX_ATTEMPTS - 1) + '): ' + task.label, 'success');
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
                    st.bytesDone += loaded - (task.loadedBytes || 0);
                    task.loadedBytes = loaded;
                    updateUploadProgressUI();
                }
            );
        };
        reader.onerror = function() {
            if (attempt < UPLOAD_MAX_ATTEMPTS) {
                setTimeout(tryOnce, 1000 * attempt);
            } else {
                if (!st.failedMsg) {
                    st.failedMsg = '读取文件失败: ' + task.label;
                }
                done(false);
            }
        };
        reader.readAsDataURL(task.blob);
    };
    tryOnce();
}

function stopUploadTimer() {
    if (uploadState && uploadState.speedTimer) {
        clearInterval(uploadState.speedTimer);
        uploadState.speedTimer = null;
    }
}

function finishUpload() {
    stopUploadTimer();
    uploadState = null;
    renderChunkPanel();
    fileTreeCache = null;
    invalidateHttpCache();
    updateUploadProgressText(100, '');
    showMessage('全部上传成功！', 'success');
    setTimeout(function() {
        closeUploadModal();
        document.getElementById('uploadBtn').disabled = false;
        loadFileList();
    }, 1500);
}

function failUpload(finalMsg) {
    var st = uploadState;
    stopUploadTimer();
    uploadState = null;
    renderChunkPanel();
    var staleParts = uploadedParts.filter(function(p) { return !st.doneBases[p.base]; });
    if (staleParts.length > 0) {
        uploadedParts = staleParts;
        cleanupUploadedParts(st.key, finalMsg);
    } else {
        showMessage(finalMsg, 'error');
        document.getElementById('uploadBtn').disabled = false;
    }
}

function sampleUploadSpeed() {
    var st = uploadState;
    if (!st) return;
    var now = Date.now();
    var dt = (now - st.lastSampleTime) / 1000;
    if (dt <= 0) return;
    var speed = (st.bytesDone - st.lastSampleBytes) / dt;
    st.lastSampleBytes = st.bytesDone;
    st.lastSampleTime = now;
    st.speedText = speed > 1024 ? formatSize(Math.round(speed)) + '/s' : '';
    // per-chunk speeds
    for (var key in st.activeTasks) {
        var t = st.activeTasks[key];
        var chunkSpeed = ((t.loadedBytes || 0) - (t.sampledBytes || 0)) / dt;
        t.sampledBytes = t.loadedBytes || 0;
        t.speedText = chunkSpeed > 1024 ? formatSize(Math.round(chunkSpeed)) + '/s' : '';
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
    document.getElementById('chunkPanelSummary').textContent =
        '· 并行 ' + st.limit + (st.adaptive ? '(自适应)' : '') + ' · 进行中 ' + activeList.length + ' · 已完成 ' + st.doneCount + '/' + uploadTasks.length;
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
    var elapsed = (Date.now() - st.startTime) / 1000;
    if (elapsed <= 0) return '';
    var speed = st.bytesDone / elapsed;
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
    if (!isFinite(eta) || eta < 1) return '';
    var m = Math.floor(eta / 60);
    var s = Math.round(eta % 60);
    if (m > 59) return Math.floor(m / 60) + '小时' + (m % 60) + '分';
    return (m > 0 ? m + '分' : '') + s + '秒';
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
}

function putFileToGitHub(key, filePath, base64Content, sha, onSuccess, onError, onProgress, retries) {
    if (retries === undefined) retries = 2;

    var data = {
        message: 'Upload file: ' + filePath,
        content: base64Content
    };
    if (sha) data.sha = sha;

    var uploadXhr = new XMLHttpRequest();
    var uploadUrl = ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + encodeURI(filePath));
    uploadXhr.open('PUT', uploadUrl, true);
    uploadXhr.setRequestHeader('Authorization', 'Bearer ' + key);
    uploadXhr.setRequestHeader('Content-Type', 'application/json');

    uploadXhr.upload.onprogress = function(e) {
        if (e.lengthComputable && onProgress) {
            onProgress(e.loaded / e.total);
        }
    };

    uploadXhr.onload = function() {
        if (uploadXhr.status === 200 || uploadXhr.status === 201) {
            var newSha = null;
            try {
                newSha = JSON.parse(uploadXhr.responseText).content.sha;
            } catch (e) {}
            onSuccess(newSha);
            return;
        }
        if (uploadXhr.status === 422 && !sha) {
            var shaXhr = new XMLHttpRequest();
            shaXhr.open('GET', uploadUrl, true);
            shaXhr.setRequestHeader('Authorization', 'Bearer ' + key);
            shaXhr.onload = function() {
                if (shaXhr.status === 200) {
                    try {
                        var info = JSON.parse(shaXhr.responseText);
                        putFileToGitHub(key, filePath, base64Content, info.sha, onSuccess, onError, onProgress);
                        return;
                    } catch (e) {}
                }
                onError(uploadXhr.status, uploadXhr.responseText);
            };
            shaXhr.onerror = function() {
                onError(uploadXhr.status, uploadXhr.responseText);
            };
            shaXhr.send();
            return;
        }
        onError(uploadXhr.status, uploadXhr.responseText);
    };

    uploadXhr.onerror = function() {
        if (retries > 0) {
            putFileToGitHub(key, filePath, base64Content, sha, onSuccess, onError, onProgress, retries - 1);
            return;
        }
        onError(0, '');
    };

    uploadXhr.send(JSON.stringify(data));
}

function cleanupUploadedParts(key, finalMsg) {
    showMessage('上传失败，正在清理已上传的分片...', 'error');
    deletePartsQuietly(key, uploadedParts, 0, function() {
        fileTreeCache = null;
        uploadedParts = [];
        showMessage(finalMsg + '（残留分片已清理）', 'error');
        document.getElementById('uploadBtn').disabled = false;
    });
}

function deletePartsQuietly(key, parts, index, done) {
    if (index >= parts.length) {
        done();
        return;
    }
    var data = {
        message: 'Delete file: ' + parts[index].path,
        sha: parts[index].sha
    };
    var xhr = new XMLHttpRequest();
    xhr.open('DELETE', ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + encodeURI(parts[index].path)), true);
    xhr.setRequestHeader('Authorization', 'Bearer ' + key);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function() {
        deletePartsQuietly(key, parts, index + 1, done);
    };
    xhr.onerror = function() {
        deletePartsQuietly(key, parts, index + 1, done);
    };
    xhr.send(JSON.stringify(data));
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

    // config and key fetches are independent: run in parallel for faster first load
    var cfgDone = false;
    var keyDone = false;
    function kickoff() {
        if (cfgDone && keyDone) loadFileList();
    }
    loadConfig(function() { cfgDone = true; kickoff(); });
    fetchGhKey(function() { keyDone = true; kickoff(); });

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
