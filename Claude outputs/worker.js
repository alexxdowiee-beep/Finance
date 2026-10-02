/**
 * ============================================================
 *  FORGE FINANCE RELAY  +  ECOSYSTEM BACKUP
 * ============================================================
 *
 *  Two jobs:
 *   1. Reads your Akahu data for the Forge Finance app.
 *   2. Holds a daily backup of all your Forge apps' data.
 *
 *  It can never move money. It only reads from Akahu.
 *
 *  ---- WHAT'S NEW (Sept 2026): PENDING TRANSACTIONS ----
 *
 *  Adds /transactions/pending so the app can include card
 *  purchases that haven't cleared yet. To update: open your
 *  worker on cloudflare.com -> Edit code -> replace everything
 *  with this file -> Deploy. Secrets and bindings are kept.
 *
 *  ---- WHAT'S NEW (Oct 2026): STEPS AND SLEEP ----
 *
 *  Adds /health. The "Health Connect Webhook" app on your phone
 *  POSTs your Samsung Health steps and sleep here (with your
 *  RELAY_KEY as an X-Relay-Key header), and Forge (steps), Mind
 *  (sleep) and the Dashboard read them back with a GET. It uses
 *  the same BACKUPS store, so there's nothing new to set up on
 *  Cloudflare: replace everything with this file -> Deploy.
 *
 *  ---- THE BACKUP STORE ----
 *
 *  You need to give the worker somewhere to keep backups. On
 *  cloudflare.com:
 *
 *  A. Storage & Databases -> KV -> Create a namespace.
 *     Call it "forge-backups". Create.
 *
 *  B. Go to your worker -> Settings -> Bindings -> Add ->
 *     KV namespace.
 *        Variable name:  BACKUPS      (exactly this)
 *        KV namespace:   forge-backups
 *     Save, then Deploy.
 *
 *  That's it. If you skip this, the Akahu side still works
 *  perfectly — backups just report that there's no store yet.
 *
 *  ---- THE SECRETS (unchanged, already done) ----
 *        AKAHU_APP_TOKEN    your Akahu App ID Token
 *        AKAHU_USER_TOKEN   your Akahu User Access Token
 *        RELAY_KEY          the password you invented
 * ============================================================
 */

const AKAHU = 'https://api.akahu.io/v1';

// Only this website may use the relay from a browser.
const ALLOWED_ORIGIN = 'https://alexxdowiee-beep.github.io';

