(() => {
  const POLL_MS = 5000;
  const $ = (id) => document.getElementById(id);
  const fmt = (cents) => '$' + Math.floor(cents / 100).toLocaleString('en-US');

  let shown = 0;          // cents currently on screen
  let goal = 0;
  let lastOk = Date.now();

  function drawTicks(goalCents) {
    const ticks = $('ticks');
    ticks.innerHTML = '';
    for (let i = 0; i <= 4; i++) {
      const t = document.createElement('div');
      t.className = 'tick';
      t.style.bottom = (i * 25) + '%';
      const v = (goalCents * i) / 4 / 100;
      t.textContent = v >= 1000 ? '$' + (v / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'k' : '$' + v;
      ticks.appendChild(t);
    }
  }

  function countTo(target) {
    const from = shown, start = performance.now(), dur = 1800;
    const step = (t) => {
      const k = Math.min(1, (t - start) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      $('amount').textContent = fmt(from + (target - from) * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    if (target > from && from > 0) {
      $('amount').classList.add('bump');
      setTimeout(() => $('amount').classList.remove('bump'), 450);
    }
    shown = target;
  }

  function render(data) {
    if (data.goalCents !== goal) {
      goal = data.goalCents;
      $('goal').textContent = fmt(goal);
      drawTicks(goal);
    }
    const pct = goal ? (data.totalCents / goal) * 100 : 0;
    $('fill').style.height = Math.min(100, Math.max(0, pct)) + '%';
    $('pct').textContent = Math.floor(pct) + '%';
    $('reached').hidden = pct < 100;
    if (data.totalCents !== shown) countTo(data.totalCents);
  }

  async function poll() {
    try {
      const r = await fetch('/api/total', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      render(await r.json());
      lastOk = Date.now();
    } catch (e) {
      // Keep showing the last total; just flag that we're reconnecting.
    }
    $('offline').hidden = Date.now() - lastOk < 20000;
  }

  poll();
  setInterval(poll, POLL_MS);
  // Reload once an hour so a long-running TV picks up any page changes.
  // Only reload if the server answers, so the TV never ends up on an error page.
  setInterval(async () => {
    try { if ((await fetch('/', { cache: 'no-store' })).ok) location.reload(); } catch (e) { /* try next hour */ }
  }, 60 * 60 * 1000);
})();
