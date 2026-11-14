/* Shared building blocks for the dashboard: DOM helpers, the API client,
   dialogs, and the video player. Used by app.js and admin.js. */

import { liveFrameHtml, watchLive } from './live.js';

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// ---- Text and formatting -------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);

const dateTime = new Intl.DateTimeFormat(undefined, {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});
export const formatDate = (ms, never = 'Not yet') => (ms ? dateTime.format(new Date(ms)) : never);

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export const VIDEO_STATUS = {
  none: ['No video yet', ''],
  receiving: ['Uploading', 'badge-info'],
  complete: ['Stored', 'badge-ok'],
  interrupted: ['Cut short', 'badge-warn'],
  purged: ['Lost on helmet', 'badge-warn'],
  expired: ['Deleted', ''],
};

// ---- Small pieces of markup ------------------------------------------------------

export const icon = (name) => `<i class="ph ${name}" aria-hidden="true"></i>`;
export const badge = ([label, tone]) => `<span class="badge caption-3 ${tone}">${esc(label)}</span>`;

export function emptyState(iconName, title, text, action = '') {
  return `<div class="empty">${icon(iconName)}<h3 class="title-2">${esc(title)}</h3>
    <p class="body-6 muted">${esc(text)}</p>${action}</div>`;
}

export function skeletonRows(count) {
  return `<div class="stack" aria-hidden="true">${'<div class="skeleton skeleton-row"></div>'.repeat(count)}</div>`;
}

const toast = $('#toast');
let toastTimer;
export function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 4000);
}

/** Copies text to the clipboard, with a fallback for plain http pages. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'sr-only';
    (dialog.open ? dialog : document.body).append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (!copied) {
      showToast('Could not copy. Select the text and copy it by hand.');
      return;
    }
  }
  showToast('Copied');
}

// ---- Forms -----------------------------------------------------------------------

/** Shows or clears the error under one named field. Returns true when valid. */
export function setFieldError(form, name, message) {
  const input = form.elements[name];
  const error = $(`[data-error="${name}"]`, form);
  if (message) {
    input.setAttribute('aria-invalid', 'true');
    error.textContent = message;
    error.hidden = false;
  } else {
    input.removeAttribute('aria-invalid');
    error.hidden = true;
  }
  return !message;
}

// ---- API -------------------------------------------------------------------------

/** Thrown when the session has ended. Callers can ignore it: the sign in page is already showing. */
export class AuthError extends Error {}

let unauthorizedHandler = () => {};
export function onUnauthorized(handler) {
  unauthorizedHandler = handler;
}

export async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new Error('Could not reach the server. Check the connection and try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/auth/login') {
    unauthorizedHandler();
    throw new AuthError('Sign in required');
  }
  if (!response.ok) throw new Error(data.error || 'The request failed. Try again.');
  return data;
}

// ---- Dialogs ---------------------------------------------------------------------

export const dialog = $('#dialog');

dialog.addEventListener('close', () => {
  stopPlayer();
  dialog.innerHTML = '';
});

export function openDialog(html, { wide = false } = {}) {
  stopPlayer();
  dialog.classList.toggle('dialog-wide', wide);
  dialog.innerHTML = html;
  // Reuse a dialog that is already open instead of closing it first: a close
  // event from the old one would otherwise arrive late and wipe the new content.
  if (!dialog.open) dialog.showModal();
  for (const button of $$('[data-close]', dialog)) {
    button.addEventListener('click', () => dialog.close());
  }
  return dialog;
}

/** Asks before something that cannot be undone. Resolves true only on the action button. */
export function confirmDialog({ title, text, action }) {
  return new Promise((resolve) => {
    openDialog(`<div class="form">
      <h2 class="heading-6" id="dialog-title">${esc(title)}</h2>
      <p class="body-6 muted">${esc(text)}</p>
      <div class="form-actions">
        <button class="btn btn-secondary button-md" type="button" data-close>Cancel</button>
        <button class="btn btn-primary button-md" type="button" data-confirm>${esc(action)}</button>
      </div>
    </div>`);
    let confirmed = false;
    $('[data-confirm]', dialog).addEventListener('click', () => {
      confirmed = true;
      dialog.close();
    });
    dialog.addEventListener('close', () => resolve(confirmed), { once: true });
  });
}

// ---- Public links ----------------------------------------------------------------

let info = { publicUrl: null, lanUrls: [] };

/** Asks the server for its public address. Call once after signing in. */
export async function loadServerInfo() {
  try {
    info = await api('/server-info');
  } catch {
    // Links fall back to the address this page was opened on.
  }
  return info;
}

export const serverInfo = () => info;

