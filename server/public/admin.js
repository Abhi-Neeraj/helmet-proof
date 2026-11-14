/* Admin pages: the video library, people, drivers and helmets.
   Only reachable by accounts with the admin role; the server checks that too. */

import {
  $, $$, esc, icon, badge, emptyState, skeletonRows, showToast, copyText, setFieldError,
  formatDate, formatBytes, formatDuration, VIDEO_STATUS,
  api, AuthError, dialog, openDialog, confirmDialog, openVideoDialog,
  riderLinkDialog, serverInfo, publicLink, openLiveDialog,
} from './ui.js';

const ROLE_BADGES = { admin: ['Admin', 'badge-ok'], staff: ['Staff', 'badge-info'], customer: ['Customer', ''] };

const SECTIONS = [
  ['videos', 'Videos'],
  ['people', 'People'],
  ['drivers', 'Drivers'],
  ['helmets', 'Helmets'],
];

/**
 * Renders the admin area into `main`.
 * `section` is one of SECTIONS; `page` gives access to the router's helpers.
 */
export async function adminView(main, section, isCurrent, currentUser, page) {
  const renderers = { videos: videosSection, people: peopleSection, drivers: driversSection, helmets: helmetsSection };
  const render = renderers[section];
  if (!render) {
    main.innerHTML = `<section class="card reveal">${emptyState('ph-compass', 'This page does not exist',
      'The address may be mistyped.', '<a class="btn btn-primary button-md" href="#/admin">Back to admin</a>')}</section>`;
    return;
  }

  document.title = `Admin: ${SECTIONS.find(([key]) => key === section)[1]} | Helmet Proof`;
  main.innerHTML = `
    <section class="page-head reveal">
      <div>
        <h1 class="heading-4">Admin</h1>
        <p class="body-3 muted">Every video on the server, and the people, drivers and helmets allowed to use it.</p>
      </div>
      <nav class="segmented" aria-label="Admin sections">
        ${SECTIONS.map(([key, label]) => `<a class="button-sm" href="#/admin/${key}"
          ${key === section ? 'aria-current="page"' : ''}>${label}</a>`).join('')}
      </nav>
    </section>
    <div class="stack" id="admin-body"><section class="card">${skeletonRows(4)}</section></div>`;

  const body = $('#admin-body', main);
  const context = {
    body,
    isCurrent,
    currentUser,
    // Redraws this section after a change, keeping the page where it is.
    reload: async () => {
      if (!isCurrent()) return;
      await render(context);
      page.observeReveals();
    },
  };
  await render(context);
}

/** Runs an admin action and reports a failure as a toast instead of breaking the page. */
async function attempt(action) {
  try {
    await action();
    return true;
  } catch (failure) {
    if (!(failure instanceof AuthError)) showToast(failure.message);
    return false;
  }
}

/** Wires every [data-act] button inside `root` to a handler by name. */
function bindActions(root, handlers) {
  for (const button of $$('[data-act]', root)) {
    const handler = handlers[button.dataset.act];
    if (handler) button.addEventListener('click', () => handler(button.dataset.id, button));
  }
}

const lastSeen = (ms) => (ms ? `Last seen ${formatDate(ms)}` : 'Never connected');

// ---- Videos ----------------------------------------------------------------------

