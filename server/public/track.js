/* Customer tracking page, opened from the link the delivery company sends.
   Shows the rider while the delivery is under way, and lets the customer
   share their own location so the rider can find them. */

import {
  mapsAvailable, createMap, LiveLayer, fitTo, distanceMetres, formatDistance, ago, poll,
} from '/map.js';
import { liveFrameHtml, watchLive } from '/live.js';

const $ = (selector) => document.querySelector(selector);
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);

const token = location.pathname.split('/').filter(Boolean)[1] || '';
const endpoint = `/api/track/${encodeURIComponent(token)}`;

const TAGS = {
  not_started: 'Waiting',
  on_the_way: 'On the way',
  no_signal: 'On the way',
  delivered: 'Delivered',
  failed: 'Not delivered',
};

let map = null;
let layer = null;
let fittedWith = '';
let latest = null;
let mine = null;        // this phone's own position while sharing
let watchId = null;
let lastSent = null;

if (mapsAvailable()) {
  map = createMap($('#map'));
  layer = new LiveLayer(map);
} else {
  $('#map').classList.add('map-fallback');
  $('#map').innerHTML = '<p class="body-6">The map could not load. The rest of this page still works.</p>';
}

// ---- Drawing --------------------------------------------------------------------

function summaryFor({ state, rider, delivery }) {
  const greeting = delivery.greeting ? `Hi ${delivery.greeting}. ` : '';
  if (state === 'on_the_way' && rider) {
    const target = mine || { lat: delivery.destLat, lon: delivery.destLon };
    const away = formatDistance(distanceMetres(rider.lat, rider.lon, target.lat, target.lon));
    return `${greeting}Your rider is on the way, ${away} from ${mine ? 'you' : 'your address'}.`;
  }
  if (state === 'no_signal') return `${greeting}Your rider is on the way. Their location has not updated for a few minutes.`;
  if (state === 'delivered') return `${greeting}This delivery is complete.`;
  if (state === 'failed') return `${greeting}This delivery could not be completed. The delivery company will contact you.`;
  return `${greeting}Your rider has not set off yet. This page updates by itself.`;
}

function draw() {
  if (!latest) return;
  const { delivery, state, rider, you, canShare, now } = latest;
  document.title = `Delivery ${delivery.id} | Helmet Proof`;
  $('#title').innerHTML = `Delivery <em>${esc(delivery.id)}</em>`;
  $('#summary').textContent = summaryFor(latest);
  $('#state-tag').textContent = TAGS[state] || 'Tracking';
  $('#share-card').hidden = !canShare;
  showLiveCard(latest.live);
  if (!canShare && watchId !== null) stopSharing('This delivery is finished, so sharing has stopped.');

  const me = mine || you;
  if (layer) {
    const points = [[delivery.destLat, delivery.destLon]];
    layer.begin();
    layer.marker('destination', delivery.destLat, delivery.destLon, { kind: 'destination', title: delivery.address });
    if (rider) {
      layer.marker('rider', rider.lat, rider.lon, { kind: 'rider', label: 'Rider', title: `Your rider, seen ${ago(rider.at, now)}` });
      points.push([rider.lat, rider.lon]);
    }
    if (me) {
      layer.marker('you', me.lat, me.lon, { kind: 'customer', label: 'You', title: 'You' });
      points.push([me.lat, me.lon]);
    }
    layer.end();
    // Zoom to fit when something new appears, but otherwise leave the map
    // where the customer put it.
    const shape = `${rider ? 'r' : ''}${me ? 'y' : ''}`;
    if (shape !== fittedWith) {
      fitTo(map, points, 16);
      fittedWith = shape;
    }
  }

  const seen = rider ? ` · rider seen ${ago(rider.at, now)}` : '';
  $('#updated').textContent = `Updated ${new Date(now).toLocaleTimeString()}${seen}`;
}

function showInvalid() {
  $('#title').textContent = 'This link does not work';
  $('#summary').textContent = 'The tracking link may be mistyped or incomplete. Open it again from the message the delivery company sent you.';
  $('#state-tag').textContent = 'Not found';
  $('#content').hidden = true;
}

// ---- Loading ------------------------------------------------------------------

