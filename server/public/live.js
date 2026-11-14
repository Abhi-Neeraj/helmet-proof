/* Live view of a helmet camera, for the dashboard and the customer page.
   Asks the server for "the next frame after N"; each answer is one JPEG,
   shown as soon as it arrives. Standalone on purpose (no ui.js import), so the
   customer tracking page can use it too. */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The markup for a live picture. Put it on the page, then call watchLive on it. */
export function liveFrameHtml(alt) {
  const safe = String(alt).replace(/"/g, '&quot;');
  return `<div class="live-frame">
    <img data-live-img alt="${safe}">
    <span class="live-tag" data-live-tag hidden><span class="live-dot"></span>LIVE</span>
    <p class="live-wait caption-1" data-live-wait>Connecting to the helmet camera</p>
  </div>
  <p class="caption-2 muted numeric" data-live-meta></p>`;
}

const WAIT_TEXT = {
  off: 'The helmet camera is off right now. It turns on near the delivery address; this view starts by itself then.',
  waiting: 'Waiting for the next picture from the helmet.',
  error: 'Lost the connection. Trying again.',
};

/**
 * Starts showing the live picture inside `root` (made with liveFrameHtml).
 * `url` is the live endpoint. Returns a function that stops it.
 */
export function watchLive(root, url, { onEnd } = {}) {
  const img = root.querySelector('[data-live-img]');
  const tag = root.querySelector('[data-live-tag]');
  const wait = root.querySelector('[data-live-wait]');
  const meta = root.parentElement.querySelector('[data-live-meta]') || root.querySelector('[data-live-meta]');
  let stopped = false;
  let after = 0;
  let first = true;
  let objectUrl = null;
  let arrivals = [];
  let controller = null;

  const showWaiting = (reason) => {
    tag.hidden = true;
    wait.hidden = false;
    wait.textContent = WAIT_TEXT[reason] || reason;
    img.classList.add('live-stale');
  };

  (async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const separator = url.includes('?') ? '&' : '?';
        const response = await fetch(`${url}${separator}after=${after}${first ? '&start=1' : ''}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        first = false;
        if (stopped) break;

        if (response.status === 200) {
          const blob = await response.blob();
          if (stopped) break;
          after = Number(response.headers.get('X-Frame-Seq')) || after;
          const next = URL.createObjectURL(blob);
          img.src = next;
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = next;
          img.classList.remove('live-stale');
          tag.hidden = false;
          wait.hidden = true;

          const now = Date.now();
          arrivals = arrivals.filter((t) => now - t < 5000);
          arrivals.push(now);
          const fps = arrivals.length > 1 ? (arrivals.length - 1) / ((now - arrivals[0]) / 1000) : 0;
          const at = Number(response.headers.get('X-Frame-At')) || now;
          if (meta) {
            meta.textContent = `${response.headers.get('X-Recording-Id') || ''} · ${new Date(at).toLocaleTimeString()}${fps ? ` · ${fps.toFixed(1)} pictures a second` : ''}`;
          }
        } else if (response.status === 204) {
          showWaiting(response.headers.get('X-Live') === 'off' ? 'off' : 'waiting');
          if (meta) meta.textContent = '';
        } else {
          const data = await response.json().catch(() => ({}));
          showWaiting(data.error || 'The live camera is not available.');
          stopped = true;
          if (onEnd) onEnd();
        }
      } catch (error) {
        if (stopped) break;
        showWaiting('error');
        await sleep(3000);
      }
    }
  })();

  return () => {
    stopped = true;
    if (controller) controller.abort();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  };
}