async function videosSection({ body, isCurrent }) {
  body.innerHTML = `
    <section class="card reveal" aria-labelledby="library-title">
      <div class="card-head">
        <h2 class="title-1" id="library-title">Video library</h2>
        <span class="caption-2 muted numeric" id="library-totals"></span>
      </div>
      <div class="toolbar">
        <input class="input body-6" id="video-search" type="search" placeholder="Search by recording, customer, driver or helmet" aria-label="Search videos">
        <select class="input body-6" id="video-status" aria-label="Filter by status">
          <option value="">All videos</option>
          <option value="complete">Stored</option>
          <option value="receiving">Uploading</option>
          <option value="interrupted">Cut short</option>
          <option value="purged">Lost on helmet</option>
          <option value="expired">Deleted</option>
        </select>
      </div>
      <div id="video-list">${skeletonRows(5)}</div>
    </section>`;

  const list = $('#video-list', body);
  let request = 0;

  function videoRow(video) {
    const canWatch = video.receivedChunks > 0 && video.status !== 'expired';
    const who = video.deliveryExists
      ? `${video.customerName} · ${video.driverId}`
      : 'No matching delivery';
    const subtitle = `${who} · ${formatDate(video.startedAt)}`;
    return `<div class="row row-video">
      <span class="row-main">
        <span class="body-4 numeric">${esc(video.id)}</span>
        <span class="caption-2 muted truncate">${esc(who)}${video.deviceId ? ` · ${esc(video.deviceId)}` : ''}</span>
      </span>
      <span class="caption-2 muted numeric cell-date">${esc(formatDate(video.startedAt))}</span>
      <span class="caption-2 muted numeric cell-length">${esc(formatDuration(video.durationMs))} · ${esc(formatBytes(video.bytes))}</span>
      <span class="cell-status">
        ${badge(VIDEO_STATUS[video.status] || [video.status, ''])}
        ${video.flags.length ? `<span class="flag" title="${esc(video.flags.join('. '))}">${icon('ph-warning')}<span class="sr-only">${esc(video.flags.join('. '))}</span></span>` : ''}
      </span>
      <span class="row-actions">
        ${canWatch ? `<button class="btn btn-primary button-sm" type="button" data-act="watch" data-id="${esc(video.id)}" data-subtitle="${esc(subtitle)}">${icon('ph-play')} Watch</button>` : ''}
        ${video.deliveryExists ? `<a class="btn btn-secondary button-sm" href="#/deliveries/${encodeURIComponent(video.deliveryId)}">Delivery</a>` : ''}
      </span>
    </div>`;
  }

  async function load() {
    const mine = ++request;
    const query = new URLSearchParams({ q: $('#video-search', body).value, status: $('#video-status', body).value });
    try {
      const { recordings, totals, retentionDays } = await api(`/admin/recordings?${query}`);
      if (!isCurrent() || mine !== request) return;
      $('#library-totals', body).textContent =
        `${totals.videos} ${totals.videos === 1 ? 'video' : 'videos'} · ${formatBytes(totals.bytes)} · kept ${retentionDays} days without a ticket`;
      const filtered = $('#video-search', body).value || $('#video-status', body).value;
      list.innerHTML = recordings.length
        ? `<div class="rows">${recordings.map(videoRow).join('')}</div>`
        : filtered
          ? emptyState('ph-magnifying-glass', 'No videos match', 'Try a different search or status.')
          : emptyState('ph-video-camera', 'No videos yet', 'Videos appear here as soon as a helmet uploads its first recording.');
      bindActions(list, {
        watch: (id, button) => openVideoDialog(id, button.dataset.subtitle),
      });
    } catch (failure) {
      if (failure instanceof AuthError || !isCurrent()) return;
      list.innerHTML = emptyState('ph-warning-circle', 'Videos could not load', failure.message);
    }
  }

  let debounce;
  $('#video-search', body).addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(load, 250);
  });
  $('#video-status', body).addEventListener('change', load);
  await load();
}

// ---- People ----------------------------------------------------------------------

