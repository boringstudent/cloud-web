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

function fetchGhKey(done) {
    var finish = function() {
        ghApiKeyFetching = false;
        if (done) done();
    };
    if (ghApiKey || ghApiKeyFetching) { finish(); return; }
    var saved = getSavedAuth();
    if (!saved) { finish(); return; }
    ghApiKeyFetching = true;
    var params = 'username=' + encodeURIComponent(saved.u) + '&password=' + encodeURIComponent(saved.p);
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://api.boring-student.cn/?' + params, true);
    xhr.onload = function() {
        if (xhr.status === 200) {
            try {
                var response = JSON.parse(xhr.responseText);
                if (response.success && response.key) ghApiKey = response.key;
            } catch (e) {}
        }
        finish();
    };
    xhr.onerror = finish;
    xhr.send();
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
    Math.floor((104857600 - 4096) * 3 / 4),
    Math.floor((73400320 - 4096) * 3 / 4),
    Math.floor((41943040 - 4096) * 3 / 4),
    Math.floor((20971520 - 4096) * 3 / 4)
];
var chunkSizeLevel = 0;
var PART_SUFFIX = /\.part(\d+)$/;

function getPartNumber(name) {
    var m = name.match(PART_SUFFIX);
    return m ? parseInt(m[1], 10) : 0;
}

var AUTH_STORAGE_KEY = 'cloud_web_auth';

function saveAuth(username, password) {
    try {
        localStorage.setItem(AUTH_STORAGE_KEY, btoa(unescape(encodeURIComponent(JSON.stringify({ u: username, p: password })))));
    } catch (e) {}
}

function getSavedAuth() {
    try {
        var data = localStorage.getItem(AUTH_STORAGE_KEY);
        if (!data) return null;
        var obj = JSON.parse(decodeURIComponent(escape(atob(data))));
        if (obj && obj.u && obj.p) return obj;
        return null;
    } catch (e) {
        return null;
    }
}

function clearAuth() {
    try {
        localStorage.removeItem(AUTH_STORAGE_KEY);
    } catch (e) {}
}

function handleRememberAuth(username, password, remember) {
    if (remember) {
        saveAuth(username, password);
    } else {
        clearAuth();
    }
    updateAuthBtn();
}

function fillAuthInputs(usernameId, passwordId, checkboxId) {
    var saved = getSavedAuth();
    if (saved) {
        document.getElementById(usernameId).value = saved.u;
        document.getElementById(passwordId).value = saved.p;
        document.getElementById(checkboxId).checked = true;
    }
}

