/* Helmet Proof dashboard: sign in, sign up, and the pages every signed in
   user sees. Admin only pages live in admin.js. Plain JavaScript, no build step. */

import {
  $, $$, esc, icon, badge, emptyState, skeletonRows, showToast, setFieldError,
  formatDate, formatBytes, formatDuration, VIDEO_STATUS,
  api, AuthError, onUnauthorized, dialog, openDialog, confirmDialog, stopPlayer, mountPlayer,
  loadServerInfo, publicLink, linkDialog, riderLinkDialog, openLiveDialog,
} from './ui.js';
import { adminView } from './admin.js';
import {
  mapsAvailable, createMap, LiveLayer, fitTo, distanceMetres, formatDistance, ago, poll, STALE_MS,
} from './map.js';
import { liveFrameHtml, watchLive } from './live.js';

const main = $('#main');
const authView = $('#login');
const appView = $('#app');

/** The signed in user, or null on the sign in and sign up pages. */
let currentUser = null;

const DELIVERY_STATUS = {
  assigned: ['Assigned', ''],
  in_progress: ['On the way', 'badge-info'],
  delivered: ['Delivered', 'badge-ok'],
  failed: ['Not delivered', 'badge-warn'],
};

const EVENT_LABELS = {
  delivery_created: 'Delivery created',
  delivery_started: 'Rider started the delivery',
  closed_delivered: 'Marked delivered from the dashboard',
  closed_failed: 'Marked not delivered from the dashboard',
  customer_linked: 'Customer account changed',
  geofence_enter: 'Driver came within 200 m of the destination',
  recording_started: 'Recording started',
  recording_restarted: 'Recording restarted',
  recording_stopped: 'Recording stopped',
  camera_disconnected: 'Camera link dropped',
  camera_reconnected: 'Camera link restored',
  delivered_blocked: 'Delivered was blocked because the camera was not recording',
  delivered: 'Marked delivered',
  delivery_failed: 'Marked not delivered',
  recording_stored: 'Video stored on the server',
  recording_interrupted: 'Video stored, but the recording was cut short',
  recording_purged: 'Video lost on the helmet',
  recording_expired: 'Video deleted after the retention period',
  completed_without_recording: 'Completed with no recording',
  completed_far_from_destination: 'Completed far from the destination',
  ticket_raised: 'Ticket raised',
  ticket_resolved: 'Ticket resolved',
  video_opened: 'Video opened',
  live_opened: 'Live camera watched',
};

const SOURCE_ICONS = {
  device: 'ph-video-camera', driver: 'ph-moped', staff: 'ph-user', system: 'ph-gear', customer: 'ph-user-circle',
};
const RAISED_BY = { customer: 'Customer', driver: 'Driver', staff: 'Staff' };
const USERNAME_RULE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,38}[A-Za-z0-9]$/;

// ---- Sign in and sign up ---------------------------------------------------------

const SIGN_IN_TEXT = 'Parcels get marked delivered that never arrive, and parcels that arrive get reported missing. A camera on the rider\'s helmet records the handover, so every dispute has an answer.';
const SIGN_UP_TEXT = 'Create a customer or staff account. The delivery company approves it before you can sign in.';

function showAuth() {
  currentUser = null;
  leavePage();
  stopPlayer();
  if (dialog.open) dialog.close();
  appView.hidden = true;
  authView.hidden = false;

  const signingUp = location.hash === '#/signup';
  $('#login-form').hidden = signingUp;
  $('#signup-form').hidden = !signingUp;
  $('#signup-done').hidden = true;
  $('#hero-sub').textContent = signingUp ? SIGN_UP_TEXT : SIGN_IN_TEXT;
  document.title = signingUp ? 'Create an account | Helmet Proof' : 'Helmet Proof | Proof for every doorstep handover';
  $(signingUp ? '#signup-username' : '#login-username').focus({ preventScroll: true });
  // The landing page's sections fade in as they scroll into view.
  for (const element of $$('#login .reveal:not(.in)')) revealObserver.observe(element);
}

// Section buttons on the landing page scroll instead of changing the address,
// because the address after # belongs to the dashboard's pages.
authView.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-scroll-to]');
  if (!trigger) return;
  const target = trigger.dataset.scrollTo;
  if (target === 'top') {
    // "Create an account" links still switch the form; everything else stays put.
    if (trigger.tagName !== 'A') event.preventDefault();
    // Wait for the address change to settle first; it would cut a smooth scroll short.
    setTimeout(() => window.scrollTo({ top: 0 }), 60);
    setTimeout(() => {
      const field = $('#signup-form').hidden ? '#login-username' : '#signup-username';
      $(field).focus({ preventScroll: true });
    }, 900);
    return;
  }
  event.preventDefault();
  const section = document.getElementById(target);
  if (section) section.scrollIntoView({ block: 'start' });
});

async function showApp(user) {
  currentUser = user;
  $('#nav-user').textContent = user.username;
  $('#nav-admin').hidden = user.role !== 'admin';
  // Customers get their own short menu; everything else is for staff.
  const audience = user.role === 'customer' ? 'customer' : 'staff';
  for (const link of $$('[data-for]')) link.hidden = link.dataset.for !== audience;
  authView.hidden = true;
  appView.hidden = false;
  // The public address is needed to build rider and customer links.
  await loadServerInfo();
  if (location.hash === '#/signup') location.hash = '#/';
  else route();
}

// ---- Links for riders and customers -------------------------------------------------

/** Opens the share dialog for the general rider page (riders sign in with their token). */
function openRiderPageDialog() {
  linkDialog({
    title: 'Rider page',
    text: 'Open this on the rider\'s phone. They sign in once with their driver token, press Start sharing, then Start delivery.',
    url: publicLink('/driver'),
    message: 'Helmet Proof rider page:',
    note: currentUser.role === 'admin'
      ? 'Tip: Admin > Drivers has a personal link for each rider that signs them in by itself.'
      : '',
  });
}

/** Opens the share dialog with a rider's personal sign-in link. Admins only. */
async function openRiderLinkDialog(driverId) {
  try {
    const { drivers } = await api('/admin/drivers');
    const driver = drivers.find((item) => item.id === driverId);
    if (!driver) {
      showToast(`Driver ${driverId} no longer exists`);
      return;
    }
    riderLinkDialog(driver);
  } catch (failure) {
    if (!(failure instanceof AuthError)) showToast(failure.message);
  }
}

function openCustomerLinkDialog(delivery, trackToken) {
  linkDialog({
    title: `Customer link for ${delivery.id}`,
    text: 'Send this to the customer. While the delivery is under way it shows them the rider on a map, and lets them share their location so the rider can find them.',
    url: publicLink(`/track/${trackToken}`),
    message: `Your delivery ${delivery.id} is on its way. Track your rider here:`,
  });
}

/** Shows one message under an auth form and marks the fields that caused it. */
function authError(form, message, fields = []) {
  for (const input of $$('input', form)) input.removeAttribute('aria-invalid');
  for (const field of fields) field.setAttribute('aria-invalid', 'true');
  const error = $('.field-error', form);
  error.textContent = message;
  error.hidden = !message;
  if (fields.length) fields[0].focus();
  return false;
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const username = $('#login-username');
  const password = $('#login-password');
  if (!username.value.trim()) return authError(form, 'Enter your username.', [username]);
  if (!password.value) return authError(form, 'Enter your password.', [password]);
  authError(form, '');

  const button = $('button', form);
  button.disabled = true;
  try {
    const { user } = await api('/auth/login', {
      method: 'POST', body: { username: username.value, password: password.value },
    });
    form.reset();
    showApp(user);
  } catch (failure) {
    authError(form, failure.message, [password]);
  } finally {
    button.disabled = false;
  }
  return true;
});

$('#signup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const username = $('#signup-username');
  const password = $('#signup-password');
  const confirm = $('#signup-confirm');
  const name = username.value.trim().replace(/\s+/g, ' ');
  if (!USERNAME_RULE.test(name)) {
    return authError(form, 'Use 3 to 40 characters: letters, numbers, spaces, dots, dashes or underscores.', [username]);
  }
  if (password.value.length < 8) return authError(form, 'Use a password of at least 8 characters.', [password]);
  if (password.value !== confirm.value) return authError(form, 'The two passwords do not match.', [confirm]);
  authError(form, '');

  const button = $('button', form);
  button.disabled = true;
  try {
    const accountType = form.elements.accountType.value;
    const { user } = await api('/auth/signup', {
      method: 'POST', body: { username: name, password: password.value, accountType },
    });
    form.reset();
    form.hidden = true;
    $('#signup-done-text').textContent = accountType === 'customer'
      ? `The account "${user.username}" is created. Once the delivery company approves it, sign in to follow your deliveries.`
      : `The account "${user.username}" is created. An admin has to approve it before you can sign in.`;
    $('#signup-done').hidden = false;
  } catch (failure) {
    authError(form, failure.message, [username]);
  } finally {
    button.disabled = false;
  }
  return true;
});

