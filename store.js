'use strict';
// All channel data lives here: dares, votes, questions, community goal. Pure logic, easy to test.
const crypto = require('node:crypto');
const { MAJOR_DARES } = require('./catalog');

const newId = () => crypto.randomBytes(5).toString('hex');
const DARE_STATUSES = ['accepted', 'rejected', 'skipped', 'completed', 'removed'];
const QUESTION_STATUSES = ['answered', 'removed'];
const isLive = (d) => d.status === 'open' || d.status === 'accepted';

class Store {
  constructor() { this.channels = new Map(); }

  ch(cid) {
    if (!this.channels.has(cid)) {
      this.channels.set(cid, { id: cid, version: 0, dares: [], questions: [], seenTx: [], goalId: MAJOR_DARES[0].id, goalBits: 0, goalUnlocked: false });
    }
    return this.channels.get(cid);
  }
  bump(c) { c.version += 1; }
  find(c, kind, id) {
    const item = c[kind].find((x) => x.id === id);
    if (!item) throw new Error('not_found');
    return item;
  }
  trim(c) {
    for (const kind of ['dares', 'questions']) {
      const finished = c[kind].filter((x) => (kind === 'dares' ? !isLive(x) : x.status !== 'open'));
      if (finished.length > 100) {
        const drop = new Set(finished.slice(0, finished.length - 100).map((x) => x.id));
        c[kind] = c[kind].filter((x) => !drop.has(x.id));
      }
    }
  }

  addDare(cid, d) {
    const c = this.ch(cid);
    if (!d.major && c.dares.filter(isLive).length >= 40) throw new Error('queue_full');
    const dare = { id: newId(), text: d.text, userId: d.userId || '', userName: d.userName || 'Viewer', paid: !!d.paid, bits: d.bits || 0, major: !!d.major, status: 'open', voters: [], at: Date.now() };
    c.dares.push(dare); this.trim(c); this.bump(c);
    return dare;
  }
  addQuestion(cid, q) {
    const c = this.ch(cid);
    if (c.questions.filter((x) => x.status === 'open').length >= 40) throw new Error('queue_full');
    const item = { id: newId(), text: q.text, userId: q.userId, userName: q.userName, status: 'open', voters: [], at: Date.now() };
    c.questions.push(item); this.trim(c); this.bump(c);
    return item;
  }
  toggleVote(cid, kind, id, userId) {
    const c = this.ch(cid);
    const it = this.find(c, kind, id);
    if (!(kind === 'dares' ? isLive(it) : it.status === 'open')) throw new Error('closed');
    const i = it.voters.indexOf(userId);
    if (i >= 0) it.voters.splice(i, 1); else it.voters.push(userId);
    this.bump(c);
    return it;
  }
  setStatus(cid, kind, id, status) {
    if (!(kind === 'dares' ? DARE_STATUSES : QUESTION_STATUSES).includes(status)) throw new Error('bad_status');
    const c = this.ch(cid);
    this.find(c, kind, id).status = status;
    this.bump(c);
  }
  // returns false if this Bits transaction was already counted (stops double-crediting)
  markTx(cid, txId) {
    const c = this.ch(cid);
    if (c.seenTx.includes(txId)) return false;
    c.seenTx.push(txId);
    if (c.seenTx.length > 500) c.seenTx.shift();
    return true;
  }
  addGoalBits(cid, bits) {
    const c = this.ch(cid);
    c.goalBits += bits;
    const g = MAJOR_DARES.find((m) => m.id === c.goalId);
    let unlocked = false;
    if (!c.goalUnlocked && c.goalBits >= g.target) {
      c.goalUnlocked = true; unlocked = true;
      this.addDare(cid, { text: g.text, userName: 'Community Goal', major: true });
    }
    this.bump(c);
    return unlocked;
  }
  setGoal(cid, goalId) {
    if (!MAJOR_DARES.some((m) => m.id === goalId)) throw new Error('bad_goal');
    const c = this.ch(cid);
    if (c.goalUnlocked) { c.goalBits = 0; c.goalUnlocked = false; }
    c.goalId = goalId;
    this.addGoalBits(cid, 0);
  }

  view(cid, userId) {
    const c = this.ch(cid);
    const g = MAJOR_DARES.find((m) => m.id === c.goalId);
    const map = (x) => ({ id: x.id, text: x.text, userName: x.userName, paid: !!x.paid, bits: x.bits || 0, major: !!x.major, status: x.status, votes: x.voters.length, voted: !!userId && x.voters.includes(userId) });
    const rank = { accepted: 0, open: 1 };
    const live = c.dares.filter(isLive).sort((a, b) => (rank[a.status] - rank[b.status]) || (b.major - a.major) || (b.paid - a.paid) || (b.voters.length - a.voters.length) || (a.at - b.at));
    const done = c.dares.filter((x) => x.status === 'completed').slice(-5).reverse();
    const qOpen = c.questions.filter((x) => x.status === 'open').sort((a, b) => (b.voters.length - a.voters.length) || (a.at - b.at));
    const qDone = c.questions.filter((x) => x.status === 'answered').slice(-5).reverse();
    return {
      version: c.version,
      goal: { id: g.id, title: g.title, text: g.text, target: g.target, current: Math.min(c.goalBits, g.target), unlocked: c.goalUnlocked },
      dares: live.concat(done).map(map),
      questions: qOpen.concat(qDone).map(map),
    };
  }

  toJSON() { return { channels: [...this.channels.values()] }; }
  load(data) { for (const c of (data && data.channels) || []) this.channels.set(c.id, c); }
}

module.exports = { Store };