/** True when this page was opened on an address only this network can reach. */
export function isPrivateHost(host = location.hostname) {
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

/**
 * A full link for riders, customers and helmets. Uses the public address when
 * there is one, so links work even when the dashboard is open on localhost.
 */
export function publicLink(path) {
  const base = info.publicUrl || location.origin;
  return `${base}${path}`;
}

function qrSvg(text) {
  if (typeof window.qrcode !== 'function') return '';
  try {
    const code = window.qrcode(0, 'M');
    code.addData(text);
    code.make();
    return code.createSvgTag({ cellSize: 4, margin: 4, scalable: true, alt: 'QR code for the link' });
  } catch {
    return '';
  }
}

/**
 * Shows a link with everything needed to pass it on: a QR code to scan with a
 * phone, Copy, Share (on phones), WhatsApp, and Open.
 */
export function linkDialog({ title, text, url, message, note = '' }) {
  const qr = qrSvg(url);
  const share = message ? `${message}\n${url}` : url;
  const unreachable = isPrivateHost(new URL(url).hostname)
    ? '<p class="field-error caption-1">This is a local address, so it only works on the same Wi-Fi as this computer. Start the public address with start-live.bat to get a link that works anywhere.</p>'
    : '';
  openDialog(`<div class="form">
    <div class="card-head">
      <h2 class="heading-6" id="dialog-title">${esc(title)}</h2>
      <button class="btn btn-quiet btn-icon" type="button" data-close aria-label="Close">${icon('ph-x')}</button>
    </div>
    <p class="body-6 muted">${esc(text)}</p>
    ${unreachable}
    ${qr ? `<div class="qr-box">${qr}</div><p class="caption-2 muted qr-hint">Scan with the phone's camera to open it.</p>` : ''}
    <div class="link-box">
      <input class="input body-6" type="text" readonly value="${esc(url)}" aria-label="Link">
      <button class="btn btn-secondary button-sm" type="button" data-copy>${icon('ph-copy')} Copy</button>
    </div>
    ${note ? `<p class="caption-2 muted">${esc(note)}</p>` : ''}
    <div class="form-actions">
      ${navigator.share ? `<button class="btn btn-secondary button-md" type="button" data-share>${icon('ph-share-network')} Share</button>` : ''}
      <a class="btn btn-secondary button-md" href="https://wa.me/?text=${encodeURIComponent(share)}" target="_blank" rel="noopener">${icon('ph-whatsapp-logo')} WhatsApp</a>
      <a class="btn btn-primary button-md" href="${esc(url)}" target="_blank" rel="noopener">${icon('ph-arrow-square-out')} Open</a>
    </div>
  </div>`);
  $('[data-copy]', dialog).addEventListener('click', () => copyText(url));
  const shareButton = $('[data-share]', dialog);
  if (shareButton) {
    shareButton.addEventListener('click', () => navigator.share({ title, text: message || title, url }).catch(() => {}));
  }
}

/** A rider's personal sign-in link, which signs the rider page in by itself. */
export function riderLinkDialog(driver) {
  linkDialog({
    title: `Rider link for ${driver.name}`,
    text: 'Open this on the rider\'s phone. It signs them in by itself. They press Start sharing, then Start delivery, and their location appears on the Live map.',
    url: publicLink(`/driver#t=${encodeURIComponent(driver.token)}`),
    message: `Hi ${driver.name}, open this to start sharing your location for deliveries:`,
    note: 'Anyone with this link can share location as this rider. If it leaks, make a new key under Admin > Drivers.',
  });
}

// ---- Live camera -----------------------------------------------------------------

/** Opens the live view of a helmet camera in a dialog. Closing the dialog stops it. */
export function openLiveDialog({ title, subtitle = '', url }) {
  openDialog(`<div class="form">
    <div class="card-head">
      <div>
        <h2 class="heading-6" id="dialog-title">${esc(title)}</h2>
        ${subtitle ? `<p class="caption-2 muted">${esc(subtitle)}</p>` : ''}
      </div>
      <button class="btn btn-quiet btn-icon" type="button" data-close aria-label="Close">${icon('ph-x')}</button>
    </div>
    <div data-live-root>${liveFrameHtml(`Live view: ${title}`)}</div>
  </div>`, { wide: true });
  const stop = watchLive($('[data-live-root] .live-frame', dialog), url);
  dialog.addEventListener('close', stop, { once: true });
}

// ---- Video player ----------------------------------------------------------------

let activePlayer = null;

export function stopPlayer() {
  if (activePlayer) activePlayer.pause();
  activePlayer = null;
}