$('#sign-out').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  currentUser = null;
  if (location.hash && location.hash !== '#/') location.hash = '#/';
  showAuth();
});

onUnauthorized(showAuth);

// ---- Navigation ------------------------------------------------------------------

const navToggle = $('#nav-toggle');
const navLinks = $('#nav-links');

function setMenu(open) {
  navLinks.classList.toggle('open', open);
  navToggle.setAttribute('aria-expanded', String(open));
  navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
}

navToggle.addEventListener('click', () => setMenu(!navLinks.classList.contains('open')));
navLinks.addEventListener('click', (event) => {
  if (event.target.closest('.nav-link')) setMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setMenu(false);
});

$('#skip-link').addEventListener('click', () => main.focus());

function setCurrentNav(section) {
  for (const link of $$('[data-nav]')) {
    if (link.dataset.nav === section) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

// Sections rise and fade in once as they enter the viewport.
const revealObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    entry.target.classList.add('in');
    revealObserver.unobserve(entry.target);
  }
}, { threshold: 0.05 });

function observeReveals() {
  for (const element of $$('.reveal:not(.in)', main)) revealObserver.observe(element);
}

// ---- Router ----------------------------------------------------------------------

let navToken = 0;

// Work a page leaves running (maps, polling) is stopped when the page changes.
const leaveHandlers = [];
function onLeave(handler) {
  leaveHandlers.push(handler);
}
function leavePage() {
  for (const handler of leaveHandlers.splice(0)) {
    try {
      handler();
    } catch {
      // A page that fails to clean up must not stop the next one loading.
    }
  }
}

async function route() {
  leavePage();
  if (!currentUser) {
    showAuth();
    return;
  }
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [section, id] = parts;
  const token = ++navToken;
  const isCurrent = () => token === navToken;
  stopPlayer();
  setMenu(false);

  let view = notFoundView;
  let navSection = null;
  const customer = currentUser.role === 'customer';
  if (customer) {
    // Customers only reach their own pages, their account and the legal pages.
    if (!section) { view = customerHomeView; navSection = ''; }
    else if (section === 'my' && parts.length === 2) { view = () => customerDeliveryView(id, isCurrent); navSection = ''; }
  }
  else if (!section) { view = overviewView; navSection = ''; }
  else if (section === 'map' && !id) { view = mapView; navSection = 'map'; }
  else if (section === 'deliveries' && !id) { view = deliveriesView; navSection = 'deliveries'; }
  else if (section === 'deliveries' && parts.length === 2) { view = () => deliveryView(id, isCurrent); navSection = 'deliveries'; }
  else if (section === 'tickets' && !id) { view = ticketsView; navSection = 'tickets'; }
  else if (section === 'alerts' && !id) { view = alertsView; navSection = 'alerts'; }
  else if (section === 'admin' && parts.length <= 2 && currentUser.role === 'admin') {
    view = () => adminView(main, id || 'videos', isCurrent, currentUser, { observeReveals, route });
    navSection = 'admin';
  }
  // Pages every signed in account can open.
  if (view === notFoundView) {
    if (section === 'account' && !id) { view = accountView; navSection = 'account'; }
    else if (section === 'privacy' && !id) view = privacyView;
    else if (section === 'terms' && !id) view = termsView;
  }
  setCurrentNav(navSection);

  try {
    await view(isCurrent);
  } catch (failure) {
    if (failure instanceof AuthError || !isCurrent()) return;
    main.innerHTML = `<section class="card">${emptyState('ph-warning-circle', 'This page could not load', failure.message,
      '<button class="btn btn-primary button-md" type="button" id="retry">Try again</button>')}</section>`;
    $('#retry').addEventListener('click', route);
  }
  if (isCurrent()) {
    observeReveals();
    window.scrollTo(0, 0);
  }
}

window.addEventListener('hashchange', route);

// Buttons that appear on several pages.
main.addEventListener('click', (event) => {
  if (event.target.closest('[data-rider-page]')) openRiderPageDialog();
  else if (event.target.closest('[data-new-delivery]')) openNewDelivery();
  else {
    const riderLink = event.target.closest('[data-rider-link]');
    if (riderLink) openRiderLinkDialog(riderLink.dataset.riderLink);
  }
});

// ---- Overview --------------------------------------------------------------------

function alertRow(alert) {
  return `<a class="row row-alert" href="#/deliveries/${encodeURIComponent(alert.deliveryId)}">
    ${icon('ph-warning')}
    <span class="row-main">
      <span class="body-5">${esc(alert.message)}</span>
      <span class="caption-2 muted numeric">Delivery ${esc(alert.deliveryId)}</span>
    </span>
    <span class="caption-2 muted numeric">${esc(formatDate(alert.at))}</span>
  </a>`;
}

function ticketRow(ticket) {
  return `<a class="row row-ticket" href="#/deliveries/${encodeURIComponent(ticket.deliveryId)}">
    <span class="row-main">
      <span class="body-5 truncate">${esc(ticket.reason)}</span>
      <span class="caption-2 muted numeric">Delivery ${esc(ticket.deliveryId)}${ticket.customerName ? `, ${esc(ticket.customerName)}` : ''}
        · raised by ${esc(RAISED_BY[ticket.raisedBy].toLowerCase())} · ${esc(formatDate(ticket.createdAt))}</span>
    </span>
    ${badge(ticket.status === 'open' ? ['Open', 'badge-warn'] : ['Resolved', 'badge-ok'])}
  </a>`;
}

async function overviewView(isCurrent) {
  document.title = 'Overview | Helmet Proof';
  main.innerHTML = `
    <section class="page-head"><div><h1 class="heading-4">Overview</h1></div></section>
    <section class="stats" aria-hidden="true">${'<div class="skeleton skeleton-tile"></div>'.repeat(5)}</section>
    <section class="card">${skeletonRows(3)}</section>`;

  const [summary, alerts, tickets] = await Promise.all([
    api('/summary'), api('/alerts'), api('/tickets?status=open'),
  ]);
  if (!isCurrent()) return;

  const tile = (iconName, value, label, accent = false) => `
    <div class="card stat ${accent ? 'stat-accent' : ''}">
      ${icon(iconName)}
      <span class="heading-5 numeric">${esc(value)}</span>
      <span class="caption-1 muted">${esc(label)}</span>
    </div>`;

  main.innerHTML = `
    <section class="page-head reveal">
      <div>
        <h1 class="heading-4">Overview</h1>
        <p class="body-3 muted">Videos stay sealed until a ticket is raised, and are deleted after ${esc(summary.retentionDays)} days without one.</p>
      </div>
      <div class="button-row">
        <a class="btn btn-secondary button-md" href="#/map">${icon('ph-map-trifold')} Live map</a>
        <button class="btn btn-secondary button-md" type="button" data-rider-page>${icon('ph-device-mobile')} Rider page</button>
        <button class="btn btn-primary button-md" type="button" data-new-delivery>${icon('ph-plus')} New delivery</button>
      </div>
    </section>
    <section class="stats reveal" aria-label="Totals">
      ${tile('ph-package', summary.deliveries, 'Deliveries')}
      ${tile('ph-check-circle', summary.delivered, 'Delivered')}
      ${tile('ph-video-camera', summary.videosStored, 'Videos stored')}
      ${tile('ph-ticket', summary.openTickets, 'Open tickets', summary.openTickets > 0)}
      ${tile('ph-hard-drives', formatBytes(summary.storageBytes), 'Storage used')}
    </section>
    <div class="grid-2">
      <section class="card reveal" aria-labelledby="attention-title">
        <div class="card-head">
          <h2 class="title-1" id="attention-title">Needs attention</h2>
          ${alerts.alerts.length ? '<a class="caption-1" href="#/alerts">View all</a>' : ''}
        </div>
        ${alerts.alerts.length
          ? `<div class="rows">${alerts.alerts.slice(0, 6).map(alertRow).join('')}</div>`
          : emptyState('ph-shield-check', 'Nothing needs attention', 'Missing videos, covered lenses and dropped camera links will be listed here.')}
      </section>
      <section class="card reveal" aria-labelledby="open-title">
        <div class="card-head">
          <h2 class="title-1" id="open-title">Open tickets</h2>
          ${tickets.tickets.length ? '<a class="caption-1" href="#/tickets">View all</a>' : ''}
        </div>
        ${tickets.tickets.length
          ? `<div class="rows">${tickets.tickets.slice(0, 6).map(ticketRow).join('')}</div>`
          : emptyState('ph-ticket', 'No open tickets', 'When a customer or driver disputes a delivery, raise a ticket from that delivery to open its video.',
            '<a class="btn btn-secondary button-sm" href="#/deliveries">Find a delivery</a>')}
      </section>
    </div>`;
}

// ---- Customer pages ------------------------------------------------------------------

