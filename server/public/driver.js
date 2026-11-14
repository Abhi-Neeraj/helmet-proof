/* Rider page for a phone browser.
   - Shares the phone's live location with the dashboard and the customer.
   - Connects to the helmet over Bluetooth (Chrome on Android), starts the
     recording within 200 m of the address, and only unlocks Delivered while the
     helmet confirms it is recording that delivery.
   - Sends the site's current address to the helmet, so the helmet keeps
     uploading to the right place when the address changes. */

import {
  mapsAvailable, createMap, LiveLayer, fitTo, distanceMetres, formatDistance, ago, poll,
} from '/map.js';

const $ = (selector) => document.querySelector(selector);
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);

const TOKEN_KEY = 'helmetProof.driverToken';
const ATTEMPTS_KEY = 'helmetProof.attempts';

// Bluetooth identifiers. Must match firmware/helmet_cam/config.h.
const HELMET_SERVICE = '7a1c0001-5b0e-4f6a-9d3c-2e8f4b6a1c00';
const HELMET_COMMAND = '7a1c0002-5b0e-4f6a-9d3c-2e8f4b6a1c00';
const HELMET_STATUS = '7a1c0003-5b0e-4f6a-9d3c-2e8f4b6a1c00';

const ZONE_METRES = 200;       // recording starts inside this distance
const ZONE_EXIT_METRES = 260;  // and stops if the rider goes back out past this
const STOP_DELAY_SECONDS = 10; // the helmet keeps recording this long after Delivered

// ---- Small helpers -----------------------------------------------------------------

const store = {
  get(key, fallback = '') {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* nothing stored */ }
  },
};

let toastTimer;
function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 3500);
}

function showError(id, message) {
  const box = $(id);
  box.textContent = message;
  box.hidden = !message;
}

class Unauthorized extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api/driver${path}`, {
    method,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) throw new Unauthorized('This rider link or token is not valid any more. Ask for a new one.');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The server answered ${response.status}.`);
  return data;
}

/** Events for the delivery timeline. A failure here must never block the rider. */
function sendEvent(deliveryId, type, extra = {}) {
  api(`/deliveries/${encodeURIComponent(deliveryId)}/events`, { method: 'POST', body: { type, ...extra } })
    .catch(() => {});
}

// ---- State ---------------------------------------------------------------------------

let token = store.get(TOKEN_KEY);
let deliveries = [];
let me = null;            // { lat, lon, accuracy, at } from this phone
let currentId = null;     // the delivery under way
let watchId = null;
let lastSent = null;
let wakeLock = null;
let stopPolling = null;
let map = null;
let layer = null;
let fittedWith = '';
let failingId = null;

// A rider link carries the token after #t= so it never reaches the server logs.
const fromLink = new URLSearchParams(location.hash.slice(1)).get('t');
if (fromLink) {
  token = fromLink;
  store.set(TOKEN_KEY, token);
  history.replaceState(null, '', location.pathname);
}

const current = () => deliveries.find((delivery) => delivery.id === currentId) || null;

// ---- Sign in -----------------------------------------------------------------------

function showSignIn(message = '') {
  stopSharing();
  if (stopPolling) stopPolling();
  $('#home').hidden = true;
  $('#signin').hidden = false;
  showError('#token-error', message);
}

function signedOut(failure) {
  store.remove(TOKEN_KEY);
  token = '';
  showSignIn(failure.message);
}

$('#token-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#token');
  const value = input.value.trim();
  if (!value) {
    showSignIn('Enter your driver token, or open the rider link your manager sent you.');
    input.focus();
    return;
  }
  token = value;
  const button = $('#token-form button');
  button.disabled = true;
  try {
    await loadDeliveries();
    store.set(TOKEN_KEY, token);
    input.value = '';
    showHome();
  } catch (failure) {
    token = '';
    showSignIn(failure instanceof Unauthorized ? 'That token is not valid. Check it in Admin > Drivers.' : failure.message);
  } finally {
    button.disabled = false;
  }
});

$('#sign-out').addEventListener('click', () => {
  store.remove(TOKEN_KEY);
  token = '';
  disconnectHelmet();
  showSignIn();
});

// ---- Home --------------------------------------------------------------------------

