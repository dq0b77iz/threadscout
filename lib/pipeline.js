// Discovery -> scoring -> drafting -> posting -> tracking -> reporting.
import * as reddit from './reddit.js';
import * as ai from './ai.js';
import * as websearch from './websearch.js';
import { getDb, save, newId, log } from './store.js';

const DAY = 86_400_000;
const running = new Set();

export const defaults = {
  minFit: 70,
  maxAgeDays: 7,
  draftsPerScan: 10,
  dailyCap: 8,
  minGapMinutes: 20,
  subCooldownHours: 48,
  scanEveryHours: 6,
  skipDisallowed: true,
  targetReplies: 50,
  campaignDays: 7,
  searchesPerScan: 10,
};

export function settings(p) {
  return { ...defaults, ...(p.settings || {}) };
}

async function rulesFor(sub) {
  const db = getDb();
  const c = db.rulesCache[sub.toLowerCase()];
  if (c && Date.now() - c.at < DAY) return c.info;
  const info = await reddit.subredditInfo(sub).catch(() => ({ rules: [], subscribers: null }));
  db.rulesCache[sub.toLowerCase()] = { at: Date.now(), info };
  save();
  return info;
}

export async function ensurePlan(p, force = false) {
  if (p.plan && !force) return p.plan;
  p.plan = await ai.planSearch(p);
  p.plan.generatedAt = Date.now();
  save();
  log(p.id, `Search plan ready: ${p.plan.queries.length} queries, ${p.plan.subreddits.length} subreddits.`);
  return p.plan;
}

export async function scan(p) {
  if (running.has(p.id)) throw new Error('A scan is already running for this project.');
  running.add(p.id);
  const db = getDb();
  const s = settings(p);
  try {
    const plan = await ensurePlan(p);
    const queries = [...new Set([...(plan.queries || []), ...splitList(p.extraKeywords)])].slice(0, 20);
    const subs = [...new Set([...splitList(p.subreddits), ...(plan.subreddits || [])])].slice(0, 12);
    const exclude = new Set(splitList(p.excludeSubreddits).map((x) => x.toLowerCase()));
    const negatives = [...(plan.negativeKeywords || []), ...splitList(p.negativeKeywords)].map((x) => x.toLowerCase());
    const seen = new Set(db.threads.filter((t) => t.projectId === p.id).map((t) => t.redditId));
    const minCreated = Date.now() / 1000 - s.maxAgeDays * 86400;

    log(p.id, `Scanning ${queries.length} queries across Reddit and ${subs.length} focus subreddits...`);
    const found = new Map();
    const add = (list) => list.forEach((t) => found.set(t.redditId, t));
    if (reddit.mode() === 'websearch') {
      const r = await websearch.discover(p, queries, { maxAgeDays: s.maxAgeDays, maxSearches: s.searchesPerScan, subreddits: subs });
      add(r.threads);
      db.meta.webSearches = (db.meta.webSearches || 0) + r.searches;
      log(p.id, `Web search used ${r.searches} searches (about $${(r.searches * 0.01).toFixed(2)}).`);
    } else {
      for (const q of queries) add(await reddit.search(q, { timeRange: s.maxAgeDays <= 1 ? 'day' : s.maxAgeDays <= 7 ? 'week' : 'month' }).catch(err => (log(p.id, `Search "${q}" failed: ${err.message}`, 'warn'), [])));
      for (const sub of subs) for (const q of queries.slice(0, 3)) add(await reddit.search(q, { subreddit: sub }).catch(() => []));
    }

    const candidates = [...found.values()].filter((t) =>
      !seen.has(t.redditId) && !t.locked && !t.archived && !t.over18 &&
      t.createdUtc >= minCreated && !exclude.has(t.subreddit.toLowerCase()) &&
      !negatives.some((n) => `${t.title} ${t.body}`.toLowerCase().includes(n))
    ).slice(0, 60);

    log(p.id, `${found.size} posts found, ${candidates.length} new candidates after filters.`);
    if (!candidates.length) return { found: found.size, candidates: 0, qualified: 0, drafted: 0 };

    const rulesBySub = {};
    for (const sub of new Set(candidates.map((t) => t.subreddit))) rulesBySub[sub] = await rulesFor(sub);

    const scored = [];
    for (let i = 0; i < candidates.length; i += 10) {
      const batch = candidates.slice(i, i + 10);
      const scores = await ai.scoreThreads(p, batch, rulesBySub).catch((err) => {
        log(p.id, `Scoring failed: ${err.message}`, 'error');
        return batch.map(() => ({ fit: 0, intent: 'unscored', rules: 'unclear', reason: 'Scoring failed', angle: '' }));
      });
      batch.forEach((t, k) => scored.push({ ...t, ...scores[k] }));
    }

    let qualified = 0;
    for (const t of scored) {
      const ok = t.fit >= s.minFit && !(s.skipDisallowed && t.rules === 'disallowed');
      if (ok) qualified++;
      db.threads.push({
        id: newId('th_'),
        projectId: p.id,
        ...t,
        subscribers: rulesBySub[t.subreddit]?.subscribers ?? null,
        status: ok ? 'qualified' : 'filtered',
        foundAt: Date.now(),
        draft: '',
      });
    }
    save();

    const toDraft = db.threads
      .filter((t) => t.projectId === p.id && t.status === 'qualified')
      .sort((a, b) => b.fit - a.fit)
      .slice(0, s.draftsPerScan);
    let drafted = 0;
    for (const t of toDraft) {
      try {
        await draft(p, t);
        drafted++;
      } catch (err) {
        log(p.id, `Draft failed for "${t.title.slice(0, 60)}": ${err.message}`, 'error');
      }
    }
    p.lastScanAt = Date.now();
    save();
    log(p.id, `Scan done: ${qualified} qualified leads, ${drafted} replies drafted for review.`);
    return { found: found.size, candidates: candidates.length, qualified, drafted };
  } finally {
    running.delete(p.id);
  }
}