const ROLE_BADGES = { admin: ['Admin', 'badge-ok'], staff: ['Staff', 'badge-info'], customer: ['Customer', ''] };

const CUSTOMER_STATUS = {
  assigned: ['Booked', ''],
  in_progress: ['On the way', 'badge-info'],
  delivered: ['Delivered', 'badge-ok'],
  failed: ['Not delivered', 'badge-warn'],
};

const isOpenStatus = (status) => status === 'assigned' || status === 'in_progress';

function customerOpenCard(delivery) {
  const moving = delivery.status === 'in_progress';
  return `<article class="ticket">
    <div class="ticket-head">
      <h3 class="title-3 numeric">${esc(delivery.id)}</h3>
      ${delivery.live ? badge(['Live now', 'badge-live']) : badge(CUSTOMER_STATUS[delivery.status])}
    </div>
    <p class="body-6">${esc(delivery.address)}</p>
    <p class="caption-2 muted">${moving
      ? `${esc(delivery.riderName || 'Your rider')} is on the way. Track them live and share your location so they can find you.`
      : 'Booked. Live tracking starts when your rider sets off.'}</p>
    <div class="button-row">
      ${delivery.live ? `<a class="btn btn-primary button-sm" href="/track/${esc(delivery.trackToken)}?live=1">${icon('ph-broadcast')} Watch live</a>` : ''}
      <a class="btn ${delivery.live ? 'btn-secondary' : 'btn-primary'} button-sm" href="/track/${esc(delivery.trackToken)}">${icon('ph-map-pin')} Track live</a>
      <a class="btn btn-secondary button-sm" href="#/my/${encodeURIComponent(delivery.id)}">Details</a>
    </div>
  </article>`;
}

async function customerHomeView(isCurrent) {
  document.title = 'My deliveries | Helmet Proof';
  main.innerHTML = `
    <section class="page-head"><div><h1 class="heading-4">My deliveries</h1></div></section>
    <section class="card">${skeletonRows(3)}</section>`;
  const { deliveries } = await api('/customer/deliveries');
  if (!isCurrent()) return;

  const open = deliveries.filter((delivery) => isOpenStatus(delivery.status));
  const past = deliveries.filter((delivery) => !isOpenStatus(delivery.status));
  const pastRow = (delivery) => `<a class="row row-ticket" href="#/my/${encodeURIComponent(delivery.id)}">
    <span class="row-main">
      <span class="body-4 numeric">${esc(delivery.id)}</span>
      <span class="caption-2 muted truncate">${esc(delivery.address)} · ${esc(formatDate(delivery.deliveredAt || delivery.createdAt))}</span>
    </span>
    ${badge(CUSTOMER_STATUS[delivery.status] || [delivery.status, ''])}
  </a>`;

  main.innerHTML = `
    <section class="page-head reveal">
      <div>
        <h1 class="heading-4">My deliveries</h1>
        <p class="body-3 muted">Hi ${esc(currentUser.username)}. Follow your rider live, and tell us if anything went wrong.</p>
      </div>
    </section>
    ${open.length ? `<section class="card reveal" aria-labelledby="open-title">
      <h2 class="title-1" id="open-title">Coming to you</h2>
      ${open.map(customerOpenCard).join('')}
    </section>` : ''}
    <section class="card reveal" aria-labelledby="past-title">
      <h2 class="title-1" id="past-title">${open.length ? 'Earlier deliveries' : 'Your deliveries'}</h2>
      ${past.length
        ? `<div class="rows">${past.map(pastRow).join('')}</div>`
        : open.length
          ? '<p class="body-6 muted">Nothing earlier yet.</p>'
          : emptyState('ph-package', 'No deliveries yet', 'When a delivery is booked to your account it appears here, and you can follow your rider live.')}
    </section>`;
}

async function customerDeliveryView(id, isCurrent) {
  document.title = `Delivery ${id} | Helmet Proof`;
  main.innerHTML = `<section class="card">${skeletonRows(4)}</section>`;
  const { deliveries, problemTypes } = await api('/customer/deliveries');
  if (!isCurrent()) return;
  const delivery = deliveries.find((item) => item.id === id);
  if (!delivery) {
    notFoundView();
    return;
  }

  const failed = delivery.status === 'failed';
  const steps = [
    ['Booked', true],
    ['On the way', delivery.status !== 'assigned'],
    [failed ? 'Not delivered' : 'Delivered', delivery.status === 'delivered' || failed],
  ];

  main.innerHTML = `
    <a class="back-link caption-1" href="#/">${icon('ph-arrow-left')} My deliveries</a>
    <section class="page-head reveal">
      <div>
        <h1 class="heading-4 numeric">Delivery <em>${esc(delivery.id)}</em></h1>
        <p class="body-3 muted">${esc(delivery.address)}</p>
      </div>
      ${badge(CUSTOMER_STATUS[delivery.status] || [delivery.status, ''])}
    </section>
    <div class="grid-2">
      <section class="card reveal" aria-labelledby="progress-title">
        <h2 class="title-1" id="progress-title">Progress</h2>
        <ol class="progress-steps caption-1">
          ${steps.map(([label, done], index) => `<li class="${done ? (failed && index === 2 ? 'failed' : 'done') : ''}">${esc(label)}</li>`).join('')}
        </ol>
        <dl class="facts body-6">
          <dt>Rider</dt><dd>${esc(delivery.riderName || 'Not assigned yet')}</dd>
          <dt>Booked</dt><dd class="numeric">${esc(formatDate(delivery.createdAt))}</dd>
          <dt>${failed ? 'Closed' : 'Delivered'}</dt><dd class="numeric">${esc(formatDate(delivery.deliveredAt))}</dd>
          ${delivery.failReason ? `<dt>Reason</dt><dd>${esc(delivery.failReason)}</dd>` : ''}
        </dl>
        ${isOpenStatus(delivery.status) ? `<div class="button-row">
          <a class="btn btn-primary button-md" href="/track/${esc(delivery.trackToken)}">${icon('ph-map-pin')} Track live</a>
        </div>` : ''}
      </section>
      <section class="card reveal" aria-labelledby="problem-title">
        <h2 class="title-1" id="problem-title">Something wrong?</h2>
        ${delivery.problems.map((problem) => `<article class="ticket">
          <div class="ticket-head">
            <span class="caption-2 muted numeric">Reported ${esc(formatDate(problem.createdAt))}</span>
            ${badge(problem.status === 'open' ? ['Being checked', 'badge-warn'] : ['Answered', 'badge-ok'])}
          </div>
          <p class="body-6">${esc(problem.reason)}</p>
          ${problem.resolution ? `<p class="body-6"><span class="body-4">Our answer.</span> ${esc(problem.resolution)}</p>` : ''}
        </article>`).join('')}
        <form class="form" id="problem-form" novalidate>
          <p class="body-6 muted">Tell us what happened. The team checks the helmet camera video of your delivery and replies here.</p>
          <label class="field">
            <span class="title-4">What went wrong</span>
            <select class="input body-6" name="problem">
              ${Object.entries(problemTypes).map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('')}
            </select>
          </label>
          <label class="field">
            <span class="title-4">Details</span>
            <textarea class="input body-6" name="details" maxlength="800" placeholder="Anything that helps, for example the time you were home"></textarea>
            <span class="field-error caption-1" data-error="details" role="alert" hidden></span>
          </label>
          <p class="field-error caption-1" data-error="form" role="alert" hidden></p>
          <div class="form-actions"><button class="btn btn-primary button-md" type="submit">Report problem</button></div>
        </form>
      </section>
    </div>`;

  $('#problem-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const problem = form.elements.problem.value;
    const details = form.elements.details.value.trim();
    if (!setFieldError(form, 'details', problem === 'other' && !details ? 'Describe the problem.' : '')) {
      form.elements.details.focus();
      return;
    }
    await submitForm(form, async () => {
      await api(`/customer/deliveries/${encodeURIComponent(delivery.id)}/problems`, {
        method: 'POST', body: { problem, details },
      });
      showToast('Problem reported. The team will reply here.');
    });
  });
}

// ---- Live map --------------------------------------------------------------------

const MAP_MISSING = 'The map could not load. It needs an internet connection for the map library and map tiles.';

function mapFallback(box) {
  box.classList.add('map-fallback');
  box.innerHTML = `<p class="body-6">${esc(MAP_MISSING)}</p>`;
}

const LEGEND = `<div class="legend caption-2">
  <span><i class="pin pin-rider"></i> Rider</span>
  <span><i class="pin pin-destination"></i> Delivery address</span>
  <span><i class="pin pin-customer"></i> Customer, when shared</span>
</div>`;