function showHome() {
  $('#signin').hidden = true;
  $('#home').hidden = false;
  if (!map && mapsAvailable()) {
    map = createMap($('#map'));
    layer = new LiveLayer(map);
  } else if (!map) {
    $('#map').classList.add('map-fallback');
    $('#map').innerHTML = '<p class="body-6">The map could not load. Sharing still works.</p>';
  }
  showHelmetSupport();
  draw();
  if (stopPolling) stopPolling();
  // Customers' shared locations change, so refresh the list now and then.
  stopPolling = poll(async () => {
    try {
      await loadDeliveries();
      draw();
    } catch (failure) {
      if (failure instanceof Unauthorized) {
        signedOut(failure);
        return false;
      }
    }
    return true;
  }, 10000);
}

async function loadDeliveries() {
  const data = await api('/deliveries');
  deliveries = data.deliveries;
  $('#driver-name').textContent = data.driverName || data.driverId;
  if (!current()) {
    const underWay = deliveries.find((delivery) => delivery.status === 'in_progress');
    currentId = underWay ? underWay.id : null;
  }
}

function directionsUrl(lat, lon) {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
}

/** What the helmet is doing for this delivery, in one line. */
function recordingLine(delivery) {
  const away = me ? distanceMetres(me.lat, me.lon, delivery.destLat, delivery.destLon) : null;
  if (!helmet.connected) return 'Connect the helmet to record this delivery.';
  if (helmet.status && helmet.status.err) return `Helmet problem: ${helmet.status.err}.`;
  if (isRecording(delivery)) return `Recording ${helmet.status.id}, ${helmet.status.ch} part${helmet.status.ch === 1 ? '' : 's'} saved.`;
  if (helmet.status && helmet.status.st === 'rec') return `The helmet is recording ${helmet.status.id}.`;
  if (away === null) return 'Start sharing your location, and recording starts by itself near the address.';
  if (away > ZONE_METRES) return `Recording starts by itself within ${ZONE_METRES} m. You are ${formatDistance(away)} away.`;
  return 'Starting the recording.';
}

function deliveryCard(delivery) {
  const away = me ? formatDistance(distanceMetres(me.lat, me.lon, delivery.destLat, delivery.destLon)) : '';
  const started = delivery.status === 'in_progress';
  const customer = delivery.customer;
  const recording = isRecording(delivery);
  const directions = `
    <a class="btn btn-secondary button-sm" href="${esc(directionsUrl(delivery.destLat, delivery.destLon))}" target="_blank" rel="noopener">Directions</a>
    ${customer ? `<a class="btn btn-secondary button-sm" href="${esc(directionsUrl(customer.lat, customer.lon))}" target="_blank" rel="noopener">To customer</a>` : ''}`;

  const actions = started
    ? `<div class="row-actions row-actions-start">
        <button class="btn btn-primary button-sm" type="button" data-delivered="${esc(delivery.id)}" ${recording ? '' : 'disabled'}>Delivered</button>
        ${helmet.connected && !recording && !(helmet.status && helmet.status.st === 'rec')
          ? `<button class="btn btn-secondary button-sm" type="button" data-record="${esc(delivery.id)}">Record now</button>` : ''}
        <button class="btn btn-secondary button-sm" type="button" data-fail="${esc(delivery.id)}">Could not deliver</button>
        ${directions}
      </div>
      <p class="caption-2 muted">${esc(recordingLine(delivery))}${recording ? '' : ' Delivered unlocks while the helmet is recording.'}</p>`
    : `<div class="row-actions row-actions-start">
        <button class="btn btn-primary button-sm" type="button" data-start="${esc(delivery.id)}">Start delivery</button>
        ${directions}
      </div>`;

  return `<article class="ticket">
    <div class="ticket-head">
      <h3 class="title-3 numeric">${esc(delivery.id)}</h3>
      ${started
        ? `<span class="badge caption-3 ${recording ? 'badge-ok' : 'badge-info'}">${recording ? 'Recording' : 'Under way'}</span>`
        : '<span class="badge caption-3">Assigned</span>'}
    </div>
    <p class="body-5">${esc(delivery.customerName)}</p>
    <p class="caption-2 muted">${esc(delivery.address)}${away ? ` · ${esc(away)} away` : ''}</p>
    ${customer ? `<p class="caption-2"><i class="ph ph-map-pin" aria-hidden="true"></i> Customer shared their location ${esc(ago(customer.at))}</p>` : ''}
    ${actions}
  </article>`;
}

let lastListHtml = '';