async function load() {
  const response = await fetch(endpoint, { cache: 'no-store' });
  if (response.status === 404) {
    showInvalid();
    return false;
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  latest = await response.json();
  draw();
  // Keep updating until the delivery is finished.
  return latest.state !== 'delivered' && latest.state !== 'failed';
}

// ---- Live camera --------------------------------------------------------------------

let stopLive = null;
// Opened from "Watch live" on My deliveries: start as soon as the camera is on.
let autoWatch = new URLSearchParams(location.search).get('live') === '1';

function stopWatching() {
  if (stopLive) stopLive();
  stopLive = null;
  $('#live-view').hidden = true;
  $('#watch-live').innerHTML = '<i class="ph ph-broadcast" aria-hidden="true"></i> Watch live';
}

function startWatching() {
  const view = $('#live-view');
  if (!view.firstElementChild) view.innerHTML = liveFrameHtml('Live view from your rider\'s helmet camera');
  view.hidden = false;
  stopLive = watchLive(view.querySelector('.live-frame'), `${endpoint}/live`, { onEnd: stopWatching });
  $('#watch-live').innerHTML = '<i class="ph ph-stop" aria-hidden="true"></i> Stop watching';
}

/** Shows the card while the camera is live. A view already open keeps running (it waits through gaps). */
function showLiveCard(isLive) {
  const card = $('#live-card');
  if (isLive) {
    card.hidden = false;
    if (autoWatch && !stopLive) {
      autoWatch = false;
      startWatching();
    }
  } else if (!stopLive) {
    card.hidden = true;
  }
}

$('#watch-live').addEventListener('click', () => {
  if (stopLive) stopWatching();
  else startWatching();
});

// ---- Sharing my location ----------------------------------------------------------

const shareButton = $('#share');

function shareError(message) {
  const box = $('#share-error');
  box.textContent = message;
  box.hidden = !message;
}

function stopSharing(note = 'Sharing stopped.') {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  shareButton.textContent = 'Share my location';
  shareButton.disabled = false;
  $('#share-status').textContent = note;
}

async function send(position) {
  const { latitude: lat, longitude: lon, accuracy } = position.coords;
  mine = { lat, lon };
  draw();

  // Send when moved 15 m, or every 30 s so the rider knows it is still current.
  const now = Date.now();
  if (lastSent) {
    const elapsed = now - lastSent.at;
    const moved = distanceMetres(lastSent.lat, lastSent.lon, lat, lon);
    if (elapsed < 5000 || (moved < 15 && elapsed < 30000)) return;
  }
  lastSent = { lat, lon, at: now };
  try {
    const response = await fetch(`${endpoint}/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lon, accuracy }),
    });
    if (response.status === 409) {
      stopSharing('This delivery is finished, so sharing has stopped.');
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    shareError('');
    $('#share-status').textContent = `Sharing your location, accurate to about ${Math.round(accuracy)} m.`;
  } catch {
    $('#share-status').textContent = 'Could not send your location. Trying again as you move.';
  }
}

function startSharing() {
  shareError('');
  if (!('geolocation' in navigator)) {
    shareError('This browser cannot share its location.');
    return;
  }
  if (!window.isSecureContext) {
    shareError('Location sharing only works on the https address of this page.');
    return;
  }
  shareButton.disabled = true;
  $('#share-status').textContent = 'Finding your location. Your browser may ask for permission.';
  watchId = navigator.geolocation.watchPosition(
    (position) => {
      shareButton.disabled = false;
      shareButton.textContent = 'Stop sharing';
      send(position);
    },
    (error) => {
      stopSharing('');
      shareError(error.code === error.PERMISSION_DENIED
        ? 'Location permission was refused. Allow location for this site in your browser settings, then try again.'
        : 'Your location could not be found. Try again near a window or outdoors.');
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
  );
}

shareButton.addEventListener('click', () => {
  if (watchId === null) startSharing();
  else stopSharing();
});

// ---- Start ------------------------------------------------------------------------

// A signed in customer gets a way back to their list of deliveries.
fetch('/api/auth/me', { cache: 'no-store' })
  .then((response) => response.json())
  .then(({ user }) => {
    if (user && user.role === 'customer') $('#my-deliveries').hidden = false;
  })
  .catch(() => {});

load()
  .then((keepGoing) => {
    if (keepGoing) poll(load, 4000);
  })
  .catch(() => {
    $('#summary').textContent = 'The delivery could not be loaded. Check your connection; this page will keep trying.';
    poll(load, 4000);
  });