async function mapView(isCurrent) {
  document.title = 'Live map | Helmet Proof';
  main.innerHTML = `
    <section class="page-head reveal">
      <div>
        <h1 class="heading-4">Live map</h1>
        <p class="body-3 muted">Riders' phones, open deliveries, and customers who chose to share their location. Updates every few seconds.</p>
        <span class="caption-2 muted numeric" id="map-updated"></span>
      </div>
      <div class="button-row">
        <button class="btn btn-secondary button-md" type="button" data-rider-page>${icon('ph-device-mobile')} Rider page</button>
        ${currentUser.role === 'admin'
          ? `<a class="btn btn-primary button-md" href="#/admin/drivers">${icon('ph-qr-code')} Rider links</a>`
          : ''}
      </div>
    </section>
    <section class="card reveal" id="map-help" hidden aria-labelledby="map-help-title">
      <h2 class="title-1" id="map-help-title">No rider is sharing a location right now</h2>
      <ol class="steps body-6">
        <li>Send the rider their link: ${currentUser.role === 'admin'
          ? '<a href="#/admin/drivers">Rider links</a> has a QR code and a WhatsApp button for each rider'
          : 'press <strong>Rider page</strong> above, or ask an admin for the rider\'s personal link'}.</li>
        <li>On their phone the rider presses <strong>Start sharing</strong> and allows location.</li>
        <li>They press <strong>Start delivery</strong> on the delivery they are taking. Its customer link then shows the rider too.</li>
      </ol>
    </section>
    <div class="grid-map">
      <section class="card reveal" aria-label="Map">
        <div class="map" id="live-map"></div>
        ${LEGEND}
      </section>
      <div class="stack">
        <section class="card reveal" aria-labelledby="cams-title">
          <h2 class="title-1" id="cams-title">Live cameras</h2>
          <div id="cam-list">${skeletonRows(1)}</div>
        </section>
        <section class="card reveal" aria-labelledby="riders-title">
          <h2 class="title-1" id="riders-title">Riders</h2>
          <div id="rider-list">${skeletonRows(2)}</div>
        </section>
        <section class="card reveal" aria-labelledby="open-title">
          <h2 class="title-1" id="open-title">Open deliveries</h2>
          <div id="open-list">${skeletonRows(2)}</div>
        </section>
      </div>
    </div>`;

  const box = $('#live-map');
  let map = null;
  let layer = null;
  if (mapsAvailable()) {
    map = createMap(box);
    layer = new LiveLayer(map);
    onLeave(() => map.remove());
  } else {
    mapFallback(box);
  }
  let fitted = false;

  // Clicking a rider in the list moves the map to them.
  $('#rider-list').addEventListener('click', (event) => {
    const row = event.target.closest('[data-lat]');
    if (row && map) map.setView([Number(row.dataset.lat), Number(row.dataset.lon)], 16);
  });

  // Watch live buttons in the Live cameras list.
  $('#cam-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-watch]');
    if (button) openLiveDialog({ title: `Live: ${button.dataset.watch}`, subtitle: button.dataset.subtitle, url: `/api/deliveries/${encodeURIComponent(button.dataset.watch)}/live` });
  });

  function draw({ drivers, deliveries, liveNow = [], now }) {
    const byId = new Map(deliveries.map((delivery) => [delivery.id, delivery]));
    if (layer) {
      const points = [];
      layer.begin();
      for (const delivery of deliveries) {
        layer.marker(`dest:${delivery.id}`, delivery.destLat, delivery.destLon, {
          kind: 'destination', label: delivery.id, title: `${delivery.id}, ${delivery.address}`,
        });
        points.push([delivery.destLat, delivery.destLon]);
        if (delivery.customer) {
          layer.marker(`customer:${delivery.id}`, delivery.customer.lat, delivery.customer.lon, {
            kind: 'customer', title: `Customer for ${delivery.id}, shared ${ago(delivery.customer.at, now)}`,
          });
        }
      }
      for (const rider of drivers) {
        if (!rider.position) continue;
        const { lat, lon, at } = rider.position;
        layer.marker(`rider:${rider.id}`, lat, lon, {
          kind: 'rider', label: rider.name, stale: now - at > STALE_MS, title: `${rider.name}, seen ${ago(at, now)}`,
        });
        points.push([lat, lon]);
        const target = rider.deliveryId && byId.get(rider.deliveryId);
        if (target) layer.line(`link:${rider.id}`, [[lat, lon], [target.destLat, target.destLon]], 'link');
      }
      layer.end();
      if (!fitted && points.length) {
        fitTo(map, points, 15);
        fitted = true;
      }
    }

    $('#rider-list').innerHTML = drivers.length
      ? `<div class="rows">${drivers.map((rider) => {
        const position = rider.position;
        const live = position && now - position.at <= STALE_MS;
        const target = rider.deliveryId && byId.get(rider.deliveryId);
        const togo = position && target
          ? ` · ${formatDistance(distanceMetres(position.lat, position.lon, target.destLat, target.destLon))} to go`
          : '';
        const doing = rider.deliveryId ? `On ${rider.deliveryId}${togo}` : 'No delivery under way';
        const attrs = position ? `data-lat="${position.lat}" data-lon="${position.lon}"` : 'disabled';
        return `<button class="live-row" type="button" ${attrs}>
          <span class="dot ${live ? 'dot-live' : ''}"></span>
          <span class="row-main">
            <span class="body-4 truncate">${esc(rider.name)}</span>
            <span class="caption-2 muted truncate">${esc(doing)}</span>
          </span>
          <span class="caption-2 muted numeric">${position ? esc(ago(position.at, now)) : 'No location yet'}</span>
        </button>`;
      }).join('')}</div>`
      : emptyState('ph-moped', 'No riders', 'Add drivers under Admin > Drivers. They appear here once their phone starts sharing its location.');

    $('#open-list').innerHTML = deliveries.length
      ? `<div class="rows">${deliveries.map((delivery) => `
        <a class="row row-ticket" href="#/deliveries/${encodeURIComponent(delivery.id)}">
          <span class="row-main">
            <span class="body-4 numeric">${esc(delivery.id)}</span>
            <span class="caption-2 muted truncate">${esc(delivery.customerName)}${delivery.customer ? ` · location shared ${esc(ago(delivery.customer.at, now))}` : ''}</span>
          </span>
          ${liveNow.some((cam) => cam.deliveryId === delivery.id) ? badge(['Live', 'badge-live']) : badge(DELIVERY_STATUS[delivery.status] || [delivery.status, ''])}
        </a>`).join('')}</div>`
      : emptyState('ph-package', 'No open deliveries', 'Deliveries waiting for a rider or under way are listed here.');

    $('#cam-list').innerHTML = liveNow.length
      ? `<div class="rows">${liveNow.map((cam) => `<div class="row row-ticket">
          <span class="row-main">
            <span class="body-4 numeric">${esc(cam.deliveryId)}</span>
            <span class="caption-2 muted truncate">${esc(cam.deviceId)} · recording ${esc(cam.recordingId)}</span>
          </span>
          <button class="btn btn-primary button-sm" type="button" data-watch="${esc(cam.deliveryId)}" data-subtitle="${esc(`${cam.deviceId} · ${cam.recordingId}`)}">${icon('ph-broadcast')} Watch live</button>
        </div>`).join('')}</div>`
      : '<p class="body-6 muted">No helmet camera is on right now. A camera turns on within 200 m of a delivery address.</p>';

    $('#map-updated').textContent = `Updated ${new Date(now).toLocaleTimeString()}`;
    $('#map-help').hidden = drivers.some((rider) => rider.position && now - rider.position.at <= STALE_MS);
  }

  async function refresh() {
    const data = await api('/live');
    if (!isCurrent()) return false;
    draw(data);
    return true;
  }

  await refresh();
  onLeave(poll(refresh, 4000, isCurrent));
}

/** The Live camera card's badge and note, from the delivery's live status. */
function showLiveStatus(data) {
  const badgeEl = $('#live-badge');
  if (!badgeEl) return;
  const on = Boolean(data.live);
  badgeEl.textContent = on ? 'Live now' : 'Off';
  badgeEl.className = `badge caption-3 ${on ? 'badge-live' : ''}`;
  $('#live-note').textContent = on
    ? `The helmet camera is on (${data.live.deviceId}, recording ${data.live.recordingId}).`
    : 'The helmet camera turns on within 200 m of the address. Watch live works from then until the handover is done.';
}

/** The line above the delivery map saying where the rider is, and the how-to under it. */
function showRiderStatus(data, driver) {
  const open = data.status === 'assigned' || data.status === 'in_progress';
  const rider = data.rider;
  const live = rider && data.now - rider.at <= STALE_MS;
  let text;
  if (!open) {
    text = data.route.length ? `Delivery closed. ${data.route.length} location points were recorded.` : 'Delivery closed.';
  } else if (live) {
    const togo = distanceMetres(rider.lat, rider.lon, data.destination.lat, data.destination.lon);
    text = `${driver.name} is sharing live, ${formatDistance(togo)} from the address (seen ${ago(rider.at, data.now)}).`;
  } else if (rider) {
    text = `${driver.name} stopped sharing. Last seen ${ago(rider.at, data.now)}.`;
  } else {
    text = `${driver.name} has not shared a location yet.`;
  }
  const status = $('#rider-status');
  if (!status) return;
  status.innerHTML = `<span class="dot ${live ? 'dot-live' : ''}"></span><span>${esc(text)}</span>`;
  $('#rider-help').hidden = !open || Boolean(live);
}

