/* JanDrop SPA — vanilla JS, no build step. Live sync via SSE. */
(() => {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);

  /* ─────────────────────────── State ─────────────────────────── */

  const state = {
    items: new Map(), // id → item (client-side mirror)
    expiry: 'never',
    deviceCount: null,
    uploading: false,
    qrUrl: null,
  };

  const els = {
    deviceCount: $('#deviceCount'),
    dropzone: $('#dropzone'),
    fileInput: $('#fileInput'),
    uploadProgress: $('#uploadProgress'),
    uploadName: $('#uploadName'),
    uploadStats: $('#uploadStats'),
    uploadBar: $('#uploadBar'),
    textInput: $('#textInput'),
    shareBtn: $('#shareBtn'),
    expiryPills: $('#expiryPills'),
    feedList: $('#feedList'),
    emptyState: $('#emptyState'),
    itemCount: $('#itemCount'),
    clearExpiredBtn: $('#clearExpiredBtn'),
    clearAllBtn: $('#clearAllBtn'),
    qrBtn: $('#qrBtn'),
    qrModal: $('#qrModal'),
    qrCode: $('#qrCode'),
    qrUrl: $('#qrUrl'),
    qrCopyBtn: $('#qrCopyBtn'),
    qrCloseBtn: $('#qrCloseBtn'),
    confirmModal: $('#confirmModal'),
    confirmTitle: $('#confirmTitle'),
    confirmMessage: $('#confirmMessage'),
    confirmOkBtn: $('#confirmOkBtn'),
    confirmCancelBtn: $('#confirmCancelBtn'),
    toasts: $('#toasts'),
  };

  /* ─────────────────────────── Helpers ─────────────────────────── */

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function linkify(text) {
    return esc(text).replace(
      /(https?:\/\/[^\s<>"']+)/g,
      (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
    );
  }

  function formatBytes(n) {
    if (n == null) return '';
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do {
      n /= 1024;
      i++;
    } while (n >= 1024 && i < units.length - 1);
    return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
  }

  function timeAgo(ts) {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 12) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function timeLeft(item) {
    if (!item.expiresAt) return null;
    const ms = item.expiresAt - Date.now();
    if (ms <= 0) return 'expiring…';
    const m = Math.ceil(ms / 60000);
    if (m < 60) return `${m}m left`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60 ? `${m % 60}m ` : ''}left`;
    return `${Math.ceil(h / 24)}d left`;
  }

  function isUrlOnly(item) {
    if (item.type !== 'text') return false;
    const t = item.text.trim();
    return /^https?:\/\/\S+$/i.test(t);
  }

  /* ─────────────────────────── Icons ─────────────────────────── */

  const svg = (d, extra = '') =>
    `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}${extra}</svg>`;

  const ICONS = {
    image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 15.5l-4.5-4.5L7 20.5"/>'),
    video: svg('<rect x="2.5" y="5" width="13" height="14" rx="2"/><path d="M15.5 10.5l6-3.5v10l-6-3.5"/>'),
    audio: svg('<path d="M9 18V6l10-2v11.5"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>'),
    archive: svg('<rect x="3" y="7" width="18" height="4" rx="1"/><path d="M5 11v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7M10 15h4"/>'),
    text: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
    link: svg('<path d="M10 14a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.4 5.56"/><path d="M14 10a5 5 0 0 0-7.07 0L4.1 12.83a5 5 0 0 0 7.07 7.07l1.42-1.42"/>'),
    generic: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
    download: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0l-5-5m5 5l5-5M4 21h16"/></svg>',
    copy: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    linkSm: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.4 5.56"/><path d="M14 10a5 5 0 0 0-7.07 0L4.1 12.83a5 5 0 0 0 7.07 7.07l1.42-1.42"/></svg>',
    trash: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6"/></svg>',
  };

  function fileIcon(mime = '') {
    if (mime.startsWith('image/')) return { cls: 'image', icon: ICONS.image };
    if (mime.startsWith('video/')) return { cls: 'video', icon: ICONS.video };
    if (mime.startsWith('audio/')) return { cls: 'audio', icon: ICONS.audio };
    if (/(zip|tar|gzip|rar|7z|compress|archive)/i.test(mime)) return { cls: 'archive', icon: ICONS.archive };
    if (/^(text\/|application\/(json|xml|javascript|x-yaml|sql|toml))/i.test(mime)) return { cls: 'text', icon: ICONS.text };
    return { cls: 'generic', icon: ICONS.generic };
  }

  /* ─────────────────────────── Rendering ─────────────────────────── */

  function badgeHtml(item) {
    const out = [];
    const left = timeLeft(item);
    if (left) {
      const soon = item.expiresAt && item.expiresAt - Date.now() < 10 * 60 * 1000;
      out.push(`<span class="badge${soon ? ' expiring' : ''}">⏱ ${esc(left)}</span>`);
    }
    if (item.maxDownloads != null) {
      const remaining = Math.max(0, item.maxDownloads - item.downloadCount);
      const unit = item.type === 'text' ? 'copy' : 'download';
      if (remaining > 0) {
        out.push(`<span class="badge burn" data-downloads>🔥 ${remaining} ${unit}${remaining === 1 ? '' : 's'} left</span>`);
      } else {
        out.push('<span class="badge burned" data-downloads>🔥 burned</span>');
      }
    } else if (item.type === 'file' && item.downloadCount > 0) {
      out.push(`<span class="badge" data-downloads>↓ ${item.downloadCount}×</span>`);
    }
    return out.join('');
  }

  function previewHtml(item) {
    const url = `/api/items/${item.id}/download?inline=1`;
    const mime = item.mimeType || '';
    if (mime.startsWith('image/')) return `<div class="preview"><img src="${url}" alt="${esc(item.filename)}" loading="lazy"></div>`;
    if (mime.startsWith('video/')) return `<div class="preview"><video src="${url}" controls preload="metadata" playsinline></video></div>`;
    if (mime.startsWith('audio/')) return `<div class="preview audio"><audio src="${url}" controls preload="metadata"></audio></div>`;
    return '';
  }

  function metaHtml(item) {
    const parts = [];
    if (item.type === 'file') {
      parts.push(`<span>${esc(formatBytes(item.size))}</span>`);
    } else {
      const chars = (item.text || '').length;
      parts.push(`<span>${chars.toLocaleString()} char${chars === 1 ? '' : 's'}</span>`);
    }
    parts.push(`<span class="sep">·</span>`);
    parts.push(`<span data-time="${item.createdAt}">${esc(timeAgo(item.createdAt))}</span>`);
    return parts.join('');
  }

  function cardHtml(item) {
    if (item.type === 'file') {
      const { cls, icon } = fileIcon(item.mimeType);
      return `
        <article class="item-card" data-id="${item.id}">
          <div class="item-icon ${cls}">${icon}</div>
          <div class="item-main">
            <div class="item-title" title="${esc(item.filename)}">${esc(item.filename)}</div>
            <div class="item-meta">${metaHtml(item)}${badgeHtml(item)}</div>
            ${previewHtml(item)}
          </div>
          <div class="item-actions">
            <a class="btn small primary" href="/api/items/${item.id}/download" download>${ICONS.download} Download</a>
            <button class="btn small ghost" data-action="copy-link">${ICONS.linkSm} Link</button>
            <button class="btn small danger" data-action="delete">${ICONS.trash} Delete</button>
          </div>
        </article>`;
    }
    const linky = isUrlOnly(item);
    return `
      <article class="item-card" data-id="${item.id}">
        <div class="item-icon ${linky ? 'link' : 'text'}">${linky ? ICONS.link : ICONS.text}</div>
        <div class="item-main">
          <pre class="item-text">${linky ? linkify(item.text) : esc(item.text)}</pre>
          <div class="item-meta">${metaHtml(item)}${badgeHtml(item)}</div>
        </div>
        <div class="item-actions">
          <button class="btn small ghost" data-action="copy-text">${ICONS.copy} Copy</button>
          <button class="btn small danger" data-action="delete">${ICONS.trash} Delete</button>
        </div>
      </article>`;
  }

  function cardEl(id) {
    return els.feedList.querySelector(`.item-card[data-id="${CSS.escape(id)}"]`);
  }

  function updateChrome() {
    const count = state.items.size;
    els.itemCount.textContent = count ? `(${count})` : '';
    els.emptyState.hidden = count > 0;
    const empty = count === 0;
    els.clearExpiredBtn.disabled = empty;
    els.clearAllBtn.disabled = empty;
  }

  function addItem(item, { prepend = true } = {}) {
    if (state.items.has(item.id)) return updateItem(item);
    state.items.set(item.id, item);
    const tpl = document.createElement('template');
    tpl.innerHTML = cardHtml(item).trim();
    const card = tpl.content.firstChild;
    prepend ? els.feedList.prepend(card) : els.feedList.append(card);
    updateChrome();
  }

  function updateItem(item) {
    state.items.set(item.id, item);
    const card = cardEl(item.id);
    if (!card) return addItem(item);
    // Update badges + meta in place so playing <video>/<audio> elements survive.
    const meta = card.querySelector('.item-meta');
    if (meta) meta.innerHTML = `${metaHtml(item)}${badgeHtml(item)}`;
  }

  function removeItem(id) {
    state.items.delete(id);
    const card = cardEl(id);
    if (card) {
      card.classList.add('removing');
      setTimeout(() => card.remove(), 180);
    }
    updateChrome();
  }

  function refreshTimes() {
    for (const el of els.feedList.querySelectorAll('[data-time]')) {
      el.textContent = timeAgo(Number(el.dataset.time));
    }
    for (const card of els.feedList.children) {
      const item = state.items.get(card.dataset.id);
      if (item) {
        const meta = card.querySelector('.item-meta');
        if (meta) meta.innerHTML = `${metaHtml(item)}${badgeHtml(item)}`;
      }
    }
  }

  /* ─────────────────────────── API calls ─────────────────────────── */

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function fetchItems() {
    const { items } = await api('/api/items');
    els.feedList.innerHTML = '';
    state.items.clear();
    for (const item of items) addItem(item, { prepend: false });
    updateChrome();
  }

  /* ─────────────────────────── Uploads ─────────────────────────── */

  function setProgress(name, loaded, total) {
    els.uploadProgress.hidden = false;
    els.uploadName.textContent = name;
    const pct = total ? Math.floor((loaded / total) * 100) : 0;
    els.uploadStats.textContent = `${formatBytes(loaded)} / ${formatBytes(total)} · ${pct}%`;
    els.uploadBar.style.width = `${pct}%`;
  }

  function hideProgress() {
    els.uploadBar.style.width = '0%';
    setTimeout(() => {
      if (!state.uploading) els.uploadProgress.hidden = true;
    }, 350);
  }

  function uploadOne(file) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      const fd = new FormData();
      fd.append('expires', state.expiry);
      fd.append('file', file, file.name);

      xhr.open('POST', '/api/upload');
      xhr.responseType = 'json';

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress(file.name, e.loaded, e.total);
      };
      xhr.onload = () => {
        if (xhr.status === 201) {
          for (const item of xhr.response.items || []) addItem(item);
          toast(`Shared “${file.name}”`, 'success');
        } else {
          const msg = (xhr.response && xhr.response.error) || `Upload failed (${xhr.status})`;
          toast(msg, 'error');
        }
        resolve();
      };
      xhr.onerror = () => {
        toast(`Upload failed — network error (“${file.name}”)`, 'error');
        resolve();
      };

      setProgress(file.name, 0, file.size || 0);
      xhr.send(fd);
    });
  }

  async function uploadFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    if (state.uploading) return toast('An upload is already in progress', 'error');
    state.uploading = true;
    for (const file of files) await uploadOne(file);
    state.uploading = false;
    hideProgress();
  }

  /* ─────────────────────────── SSE ─────────────────────────── */

  function connectEvents() {
    const es = new EventSource('/api/events');

    es.addEventListener('open', fetchItems); // resync after any reconnect

    es.addEventListener('clients', (e) => {
      const { count } = JSON.parse(e.data);
      state.deviceCount = count;
      els.deviceCount.textContent = count;
      els.deviceCount.parentElement.title = `${count} device${count === 1 ? '' : 's'} connected`;
    });

    es.addEventListener('item:created', (e) => {
      const { item } = JSON.parse(e.data);
      addItem(item);
    });

    es.addEventListener('item:updated', (e) => {
      const { id, downloadCount } = JSON.parse(e.data);
      const item = state.items.get(id);
      if (item) {
        item.downloadCount = downloadCount;
        const card = cardEl(id);
        if (card) {
          const meta = card.querySelector('.item-meta');
          if (meta) meta.innerHTML = `${metaHtml(item)}${badgeHtml(item)}`;
        }
      }
    });

    es.addEventListener('item:deleted', (e) => {
      const { id } = JSON.parse(e.data);
      removeItem(id);
    });
  }

  /* ─────────────────────────── UI actions ─────────────────────────── */

  function copyToClipboard(text, btn, label = 'Copy', after) {
    const done = () => {
      if (after) after();
      btn.classList.add('copied');
      btn.innerHTML = 'Copied ✓';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = `${ICONS.copy} ${label}`;
      }, 1600);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch {
      toast('Copy failed — select the text manually', 'error');
    }
    ta.remove();
  }

  async function deleteItem(id) {
    const card = cardEl(id);
    if (card) {
      card.style.opacity = '0.5';
      card.style.pointerEvents = 'none';
    }
    try {
      await api(`/api/items/${id}`, { method: 'DELETE' });
      removeItem(id); // SSE also removes; harmless double
    } catch (err) {
      toast(err.message, 'error');
      if (card) {
        card.style.opacity = '';
        card.style.pointerEvents = '';
      }
    }
  }

  async function shareText() {
    const text = els.textInput.value.trim();
    if (!text) return els.textInput.focus();
    try {
      const { item } = await api('/api/text', { method: 'POST', body: { text, expires: state.expiry } });
      addItem(item);
      els.textInput.value = '';
      els.textInput.focus();
      toast('Text shared', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ─────────────────────────── Modals ─────────────────────────── */

  function openModal(modal) {
    modal.hidden = false;
  }

  function closeModal(modal) {
    modal.hidden = true;
  }

  let confirmResolve = null;
  function confirmDialog({ title, message, confirmText = 'Confirm' }) {
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    els.confirmOkBtn.textContent = confirmText;
    openModal(els.confirmModal);
    return new Promise((resolve) => {
      confirmResolve = resolve;
    });
  }

  function settleConfirm(result) {
    closeModal(els.confirmModal);
    if (confirmResolve) {
      confirmResolve(result);
      confirmResolve = null;
    }
  }

  async function openQr() {
    openModal(els.qrModal);
    els.qrCode.textContent = '';
    try {
      if (!state.qrUrl) {
        const info = await api('/api/server-info');
        state.qrUrl = info.url;
      }
      const res = await fetch(`/api/qr?data=${encodeURIComponent(state.qrUrl)}`);
      if (!res.ok) throw new Error('QR generation failed');
      els.qrCode.innerHTML = await res.text();
      els.qrUrl.textContent = state.qrUrl;
    } catch (err) {
      toast(err.message, 'error');
      closeModal(els.qrModal);
    }
  }

  /* ─────────────────────────── Toasts ─────────────────────────── */

  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    els.toasts.append(el);
    setTimeout(() => el.classList.add('fade'), 2600);
    setTimeout(() => el.remove(), 3000);
  }

  /* ─────────────────────────── Event wiring ─────────────────────────── */

  // Drop zone
  els.dropzone.addEventListener('click', () => els.fileInput.click());
  els.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener('change', () => {
    uploadFiles(els.fileInput.files);
    els.fileInput.value = '';
  });

  for (const type of ['dragenter', 'dragover']) {
    els.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      els.dropzone.classList.add('dragover');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    els.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      els.dropzone.classList.remove('dragover');
    });
  }
  els.dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });
  // Stop the browser from navigating away when a file misses the drop zone.
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (e) => e.preventDefault());
  }

  // Paste anywhere (outside inputs) fills the share bar.
  document.addEventListener('paste', (e) => {
    if (e.target.closest('input, textarea, [contenteditable]')) return;
    const text = (e.clipboardData || {}).getData ? e.clipboardData.getData('text') : '';
    if (text && !text.startsWith('http')) {
      els.textInput.value = text;
      els.textInput.focus();
    }
  });

  // Text share
  els.shareBtn.addEventListener('click', shareText);
  els.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') shareText();
  });

  // Expiry pills
  els.expiryPills.addEventListener('click', (e) => {
    const pill = e.target.closest('.pill');
    if (!pill) return;
    state.expiry = pill.dataset.value;
    for (const p of els.expiryPills.children) p.classList.toggle('active', p === pill);
  });

  // Feed actions (event delegation)
  els.feedList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = btn.closest('.item-card');
    if (!card) return;
    const id = card.dataset.id;
    const item = state.items.get(id);
    if (!item) return;

    switch (btn.dataset.action) {
      case 'copy-link':
        copyToClipboard(`${location.origin}/api/items/${id}/download`, btn, 'Link');
        break;
      case 'copy-text':
        copyToClipboard(item.text || '', btn, 'Copy', async () => {
          try {
            const r = await api(`/api/items/${id}/copy`, { method: 'POST' });
            if (r.burned) toast('🔥 Snippet burned after copy', 'success');
          } catch {
            /* non-fatal: the copy itself already succeeded */
          }
        });
        break;
      case 'delete':
        deleteItem(id);
        break;
    }
  });

  // Clear buttons
  els.clearExpiredBtn.addEventListener('click', async () => {
    try {
      const { removed } = await api('/api/items/clear-expired', { method: 'POST' });
      toast(removed ? `Removed ${removed} expired item${removed === 1 ? '' : 's'}` : 'No expired items', removed ? 'success' : 'info');
      fetchItems();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  els.clearAllBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Clear all shared items?',
      message: 'Every file and snippet will be deleted, and files will be removed from disk. This cannot be undone.',
      confirmText: 'Delete everything',
    });
    if (!ok) return;
    try {
      await api('/api/items/clear-all', { method: 'POST' });
      toast('Feed cleared', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // QR modal
  els.qrBtn.addEventListener('click', openQr);
  els.qrCloseBtn.addEventListener('click', () => closeModal(els.qrModal));
  els.qrCopyBtn.addEventListener('click', (e) => copyToClipboard(state.qrUrl || '', e.currentTarget, 'Copy URL'));
  els.qrModal.addEventListener('click', (e) => {
    if (e.target === els.qrModal) closeModal(els.qrModal);
  });

  // Confirm modal
  els.confirmOkBtn.addEventListener('click', () => settleConfirm(true));
  els.confirmCancelBtn.addEventListener('click', () => settleConfirm(false));
  els.confirmModal.addEventListener('click', (e) => {
    if (e.target === els.confirmModal) settleConfirm(false);
  });

  // Esc closes any open modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.qrModal.hidden) closeModal(els.qrModal);
      if (!els.confirmModal.hidden) settleConfirm(false);
    }
  });

  /* ─────────────────────────── Boot ─────────────────────────── */

  fetchItems().catch((err) => toast(err.message, 'error'));
  connectEvents();
  setInterval(refreshTimes, 30_000);
})();
