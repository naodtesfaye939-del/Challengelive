'use strict';
// Minimal HS256 JWT helper. Twitch signs every Extension request with your Extension Secret.
const crypto = require('node:crypto');

const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function sign(payload, secretB64) {
  const body = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}`;
  const sig = crypto.createHmac('sha256', Buffer.from(secretB64, 'base64')).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token, secretB64) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !secretB64) throw new Error('bad_token');
  const [h, p, s] = parts;
  if (JSON.parse(Buffer.from(h, 'base64url').toString()).alg !== 'HS256') throw new Error('bad_alg');
  const expected = crypto.createHmac('sha256', Buffer.from(secretB64, 'base64')).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new Error('bad_signature');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (payload.exp && payload.exp < Date.now() / 1000) throw new Error('expired');
  return payload;
}

module.exports = { sign, verify };