/** The delivery page's map: address, the rider's path and live dot, and the customer. */
async function mountRouteMap(delivery, driver, isCurrent) {
  const box = $('#route-map');
  let map = null;
  let layer = null;
  if (mapsAvailable()) {
    map = createMap(box);
    onLeave(() => map.remove());
    layer = new LiveLayer(map);
  } else {
    mapFallback(box);
  }
  let fitted = false;

  async function refresh() {
    const data = await api(`/deliveries/${encodeURIComponent(delivery.id)}/route`);
    if (!isCurrent()) return false;
    showRiderStatus(data, driver);
    showLiveStatus(data);
    const stillOpen = data.status === 'assigned' || data.status === 'in_progress';
    if (!layer) return stillOpen;
    const points = [[data.destination.lat, data.destination.lon]];
    layer.begin();
    layer.marker('destination', data.destination.lat, data.destination.lon, {
      kind: 'destination', title: delivery.address,
    });
    if (data.route.length) {
      const path = data.route.map((point) => [point.lat, point.lon]);
      if (path.length > 1) layer.line('route', path, 'route');
      layer.marker('start', path[0][0], path[0][1], { kind: 'start', title: 'Where tracking began' });
      points.push(...path);
    }
    if (data.rider) {
      layer.marker('rider', data.rider.lat, data.rider.lon, {
        kind: 'rider', stale: data.now - data.rider.at > STALE_MS, title: `Rider, seen ${ago(data.rider.at, data.now)}`,
      });
      points.push([data.rider.lat, data.rider.lon]);
    }
    if (data.customer) {
      layer.marker('customer', data.customer.lat, data.customer.lon, {
        kind: 'customer', title: `Customer, shared ${ago(data.customer.at, data.now)}`,
      });
      points.push([data.customer.lat, data.customer.lon]);
    }
    layer.end();
    if (!fitted) {
      fitTo(map, points, 16);
      fitted = true;
    }
    // Nothing moves once the delivery is finished, so stop asking.
    return stillOpen;
  }

  if (await refresh()) onLeave(poll(refresh, 5000, isCurrent));
}

// ---- Deliveries ------------------------------------------------------------------

function deliveryRow(delivery) {
  return `<a class="row row-delivery" href="#/deliveries/${encodeURIComponent(delivery.id)}">
    <span class="body-4 numeric">${esc(delivery.id)}</span>
    <span class="body-5 truncate cell-customer">${esc(delivery.customerName)}</span>
    <span class="body-6 muted truncate cell-address">${esc(delivery.address)}</span>
    <span class="cell-status">${badge(DELIVERY_STATUS[delivery.status] || [delivery.status, ''])}</span>
    <span class="cell-video">${badge(VIDEO_STATUS[delivery.videoStatus] || [delivery.videoStatus, ''])}</span>
    <span class="cell-chevron">${icon('ph-caret-right')}</span>
  </a>`;
}

async function deliveriesView(isCurrent) {
  document.title = 'Deliveries | Helmet Proof';
  main.innerHTML = `
    <section class="page-head reveal">
      <div>
        <h1 class="heading-4">Deliveries</h1>
        <p class="body-3 muted">Search by delivery ID, customer or address. The recording ID always matches the delivery ID.</p>
      </div>
      <button class="btn btn-primary button-md" type="button" id="new-delivery">${icon('ph-plus')} New delivery</button>
    </section>
    <section class="card reveal" aria-label="Delivery list">
      <div class="toolbar">
        <input class="input body-6" id="search" type="search" placeholder="Search deliveries" aria-label="Search deliveries">
        <select class="input body-6" id="status" aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="assigned">Assigned</option>
          <option value="in_progress">On the way</option>
          <option value="delivered">Delivered</option>
          <option value="failed">Not delivered</option>
        </select>
      </div>
      <div id="delivery-list">${skeletonRows(5)}</div>
    </section>`;

  const list = $('#delivery-list');
  let request = 0;

  async function load() {
    const mine = ++request;
    const query = new URLSearchParams({ q: $('#search').value, status: $('#status').value });
    try {
      const { deliveries } = await api(`/deliveries?${query}`);
      if (!isCurrent() || mine !== request) return;
      const filtered = $('#search').value || $('#status').value;
      list.innerHTML = deliveries.length
        ? `<div class="rows">
            <div class="row row-delivery row-head caption-3" aria-hidden="true">
              <span>ID</span><span>Customer</span><span>Address</span><span>Status</span><span>Video</span><span></span>
            </div>
            ${deliveries.map(deliveryRow).join('')}
          </div>`
        : filtered
          ? emptyState('ph-magnifying-glass', 'No deliveries match', 'Try a different ID, name or status.')
          : emptyState('ph-package', 'No deliveries yet', 'Create the first delivery and assign it to a driver. It appears in the driver app straight away.');
    } catch (failure) {
      if (failure instanceof AuthError || !isCurrent()) return;
      list.innerHTML = emptyState('ph-warning-circle', 'Deliveries could not load', failure.message);
    }
  }

  let debounce;
  $('#search').addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(load, 250);
  });
  $('#status').addEventListener('change', load);
  $('#new-delivery').addEventListener('click', openNewDelivery);
  await load();
}

// ---- New delivery dialog ---------------------------------------------------------