async function peopleSection({ body, isCurrent, currentUser, reload }) {
  const { users } = await api('/admin/users');
  if (!isCurrent()) return;
  const pending = users.filter((user) => user.status === 'pending');
  const others = users.filter((user) => user.status !== 'pending');

  const pendingRow = (user) => `<div class="row row-user">
    <span class="row-main">
      <span class="body-4">${esc(user.username)}</span>
      <span class="caption-2 muted numeric">Asked for access ${esc(formatDate(user.createdAt))}</span>
    </span>
    <span class="row-badges">${badge(ROLE_BADGES[user.role] || ['Staff', 'badge-info'])}</span>
    <span class="row-actions">
      <button class="btn btn-primary button-sm" type="button" data-act="approve" data-id="${user.id}">Approve</button>
      <button class="btn btn-secondary button-sm" type="button" data-act="reject" data-id="${user.id}">Reject</button>
    </span>
  </div>`;

  const userRow = (user) => {
    const self = user.id === currentUser.id;
    const active = user.status === 'active';
    return `<div class="row row-user">
      <span class="row-main">
        <span class="body-4">${esc(user.username)}${self ? ' <span class="caption-2 muted">(you)</span>' : ''}</span>
        <span class="caption-2 muted numeric">Joined ${esc(formatDate(user.createdAt))} · ${user.lastLoginAt ? `last signed in ${esc(formatDate(user.lastLoginAt))}` : 'never signed in'}</span>
      </span>
      <span class="row-badges">
        ${badge(ROLE_BADGES[user.role] || ['Staff', 'badge-info'])}
        ${active ? '' : badge(['Disabled', 'badge-warn'])}
      </span>
      <span class="row-actions">
        ${self ? '' : `
          ${user.role === 'customer' ? '' : `<button class="btn btn-secondary button-sm" type="button" data-act="role" data-id="${user.id}">${user.role === 'admin' ? 'Make staff' : 'Make admin'}</button>`}
          <button class="btn btn-secondary button-sm" type="button" data-act="password" data-id="${user.id}">Reset password</button>
          <button class="btn btn-secondary button-sm" type="button" data-act="${active ? 'disable' : 'enable'}" data-id="${user.id}">${active ? 'Disable' : 'Enable'}</button>`}
      </span>
    </div>`;
  };

  body.innerHTML = `
    ${pending.length ? `<section class="card reveal" aria-labelledby="pending-title">
      <h2 class="title-1" id="pending-title">Waiting for approval</h2>
      <div class="rows">${pending.map(pendingRow).join('')}</div>
    </section>` : ''}
    <section class="card reveal" aria-labelledby="accounts-title">
      <div class="card-head">
        <h2 class="title-1" id="accounts-title">Accounts</h2>
        <span class="caption-2 muted">People who sign up themselves wait under Waiting for approval.</span>
      </div>
      <form class="inline-form inline-form-3" id="account-form" novalidate>
        <label class="field"><span class="title-4">Username</span><input class="input body-6" name="username" maxlength="40" autocomplete="off" autocapitalize="none" spellcheck="false" required></label>
        <label class="field"><span class="title-4">Password</span><input class="input body-6" name="password" type="text" autocomplete="off" spellcheck="false" placeholder="8 characters or more" required></label>
        <label class="field"><span class="title-4">Type</span><select class="input body-6" name="role"><option value="customer">Customer</option><option value="staff">Staff</option><option value="admin">Admin</option></select></label>
        <button class="btn btn-primary button-md" type="submit">${icon('ph-user-plus')} Add account</button>
        <p class="field-error caption-1" role="alert" hidden></p>
      </form>
      <div class="rows">${others.map(userRow).join('')}</div>
    </section>`;

  const accountForm = $('#account-form', body);
  accountForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('.field-error', accountForm);
    const username = accountForm.elements.username.value.trim();
    const password = accountForm.elements.password.value;
    const role = accountForm.elements.role.value;
    error.hidden = true;
    const problem = !username ? 'Enter a username.' : password.length < 8 ? 'Use a password of at least 8 characters.' : '';
    if (problem) {
      error.textContent = problem;
      error.hidden = false;
      return;
    }
    try {
      const { user } = await api('/admin/users', { method: 'POST', body: { username, password, role } });
      showToast(`${user.username} can now sign in as ${role}`);
      await reload();
    } catch (failure) {
      if (failure instanceof AuthError) return;
      error.textContent = failure.message;
      error.hidden = false;
    }
  });

  const find = (id) => users.find((user) => user.id === Number(id));
  const update = (id, change, message) => attempt(async () => {
    await api(`/admin/users/${id}`, { method: 'POST', body: change });
    showToast(message);
    await reload();
  });

  bindActions(body, {
    approve: (id) => update(id, { status: 'active' }, `${find(id).username} can now sign in`),
    enable: (id) => update(id, { status: 'active' }, `${find(id).username} can sign in again`),
    role: (id) => {
      const makeAdmin = find(id).role !== 'admin';
      return update(id, { role: makeAdmin ? 'admin' : 'staff' },
        `${find(id).username} is now ${makeAdmin ? 'an admin' : 'staff'}`);
    },
    disable: async (id) => {
      const user = find(id);
      const confirmed = await confirmDialog({
        title: `Disable ${user.username}?`,
        text: 'They are signed out at once and cannot sign in until you enable the account again.',
        action: 'Disable account',
      });
      if (confirmed) await update(id, { status: 'disabled' }, `${user.username} is disabled`);
    },
    reject: async (id) => {
      const user = find(id);
      const confirmed = await confirmDialog({
        title: `Reject ${user.username}?`,
        text: 'The request is deleted. They can sign up again later.',
        action: 'Reject request',
      });
      if (!confirmed) return;
      await attempt(async () => {
        await api(`/admin/users/${id}/remove`, { method: 'POST' });
        showToast(`Request from ${user.username} rejected`);
        await reload();
      });
    },
    password: (id) => openResetPassword(find(id)),
  });
}

