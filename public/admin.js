(() => {
  const $ = (id) => document.getElementById(id);
  const money = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const plain = (c) => (c / 100).toFixed(2);
  const time = (v) => new Date(v).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const ago = (iso) => {
    if (!iso) return 'never';
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : time(iso);
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let state = null;
  let editingId = null;
  let settingsDirty = false;

  async function api(method, url, body) {
    const r = await fetch(url, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin',
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) { showLogin(); throw new Error(data.error || 'Please log in'); }
    if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
    return data;
  }

  function showLogin() { $('login').hidden = false; $('app').hidden = true; $('logout').hidden = true; }
  function showApp() { $('login').hidden = true; $('app').hidden = false; $('logout').hidden = false; }

  // Pacific wall-clock time for a datetime-local input
  function toLocalInput(ms) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }

  function render() {
    const t = state.totals, s = state.settings, st = state.status;
    $('tTotal').textContent = money(t.totalCents);
    $('tGoal').textContent = money(t.goalCents);
    $('tPct').textContent = Math.floor((t.totalCents / t.goalCents) * 100) + '%';
    $('tGl').textContent = money(t.givelivelyCents);
    $('tStripe').textContent = money(t.stripeCents);
    $('tCash').textContent = money(t.cashCents);
    $('tAdj').textContent = money(t.adjustCents) + (s.adjustNote ? ` (${s.adjustNote})` : '');

    $('names').innerHTML = state.adminNames.map((n) => `<option value="${esc(n)}">`).join('');

    $('cashRows').innerHTML = state.cash.map((c) => `
      <tr class="${c.deleted_at ? 'deleted' : ''}">
        <td>${time(c.created_at)}</td><td>${money(c.amount_cents)}</td><td>${esc(c.kind)}</td>
        <td>${esc(c.note)}</td><td>${esc(c.entered_by)}</td>
        <td>${c.deleted_at
          ? `<button class="small" data-restore="${c.id}">Restore</button>`
          : `<button class="small" data-edit="${c.id}">Edit</button><button class="small danger" data-del="${c.id}">Delete</button>`}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">No cash entered yet.</td></tr>';

    if (!settingsDirty) {
      $('sGoal').value = plain(s.goalCents);
      $('sStart').value = toLocalInput(s.eventStartMs);
      $('sAdj').value = plain(s.adjustCents);
      $('sAdjNote').value = s.adjustNote || '';
    }

    const dot = (cls) => `<span class="dot ${cls}"></span>`;
    const syncCls = st.lastSyncOk === true ? 'ok' : st.lastSyncOk === false ? 'bad' : 'warn';
    $('status').innerHTML = [
      `<li>${dot(st.stripeKey ? 'ok' : 'bad')}Stripe key ${st.stripeKey ? 'set' : '<b>missing</b>'}</li>`,
      `<li>${dot(syncCls)}Stripe check: ${ago(st.lastSyncAt)}${st.lastSyncError ? ` — <b>${esc(st.lastSyncError)}</b>` : st.lastSyncOk ? ` (${st.lastSyncSeen} charges read)` : ''}</li>`,
      `<li>${dot(st.webhookSecret ? (st.lastWebhookAt ? 'ok' : 'warn') : 'bad')}Stripe webhook: ${st.webhookSecret ? `last event ${ago(st.lastWebhookAt)}${st.lastWebhookType ? ` (${esc(st.lastWebhookType)})` : ''}` : '<b>secret missing</b>'}${st.webhookErrors ? ` · ${st.webhookErrors} rejected` : ''}</li>`,
      `<li>${dot('ok')}Give Lively campaign: <code>${esc(st.campaignSlug)}</code></li>`,
      `<li class="muted">Server up since ${time(st.startedAt)}</li>`,
    ].join('');

    $('chargeRows').innerHTML = state.charges.map((c) => `
      <tr><td>${time(c.created * 1000)}</td><td>${c.source === 'givelively' ? 'Give Lively' : 'Stripe' + (c.method === 'card_present' ? ' (reader)' : '')}</td>
      <td>${money(c.charge_cents)}</td><td><b>${money(c.cents)}</b></td><td>${esc(c.reason)}</td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">No charges yet.</td></tr>';
  }

  async function load() {
    try {
      state = await api('GET', '/api/admin/state');
      showApp();
      render();
    } catch (e) {
      if ($('app').hidden) { showLogin(); if (!/log in/i.test(e.message)) $('loginErr').textContent = e.message; }
    }
  }

  function who() {
    const v = $('cWho').value.trim();
    try { if (v) localStorage.setItem('who', v); } catch (e) { /* ignore */ }
    return v;
  }

  function resetCashForm() {
    editingId = null;
    $('cashForm').reset();
    try { $('cWho').value = localStorage.getItem('who') || ''; } catch (e) { /* ignore */ }
    $('cashTitle').textContent = 'Add cash';
    $('cSubmit').textContent = 'Add to thermometer';
    $('cCancel').hidden = true;
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginErr').textContent = '';
    try { await api('POST', '/api/admin/login', { pin: $('pin').value }); $('pin').value = ''; load(); }
    catch (err) { $('loginErr').textContent = err.message; }
  });

  $('logout').addEventListener('click', async () => { await api('POST', '/api/admin/logout'); showLogin(); });

  $('cashForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('cashErr').textContent = '';
    const body = { amount: $('cAmount').value, kind: $('cKind').value, note: $('cNote').value, who: who() };
    if (!editingId && !confirm(`Add $${Number(body.amount.replace(/[^0-9.]/g, '')).toFixed(2)} ${body.kind} to the thermometer?`)) return;
    try {
      if (editingId) await api('PUT', `/api/admin/cash/${editingId}`, body);
      else await api('POST', '/api/admin/cash', body);
      resetCashForm();
      load();
    } catch (err) { $('cashErr').textContent = err.message; }
  });
  $('cCancel').addEventListener('click', resetCashForm);

  $('cashRows').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    try {
      if (b.dataset.edit) {
        const c = state.cash.find((x) => String(x.id) === b.dataset.edit);
        editingId = c.id;
        $('cAmount').value = plain(c.amount_cents);
        $('cKind').value = c.kind;
        $('cNote').value = c.note;
        $('cashTitle').textContent = `Edit entry #${c.id}`;
        $('cSubmit').textContent = 'Save changes';
        $('cCancel').hidden = false;
        $('cAmount').focus();
        return;
      }
      if (b.dataset.del) {
        if (!confirm('Remove this entry from the thermometer? You can restore it later.')) return;
        await api('DELETE', `/api/admin/cash/${b.dataset.del}?who=${encodeURIComponent(who())}`);
      }
      if (b.dataset.restore) await api('POST', `/api/admin/cash/${b.dataset.restore}/restore`, { who: who() });
      load();
    } catch (err) { $('cashErr').textContent = err.message; }
  });

  $('setForm').addEventListener('input', () => { settingsDirty = true; });
  $('setForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('setErr').textContent = '';
    try {
      await api('POST', '/api/admin/settings', {
        goal: $('sGoal').value, eventStart: $('sStart').value,
        adjust: $('sAdj').value || '0', adjustNote: $('sAdjNote').value, who: who(),
      });
      settingsDirty = false;
      load();
    } catch (err) { $('setErr').textContent = err.message; }
  });

  $('syncBtn').addEventListener('click', async () => {
    $('syncMsg').textContent = 'Checking…';
    try {
      const r = await api('POST', '/api/admin/sync');
      $('syncMsg').textContent = r.ok ? `Done — ${r.seen} charges read.` : `Failed: ${r.error}`;
      load();
    } catch (err) { $('syncMsg').textContent = err.message; }
  });

  resetCashForm();
  load();
  setInterval(() => { if (!$('app').hidden) load(); }, 15000);
})();
