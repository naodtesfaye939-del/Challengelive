'use strict';
// ChallengeLive backend (Extension Backend Service). No outside packages needed.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { verify } = require('./jwt');
const { Store } = require('./store');
const { moderate } = require('./moderation');
const { PAID_DARES, GOAL_BOOSTS, MAJOR_DARES } = require('./catalog');
const twitch = require('./twitch');

const fail = (status, message) => Object.assign(new Error(message), { status });
const clean = (s) => String(s || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim();

function createServer(cfg) {
  const store = new Store();
  if (cfg.dataFile && fs.existsSync(cfg.dataFile)) {
    try { store.load(JSON.parse(fs.readFileSync(cfg.dataFile, 'utf8'))); } catch (e) { console.error('could not load saved data:', e.message); }
  }

  // ---- tiny rate limiter + strike system ----
  const hits = new Map();
  const limited = (key, max, ms) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < ms);
    const over = arr.length >= max;
    if (!over) arr.push(now);
    hits.set(key, arr);
    return over;
  };
  const strikes = new Map();
  const isMuted = (key) => (strikes.get(key) || []).filter((t) => Date.now() - t < 30 * 60000).length >= 3;
  const addStrike = (key) => strikes.set(key, [...(strikes.get(key) || []), Date.now()].slice(-10));
  setInterval(() => { for (const [k, v] of hits) if (!v.some((t) => Date.now() - t < 600000)) hits.delete(k); }, 300000).unref();

  // ---- realtime: tell every viewer "something changed" (they then fetch the new state) ----
  const timers = new Map();
  function changed(cid) {
    if (timers.has(cid)) return;
    timers.set(cid, setTimeout(() => {
      timers.delete(cid);
      twitch.broadcast(cfg, cid, { v: store.ch(cid).version }).catch((e) => console.error('broadcast error', e.message));
      if (cfg.dataFile) {
        try { fs.mkdirSync(path.dirname(cfg.dataFile), { recursive: true }); fs.writeFileSync(cfg.dataFile, JSON.stringify(store)); } catch (e) { console.error('save failed:', e.message); }
      }
    }, 800));
  }

  function authenticate(req) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    try {
      if (cfg.devMode && token.startsWith('dev:')) { const [, channelId, userId, role] = token.split(':'); return { channelId, userId: userId || '', role: role || 'viewer' }; }
      const p = verify(token, cfg.secret);
      if (!p.channel_id) throw new Error('no channel');
      return { channelId: p.channel_id, userId: p.user_id || '', role: p.role || 'viewer' };
    } catch (e) { throw fail(401, 'unauthorized'); }
  }
  const needUser = (me) => { if (!me.userId) throw fail(401, 'share_identity'); }; // Twitch rule 7.1
  const needStreamer = (me) => { if (me.role !== 'broadcaster') throw fail(403, 'streamer_only'); };

  async function readBody(req) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > 10000) throw fail(413, 'too_big'); chunks.push(c); }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail(400, 'bad_json'); }
  }

  // Shared by dares and questions: clean -> rate limit -> moderate -> add
  async function submit(me, kind, rawText, add) {
    needUser(me);
    const key = `${me.channelId}:${me.userId}`;
    if (isMuted(key)) throw fail(429, 'muted');
    if (limited(`sub:${kind}:${key}`, 1, 30000) || limited(`subs:${key}`, 8, 600000)) throw fail(429, 'rate_limited');
    const text = clean(rawText);
    const result = await moderate(text, { kind, ...aiOptions(cfg) });
    if (!result.ok) { addStrike(key); throw Object.assign(fail(422, 'blocked'), { reason: result.reason }); }
    const userName = await twitch.displayName(cfg, me.userId); // Twitch rule 7.3: show the username
    return add({ text, userId: me.userId, userName });
  }

  async function handle(req, res) {
    const origin = req.headers.origin;
    const allowed = cfg.devMode || (cfg.clientId && origin === `https://${cfg.clientId}.ext-twitch.tv`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (origin && allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/health' || p === '/') return send(res, 200, { ok: true, name: 'ChallengeLive' });
    if (!p.startsWith('/api/')) throw fail(404, 'not_found');
    if (origin && !allowed) throw fail(403, 'bad_origin');
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
    if (limited('ip:' + ip, 150, 60000)) throw fail(429, 'slow_down');

    const me = authenticate(req);
    const cid = me.channelId;
    let m;

    if (req.method === 'GET' && p === '/api/state') {
      return send(res, 200, {
        ...store.view(cid, me.userId),
        you: { role: me.role, linked: !!me.userId },
        catalog: { dares: PAID_DARES, boosts: GOAL_BOOSTS, majors: MAJOR_DARES },
        aiOn: !!(cfg.geminiKey || cfg.anthropicKey),
      });
    }
    if (req.method !== 'POST') throw fail(405, 'method');
    const body = await readBody(req);

    if (p === '/api/dares') {
      await submit(me, 'dare', body.text, (d) => store.addDare(cid, d));
    } else if (p === '/api/questions') {
      await submit(me, 'question', body.text, (q) => store.addQuestion(cid, q));
    } else if ((m = p.match(/^\/api\/(dares|questions)\/([a-f0-9]+)\/vote$/))) {
      needUser(me);
      if (limited(`vote:${cid}:${me.userId}`, 30, 60000)) throw fail(429, 'rate_limited');
      store.toggleVote(cid, m[1], m[2], me.userId);
    } else if ((m = p.match(/^\/api\/(dares|questions)\/([a-f0-9]+)\/status$/))) {
      needStreamer(me);
      store.setStatus(cid, m[1], m[2], body.status);
    } else if (p === '/api/goal') {
      needStreamer(me);
      store.setGoal(cid, body.goalId);
    } else if (p === '/api/bits/receipt') {
      needUser(me);
      creditBits(me, body.receipt);
    } else throw fail(404, 'not_found');

    changed(cid);
    return send(res, 200, { ok: true });
  }

  // A viewer used Bits: Twitch gives the page a signed receipt, we verify it and create the dare.
  function creditBits(me, receipt) {
    let data;
    if (cfg.devMode && String(receipt).startsWith('dev-receipt:')) {
      const [, sku, bits, tx] = receipt.split(':');
      data = { transactionId: tx, userId: me.userId, product: { sku, cost: { amount: Number(bits) } } };
    } else {
      let payload;
      try { payload = verify(receipt, cfg.secret); } catch { throw fail(400, 'bad_receipt'); }
      data = payload.data;
    }
    if (!data || !data.product || String(data.userId) !== String(me.userId)) throw fail(403, 'receipt_mismatch');
    const sku = data.product.sku;
    const dare = PAID_DARES.find((d) => d.sku === sku);
    const boost = GOAL_BOOSTS.find((b) => b.sku === sku);
    if (!dare && !boost) throw fail(400, 'unknown_product');
    const bits = Number(data.product.cost && data.product.cost.amount) || (dare || boost).bits;
    if (!store.markTx(me.channelId, String(data.transactionId))) return; // already counted
    if (dare) {
      twitch.displayName(cfg, me.userId).then((userName) => { store.addDare(me.channelId, { text: dare.text, userId: me.userId, userName, paid: true, bits, major: false }); changed(me.channelId); });
    }
    store.addGoalBits(me.channelId, bits);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!e.status) console.error(e);
      const known = ['not_found', 'closed', 'bad_status', 'bad_goal', 'queue_full'];
      const status = e.status || (known.includes(e.message) ? 400 : 500);
      send(res, status, { error: e.status || known.includes(e.message) ? e.message : 'server_error', reason: e.reason });
    });
  });
  server.store = store;
  return server;
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function aiOptions(cfg) {
  if (cfg.geminiKey) return { provider: 'gemini', apiKey: cfg.geminiKey, model: cfg.geminiModel };
  return { provider: 'anthropic', apiKey: cfg.anthropicKey };
}

function configFromEnv(env = process.env) {
  return {
    secret: env.EXTENSION_SECRET, clientId: env.EXTENSION_CLIENT_ID, ownerId: env.EXTENSION_OWNER_ID, ownerLogin: env.EXTENSION_OWNER_LOGIN,
    clientSecret: env.TWITCH_CLIENT_SECRET, anthropicKey: env.ANTHROPIC_API_KEY,
    geminiKey: env.GEMINI_API_KEY, geminiModel: env.GEMINI_MODEL || 'gemini-3.5-flash',
    dataFile: env.DATA_FILE, devMode: env.DEV_MODE === 'true',
  };
}

if (require.main === module) {
  const cfg = configFromEnv();
  if (!cfg.secret && !cfg.devMode) console.warn('WARNING: EXTENSION_SECRET is not set. Every request will be rejected.');
  if (cfg.devMode) console.warn('WARNING: DEV_MODE is on. Never use this online.');
  if (!cfg.geminiKey && !cfg.anthropicKey) console.warn('Note: no GEMINI_API_KEY set. Using local safety rules only.');
  const port = process.env.PORT || 8080;
  createServer(cfg).listen(port, () => console.log('ChallengeLive backend running on port ' + port));
}

module.exports = { createServer, configFromEnv };