function openResetPassword(user) {
  openDialog(`
    <form class="form" id="reset-form" novalidate>
      <h2 class="heading-6" id="dialog-title">Reset password</h2>
      <p class="body-6 muted">Set a new password for ${esc(user.username)}, then pass it to them. They can change it under their account.</p>
      <label class="field">
        <span class="title-4">New password</span>
        <input class="input body-6" name="password" type="text" autocomplete="off" spellcheck="false" required>
        <span class="field-error caption-1" data-error="password" role="alert" hidden></span>
      </label>
      <div class="form-actions">
        <button class="btn btn-secondary button-md" type="button" data-close>Cancel</button>
        <button class="btn btn-primary button-md" type="submit">Set password</button>
      </div>
    </form>`);

  const form = $('#reset-form', dialog);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = form.elements.password.value;
    if (!setFieldError(form, 'password', password.length >= 8 ? '' : 'Use at least 8 characters.')) return;
    const submit = $('button[type="submit"]', form);
    submit.disabled = true;
    try {
      await api(`/admin/users/${user.id}/password`, { method: 'POST', body: { password } });
      dialog.close();
      showToast(`Password changed for ${user.username}`);
    } catch (failure) {
      if (!(failure instanceof AuthError)) setFieldError(form, 'password', failure.message);
    } finally {
      submit.disabled = false;
    }
  });
}

// ---- Drivers and helmets share one layout ------------------------------------------

/** A row with a secret that stays hidden until the admin asks to see it. */
function keyRow({ id, title, subtitle, disabled, secretText, showLabel, lead = '' }) {
  return `<div class="row row-key">
    <span class="row-main">
      <span class="body-4 numeric">${title}</span>
      <span class="caption-2 muted numeric">${subtitle}</span>
      <pre class="secret caption-2" data-secret="${esc(id)}" hidden>${esc(secretText)}</pre>
    </span>
    <span class="row-badges">${disabled ? badge(['Disabled', 'badge-warn']) : ''}</span>
    <span class="row-actions">
      ${lead}
      <button class="btn btn-secondary button-sm" type="button" data-act="show" data-id="${esc(id)}" data-label="${esc(showLabel)}">${esc(showLabel)}</button>
      <button class="btn btn-secondary button-sm" type="button" data-act="copy" data-id="${esc(id)}">Copy</button>
      <button class="btn btn-secondary button-sm" type="button" data-act="renew" data-id="${esc(id)}">New key</button>
      <button class="btn btn-secondary button-sm" type="button" data-act="${disabled ? 'enable' : 'disable'}" data-id="${esc(id)}">${disabled ? 'Enable' : 'Disable'}</button>
    </span>
  </div>`;
}

/** Shared behaviour for the Show, Copy, New key and Disable buttons. */
function bindKeyActions(body, { secretOf, renew, setDisabled, renewText, disableText }) {
  bindActions(body, {
    show: (id, button) => {
      const box = $(`[data-secret="${CSS.escape(id)}"]`, body);
      box.hidden = !box.hidden;
      button.textContent = box.hidden ? button.dataset.label : 'Hide';
    },
    copy: (id) => copyText(secretOf(id)),
    renew: async (id) => {
      if (await confirmDialog({ title: `Make a new key for ${id}?`, text: renewText, action: 'Make new key' })) {
        await renew(id);
      }
    },
    disable: async (id) => {
      if (await confirmDialog({ title: `Disable ${id}?`, text: disableText, action: 'Disable' })) {
        await setDisabled(id, true);
      }
    },
    enable: (id) => setDisabled(id, false),
  });
}