/** Plays a recording frame by frame, keeping pace with the times stored in the video. */
class Player {
  constructor(container, meta) {
    this.id = meta.recordingId;
    this.times = meta.times;
    this.startMs = meta.startEpoch * 1000;
    this.index = 0;
    this.speed = 1;
    this.playing = false;
    this.frameRequest = 0;

    container.innerHTML = `<div class="player">
      <div class="player-frame"><img alt="Helmet camera video for recording ${esc(this.id)}"></div>
      <div class="player-bar">
        <button class="btn btn-secondary btn-icon" type="button" data-act="play" aria-label="Play">${icon('ph-play')}</button>
        <button class="btn btn-quiet btn-icon" type="button" data-act="back" aria-label="Previous frame">${icon('ph-caret-left')}</button>
        <button class="btn btn-quiet btn-icon" type="button" data-act="forward" aria-label="Next frame">${icon('ph-caret-right')}</button>
        <input type="range" min="0" max="${this.times.length - 1}" value="0" aria-label="Position in video">
        <button class="btn btn-quiet button-sm numeric" type="button" data-act="speed" aria-label="Playback speed">1x</button>
      </div>
      <p class="caption-2 muted numeric" data-stamp></p>
      <p class="caption-2 muted numeric">Recording started near ${esc(meta.lat.toFixed(5))}, ${esc(meta.lon.toFixed(5))}</p>
    </div>`;

    this.image = $('img', container);
    this.range = $('input', container);
    this.stamp = $('[data-stamp]', container);
    this.playButton = $('[data-act="play"]', container);
    this.speedButton = $('[data-act="speed"]', container);

    this.playButton.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    $('[data-act="back"]', container).addEventListener('click', () => { this.pause(); this.show(this.index - 1); });
    $('[data-act="forward"]', container).addEventListener('click', () => { this.pause(); this.show(this.index + 1); });
    this.speedButton.addEventListener('click', () => {
      this.speed = this.speed === 1 ? 2 : this.speed === 2 ? 4 : 1;
      this.speedButton.textContent = `${this.speed}x`;
      if (this.playing) this.anchor();
    });
    this.range.addEventListener('input', () => {
      this.show(Number(this.range.value));
      if (this.playing) this.anchor();
    });
    this.show(0);
  }

  url(index) {
    return `/api/recordings/${encodeURIComponent(this.id)}/frames/${index}`;
  }

  show(index) {
    this.index = Math.max(0, Math.min(this.times.length - 1, index));
    this.image.src = this.url(this.index);
    this.range.value = String(this.index);
    const elapsed = this.times[this.index] - this.times[0];
    const total = this.times[this.times.length - 1] - this.times[0];
    this.stamp.textContent = `${formatDuration(elapsed)} of ${formatDuration(total)} · ${
      new Date(this.startMs + elapsed).toLocaleString()}`;
    // Warm the cache for the next few frames so playback stays smooth.
    for (let ahead = 1; ahead <= 3 && this.index + ahead < this.times.length; ahead += 1) {
      new Image().src = this.url(this.index + ahead);
    }
  }

  /** Ties the video clock to the wall clock from the current frame. */
  anchor() {
    this.anchorWall = performance.now();
    this.anchorVideo = this.times[this.index];
  }

  play() {
    if (this.index >= this.times.length - 1) this.show(0);
    this.playing = true;
    this.playButton.innerHTML = icon('ph-pause');
    this.playButton.setAttribute('aria-label', 'Pause');
    this.anchor();
    const tick = () => {
      if (!this.playing) return;
      const videoTime = this.anchorVideo + (performance.now() - this.anchorWall) * this.speed;
      let next = this.index;
      while (next + 1 < this.times.length && this.times[next + 1] <= videoTime) next += 1;
      if (next !== this.index) this.show(next);
      if (this.index >= this.times.length - 1) {
        this.pause();
        return;
      }
      this.frameRequest = requestAnimationFrame(tick);
    };
    this.frameRequest = requestAnimationFrame(tick);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.frameRequest);
    this.playButton.innerHTML = icon('ph-play');
    this.playButton.setAttribute('aria-label', 'Play');
  }
}

/** Loads a recording into `container`. Returns true when the player is showing. */
export async function mountPlayer(container, recordingId) {
  stopPlayer();
  container.innerHTML = '<div class="skeleton player-frame" aria-hidden="true"></div>';
  try {
    const meta = await api(`/recordings/${encodeURIComponent(recordingId)}/frames`);
    if (!container.isConnected) return false;
    if (!meta.times.length) {
      container.innerHTML = '<p class="field-error caption-1" role="alert">This recording has no playable frames.</p>';
      return false;
    }
    activePlayer = new Player(container, meta);
    return true;
  } catch (failure) {
    if (!(failure instanceof AuthError) && container.isConnected) {
      container.innerHTML = `<p class="field-error caption-1" role="alert">${esc(failure.message)}</p>`;
    }
    return false;
  }
}

/** Opens a recording in a dialog. Used by the admin video library. */
export function openVideoDialog(recordingId, subtitle = '') {
  openDialog(`<div class="form">
    <div class="card-head">
      <div>
        <h2 class="heading-6 numeric" id="dialog-title">${esc(recordingId)}</h2>
        ${subtitle ? `<p class="caption-2 muted">${esc(subtitle)}</p>` : ''}
      </div>
      <button class="btn btn-quiet btn-icon" type="button" data-close aria-label="Close">${icon('ph-x')}</button>
    </div>
    <div data-player></div>
  </div>`, { wide: true });
  return mountPlayer($('[data-player]', dialog), recordingId);
}