async function openNewDelivery() {
  let drivers;
  let customers;
  try {
    [{ drivers }, { customers }] = await Promise.all([api('/drivers'), api('/customers')]);
  } catch (failure) {
    if (!(failure instanceof AuthError)) showToast(failure.message);
    return;
  }

  if (!drivers.length) {
    const isAdmin = currentUser.role === 'admin';
    openDialog(`<div class="form">
      ${emptyState('ph-moped', 'Add a driver first',
        isAdmin
          ? 'A delivery has to be assigned to a driver, and none exist yet.'
          : 'A delivery has to be assigned to a driver, and none exist yet. Ask an admin to add one.')}
      <div class="form-actions">
        <button class="btn btn-secondary button-md" type="button" data-close>Close</button>
        ${isAdmin ? '<a class="btn btn-primary button-md" href="#/admin/drivers" data-close>Add a driver</a>' : ''}
      </div>
    </div>`);
    return;
  }

  const field = (name, label, attrs, hint = '') => `
    <label class="field">
      <span class="title-4">${label}</span>
      <input class="input body-6" name="${name}" ${attrs}>
      ${hint ? `<span class="caption-5 muted">${hint}</span>` : ''}
      <span class="field-error caption-1" data-error="${name}" role="alert" hidden></span>
    </label>`;

  openDialog(`
    <form class="form" id="delivery-form" novalidate>
      <h2 class="heading-6" id="dialog-title">New delivery</h2>
      ${field('id', 'Delivery ID', 'maxlength="24" autocomplete="off"', 'Leave empty to generate one.')}
      ${field('customerName', 'Customer name', 'maxlength="120" autocomplete="off" required')}
      ${field('address', 'Address', 'maxlength="300" autocomplete="off" required')}
      <div class="field-row">
        ${field('destLat', 'Latitude', 'inputmode="decimal" autocomplete="off" required')}
        ${field('destLon', 'Longitude', 'inputmode="decimal" autocomplete="off" required')}
      </div>
      <label class="field">
        <span class="title-4">Driver</span>
        <select class="input body-6" name="driverId">
          ${drivers.map((driver) => `<option value="${esc(driver.id)}">${esc(driver.name)} (${esc(driver.id)})</option>`).join('')}
        </select>
      </label>
      <label class="field">
        <span class="title-4">Customer account</span>
        <select class="input body-6" name="customerUserId">
          <option value="">No account, link only</option>
          ${customers.map((account) => `<option value="${account.id}">${esc(account.username)}</option>`).join('')}
        </select>
        <span class="caption-5 muted">A customer with an account can sign in to follow this delivery and report a problem.</span>
      </label>
      <p class="field-error caption-1" data-error="form" role="alert" hidden></p>
      <div class="form-actions">
        <button class="btn btn-secondary button-md" type="button" data-close>Cancel</button>
        <button class="btn btn-primary button-md" type="submit">Create delivery</button>
      </div>
    </form>`);

  const form = $('#delivery-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = (name) => form.elements[name].value.trim();
    const lat = Number(value('destLat'));
    const lon = Number(value('destLon'));
    const checks = [
      setFieldError(form, 'id', value('id') && !/^[A-Za-z0-9_-]{1,24}$/.test(value('id'))
        ? 'Use letters, numbers, dashes and underscores only.' : ''),
      setFieldError(form, 'customerName', value('customerName') ? '' : 'Enter the customer name.'),
      setFieldError(form, 'address', value('address') ? '' : 'Enter the delivery address.'),
      setFieldError(form, 'destLat', value('destLat') && Number.isFinite(lat) && Math.abs(lat) <= 90
        ? '' : 'Enter a latitude between 90 and minus 90.'),
      setFieldError(form, 'destLon', value('destLon') && Number.isFinite(lon) && Math.abs(lon) <= 180
        ? '' : 'Enter a longitude between 180 and minus 180.'),
    ];
    const formError = $('[data-error="form"]', form);
    formError.hidden = true;
    if (checks.includes(false)) {
      $('[aria-invalid="true"]', form).focus();
      return;
    }
    const submit = $('button[type="submit"]', form);
    submit.disabled = true;
    try {
      const { id } = await api('/deliveries', {
        method: 'POST',
        body: {
          id: value('id') || undefined, customerName: value('customerName'), address: value('address'),
          destLat: lat, destLon: lon, driverId: value('driverId'),
          customerUserId: value('customerUserId') ? Number(value('customerUserId')) : null,
        },
      });
      dialog.close();
      showToast(`Delivery ${id} created`);
      location.hash = `#/deliveries/${encodeURIComponent(id)}`;
    } catch (failure) {
      if (failure instanceof AuthError) return;
      formError.textContent = failure.message;
      formError.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}

// ---- Delivery detail -------------------------------------------------------------

function recordingCard(recording, unlocked) {
  const parts = recording.expectedChunks === null
    ? `${recording.receivedChunks} parts received`
    : `${recording.receivedChunks} of ${recording.expectedChunks} parts`;
  const canOpen = unlocked && recording.receivedChunks > 0 && recording.status !== 'expired';
  return `<article class="recording" data-recording="${esc(recording.id)}">
    <div class="recording-head">
      <h3 class="title-3 numeric">${esc(recording.id)}</h3>
      ${badge(VIDEO_STATUS[recording.status] || [recording.status, ''])}
    </div>
    <div class="recording-meta caption-2 numeric">
      <span>${esc(formatDate(recording.startedAt))}</span>
      <span>${esc(formatDuration(recording.durationMs))} long</span>
      <span>${esc(parts)}</span>
      <span>${esc(formatBytes(recording.bytes))}</span>
      ${recording.deviceId ? `<span>${esc(recording.deviceId)}</span>` : ''}
    </div>
    ${recording.flags.length ? `<ul class="flag-list caption-1">
      ${recording.flags.map((flag) => `<li>${icon('ph-warning')}<span>${esc(flag)}</span></li>`).join('')}
    </ul>` : ''}
    ${canOpen ? `<div><button class="btn btn-primary button-sm" type="button" data-open="${esc(recording.id)}">${icon('ph-play')} Open video</button></div>` : ''}
    <div data-player></div>
  </article>`;
}

function ticketCard(ticket) {
  const open = ticket.status === 'open';
  return `<article class="ticket">
    <div class="ticket-head">
      <h3 class="title-3 numeric">Ticket ${esc(ticket.id)}</h3>
      ${badge(open ? ['Open', 'badge-warn'] : ['Resolved', 'badge-ok'])}
    </div>
    <p class="caption-2 muted numeric">Raised by ${esc(RAISED_BY[ticket.raisedBy].toLowerCase())} on ${esc(formatDate(ticket.createdAt))}</p>
    <p class="body-6">${esc(ticket.reason)}</p>
    ${open ? `<form class="form" data-resolve="${esc(ticket.id)}" novalidate>
        <label class="field">
          <span class="title-4">Resolution</span>
          <textarea class="input body-6" name="resolution" maxlength="1000" required></textarea>
          <span class="field-error caption-1" data-error="resolution" role="alert" hidden></span>
        </label>
        <div class="form-actions"><button class="btn btn-secondary button-sm" type="submit">Resolve ticket</button></div>
      </form>`
      : `<p class="body-6"><span class="body-4">Resolution.</span> ${esc(ticket.resolution)}</p>
         <p class="caption-2 muted numeric">Resolved ${esc(formatDate(ticket.resolvedAt))}</p>`}
  </article>`;
}

/** The note above the recordings explaining who may watch them, and why. */
function sealNotice(hasTicket) {
  if (hasTicket) return '';
  const text = currentUser.role === 'admin'
    ? 'No ticket has been raised, so staff cannot open this video. As an admin you can, and each viewing is recorded on the timeline with your name.'
    : 'Sealed. Nobody on staff can watch this video until a ticket is raised for the delivery. Every viewing is recorded on the timeline.';
  return `<div class="notice">${icon('ph-lock-key')}<p class="body-6">${text}</p></div>`;
}

async function deliveryView(id, isCurrent) {
  document.title = `Delivery ${id} | Helmet Proof`;
  main.innerHTML = `<section class="card">${skeletonRows(2)}</section>
    <div class="grid-detail"><section class="card">${skeletonRows(4)}</section><section class="card">${skeletonRows(4)}</section></div>`;

  const data = await api(`/deliveries/${encodeURIComponent(id)}`);
  if (!isCurrent()) return;
  const { delivery, recordings, tickets, events, hasTicket, videoUnlocked, trackToken, driver, customerAccount } = data;
  const isAdmin = currentUser.role === 'admin';
  const isOpen = delivery.status === 'assigned' || delivery.status === 'in_progress';

  main.innerHTML = `
    <a class="back-link caption-1" href="#/deliveries">${icon('ph-arrow-left')} All deliveries</a>
    <section class="page-head reveal">
      <div>
        <h1 class="heading-4 numeric">Delivery <em>${esc(delivery.id)}</em></h1>
        <p class="body-3 muted">${esc(delivery.customerName)}</p>
      </div>
      ${badge(DELIVERY_STATUS[delivery.status] || [delivery.status, ''])}
    </section>
    <div class="grid-detail">
      <div class="stack">
        <section class="card reveal" aria-labelledby="details-title">
          <h2 class="title-1" id="details-title">Details</h2>
          <dl class="facts body-6">
            <dt>Address</dt><dd>${esc(delivery.address)}</dd>
            <dt>Destination</dt><dd class="numeric">${esc(delivery.destLat.toFixed(5))}, ${esc(delivery.destLon.toFixed(5))}</dd>
            <dt>Rider</dt><dd>${esc(driver.name)} <span class="muted numeric">(${esc(driver.id)})</span></dd>
            <dt>Customer login</dt><dd>${customerAccount ? esc(customerAccount.username) : '<span class="muted">None</span>'}
              <button class="btn btn-quiet button-xsm" type="button" id="link-customer">${customerAccount ? 'Change' : 'Link account'}</button></dd>
            <dt>Created</dt><dd class="numeric">${esc(formatDate(delivery.createdAt))}</dd>
            <dt>${delivery.status === 'failed' ? 'Closed' : 'Delivered'}</dt><dd class="numeric">${esc(formatDate(delivery.deliveredAt))}</dd>
            ${delivery.failReason ? `<dt>Reason</dt><dd>${esc(delivery.failReason)}</dd>` : ''}
          </dl>
          ${isOpen ? `<div class="button-row">
            <button class="btn btn-secondary button-sm" type="button" id="close-delivered">${icon('ph-check-circle')} Mark delivered</button>
            <button class="btn btn-secondary button-sm" type="button" id="close-failed">${icon('ph-x-circle')} Mark not delivered</button>
          </div>` : ''}
        </section>
        <section class="card reveal" aria-labelledby="location-title">
          <h2 class="title-1" id="location-title">Location</h2>
          <p class="live-status body-6" id="rider-status"><span class="dot"></span><span>Loading the rider's location</span></p>
          <div class="map map-sm" id="route-map"></div>
          <div class="legend caption-2">
            <span><i class="pin pin-rider"></i> Rider</span>
            <span><i class="pin pin-start"></i> Route</span>
            <span><i class="pin pin-destination"></i> Address</span>
            <span><i class="pin pin-customer"></i> Customer</span>
          </div>
          <ol class="steps body-6" id="rider-help" hidden>
            <li>${isAdmin
              ? `Press <strong>Send rider link</strong> and open it on ${esc(driver.name)}'s phone (scan the QR code or send it on WhatsApp).`
              : `Ask an admin to send ${esc(driver.name)} their rider link, or press <strong>Rider page</strong> on the Live map.`}</li>
            <li>On the phone, press <strong>Start sharing</strong> and allow location.</li>
            <li>Press <strong>Start delivery</strong> on ${esc(delivery.id)}. The rider then shows on this map and on the customer's link.</li>
          </ol>
          <div class="button-row">
            ${isAdmin ? `<button class="btn btn-primary button-sm" type="button" data-rider-link="${esc(driver.id)}">${icon('ph-moped')} Send rider link</button>` : ''}
            <button class="btn btn-secondary button-sm" type="button" id="customer-link">${icon('ph-user')} Send customer link</button>
          </div>
        </section>
        <section class="card reveal" aria-labelledby="timeline-title">
          <h2 class="title-1" id="timeline-title">Timeline</h2>
          <ol class="timeline">
            ${events.map((event) => `<li>
              ${icon(SOURCE_ICONS[event.source] || 'ph-dot')}
              <div class="timeline-body">
                <span class="body-5">${esc(EVENT_LABELS[event.type] || event.type)}${event.actor ? ` by ${esc(event.actor)}` : ''}</span>
                ${event.detail ? `<span class="caption-2 muted">${esc(event.detail)}</span>` : ''}
                <span class="caption-5 muted numeric">${esc(formatDate(event.at))}</span>
              </div>
            </li>`).join('')}
          </ol>
        </section>
      </div>
      <div class="stack">
        ${isOpen ? `<section class="card reveal" aria-labelledby="live-title">
          <div class="card-head">
            <h2 class="title-1" id="live-title">Live camera</h2>
            <span class="badge caption-3" id="live-badge">Off</span>
          </div>
          <p class="body-6 muted" id="live-note">The helmet camera turns on within 200 m of the address. Watch live works from then until the handover is done.</p>
          <div id="live-view" hidden>${liveFrameHtml(`Live view of delivery ${delivery.id}`)}</div>
          <div class="button-row">
            <button class="btn btn-primary button-sm" type="button" id="watch-live">${icon('ph-broadcast')} Watch live</button>
          </div>
        </section>` : ''}
        <section class="card reveal" aria-labelledby="video-title">
          <h2 class="title-1" id="video-title">Video evidence</h2>
          ${recordings.length
            ? sealNotice(hasTicket) + recordings.map((recording) => recordingCard(recording, videoUnlocked)).join('')
            : emptyState('ph-video-camera-slash', 'No video yet', 'The helmet starts recording when the driver comes within 200 m of the destination, and uploads once it has a connection.')}
        </section>
        <section class="card reveal" aria-labelledby="tickets-title">
          <h2 class="title-1" id="tickets-title">Tickets</h2>
          ${tickets.map(ticketCard).join('')}
          <form class="form" id="ticket-form" novalidate>
            <h3 class="title-3">Raise a ticket</h3>
            <label class="field">
              <span class="title-4">Raised by</span>
              <select class="input body-6" name="raisedBy">
                <option value="customer">Customer</option>
                <option value="driver">Driver</option>
                <option value="staff">Staff</option>
              </select>
            </label>
            <label class="field">
              <span class="title-4">What is being disputed</span>
              <textarea class="input body-6" name="reason" maxlength="1000" required></textarea>
              <span class="field-error caption-1" data-error="reason" role="alert" hidden></span>
            </label>
            <p class="field-error caption-1" data-error="form" role="alert" hidden></p>
            <div class="form-actions"><button class="btn btn-primary button-md" type="submit">Raise ticket</button></div>
          </form>
        </section>
      </div>
    </div>`;

  $('#customer-link').addEventListener('click', () => openCustomerLinkDialog(delivery, trackToken));
  $('#link-customer').addEventListener('click', () => openLinkCustomerDialog(delivery, customerAccount));
  if (isOpen) {
    $('#close-delivered').addEventListener('click', () => closeDelivered(delivery));
    $('#close-failed').addEventListener('click', () => closeFailed(delivery));
  }
  // Watch live: shows the camera inside the card; pressing again stops it.
  const watchButton = $('#watch-live');
  if (watchButton) {
    let stopLive = null;
    const stop = () => {
      if (stopLive) stopLive();
      stopLive = null;
      $('#live-view').hidden = true;
      watchButton.innerHTML = `${icon('ph-broadcast')} Watch live`;
    };
    watchButton.addEventListener('click', () => {
      if (stopLive) {
        stop();
        return;
      }
      $('#live-view').hidden = false;
      stopLive = watchLive($('#live-view .live-frame'), `/api/deliveries/${encodeURIComponent(delivery.id)}/live`, { onEnd: stop });
      watchButton.innerHTML = `${icon('ph-stop')} Stop watching`;
    });
    onLeave(stop);
  }

  mountRouteMap(delivery, driver, isCurrent).catch(() => {
    // The rest of the page still works without the map.
  });

  for (const button of $$('[data-open]', main)) {
    button.addEventListener('click', async () => {
      for (const other of $$('[data-player]', main)) other.innerHTML = '';
      for (const other of $$('[data-open]', main)) other.hidden = false;
      button.disabled = true;
      const container = $('[data-player]', button.closest('[data-recording]'));
      const showing = await mountPlayer(container, button.dataset.open);
      button.disabled = false;
      button.hidden = showing;
    });
  }

  $('#ticket-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const reason = form.elements.reason.value.trim();
    if (!setFieldError(form, 'reason', reason ? '' : 'Describe what the customer or driver is disputing.')) {
      form.elements.reason.focus();
      return;
    }
    await submitForm(form, async () => {
      await api(`/deliveries/${encodeURIComponent(id)}/tickets`, {
        method: 'POST', body: { raisedBy: form.elements.raisedBy.value, reason },
      });
      showToast(`Ticket raised for delivery ${id}. The video is now open to staff.`);
    });
  });

  for (const form of $$('[data-resolve]', main)) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const resolution = form.elements.resolution.value.trim();
      if (!setFieldError(form, 'resolution', resolution ? '' : 'Write what was decided.')) {
        form.elements.resolution.focus();
        return;
      }
      await submitForm(form, async () => {
        await api(`/tickets/${form.dataset.resolve}/resolve`, { method: 'POST', body: { resolution } });
        showToast(`Ticket ${form.dataset.resolve} resolved`);
      });
    });
  }
}

// ---- Linking a customer account to a delivery ---------------------------------------

async function openLinkCustomerDialog(delivery, linked) {
  let customers;
  try {
    ({ customers } = await api('/customers'));
  } catch (failure) {
    if (!(failure instanceof AuthError)) showToast(failure.message);
    return;
  }
  const isAdmin = currentUser.role === 'admin';
  openDialog(`
    <form class="form" id="link-customer-form" novalidate>
      <h2 class="heading-6" id="dialog-title">Customer login for ${esc(delivery.id)}</h2>
      <p class="body-6 muted">The customer account chosen here can sign in to see this delivery, track the rider live, and report a problem.</p>
      ${customers.length ? `<label class="field">
        <span class="title-4">Customer account</span>
        <select class="input body-6" name="customerUserId">
          <option value="">No account</option>
          ${customers.map((account) => `<option value="${account.id}" ${linked && linked.id === account.id ? 'selected' : ''}>${esc(account.username)}</option>`).join('')}
        </select>
      </label>` : `<p class="body-6">There are no customer accounts yet. ${isAdmin
        ? 'Create one under <a href="#/admin/people" data-close>Admin &gt; People</a>.'
        : 'Customers can sign up from the sign in page, or an admin can create one.'}</p>`}
      <p class="field-error caption-1" data-error="form" role="alert" hidden></p>
      <div class="form-actions">
        <button class="btn btn-secondary button-md" type="button" data-close>Cancel</button>
        ${customers.length ? '<button class="btn btn-primary button-md" type="submit">Save</button>' : ''}
      </div>
    </form>`);
  const form = $('#link-customer-form', dialog);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = form.elements.customerUserId.value;
    const submit = $('button[type="submit"]', form);
    submit.disabled = true;
    try {
      await api(`/deliveries/${encodeURIComponent(delivery.id)}/customer`, {
        method: 'POST', body: { customerUserId: value ? Number(value) : null },
      });
      dialog.close();
      showToast(value ? 'Customer account linked' : 'Customer account removed');
      route();
    } catch (failure) {
      if (failure instanceof AuthError) return;
      const error = $('[data-error="form"]', form);
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}

// ---- Closing a delivery from the dashboard ------------------------------------------

async function closeDelivered(delivery) {
  const confirmed = await confirmDialog({
    title: `Mark ${delivery.id} as delivered?`,
    text: 'Use this when the rider cannot close it from their phone. It is recorded on the timeline with your name. The customer\'s tracking link then shows the delivery as complete.',
    action: 'Mark delivered',
  });
  if (!confirmed) return;
  try {
    await api(`/deliveries/${encodeURIComponent(delivery.id)}/close`, { method: 'POST', body: { outcome: 'delivered' } });
    showToast(`${delivery.id} marked delivered`);
    route();
  } catch (failure) {
    if (!(failure instanceof AuthError)) showToast(failure.message);
  }
}

function closeFailed(delivery) {
  openDialog(`
    <form class="form" id="fail-form" novalidate>
      <h2 class="heading-6" id="dialog-title">Mark ${esc(delivery.id)} as not delivered</h2>
      <p class="body-6 muted">Recorded on the timeline with your name. The customer's tracking link then shows that the delivery could not be completed.</p>
      <label class="field">
        <span class="title-4">What happened</span>
        <textarea class="input body-6" name="reason" maxlength="300" required></textarea>
        <span class="field-error caption-1" data-error="reason" role="alert" hidden></span>
      </label>
      <div class="form-actions">
        <button class="btn btn-secondary button-md" type="button" data-close>Cancel</button>
        <button class="btn btn-primary button-md" type="submit">Mark not delivered</button>
      </div>
    </form>`);
  const form = $('#fail-form', dialog);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const reason = form.elements.reason.value.trim();
    if (!setFieldError(form, 'reason', reason ? '' : 'Say why it could not be delivered.')) {
      form.elements.reason.focus();
      return;
    }
    const submit = $('button[type="submit"]', form);
    submit.disabled = true;
    try {
      await api(`/deliveries/${encodeURIComponent(delivery.id)}/close`, {
        method: 'POST', body: { outcome: 'failed', reason },
      });
      dialog.close();
      showToast(`${delivery.id} marked not delivered`);
      route();
    } catch (failure) {
      if (!(failure instanceof AuthError)) setFieldError(form, 'reason', failure.message);
    } finally {
      submit.disabled = false;
    }
  });
}

/** Runs a form action, shows any failure inline, and reloads the view on success. */
async function submitForm(form, action) {
  const submit = $('button[type="submit"]', form);
  const formError = $('[data-error="form"]', form) || $('.field-error', form);
  submit.disabled = true;
  try {
    await action();
    route();
  } catch (failure) {
    if (failure instanceof AuthError) return;
    formError.textContent = failure.message;
    formError.hidden = false;
  } finally {
    submit.disabled = false;
  }
}

// ---- Tickets ---------------------------------------------------------------------

async function ticketsView(isCurrent) {
  document.title = 'Tickets | Helmet Proof';
  main.innerHTML = `
    <section class="page-head reveal">
      <div>
        <h1 class="heading-4">Tickets</h1>
        <p class="body-3 muted">A ticket is what opens a delivery video to staff. Raise one from the delivery it concerns.</p>
      </div>
      <div class="segmented" role="group" aria-label="Filter tickets">
        <button class="button-sm" type="button" data-filter="" aria-pressed="true">All</button>
        <button class="button-sm" type="button" data-filter="open" aria-pressed="false">Open</button>
        <button class="button-sm" type="button" data-filter="resolved" aria-pressed="false">Resolved</button>
      </div>
    </section>
    <section class="card reveal" aria-label="Ticket list"><div id="ticket-list">${skeletonRows(4)}</div></section>`;

  const list = $('#ticket-list');
  async function load(status) {
    try {
      const { tickets } = await api(`/tickets${status ? `?status=${status}` : ''}`);
      if (!isCurrent()) return;
      list.innerHTML = tickets.length
        ? `<div class="rows">${tickets.map(ticketRow).join('')}</div>`
        : emptyState('ph-ticket', status ? `No ${status} tickets` : 'No tickets yet',
          'When a customer or driver disputes a delivery, open that delivery and raise a ticket to unlock its video.',
          '<a class="btn btn-secondary button-sm" href="#/deliveries">Find a delivery</a>');
    } catch (failure) {
      if (failure instanceof AuthError || !isCurrent()) return;
      list.innerHTML = emptyState('ph-warning-circle', 'Tickets could not load', failure.message);
    }
  }

  for (const button of $$('[data-filter]', main)) {
    button.addEventListener('click', () => {
      for (const other of $$('[data-filter]', main)) other.setAttribute('aria-pressed', String(other === button));
      load(button.dataset.filter);
    });
  }
  await load('');
}

// ---- Alerts ----------------------------------------------------------------------

async function alertsView(isCurrent) {
  document.title = 'Alerts | Helmet Proof';
  main.innerHTML = `
    <section class="page-head"><div><h1 class="heading-4">Alerts</h1></div></section>
    <section class="card">${skeletonRows(4)}</section>`;
  const { alerts } = await api('/alerts');
  if (!isCurrent()) return;
  main.innerHTML = `
    <section class="page-head reveal">
      <div>
        <h1 class="heading-4">Alerts</h1>
        <p class="body-3 muted">Deliveries whose evidence is missing, incomplete or possibly tampered with.</p>
      </div>
    </section>
    <section class="card reveal" aria-label="Alert list">
      ${alerts.length
        ? `<div class="rows">${alerts.map(alertRow).join('')}</div>`
        : emptyState('ph-shield-check', 'Nothing needs attention', 'Missing videos, covered lenses and dropped camera links will be listed here.')}
    </section>`;
}

// ---- Your account ----------------------------------------------------------------

function accountView() {
  document.title = 'Your account | Helmet Proof';
  const passwordField = (name, label, autocomplete) => `
    <label class="field">
      <span class="title-4">${label}</span>
      <input class="input body-6" name="${name}" type="password" autocomplete="${autocomplete}" required>
      <span class="field-error caption-1" data-error="${name}" role="alert" hidden></span>
    </label>`;

  main.innerHTML = `
    <section class="page-head reveal">
      <div>
        <h1 class="heading-4">Your account</h1>
        <p class="body-3 muted">Signed in as ${esc(currentUser.username)}.</p>
      </div>
      ${badge(ROLE_BADGES[currentUser.role] || ['Staff', 'badge-info'])}
    </section>
    <div class="grid-2">
      <section class="card reveal" aria-labelledby="password-title">
        <h2 class="title-1" id="password-title">Change password</h2>
        <form class="form" id="password-form" novalidate>
          ${passwordField('current', 'Current password', 'current-password')}
          ${passwordField('next', 'New password', 'new-password')}
          ${passwordField('repeat', 'Repeat the new password', 'new-password')}
          <p class="field-error caption-1" data-error="form" role="alert" hidden></p>
          <div class="form-actions"><button class="btn btn-primary button-md" type="submit">Change password</button></div>
        </form>
      </section>
    </div>`;

  $('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const value = (name) => form.elements[name].value;
    const checks = [
      setFieldError(form, 'current', value('current') ? '' : 'Enter your current password.'),
      setFieldError(form, 'next', value('next').length >= 8 ? '' : 'Use at least 8 characters.'),
      setFieldError(form, 'repeat', value('repeat') === value('next') ? '' : 'The two passwords do not match.'),
    ];
    const formError = $('[data-error="form"]', form);
    formError.hidden = true;
    if (checks.includes(false)) {
      $('[aria-invalid="true"]', form).focus();
      return;
    }
    const submit = $('button[type="submit"]', form);
    submit.disabled = true;
    try {
      await api('/auth/password', { method: 'POST', body: { current: value('current'), next: value('next') } });
      form.reset();
      showToast('Password changed');
    } catch (failure) {
      if (failure instanceof AuthError) return;
      formError.textContent = failure.message;
      formError.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}

// ---- Static pages ----------------------------------------------------------------

function privacyView() {
  document.title = 'Privacy | Helmet Proof';
  main.innerHTML = `
    <a class="back-link caption-1" href="#/">${icon('ph-arrow-left')} Overview</a>
    <section class="card reveal">
      <div class="prose">
        <h1 class="heading-5">How delivery videos are handled</h1>
        <p class="body-3">The helmet camera records only the final approach to a delivery, starting when the driver comes within 200 m of the destination and ending shortly after the delivery is completed.</p>
        <p class="body-3">Each video is stored sealed. Staff cannot watch it until a ticket has been raised for that delivery. Admins manage the video library and can open any video. Every viewing, by anyone, is written to the delivery timeline with the viewer's name.</p>
        <p class="body-3">Videos for deliveries with no ticket are deleted automatically after the retention period shown on the overview page.</p>
        <p class="body-3">Each video part is signed by the helmet that recorded it, so the server rejects footage from unknown devices.</p>
      </div>
    </section>`;
}

function termsView() {
  document.title = 'Terms | Helmet Proof';
  main.innerHTML = `
    <a class="back-link caption-1" href="#/">${icon('ph-arrow-left')} Overview</a>
    <section class="card reveal">
      <div class="prose">
        <h1 class="heading-5">Terms of use</h1>
        <p class="body-3">This dashboard is for authorised staff reviewing delivery disputes. Open a video only for the ticket you are handling, and do not copy or share footage outside that review.</p>
        <p class="body-3">Accounts are personal. Do not share your password, and tell an admin if you think someone else has used your account.</p>
      </div>
    </section>`;
}

function notFoundView() {
  document.title = 'Page not found | Helmet Proof';
  main.innerHTML = `<section class="card reveal">${emptyState('ph-compass', 'This page does not exist',
    'The address may be mistyped, or you may not have access to it.',
    '<a class="btn btn-primary button-md" href="#/">Back to overview</a>')}</section>`;
}

// ---- Start -----------------------------------------------------------------------

api('/auth/me')
  .then(({ signedIn, user, retentionDays }) => {
    if (retentionDays) $('#retention-days').textContent = retentionDays;
    if (signedIn) showApp(user);
    else showAuth();
  })
  .catch(showAuth);