async function driversSection({ body, isCurrent, reload }) {
  const { drivers } = await api('/admin/drivers');
  if (!isCurrent()) return;

  body.innerHTML = `
    <section class="card reveal" aria-labelledby="drivers-title">
      <div class="card-head">
        <h2 class="title-1" id="drivers-title">Drivers</h2>
        <span class="caption-2 muted">Send each rider their link. It opens the rider page on their phone, already signed in.</span>
      </div>
      <form class="inline-form" id="driver-form" novalidate>
        <label class="field">
          <span class="title-4">Driver name</span>
          <input class="input body-6" name="name" maxlength="80" autocomplete="off" required>
        </label>
        <label class="field">
          <span class="title-4">Driver ID</span>
          <input class="input body-6" name="id" maxlength="32" autocomplete="off" placeholder="Leave empty to generate">
        </label>
        <button class="btn btn-primary button-md" type="submit">${icon('ph-plus')} Add driver</button>
        <p class="field-error caption-1" role="alert" hidden></p>
      </form>
      ${drivers.length
        ? `<div class="rows">${drivers.map((driver) => keyRow({
          id: driver.id,
          title: `${esc(driver.id)} · ${esc(driver.name)}`,
          subtitle: `${esc(lastSeen(driver.lastSeenAt))} · ${driver.openDeliveries} open ${driver.openDeliveries === 1 ? 'delivery' : 'deliveries'}`,
          disabled: driver.disabled,
          secretText: driver.token,
          showLabel: 'Show token',
          lead: `<button class="btn btn-primary button-sm" type="button" data-act="riderlink" data-id="${esc(driver.id)}">${icon('ph-qr-code')} Rider link</button>`,
        })).join('')}</div>`
        : emptyState('ph-moped', 'No drivers yet', 'Add a driver to get the token for their phone app. Deliveries can then be assigned to them.')}
    </section>`;

  const form = $('#driver-form', body);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('.field-error', form);
    const name = form.elements.name.value.trim();
    const id = form.elements.id.value.trim();
    error.hidden = true;
    if (!name) {
      error.textContent = 'Enter the driver name.';
      error.hidden = false;
      form.elements.name.focus();
      return;
    }
    try {
      const { driver } = await api('/admin/drivers', { method: 'POST', body: { name, id: id || undefined } });
      showToast(`Driver ${driver.id} added`);
      await reload();
    } catch (failure) {
      if (failure instanceof AuthError) return;
      error.textContent = failure.message;
      error.hidden = false;
    }
  });

  bindActions(body, {
    riderlink: (id) => riderLinkDialog(drivers.find((driver) => driver.id === id)),
  });

  bindKeyActions(body, {
    secretOf: (id) => drivers.find((driver) => driver.id === id).token,
    renewText: 'The current token stops working at once. The driver has to type the new one into the phone app.',
    disableText: 'The driver app stops working for this driver until you enable them again.',
    renew: (id) => attempt(async () => {
      await api(`/admin/drivers/${encodeURIComponent(id)}/token`, { method: 'POST' });
      showToast(`New token made for ${id}`);
      await reload();
    }),
    setDisabled: (id, disabled) => attempt(async () => {
      await api(`/admin/drivers/${encodeURIComponent(id)}`, { method: 'POST', body: { disabled } });
      showToast(`${id} ${disabled ? 'disabled' : 'enabled'}`);
      await reload();
    }),
  });
}