export async function draft(p, t, extra = '') {
  const info = await rulesFor(t.subreddit);
  const comments = await reddit.topComments(t.redditId).catch(() => []);
  t.draft = await ai.draftReply(p, t, info, comments, extra);
  t.status = 'review';
  t.draftedAt = Date.now();
  save();
  return t;
}

export function postingBlockers(p, t) {
  const db = getDb();
  const s = settings(p);
  const mine = db.replies.filter((r) => r.projectId === p.id);
  const today = mine.filter((r) => Date.now() - r.postedAt < DAY).length;
  if (today >= s.dailyCap) return `Daily cap reached (${s.dailyCap}/day). Change it in Setup if you need more.`;
  const gap = Date.now() - (db.meta.lastPostAt || 0);
  if (gap < s.minGapMinutes * 60_000) return `Wait ${Math.ceil((s.minGapMinutes * 60_000 - gap) / 60_000)} more min between posts (spacing protects your account).`;
  const recentSame = mine.find((r) => r.subreddit.toLowerCase() === t.subreddit.toLowerCase() && Date.now() - r.postedAt < s.subCooldownHours * 3_600_000);
  if (recentSame) return `Already replied in r/${t.subreddit} within ${s.subCooldownHours}h.`;
  if (db.replies.some((r) => r.threadId === t.id)) return 'Already replied to this thread.';
  if (splitList(p.excludeSubreddits).some((x) => x.toLowerCase() === t.subreddit.toLowerCase())) return `r/${t.subreddit} is on your never-post list.`;
  if (!t.draft?.trim()) return 'Draft is empty.';
  if (!t.draft.includes(ai.disclosureLine(p))) return 'Draft is missing the disclosure line.';
  return null;
}

export async function post(p, t, { force = false } = {}) {
  const block = postingBlockers(p, t);
  if (block && !(force && !/disclosure|Already replied to this|empty/.test(block))) throw new Error(block);
  const { commentId, permalink } = await reddit.postComment(t.redditId, t.draft, t.url);
  return recordReply(p, t, { commentId, permalink, method: 'api' });
}

export function recordReply(p, t, { commentId, permalink, method }) {
  const db = getDb();
  const r = {
    id: newId('rp_'),
    projectId: p.id,
    threadId: t.id,
    subreddit: t.subreddit,
    threadTitle: t.title,
    threadUrl: t.url,
    text: t.draft,
    commentId,
    permalink,
    method,
    postedAt: Date.now(),
    status: 'live',
    score: 1,
    checkedAt: null,
    removedAt: null,
  };
  db.replies.push(r);
  db.meta.lastPostAt = Date.now();
  t.status = 'posted';
  save();
  log(p.id, `Reply posted in r/${t.subreddit}: ${permalink}`);
  return r;
}

export async function track() {
  const db = getDb();
  const live = db.replies.filter((r) => r.status === 'live' && r.commentId && Date.now() - r.postedAt < 45 * DAY);
  if (!live.length) return { checked: 0, removed: 0 };
  if (!reddit.canTrack()) return { checked: 0, removed: 0, manual: true };
  const statuses = await reddit.commentStatus(live.map((r) => r.commentId));
  let removed = 0;
  for (const st of statuses) {
    const r = live.find((x) => x.commentId === st.commentId);
    if (!r) continue;
    r.score = st.score;
    r.checkedAt = Date.now();
    if (st.status !== 'live') {
      r.status = st.status;
      r.removedAt = Date.now();
      removed++;
      log(r.projectId, `Reply in r/${r.subreddit} was ${st.status}. It no longer counts toward the goal.`, 'warn');
    }
  }
  save();
  return { checked: statuses.length, removed };
}