function draw() {
  const html = deliveries.length
    ? deliveries.map(deliveryCard).join('')
    : '<p class="body-6 muted">No deliveries are assigned to you right now. This list updates by itself.</p>';
  // Only rebuild the list when something in it changed, so buttons do not
  // flicker under the rider's finger on every GPS update.
  if (html !== lastListHtml) {
    lastListHtml = html;
    const list = $('#list');
    list.innerHTML = html;
    for (const button of list.querySelectorAll('[data-start]')) {
      button.addEventListener('click', () => startDelivery(button.dataset.start, button));
    }
    for (const button of list.querySelectorAll('[data-delivered]')) {
      button.addEventListener('click', () => markDelivered(button.dataset.delivered, button));
    }
    for (const button of list.querySelectorAll('[data-record]')) {
      button.addEventListener('click', () => startRecording(button.dataset.record, 'by hand'));
    }
    for (const button of list.querySelectorAll('[data-fail]')) {
      button.addEventListener('click', () => openFailPanel(button.dataset.fail));
    }
  }

  if (!layer) return;
  const points = [];
  layer.begin();
  for (const delivery of deliveries) {
    layer.marker(`dest:${delivery.id}`, delivery.destLat, delivery.destLon, {
      kind: 'destination', label: delivery.id, title: delivery.address,
    });
    points.push([delivery.destLat, delivery.destLon]);
    if (delivery.customer) {
      layer.marker(`customer:${delivery.id}`, delivery.customer.lat, delivery.customer.lon, {
        kind: 'customer', title: `${delivery.customerName}, shared ${ago(delivery.customer.at)}`,
      });
      points.push([delivery.customer.lat, delivery.customer.lon]);
    }
  }
  if (me) {
    layer.marker('me', me.lat, me.lon, { kind: 'rider', label: 'You', title: 'You' });
    points.push([me.lat, me.lon]);
  }
  layer.end();
  const shape = `${deliveries.map((delivery) => delivery.id).join(',')}|${me ? 'me' : ''}`;
  if (points.length && shape !== fittedWith) {
    fitTo(map, points, 16);
    fittedWith = shape;
  }
}

// ---- Delivery actions ------------------------------------------------------------------

async function startDelivery(id, button) {
  button.disabled = true;
  try {
    await api(`/deliveries/${encodeURIComponent(id)}/events`, { method: 'POST', body: { type: 'delivery_started' } });
    currentId = id;
    await loadDeliveries();
    draw();
    toast(`Delivery ${id} started. The customer can now see you.`);
    if (watchId === null) startSharing();
  } catch (failure) {
    if (failure instanceof Unauthorized) {
      signedOut(failure);
      return;
    }
    toast(failure.message);
    button.disabled = false;
  }
}

async function markDelivered(id, button) {
  const delivery = deliveries.find((item) => item.id === id);
  if (!delivery || !isRecording(delivery)) {
    sendEvent(id, 'delivered_blocked', { recordingId: recordingIdFor(id) });
    toast('Delivered only works while the helmet is recording this delivery.');
    return;
  }
  button.disabled = true;
  const recordingId = helmet.status.id;
  try {
    await api(`/deliveries/${encodeURIComponent(id)}/complete`, {
      method: 'POST',
      body: { recordingId, ...(me ? { lat: me.lat, lon: me.lon } : {}) },
    });
    // Keep recording a few more seconds so the handover itself is on video.
    await helmetCommand({ cmd: 'stop', after: STOP_DELAY_SECONDS });
    autoStarted.delete(id);
    toast(`Delivery ${id} done. The video uploads by itself.`);
    currentId = null;
    await loadDeliveries();
    draw();
  } catch (failure) {
    if (failure instanceof Unauthorized) {
      signedOut(failure);
      return;
    }
    toast(failure.message);
    button.disabled = false;
  }
}