async function helmetsSection({ body, isCurrent, reload }) {
  const { devices } = await api('/admin/devices');
  if (!isCurrent()) return;

  const { publicUrl, lanUrls } = serverInfo();
  const helmetUrl = publicUrl || publicLink('');

  // The lines to paste into firmware/helmet_cam/config.h.
  const firmwareLines = (device) => [
    `#define DEVICE_ID      "${device.id}"`,
    `#define DEVICE_SECRET  "${device.secret}"`,
    `#define DEFAULT_SERVER_URL  "${helmetUrl}"`,
  ].join('\n');

  const addressRow = (label, url, note) => `<div class="row row-key">
      <span class="row-main">
        <span class="body-4">${esc(label)}</span>
        <span class="caption-2 muted">${esc(note)}</span>
        <code class="secret caption-2">server ${esc(url)}</code>
      </span>
      <span></span>
      <span class="row-actions">
        <button class="btn btn-secondary button-sm" type="button" data-copy-text="${esc(url)}">Copy address</button>
        <button class="btn btn-secondary button-sm" type="button" data-copy-text="server ${esc(url)}">Copy command</button>
      </span>
    </div>`;

  body.innerHTML = `
    <section class="card reveal" aria-labelledby="server-title">
      <div class="card-head">
        <h2 class="title-1" id="server-title">Where helmets upload to</h2>
        <span class="caption-2 muted">The rider page sends this to the helmet each time it connects.</span>
      </div>
      <p class="body-6 muted">To set it by hand, copy the command and type it into the Arduino Serial Monitor (115200 baud). The helmet keeps it, even after a restart.</p>
      <div class="rows">
        ${publicUrl ? addressRow('Public address', publicUrl, 'Works anywhere with internet. Changes each time the tunnel restarts.') : ''}
        ${lanUrls.map((url) => addressRow('This computer on the local network', url, 'Works only when the helmet is on the same Wi-Fi as this computer.')).join('')}
      </div>
    </section>
    <section class="card reveal" aria-labelledby="helmets-title">
      <div class="card-head">
        <h2 class="title-1" id="helmets-title">Helmets</h2>
        <span class="caption-2 muted">Press Show config, paste the lines into config.h in the firmware, then flash it.</span>
      </div>
      <form class="inline-form" id="helmet-form" novalidate>
        <label class="field">
          <span class="title-4">Helmet ID</span>
          <input class="input body-6" name="id" maxlength="32" autocomplete="off" placeholder="HELMET-001" required>
        </label>
        <label class="field">
          <span class="title-4">Note</span>
          <input class="input body-6" name="label" maxlength="80" autocomplete="off" placeholder="Who wears it, for example">
        </label>
        <button class="btn btn-primary button-md" type="submit">${icon('ph-plus')} Add helmet</button>
        <p class="field-error caption-1" role="alert" hidden></p>
      </form>
      ${devices.length
        ? `<div class="rows">${devices.map((device) => keyRow({
          id: device.id,
          title: `${esc(device.id)}${device.label ? ` · ${esc(device.label)}` : ''}`,
          subtitle: `${esc(lastSeen(device.lastSeenAt))} · ${device.videos} ${device.videos === 1 ? 'video' : 'videos'}`,
          disabled: device.disabled,
          secretText: firmwareLines(device),
          showLabel: 'Show config',
          lead: device.live
            ? `${badge(['Live', 'badge-live'])}<button class="btn btn-primary button-sm" type="button" data-act="watch" data-id="${esc(device.id)}">${icon('ph-broadcast')} Watch live</button>`
            : '',
        })).join('')}</div>`
        : emptyState('ph-hard-hat', 'No helmets yet', 'Add a helmet to get the ID and secret for its firmware. The server only accepts video from helmets listed here.')}
    </section>`;

  const form = $('#helmet-form', body);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('.field-error', form);
    const id = form.elements.id.value.trim();
    error.hidden = true;
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      error.textContent = 'Enter a helmet ID using letters, numbers, dashes and underscores.';
      error.hidden = false;
      form.elements.id.focus();
      return;
    }
    try {
      await api('/admin/devices', { method: 'POST', body: { id, label: form.elements.label.value.trim() } });
      showToast(`Helmet ${id} added`);
      await reload();
    } catch (failure) {
      if (failure instanceof AuthError) return;
      error.textContent = failure.message;
      error.hidden = false;
    }
  });

  bindActions(body, {
    watch: (id) => {
      const device = devices.find((item) => item.id === id);
      openLiveDialog({
        title: `Live: ${id}`,
        subtitle: device && device.live ? `Recording ${device.live.recordingId}` : '',
        url: `/api/helmets/${encodeURIComponent(id)}/live`,
      });
    },
  });

  for (const button of $$('[data-copy-text]', body)) {
    button.addEventListener('click', () => copyText(button.dataset.copyText));
  }

  bindKeyActions(body, {
    secretOf: (id) => firmwareLines(devices.find((device) => device.id === id)),
    renewText: 'The helmet cannot upload again until the new secret is flashed into it. Videos waiting on its card stay there until then.',
    disableText: 'The server rejects every upload from this helmet until you enable it again.',
    renew: (id) => attempt(async () => {
      await api(`/admin/devices/${encodeURIComponent(id)}/secret`, { method: 'POST' });
      showToast(`New secret made for ${id}`);
      await reload();
    }),
    setDisabled: (id, disabled) => attempt(async () => {
      await api(`/admin/devices/${encodeURIComponent(id)}`, { method: 'POST', body: { disabled } });
      showToast(`${id} ${disabled ? 'disabled' : 'enabled'}`);
      await reload();
    }),
  });
}