export function stats(p) {
  const db = getDb();
  const s = settings(p);
  const replies = db.replies.filter((r) => r.projectId === p.id);
  const threads = db.threads.filter((t) => t.projectId === p.id);
  const verified = replies.filter((r) => r.status === 'live' && Date.now() - r.postedAt >= 72 * 3_600_000).length;
  const live = replies.filter((r) => r.status === 'live').length;
  const removed = replies.filter((r) => r.status !== 'live').length;
  const start = p.campaignStart || p.createdAt;
  return {
    found: threads.length,
    qualified: threads.filter((t) => t.status !== 'filtered').length,
    inReview: threads.filter((t) => t.status === 'review').length,
    posted: replies.length,
    live,
    verified,
    removed,
    removalRate: replies.length ? Math.round((removed / replies.length) * 100) : 0,
    upvotes: replies.reduce((a, r) => a + (r.status === 'live' ? Math.max(0, (r.score || 1) - 1) : 0), 0),
    target: s.targetReplies,
    replacementsNeeded: Math.max(0, s.targetReplies - live),
    campaignEnds: start + s.campaignDays * DAY,
    subreddits: [...new Set(replies.map((r) => r.subreddit))].length,
  };
}

export function digest(p, days = 7) {
  const db = getDb();
  const since = Date.now() - days * DAY;
  return db.threads
    .filter((t) => t.projectId === p.id && t.foundAt >= since && t.status !== 'filtered')
    .sort((a, b) => b.fit - a.fit)
    .slice(0, 25)
    .map((t) => ({ title: t.title, url: t.url, subreddit: t.subreddit, fit: t.fit, intent: t.intent, reason: t.reason, status: t.status }));
}

export async function sendDigest(p) {
  if (!process.env.SMTP_HOST || !p.digestEmail) throw new Error('Set SMTP_* in .env and a digest email in Setup.');
  const items = digest(p);
  const { default: nodemailer } = await import('nodemailer');
  const tx = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  const html = `<h2>${esc(p.name)}: Reddit threads asking for what you sell</h2><p>${items.length} threads from the last 7 days, best fit first.</p><ol>${items
    .map((i) => `<li><a href="${esc(i.url)}">${esc(i.title)}</a> <small>r/${esc(i.subreddit)} · fit ${i.fit} · ${esc(i.intent)}</small><br><small>${esc(i.reason)}</small></li>`)
    .join('')}</ol>`;
  await tx.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: p.digestEmail, subject: `${items.length} Reddit leads for ${p.name} this week`, html });
  p.lastDigestAt = Date.now();
  save();
  log(p.id, `Weekly digest sent to ${p.digestEmail}.`);
  return items.length;
}

export function startScheduler() {
  const tick = async () => {
    const db = getDb();
    for (const p of db.projects.filter((x) => x.autoScan && !x.paused)) {
      const s = settings(p);
      if (Date.now() - (p.lastScanAt || 0) >= s.scanEveryHours * 3_600_000) await scan(p).catch((e) => log(p.id, `Auto-scan failed: ${e.message}`, 'error'));
      if (p.digestEmail && process.env.SMTP_HOST && Date.now() - (p.lastDigestAt || 0) >= 7 * DAY) await sendDigest(p).catch((e) => log(p.id, `Digest failed: ${e.message}`, 'error'));
    }
    if (Date.now() - (db.meta.lastTrackAt || 0) >= 2 * 3_600_000) {
      db.meta.lastTrackAt = Date.now();
      await track().catch((e) => log(null, `Tracking failed: ${e.message}`, 'error'));
    }
  };
  setInterval(tick, 5 * 60_000);
  setTimeout(tick, 10_000);
}

export const splitList = (s) => String(s || '').split(/[,\n]/).map((x) => x.trim().replace(/^\/?r\//i, '')).filter(Boolean);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// How each community treats your replies, so you can drop the ones that remove them.
export function subredditStats(p) {
  const db = getDb();
  const by = {};
  for (const r of db.replies.filter((x) => x.projectId === p.id)) {
    const k = r.subreddit;
    by[k] ||= { subreddit: k, posted: 0, live: 0, removed: 0, score: 0 };
    by[k].posted++;
    if (r.status === 'live') { by[k].live++; by[k].score += r.score || 0; } else by[k].removed++;
  }
  const excluded = new Set(splitList(p.excludeSubreddits).map((x) => x.toLowerCase()));
  return Object.values(by)
    .map((s) => ({ ...s, avgScore: s.live ? Math.round((s.score / s.live) * 10) / 10 : 0, removalRate: Math.round((s.removed / s.posted) * 100), excluded: excluded.has(s.subreddit.toLowerCase()) }))
    .sort((a, b) => b.posted - a.posted);
}

export function exportCsv(p) {
  const rows = getDb().replies.filter((r) => r.projectId === p.id).sort((a, b) => a.postedAt - b.postedAt);
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['posted_at', 'subreddit', 'thread_title', 'thread_url', 'comment_url', 'status', 'score', 'method', 'text'];
  return [head.join(','), ...rows.map((r) => [new Date(r.postedAt).toISOString(), r.subreddit, r.threadTitle, r.threadUrl, r.permalink, r.status, r.score, r.method, r.text].map(cell).join(','))].join('\n');
}

export function setReplyStatus(r, status) {
  if (!['live', 'removed', 'deleted'].includes(status)) throw new Error('Bad status');
  r.status = status;
  r.removedAt = status === 'live' ? null : Date.now();
  r.checkedAt = Date.now();
  save();
  log(r.projectId, `Reply in r/${r.subreddit} marked ${status} by hand.`, status === 'live' ? 'info' : 'warn');
  return r;
}