function updateAuthBtn() {
    var btn = document.getElementById('authBtn');
    var user = document.getElementById('authUser');
    var saved = getSavedAuth();
    if (btn) {
        btn.textContent = saved ? '退出登录' : '登录';
    }
    if (user) {
        if (saved) {
            user.textContent = '当前用户: ' + saved.u;
            user.style.display = 'block';
        } else {
            user.style.display = 'none';
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
    var loginBtn = document.getElementById('loginBtn');

    if (!username || !password) {
        showLoginMessage('请输入用户名和密码', 'error');
        return;
    }

    loginBtn.disabled = true;
    showLoginMessage('正在登录...', 'success');

    var params = 'username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(password);
    var keyUrl = 'https://api.boring-student.cn/?' + params;

    var xhr = new XMLHttpRequest();
    xhr.open('GET', keyUrl, true);
    xhr.onload = function() {
        if (xhr.status === 200) {
            try {
                var response = JSON.parse(xhr.responseText);
                if (response.success && response.key) {
                    ghApiKey = response.key;
                    saveAuth(username, password);
                    updateAuthBtn();
                    showLoginMessage('登录成功！', 'success');
                    setTimeout(function() {
                        closeLoginModal();
                        document.getElementById('loginBtn').disabled = false;
                    }, 1000);
                } else {
                    showLoginMessage('用户名或密码错误', 'error');
                    loginBtn.disabled = false;
                }
            } catch (e) {
                showLoginMessage('解析响应失败', 'error');
                loginBtn.disabled = false;
            }
        } else {
            showLoginMessage('登录失败，状态码: ' + xhr.status, 'error');
            loginBtn.disabled = false;
        }
    };
    xhr.onerror = function() {
        showLoginMessage('网络错误，登录失败', 'error');
        loginBtn.disabled = false;
    };
    xhr.send();
}

function logout() {
    ghApiKey = null;
    clearAuth();
    updateAuthBtn();
    document.getElementById('deleteUsername').value = '';
    document.getElementById('deletePassword').value = '';
    document.getElementById('deleteRememberMe').checked = false;
    document.getElementById('loginUsername').value = '';
    document.getElementById('loginPassword').value = '';
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
    var sizeSpans = document.querySelectorAll('.dir-size');
    sizeSpans.forEach(function(span) {
        var dirPath = span.getAttribute('data-path');
        if (!dirPath) return;
        var totalSize = 0;
        var prefix = dirPath + '/';
        fileTreeCache.forEach(function(item) {
            if (item.type === 'blob' && item.path && item.path.indexOf(prefix) === 0) {
                totalSize += (item.size || 0);
            }
        });
        var text = formatSize(totalSize);
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
    propsHtml += propRow('名称', escapeHtml(fileName));
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
    window.open(url, '_blank');
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

function downloadFile(filePath, fileName) {
    var url = ghUrl('https://raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME + '/' + DEFAULT_BRANCH + '/' + encodeURI(filePath));
    var link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
var MERGE_CONCURRENCY = 4;

function fetchMergedBlob(parts, onDone, onFail) {
    var buffers = new Array(parts.length);
    var nextIndex = 0;
    var doneCount = 0;
    var failed = false;
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
            onDone(new Blob(buffers));
            return;
        }
        if (nextIndex >= parts.length) return;
        var i = nextIndex++;
        var url = ghUrl('https://raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME + '/' + DEFAULT_BRANCH + '/' + encodeURI(parts[i].path));
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = function() {
            if (xhr.status === 200) {
                buffers[i] = xhr.response;
                doneCount++;
                showToast('正在加载 ' + doneCount + '/' + parts.length + ' ...');
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

function downloadMergedFile(parts, fileName) {
    fetchMergedBlob(parts, function(blob) {
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(function() { URL.revokeObjectURL(url); }, 10000);
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
                    var textarea = document.createElement('textarea');
                    textarea.className = 'preview-text';
                    textarea.value = textReader.result;
                    textarea.readOnly = true;
                    content.innerHTML = '';
                    content.appendChild(textarea);
                };
                textReader.readAsText(blob);
            }
        }, function() {
            content.innerHTML = '';
            var msgDiv = document.createElement('div');
            msgDiv.className = 'message error';
            msgDiv.textContent = '无法加载文件分片';
            content.appendChild(msgDiv);
        });
        return;
    }

    if (AUDIO_EXTS.indexOf(ext) !== -1) {
        content.innerHTML = '';
        var audio = document.createElement('audio');
        audio.src = previewUrl;
        audio.controls = true;
        audio.preload = 'auto';
        audio.className = 'preview-audio';
        content.appendChild(audio);
    } else if (VIDEO_EXTS.indexOf(ext) !== -1) {
        content.innerHTML = '';
        var video = document.createElement('video');
        video.src = previewUrl;
        video.controls = true;
        video.preload = 'auto';
        video.className = 'preview-video';
        content.appendChild(video);
    } else if (IMAGE_EXTS.indexOf(ext) !== -1) {
        content.innerHTML = '';
        var img = document.createElement('img');
        img.src = previewUrl;
        img.alt = fileName;
        img.style.maxWidth = '100%';
        img.style.maxHeight = '60vh';
        img.style.borderRadius = '8px';
        content.appendChild(img);
    } else {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', previewUrl, true);
        xhr.onload = function() {
            if (xhr.status === 200) {
                var textarea = document.createElement('textarea');
                textarea.className = 'preview-text';
                textarea.value = xhr.responseText;
                textarea.readOnly = true;
                content.innerHTML = '';
                content.appendChild(textarea);
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
            var textarea = document.createElement('textarea');
            textarea.className = 'preview-text';
            textarea.value = xhr.responseText;
            textarea.readOnly = false;
            content.innerHTML = '';
            content.appendChild(textarea);
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

    var savedAuth = getSavedAuth();
    var username, password;
    if (savedAuth) {
        username = savedAuth.u;
        password = savedAuth.p;
    } else {
        username = prompt('请输入用户名:');
        password = prompt('请输入密码:');
    }

    if (!username || !password) {
        showPreviewMessage('请输入用户名和密码', 'error');
        saveBtn.disabled = false;
        return;
    }

    var params = 'username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(password);
    var keyUrl = 'https://api.boring-student.cn/?' + params;

    var xhr = new XMLHttpRequest();
    xhr.open('GET', keyUrl, true);
    xhr.onload = function() {
        if (xhr.status === 200) {
            try {
                var response = JSON.parse(xhr.responseText);
                if (response.success && response.key) {
                    updateFileOnGitHub(response.key, previewFileInfo.path, newContent);
                } else {
                    showPreviewMessage('获取授权失败', 'error');
                    saveBtn.disabled = false;
                }
            } catch (e) {
                showPreviewMessage('解析授权响应失败', 'error');
                saveBtn.disabled = false;
            }
        } else {
            showPreviewMessage('获取授权失败，状态码: ' + xhr.status, 'error');
            saveBtn.disabled = false;
        }
    };
    xhr.onerror = function() {
        showPreviewMessage('网络错误，无法获取授权', 'error');
        saveBtn.disabled = false;
    };
    xhr.send();
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
    var savedAuth = getSavedAuth();
    var username, password;
    if (savedAuth) {
        username = savedAuth.u;
        password = savedAuth.p;
    } else {
        username = document.getElementById('deleteUsername').value;
        password = document.getElementById('deletePassword').value;
    }
    var deleteBtn = document.getElementById('deleteBtn');

    if (!username || !password) {
        showDeleteMessage('请输入用户名和密码', 'error');
        return;
    }

    deleteBtn.disabled = true;
    showDeleteMessage('正在获取授权...', 'success');

    var params = 'username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(password);
    var keyUrl = 'https://api.boring-student.cn/?' + params;

    var xhr = new XMLHttpRequest();
    xhr.open('GET', keyUrl, true);
    xhr.onload = function() {
        if (xhr.status === 200) {
            try {
                var response = JSON.parse(xhr.responseText);
                if (response.success && response.key) {
                    if (!savedAuth) {
                        handleRememberAuth(username, password, document.getElementById('deleteRememberMe').checked);
                    }
                    if (deleteFileType === 'dir') {
                        deleteFolder(response.key, deleteFilePath);
                    } else if (deleteFileType === 'chunked') {
                        deleteFolderFiles(response.key, deleteParts, 0);
                    } else {
                        deleteFile(response.key, deleteFilePath, deleteFileSha);
                    }
                } else {
                    showDeleteMessage('获取授权失败', 'error');
                    deleteBtn.disabled = false;
                }
            } catch (e) {
                showDeleteMessage('解析授权响应失败', 'error');
                deleteBtn.disabled = false;
            }
        } else {
            showDeleteMessage('获取授权失败，状态码: ' + xhr.status, 'error');
            deleteBtn.disabled = false;
        }
    };
    xhr.onerror = function() {
        showDeleteMessage('网络错误，无法获取授权', 'error');
        deleteBtn.disabled = false;
    };
    xhr.send();
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

function deleteFolderFiles(key, files, index) {
    if (index >= files.length) {
        fileTreeCache = null;
        invalidateHttpCache();
        showDeleteMessage('删除成功！', 'success');
        setTimeout(function() {
            closeDeleteModal();
            loadFileList();
        }, 1500);
        return;
    }

    showDeleteMessage('正在删除 (' + (index + 1) + '/' + files.length + '): ' + files[index].path, 'success');

    var data = {
        message: 'Delete file: ' + files[index].path,
        sha: files[index].sha
    };

    var deleteXhr = new XMLHttpRequest();
    var deleteUrl = ghUrl('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + encodeURI(files[index].path));
    deleteXhr.open('DELETE', deleteUrl, true);
    deleteXhr.setRequestHeader('Authorization', 'Bearer ' + key);
    deleteXhr.setRequestHeader('Content-Type', 'application/json');

    deleteXhr.onload = function() {
        if (deleteXhr.status === 200 || deleteXhr.status === 201) {
            deleteFolderFiles(key, files, index + 1);
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

function getCurrentPath() {
    var path = window.location.pathname;
    if (path.endsWith('/')) {
        path = path.substring(0, path.length - 1);
    }
    if (path === '') {
        return '';
    }
    var parts = path.split('/');
    if (parts.length > 0 && parts[0] === REPO_NAME) {
        return parts.slice(1).join('/');
    }
    return path.substring(1);
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
        currentPath += '/' + parts[i];
        var separator = document.createElement('span');
        separator.textContent = ' / ';
        crumbs.appendChild(separator);

        var link = document.createElement('a');
        link.href = currentPath + '/';
        link.textContent = decodeURIComponent(parts[i]);
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
    var apiUrl = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + path;

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
                    var dirName = decodeURIComponent(pathParts[pathParts.length - 1]);
                    pageTitle.textContent = dirName;
                    document.title = dirName + ' - boring_student';
                }
                renderFileList(items);
            } catch (e) {
                showListError('解析文件列表失败');
            }
        } else if (status === 403) {
            if (!retried && !ghApiKey && getSavedAuth()) {
                fetchGhKey(function() { loadFileList(true); });
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
            path: file.path,
            sha: file.sha,
            size: file.size,
            chunked: file.chunked || false,
            parts: file.parts || null,
            sizeText: formatSize(file.size)
        });
    });
    return models;
}

function createEntryElement(model) {
    var currentPath = getCurrentPath();
    var baseUrl = currentPath ? '/' + currentPath + '/' : '/';

    var entry = document.createElement('a');
    entry.className = 'entry';
    entry._key = model.key;

    var nameSpan = document.createElement('span');
    var infoSpan = document.createElement('span');
    infoSpan.className = 'file-info';
    var sizeSpan = document.createElement('span');

    if (model.kind === 'dir') {
        entry.href = baseUrl + encodeURIComponent(model.name) + '/';
        nameSpan.textContent = model.name + '/';
        sizeSpan.className = 'dir-size';
        sizeSpan.setAttribute('data-path', model.path);
        sizeSpan.textContent = '-';
        entry._model = {
            path: model.path,
            sha: model.sha,
            name: model.name,
            type: 'dir'
        };
    } else {
        if (model.chunked) {
            entry.href = 'javascript:void(0);';
            entry.onclick = function() {
                downloadMergedFile(entry._model.parts, entry._model.name);
            };
        } else {
            entry.href = ghUrl('https://raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME + '/' + DEFAULT_BRANCH + '/' + encodeURI(model.path));
            entry.target = '_blank';
        }
        nameSpan.textContent = model.name;
        sizeSpan.textContent = model.sizeText;
        entry._model = {
            path: model.path,
            sha: model.sha,
            name: model.name,
            type: 'file',
            size: model.size,
            chunked: model.chunked,
            parts: model.parts
        };
    }

    infoSpan.appendChild(sizeSpan);
    entry.appendChild(nameSpan);
    entry.appendChild(infoSpan);
    entry._sizeSpan = sizeSpan;
    bindEntryEvents(entry);
    return entry;
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

    uploadBtn.disabled = true;
    showMessage('正在获取授权...', 'success');

    var params = 'username=' + encodeURIComponent(auth.u) + '&password=' + encodeURIComponent(auth.p);
    var keyUrl = 'https://api.boring-student.cn/?' + params;

    var xhr = new XMLHttpRequest();
    xhr.open('GET', keyUrl, true);
    xhr.onload = function() {
        if (xhr.status === 200) {
            try {
                var response = JSON.parse(xhr.responseText);
                if (response.success && response.key) {
                    uploadTasks = buildUploadTasks();
                    uploadedParts = [];
                    chunkSizeLevel = 0;
                    uploadNextFile(response.key, 0);
                } else {
                    showMessage('获取授权失败', 'error');
                    uploadBtn.disabled = false;
                }
            } catch (e) {
                showMessage('解析授权响应失败', 'error');
                uploadBtn.disabled = false;
            }
        } else {
            showMessage('获取授权失败，状态码: ' + xhr.status, 'error');
            uploadBtn.disabled = false;
        }
    };
    xhr.onerror = function() {
        showMessage('网络错误，无法获取授权', 'error');
        uploadBtn.disabled = false;
    };
    xhr.send();
}

function uploadNextFile(key, index) {
    var total = uploadTasks.length;
    if (index >= total) {
        fileTreeCache = null;
        invalidateHttpCache();
        showMessage('全部上传成功！', 'success');
        setTimeout(function() {
            closeUploadModal();
            document.getElementById('uploadBtn').disabled = false;
            loadFileList();
        }, 1500);
        return;
    }

    var item = uploadTasks[index];
    var progressContainer = document.querySelector('.progress-container');
    progressContainer.style.display = 'block';
    showMessage('正在上传 (' + (index + 1) + '/' + total + '): ' + item.label, 'success');

    var reader = new FileReader();
    reader.onload = function(e) {
        var base64Content = e.target.result.split(',')[1];
        var currentPath = getCurrentPath();
        var filePath = currentPath ? currentPath + '/' + item.relativePath : item.relativePath;

        putFileToGitHub(key, filePath, base64Content, null,
            function(newSha) {
                if (PART_SUFFIX.test(item.relativePath) && newSha) {
                    uploadedParts.push({ path: filePath, sha: newSha, base: item.base });
                }
                updateUploadProgress(index + 1, total, 0);
                uploadNextFile(key, index + 1);
            },
            function(status, responseText) {
                var errMsg = status === 0 ? '网络连接中断，可能是文件过大或网络不稳定' : ('状态码: ' + status);
                try {
                    var error = JSON.parse(responseText);
                    if (error.message) errMsg = error.message;
                } catch (e) {}

                var base = item.base;
                var j = index;
                while (j > 0 && uploadTasks[j - 1].base === base) j--;
                var doneBases = {};
                for (var k = 0; k < j; k++) doneBases[uploadTasks[k].base] = true;
                var staleParts = uploadedParts.filter(function(p) { return !doneBases[p.base]; });
                uploadedParts = uploadedParts.filter(function(p) { return doneBases[p.base]; });

                if (/too large/i.test(responseText || '') && chunkSizeLevel < CHUNK_SIZE_LEVELS.length - 1) {
                    chunkSizeLevel++;
                    showMessage('分片过大，已自动减小分片大小，正在重新上传...', 'success');
                    deletePartsQuietly(key, staleParts, 0, function() {
                        fileTreeCache = null;
                        uploadTasks = buildUploadTasks().filter(function(t) { return !doneBases[t.base]; });
                        uploadNextFile(key, 0);
                    });
                    return;
                }

                var finalMsg = '上传失败 (' + item.relativePath + '): ' + errMsg;
                if (staleParts.length > 0) {
                    uploadedParts = staleParts;
                    cleanupUploadedParts(key, finalMsg);
                } else {
                    showMessage(finalMsg, 'error');
                    document.getElementById('uploadBtn').disabled = false;
                }
            },
            function(fraction) {
                updateUploadProgress(index, total, fraction);
            }
        );
    };
    reader.readAsDataURL(item.blob);
}

function updateUploadProgress(index, total, fraction) {
    var percent = Math.round(((index + fraction) / total) * 100);
    document.getElementById('progressFill').style.width = percent + '%';
    document.getElementById('progressText').textContent = percent + '%';
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
});