function openFailPanel(id) {
  failingId = id;
  $('#fail-title').textContent = `Could not deliver ${id}`;
  $('#fail-reason').value = '';
  showError('#fail-error', '');
  $('#fail-panel').hidden = false;
  $('#fail-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('#fail-reason').focus({ preventScroll: true });
}

$('#fail-cancel').addEventListener('click', () => {
  failingId = null;
  $('#fail-panel').hidden = true;
});

$('#fail-confirm').addEventListener('click', async () => {
  const reason = $('#fail-reason').value.trim();
  if (!reason) {
    showError('#fail-error', 'Say what happened, for example nobody home.');
    return;
  }
  const id = failingId;
  const button = $('#fail-confirm');
  button.disabled = true;
  try {
    const recording = helmet.status && helmet.status.st === 'rec' ? helmet.status.id : undefined;
    await api(`/deliveries/${encodeURIComponent(id)}/fail`, { method: 'POST', body: { reason, recordingId: recording } });
    if (recording) await helmetCommand({ cmd: 'stop', after: 3 });
    autoStarted.delete(id);
    $('#fail-panel').hidden = true;
    failingId = null;
    if (currentId === id) currentId = null;
    toast(`Delivery ${id} marked as not delivered.`);
    await loadDeliveries();
    draw();
  } catch (failure) {
    if (failure instanceof Unauthorized) {
      signedOut(failure);
      return;
    }
    showError('#fail-error', failure.message);
  } finally {
    button.disabled = false;
  }
});

// ---- Location sharing ---------------------------------------------------------------

const shareButton = $('#share');

function setShareState(on, text) {
  shareButton.textContent = on ? 'Stop sharing' : 'Start sharing';
  const badge = $('#share-badge');
  badge.textContent = on ? 'On' : 'Off';
  badge.className = `badge caption-3 ${on ? 'badge-ok' : ''}`;
  if (text) $('#share-status').textContent = text;
}

// Keeps the screen awake while sharing, where the browser supports it.
async function holdWakeLock() {
  try {
    if ('wakeLock' in navigator && !document.hidden) wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (watchId !== null || helmet.connected)) holdWakeLock();
});

async function onPosition(position) {
  const { latitude: lat, longitude: lon, accuracy, speed, heading } = position.coords;
  me = { lat, lon, accuracy, at: Date.now() };
  checkZone();
  draw();

  // Send after moving 10 m, or every 20 s while standing still.
  if (lastSent) {
    const elapsed = me.at - lastSent.at;
    const moved = distanceMetres(lastSent.lat, lastSent.lon, lat, lon);
    if (elapsed < 4000 || (moved < 10 && elapsed < 20000)) return;
  }
  lastSent = { lat, lon, at: me.at };
  try {
    await api('/location', {
      method: 'POST',
      body: { lat, lon, accuracy, speed, heading, deliveryId: currentId || undefined },
    });
    showError('#share-error', '');
    const on = currentId ? ` for delivery ${currentId}` : '';
    setShareState(true, `Sharing${on}, accurate to about ${Math.round(accuracy)} m. Last sent ${new Date().toLocaleTimeString()}.`);
  } catch (failure) {
    if (failure instanceof Unauthorized) {
      signedOut(failure);
      return;
    }
    $('#share-status').textContent = 'Could not reach the server. Your location is sent again as you move.';
  }
}

function startSharing() {
  showError('#share-error', '');
  if (!('geolocation' in navigator)) {
    showError('#share-error', 'This browser cannot share its location.');
    return;
  }
  if (!window.isSecureContext) {
    showError('#share-error', 'Location only works on the https address of this site.');
    return;
  }
  lastSent = null;
  setShareState(true, 'Finding your location. Allow location if the browser asks.');
  watchId = navigator.geolocation.watchPosition(
    onPosition,
    (error) => {
      stopSharing();
      showError('#share-error', error.code === error.PERMISSION_DENIED
        ? 'Location permission was refused. Allow location for this site in the browser settings, then start again.'
        : 'Your location could not be found. Check that location is switched on.');
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 30000 },
  );
  holdWakeLock();
}

function stopSharing() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  if (wakeLock && !helmet.connected) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
  setShareState(false, 'Sharing is off. The dashboard and your customers see your last known location only.');
}

shareButton.addEventListener('click', () => {
  if (watchId === null) startSharing();
  else stopSharing();
});

// ---- Helmet over Bluetooth ------------------------------------------------------------

const helmet = {
  device: null,
  command: null,
  statusChar: null,
  connected: false,
  status: null,       // { st, id, ch, q, free, wifi, fl, err } from the helmet
  timer: null,
  wanted: false,      // the rider asked to be connected; reconnect if it drops
};

// Web Bluetooth allows one operation at a time, so every call queues here.
let gattQueue = Promise.resolve();
function gatt(operation) {
  const result = gattQueue.then(operation, operation);
  gattQueue = result.catch(() => {});
  return result;
}

function isRecording(delivery) {
  return Boolean(helmet.connected && helmet.status && helmet.status.st === 'rec'
    && helmet.status.id && helmet.status.id.startsWith(`${delivery.id}-`));
}