const MAX_PAGES = 20;                       // Akahu paging safety stop
const MAX_BACKUP_BYTES = 20 * 1024 * 1024;  // refuse anything daft
const KEEP_SNAPSHOTS_DAYS = 90;
const HEALTH_KEEP_DAYS = 70;
const HOME_TZ = 'Pacific/Auckland';           // days are counted in NZ time

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Headers': 'X-Relay-Key, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (!env.RELAY_KEY) {
      return json({ error: 'Relay is missing its secrets. Check the worker settings.' }, 500, cors);
    }
    if (!safeEqual(request.headers.get('X-Relay-Key') || '', env.RELAY_KEY)) {
      return json({ error: 'Not authorised.' }, 401, cors);
    }

    /* ---------------- backups ---------------- */

    if (url.pathname === '/backup') {
      if (!env.BACKUPS) {
        return json({ error: 'No backup store connected. Add a KV binding named BACKUPS.' }, 501, cors);
      }

      // save a snapshot
      if (request.method === 'POST') {
        const body = await request.text();
        if (!body || body.length > MAX_BACKUP_BYTES) {
          return json({ error: 'Backup missing or too large.' }, 413, cors);
        }
        try { JSON.parse(body); }
        catch (e) { return json({ error: 'Backup was not valid JSON — nothing saved.' }, 400, cors); }

        const day = new Date().toISOString().slice(0, 10);
        await env.BACKUPS.put('latest', body);
        await env.BACKUPS.put('snap:' + day, body, { expirationTtl: 60 * 60 * 24 * KEEP_SNAPSHOTS_DAYS });
        return json({ ok: true, bytes: body.length, savedAs: ['latest', 'snap:' + day] }, 200, cors);
      }

      // hand the most recent one back
      if (request.method === 'GET') {
        const stored = await env.BACKUPS.get('latest');
        if (!stored) return json({ error: 'Nothing backed up yet.' }, 404, cors);
        return new Response(stored, {
          status: 200,
          headers: Object.assign({ 'Content-Type': 'application/json' }, cors)
        });
      }
    }

    // which days are available to restore from
    if (url.pathname === '/backup/list' && request.method === 'GET') {
      if (!env.BACKUPS) return json({ error: 'No backup store connected.' }, 501, cors);
      const listed = await env.BACKUPS.list({ prefix: 'snap:' });
      return json({ days: listed.keys.map(function (k) { return k.name.slice(5); }).sort().reverse() }, 200, cors);
    }

    // a particular day
    if (url.pathname.indexOf('/backup/day/') === 0 && request.method === 'GET') {
      if (!env.BACKUPS) return json({ error: 'No backup store connected.' }, 501, cors);
      const day = url.pathname.slice('/backup/day/'.length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: 'Bad date.' }, 400, cors);
      const stored = await env.BACKUPS.get('snap:' + day);
      if (!stored) return json({ error: 'No backup from that day.' }, 404, cors);
      return new Response(stored, {
        status: 200,
        headers: Object.assign({ 'Content-Type': 'application/json' }, cors)
      });
    }

    /* ---------------- Steps and sleep (Health Connect) ---------------- */
    if (url.pathname === '/health') {
      if (!env.BACKUPS) return json({ error: 'No store connected. Add a KV binding named BACKUPS.' }, 501, cors);
      let stored;
      try { stored = JSON.parse((await env.BACKUPS.get('health')) || 'null'); } catch (e) { stored = null; }
      if (!stored || typeof stored !== 'object') stored = { steps: {}, sleep: {} };
      stored.steps = stored.steps || {}; stored.sleep = stored.sleep || {};

      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch (e) { return json({ error: 'Not valid JSON - nothing saved.' }, 400, cors); }
        // Keyed by start time, so a record sent twice (or updated later) replaces itself.
        (body.steps || []).forEach(function (s) {
          if (s && s.start_time) stored.steps[s.start_time] = { end: s.end_time || null, n: Math.max(0, Number(s.count) || 0) };
        });
        (body.sleep || []).forEach(function (s) {
          if (!s || !s.session_end_time) return;
          const first = (s.stages || []).map(function (x) { return x.start_time; }).filter(Boolean).sort()[0] || null;
          stored.sleep[s.session_end_time] = { start: first, secs: Math.max(0, Number(s.duration_seconds) || 0) };
        });
        const cutoff = Date.now() - HEALTH_KEEP_DAYS * 864e5;
        ['steps', 'sleep'].forEach(function (k) {
          Object.keys(stored[k]).forEach(function (t) { if (new Date(t).getTime() < cutoff) delete stored[k][t]; });
        });
        stored.updatedAt = new Date().toISOString();
        await env.BACKUPS.put('health', JSON.stringify(stored));
        return json({ ok: true, stepRecords: Object.keys(stored.steps).length, sleepRecords: Object.keys(stored.sleep).length }, 200, cors);
      }
      if (request.method === 'GET') return json(healthByDay(stored), 200, cors);
      return json({ error: 'Use GET or POST.' }, 405, cors);
    }

    /* ---------------- Akahu, read only ---------------- */

    if (request.method !== 'GET') {
      return json({ error: 'Only backups accept a POST.' }, 405, cors);
    }
    if (!env.AKAHU_APP_TOKEN || !env.AKAHU_USER_TOKEN) {
      return json({ error: 'Relay is missing its Akahu tokens.' }, 500, cors);
    }

    const akahu = {
      'Authorization': 'Bearer ' + env.AKAHU_USER_TOKEN,
      'X-Akahu-Id': env.AKAHU_APP_TOKEN
    };

    try {
      if (url.pathname === '/accounts') {
        const r = await fetch(AKAHU + '/accounts', { headers: akahu });
        const body = await r.json().catch(function () { return { error: 'Akahu sent something unreadable.' }; });
        return json(body, r.status, cors);
      }

      // Card purchases the bank hasn't finished processing yet. Akahu warns
      // these can change (date, description) until they settle.
      if (url.pathname === '/transactions/pending') {
        const r = await fetch(AKAHU + '/transactions/pending', { headers: akahu });
        const body = await r.json().catch(function () { return { error: 'Akahu sent something unreadable.' }; });
        return json(body, r.status, cors);
      }

      if (url.pathname === '/transactions') {
        const start = url.searchParams.get('start');
        const end = url.searchParams.get('end');
        let items = [];
        let cursor = null;
        let pages = 0;

        do {
          const q = new URLSearchParams();
          if (start) q.set('start', start);
          if (end) q.set('end', end);
          if (cursor) q.set('cursor', cursor);

          const r = await fetch(AKAHU + '/transactions?' + q.toString(), { headers: akahu });
          if (!r.ok) {
            const text = await r.text();
            return json({ error: 'Akahu returned ' + r.status, detail: text.slice(0, 300) }, r.status, cors);
          }
          const page = await r.json();
          items = items.concat(page.items || []);
          cursor = page.cursor && page.cursor.next ? page.cursor.next : null;
          pages++;
        } while (cursor && pages < MAX_PAGES);

        return json({ success: true, items: items, pages: pages, truncated: !!cursor }, 200, cors);
      }

      return json({ error: 'Unknown path.' }, 404, cors);

    } catch (e) {
      return json({ error: 'Relay could not reach Akahu.', detail: String(e) }, 502, cors);
    }
  }
};

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, cors)
  });
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// NZ calendar date (YYYY-MM-DD) for a moment in time.
function nzDay(t) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: HOME_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

// Turn the stored records into one row per NZ day:
//   { updatedAt, days: { '2026-10-02': { steps, sleepMin, sleepStart, sleepEnd } } }
// Steps count on the day their interval falls in (its midpoint). Sleep counts on the
// day you woke up; if there are two sessions that day (a nap), the longest is "last night".
function healthByDay(stored) {
  const days = {};
  const day = function (d) { return days[d] = days[d] || {}; };
  Object.keys(stored.steps || {}).forEach(function (start) {
    const r = stored.steps[start];
    const mid = r.end ? (new Date(start).getTime() + new Date(r.end).getTime()) / 2 : new Date(start).getTime();
    const d = day(nzDay(mid));
    d.steps = (d.steps || 0) + r.n;
  });
  Object.keys(stored.sleep || {}).forEach(function (end) {
    const r = stored.sleep[end], d = day(nzDay(end)), mins = Math.round(r.secs / 60);
    if (!d.sleepMin || mins > d.sleepMin) { d.sleepMin = mins; d.sleepStart = r.start; d.sleepEnd = end; }
  });
  return { updatedAt: stored.updatedAt || null, days: days };
}
