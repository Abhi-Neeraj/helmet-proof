/* Shared map helpers for the dashboard, the driver page and the customer page.
   Wraps Leaflet, which each page loads from unpkg with an integrity hash.
   This file must not import ui.js: the driver and customer pages do not have
   the dashboard's dialog and toast elements. */

// OpenStreetMap's own tiles: free, no key, fine for light use like this.
// Their usage policy needs a referrer, which the site's own policy would
// otherwise strip; the tile layer sends just the site's origin, never the path
// (a tracking link's token stays private). styles.css darkens the tiles.
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** India, for a map with nothing on it yet. */
const DEFAULT_VIEW = { center: [21.0, 78.9], zoom: 4 };

/** A rider position older than this is drawn grey. */
export const STALE_MS = 5 * 60 * 1000;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);

export const mapsAvailable = () => typeof window.L !== 'undefined';

export function createMap(container) {
  const map = window.L.map(container, { zoomControl: true, attributionControl: true })
    .setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
  window.L.tileLayer(TILES, {
    attribution: ATTRIBUTION,
    maxZoom: 19,
    referrerPolicy: 'strict-origin-when-cross-origin',
    className: 'map-tiles',
  }).addTo(map);
  return map;
}

/** A marker drawn with CSS. `kind` is rider, destination, customer or start. */
function markerIcon(kind, label, stale) {
  const classes = `pin pin-${kind}${stale ? ' pin-stale' : ''}`;
  return window.L.divIcon({
    className: 'pin-host',
    html: `<span class="${classes}"></span>${label ? `<span class="pin-label">${esc(label)}</span>` : ''}`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

/**
 * A set of markers and lines that can be redrawn every few seconds without
 * flicker: items are keyed, moved when they exist, and removed when they stop
 * being sent.
 */
export class LiveLayer {
  constructor(map) {
    this.map = map;
    this.markers = new Map();
    this.lines = new Map();
    this.seen = new Set();
  }

  /** Call before each redraw. */
  begin() {
    this.seen.clear();
  }

  marker(key, lat, lon, { kind, label = '', stale = false, title = '' }) {
    this.seen.add(key);
    const signature = `${kind}|${label}|${stale}`;
    let entry = this.markers.get(key);
    if (entry && entry.signature !== signature) {
      entry.marker.remove();
      entry = null;
    }
    if (!entry) {
      const marker = window.L.marker([lat, lon], {
        icon: markerIcon(kind, label, stale),
        title,
        keyboard: false,
        zIndexOffset: kind === 'rider' ? 1000 : 0,
      }).addTo(this.map);
      entry = { marker, signature };
      this.markers.set(key, entry);
    } else {
      entry.marker.setLatLng([lat, lon]);
    }
    return entry.marker;
  }

  /** A line through `points` ([[lat, lon], ...]). `kind` is route or link. */
  line(key, points, kind) {
    this.seen.add(key);
    const existing = this.lines.get(key);
    if (existing) {
      existing.setLatLngs(points);
      return existing;
    }
    const style = kind === 'route'
      ? { color: '#C6F432', weight: 4, opacity: 0.9 }
      : { color: '#FFFFFF', weight: 2, opacity: 0.5, dashArray: '4 8' };
    const line = window.L.polyline(points, { ...style, interactive: false }).addTo(this.map);
    this.lines.set(key, line);
    return line;
  }

  /** Removes everything not drawn since begin(). */
  end() {
    for (const [key, entry] of this.markers) {
      if (!this.seen.has(key)) {
        entry.marker.remove();
        this.markers.delete(key);
      }
    }
    for (const [key, line] of this.lines) {
      if (!this.seen.has(key)) {
        line.remove();
        this.lines.delete(key);
      }
    }
  }
}

/** Zooms to show every point. One point gets a street level zoom. */
export function fitTo(map, points, maxZoom = 16) {
  if (!points.length) return;
  if (points.length === 1) {
    map.setView(points[0], maxZoom);
    return;
  }
  map.fitBounds(window.L.latLngBounds(points), { padding: [40, 40], maxZoom });
}

export function distanceMetres(lat1, lon1, lat2, lon2) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(a));
}

export function formatDistance(metres) {
  if (metres >= 1000) return `${(metres / 1000).toFixed(metres >= 10000 ? 0 : 1)} km`;
  return `${Math.round(metres)} m`;
}

/** "just now", "40 s ago", "3 min ago", "2 h ago". */
export function ago(at, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}

/**
 * Calls `tick` every `ms` until it returns false or `keepGoing()` does.
 * Skips beats while the tab is hidden. Returns a function that stops it.
 */
export function poll(tick, ms, keepGoing = () => true) {
  let stopped = false;
  let timer = null;
  const loop = async () => {
    if (stopped || !keepGoing()) return;
    if (!document.hidden) {
      try {
        if ((await tick()) === false) return;
      } catch {
        // A missed update is fine; the next one will catch up.
      }
    }
    if (!stopped && keepGoing()) timer = setTimeout(loop, ms);
  };
  timer = setTimeout(loop, ms);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