function showHelmetSupport() {
  if (!navigator.bluetooth) {
    $('#helmet-connect').hidden = true;
    $('#helmet-status').textContent = 'This browser cannot connect to the helmet. Open this page in Chrome on an Android phone. You can still share your location here.';
  }
}

function setHelmetBadge() {
  const badge = $('#helmet-badge');
  const recording = helmet.connected && helmet.status && helmet.status.st === 'rec';
  badge.textContent = !helmet.connected ? 'Not connected' : recording ? 'Recording' : 'Connected';
  badge.className = `badge caption-3 ${recording ? 'badge-ok' : helmet.connected ? 'badge-info' : ''}`;
  $('#helmet-connect').textContent = helmet.connected || helmet.wanted ? 'Disconnect helmet' : 'Connect helmet';

  if (!helmet.connected) {
    if (helmet.wanted) $('#helmet-status').textContent = 'Lost the helmet. Reconnecting; keep it switched on and close by.';
    return;
  }
  const s = helmet.status;
  if (!s) return;
  const parts = [
    recording ? `Recording ${s.id}` : 'Ready',
    `${s.free} MB free`,
    s.wifi ? 'Wi-Fi on' : 'no Wi-Fi',
    s.q ? `${s.q} waiting to upload` : 'nothing waiting to upload',
  ];
  $('#helmet-status').textContent = `${helmet.device.name || 'Helmet'}: ${parts.join(' · ')}.`;
  showError('#helmet-error', s.err ? `Helmet problem: ${s.err}` : '');
}

function parseStatus(view) {
  try {
    const status = JSON.parse(new TextDecoder().decode(view));
    if (status && typeof status.st === 'string') {
      helmet.status = status;
      setHelmetBadge();
      draw();
    }
  } catch {
    // A status cut short by a small Bluetooth packet; the next read is complete.
  }
}

async function readStatus() {
  if (!helmet.connected || !helmet.statusChar) return;
  try {
    parseStatus(await gatt(() => helmet.statusChar.readValue()));
  } catch {
    // Disconnects are handled by the gattserverdisconnected event.
  }
}

async function helmetCommand(command) {
  if (!helmet.connected || !helmet.command) return false;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(command));
    await gatt(() => helmet.command.writeValueWithResponse(bytes));
    setTimeout(readStatus, 400);
    return true;
  } catch {
    return false;
  }
}

/** The address the helmet should upload to: this site, unless this page is open on localhost. */
function siteAddressForHelmet() {
  return /^(localhost|127\.)/.test(location.hostname) ? null : location.origin;
}

async function openHelmet() {
  const server = await gatt(() => helmet.device.gatt.connect());
  const service = await gatt(() => server.getPrimaryService(HELMET_SERVICE));
  helmet.command = await gatt(() => service.getCharacteristic(HELMET_COMMAND));
  helmet.statusChar = await gatt(() => service.getCharacteristic(HELMET_STATUS));
  try {
    helmet.statusChar.addEventListener('characteristicvaluechanged', (event) => parseStatus(event.target.value));
    await gatt(() => helmet.statusChar.startNotifications());
  } catch {
    // Reading every second below still works without notifications.
  }
  helmet.connected = true;
  showError('#helmet-error', '');
  await helmetCommand({ cmd: 'time', ts: Math.floor(Date.now() / 1000) });
  const address = siteAddressForHelmet();
  if (address) await helmetCommand({ cmd: 'server', url: address });
  await readStatus();
  clearInterval(helmet.timer);
  helmet.timer = setInterval(readStatus, 1500);
  holdWakeLock();
  if (currentId) sendEvent(currentId, 'camera_reconnected');
  setHelmetBadge();
  draw();
  checkZone();
}

function onHelmetLost() {
  const wasRecording = helmet.status && helmet.status.st === 'rec';
  helmet.connected = false;
  clearInterval(helmet.timer);
  if (wasRecording && currentId) sendEvent(currentId, 'camera_disconnected', { recordingId: helmet.status.id });
  setHelmetBadge();
  draw();
  if (helmet.wanted) setTimeout(reconnectHelmet, 4000);
}

async function reconnectHelmet() {
  if (!helmet.wanted || helmet.connected || !helmet.device) return;
  try {
    await openHelmet();
    toast('Helmet reconnected.');
  } catch {
    setTimeout(reconnectHelmet, 5000);
  }
}

