'use strict';
// Talks to Twitch: (1) realtime broadcast to every viewer of a channel, (2) looks up usernames.
const { sign } = require('./jwt');

async function broadcast(cfg, channelId, message) {
  const ownerId = await resolveOwnerId(cfg);
  if (!cfg.secret || !cfg.clientId || !ownerId) return; // not configured (local testing)
  const jwt = sign({ exp: Math.floor(Date.now() / 1000) + 60, role: 'external', channel_id: channelId, user_id: ownerId, pubsub_perms: { send: ['broadcast'] } }, cfg.secret);
  const r = await fetch('https://api.twitch.tv/helix/extensions/pubsub', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + jwt, 'Client-Id': cfg.clientId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: ['broadcast'], broadcaster_id: channelId, is_global_broadcast: false, message: JSON.stringify(message) }),
  });
  if (!r.ok) console.error('Twitch broadcast failed:', r.status);
}

let appToken = null; let appTokenExp = 0;
const names = new Map();

async function getAppToken(cfg) {
  if (!appToken || Date.now() > appTokenExp) {
    const t = await (await fetch(`https://id.twitch.tv/oauth2/token?client_id=${cfg.clientId}&client_secret=${cfg.clientSecret}&grant_type=client_credentials`, { method: 'POST' })).json();
    if (!t.access_token) throw new Error('no_app_token');
    appToken = t.access_token; appTokenExp = Date.now() + (t.expires_in - 300) * 1000;
  }
  return appToken;
}

// The owner's numeric Twitch ID: use EXTENSION_OWNER_ID if given, otherwise look it up once from EXTENSION_OWNER_LOGIN.
let ownerCache = { login: '', id: '' };
async function resolveOwnerId(cfg) {
  if (cfg.ownerId) return cfg.ownerId;
  const login = String(cfg.ownerLogin || '').trim().toLowerCase();
  if (!login || !cfg.clientId || !cfg.clientSecret) return '';
  if (ownerCache.login === login && ownerCache.id) return ownerCache.id;
  try {
    const token = await getAppToken(cfg);
    const u = await (await fetch('https://api.twitch.tv/helix/users?login=' + encodeURIComponent(login), { headers: { Authorization: 'Bearer ' + token, 'Client-Id': cfg.clientId } })).json();
    const id = u.data && u.data[0] && u.data[0].id;
    if (id) { ownerCache = { login, id }; return id; }
    console.error('owner lookup: no Twitch user found for login', login);
  } catch (e) { console.error('owner lookup failed:', e.message); }
  return '';
}

async function displayName(cfg, userId) {
  const fallback = 'Viewer' + String(userId).slice(-4);
  if (names.has(userId)) return names.get(userId);
  if (!cfg.clientId || !cfg.clientSecret) return fallback;
  try {
    const token = await getAppToken(cfg);
    const u = await (await fetch('https://api.twitch.tv/helix/users?id=' + encodeURIComponent(userId), { headers: { Authorization: 'Bearer ' + token, 'Client-Id': cfg.clientId } })).json();
    const name = u.data && u.data[0] && u.data[0].display_name;
    if (name) { names.set(userId, name); return name; }
  } catch (e) { console.error('name lookup failed:', e.message); }
  return fallback;
}

module.exports = { broadcast, displayName, resolveOwnerId };