async function connectHelmet() {
  showError('#helmet-error', '');
  try {
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [HELMET_SERVICE] }] });
    if (helmet.device !== device) device.addEventListener('gattserverdisconnected', onHelmetLost);
    helmet.device = device;
    helmet.wanted = true;
    $('#helmet-status').textContent = 'Connecting to the helmet.';
    await openHelmet();
    toast('Helmet connected. It now uploads to this site.');
  } catch (failure) {
    if (failure && failure.name === 'NotFoundError') {
      showError('#helmet-error', 'No helmet was chosen. Switch the helmet on, keep it close, and try again.');
    } else {
      showError('#helmet-error', `Could not connect to the helmet. ${failure && failure.message ? failure.message : ''}`.trim());
    }
    helmet.wanted = false;
    setHelmetBadge();
  }
}

function disconnectHelmet() {
  helmet.wanted = false;
  clearInterval(helmet.timer);
  if (helmet.device && helmet.device.gatt.connected) helmet.device.gatt.disconnect();
  helmet.connected = false;
  setHelmetBadge();
  draw();
}

$('#helmet-connect').addEventListener('click', () => {
  if (helmet.connected || helmet.wanted) disconnectHelmet();
  else connectHelmet();
});

// ---- Recording near the address ----------------------------------------------------------

const autoStarted = new Set();  // deliveries whose recording this page started on approach
let startInFlight = false;

function attemptsFor(id) {
  try {
    return JSON.parse(store.get(ATTEMPTS_KEY, '{}'))[id] || 0;
  } catch {
    return 0;
  }
}

function setAttempts(id, attempts) {
  let all = {};
  try { all = JSON.parse(store.get(ATTEMPTS_KEY, '{}')); } catch { all = {}; }
  all[id] = attempts;
  store.set(ATTEMPTS_KEY, JSON.stringify(all));
}

function recordingIdFor(id) {
  const delivery = deliveries.find((item) => item.id === id);
  return `${id}-${Math.max(delivery ? delivery.attempts : 0, attemptsFor(id)) || 1}`;
}

/** Starts a new recording attempt for this delivery, named "<delivery>-<attempt>". */
async function startRecording(id, how) {
  if (startInFlight || !helmet.connected) return;
  const delivery = deliveries.find((item) => item.id === id);
  if (!delivery || isRecording(delivery)) return;
  if (helmet.status && helmet.status.st === 'rec') {
    toast(`The helmet is still recording ${helmet.status.id}.`);
    return;
  }
  startInFlight = true;
  try {
    const attempt = Math.max(delivery.attempts || 0, attemptsFor(id)) + 1;
    const recordingId = `${id}-${attempt}`;
    const sent = await helmetCommand({
      cmd: 'start',
      id: recordingId,
      ts: Math.floor(Date.now() / 1000),
      lat: me ? me.lat : delivery.destLat,
      lon: me ? me.lon : delivery.destLon,
    });
    if (!sent) {
      toast('Could not reach the helmet. Trying again.');
      return;
    }
    setAttempts(id, attempt);
    if (how === 'nearby') autoStarted.add(id);
    sendEvent(id, 'recording_started', { recordingId, detail: how === 'nearby' ? `Started ${ZONE_METRES} m from the address` : 'Started by hand' });
    toast(`Recording ${recordingId}.`);
  } finally {
    startInFlight = false;
  }
}

/** Starts the recording on arrival, and stops it if the rider rides away without delivering. */
function checkZone() {
  const delivery = current();
  if (!delivery || !me || !helmet.connected || !helmet.status) return;
  const away = distanceMetres(me.lat, me.lon, delivery.destLat, delivery.destLon);
  if (away <= ZONE_METRES && !isRecording(delivery) && helmet.status.st !== 'rec') {
    if (!autoStarted.has(delivery.id)) sendEvent(delivery.id, 'geofence_enter');
    startRecording(delivery.id, 'nearby');
  } else if (away > ZONE_EXIT_METRES && isRecording(delivery) && autoStarted.has(delivery.id)) {
    autoStarted.delete(delivery.id);
    helmetCommand({ cmd: 'stop', after: 0 });
    sendEvent(delivery.id, 'recording_stopped', { recordingId: helmet.status.id, detail: 'Rider left the area without delivering' });
  }
}

// ---- Start ---------------------------------------------------------------------------

if (!token) {
  showSignIn();
} else {
  loadDeliveries()
    .then(showHome)
    .catch((failure) => {
      if (failure instanceof Unauthorized) signedOut(failure);
      else showHome();  // offline at start: show what we can and keep trying
    });
}
