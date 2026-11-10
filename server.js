import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, getDb, save, newId, token, log } from './lib/store.js';
import * as pipe from './lib/pipeline.js';
import * as reddit from './lib/reddit.js';
import * as ai from './lib/ai.js';

load();
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({ limit: '1mb' }));

// Public client report (no login): /report/<token>
app.get('/report/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'report.html')));
app.get('/api/report/:token', (req, res) => {
  const p = getDb().projects.find((x) => x.reportToken === req.params.token);
  if (!p) return res.status(404).json({ error: 'Report not found' });
  const replies = getDb().replies.filter((r) => r.projectId === p.id).sort((a, b) => b.postedAt - a.postedAt)
    .map(({ subreddit, threadTitle, threadUrl, permalink, postedAt, status, score, removedAt }) => ({ subreddit, threadTitle, threadUrl, permalink, postedAt, status, score, removedAt }));
  res.json({ name: p.name, url: p.url, stats: pipe.stats(p), replies });
});

// Everything else sits behind APP_PASSWORD (HTTP basic auth) when set.
app.use((req, res, next) => {
  const pass = process.env.APP_PASSWORD;
  if (!pass) return next();
  const [, b64] = (req.headers.authorization || '').split(' ');
  const [, given] = Buffer.from(b64 || '', 'base64').toString().split(':');
  if (given === pass) return next();
  res.set('WWW-Authenticate', 'Basic realm="Threadscout"').status(401).send('Login required');
});
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));
const proj = (id) => {
  const p = getDb().projects.find((x) => x.id === id);
  if (!p) throw new Error('Project not found');
  return p;
};
const thread = (id) => {
  const t = getDb().threads.find((x) => x.id === id);
  if (!t) throw new Error('Thread not found');
  return t;
};

const FIELDS = ['name', 'description', 'audience', 'url', 'pricing', 'differentiators', 'competitors', 'tone', 'disclosure',
  'subreddits', 'excludeSubreddits', 'extraKeywords', 'negativeKeywords', 'digestEmail', 'autoScan', 'paused'];
const pick = (b) => Object.fromEntries(FIELDS.filter((f) => f in b).map((f) => [f, b[f]]));

app.get('/api/status', (req, res) => res.json({
  ai: ai.hasAI(), redditRead: reddit.hasReadCreds(), redditPost: reddit.hasPostCreds(), demo: reddit.isDemo(), mode: reddit.mode(), canTrack: reddit.canTrack(),
  smtp: !!process.env.SMTP_HOST, redditUser: process.env.REDDIT_USERNAME || null, defaults: pipe.defaults,
}));

app.get('/api/projects', (req, res) => res.json(getDb().projects.map((p) => ({ ...p, stats: pipe.stats(p) }))));

app.post('/api/projects', wrap(async (req, res) => {
  const b = pick(req.body);
  if (!b.name || !b.description) throw new Error('Name and description are required.');
  const p = { id: newId('pr_'), createdAt: Date.now(), campaignStart: Date.now(), reportToken: token(), autoScan: true, settings: {}, ...b };
  getDb().projects.push(p);
  save();
  log(p.id, `Project "${p.name}" created.`);
  res.json(p);
}));

app.put('/api/projects/:id', wrap(async (req, res) => {
  const p = proj(req.params.id);
  Object.assign(p, pick(req.body));
  if (req.body.settings) p.settings = { ...p.settings, ...numberize(req.body.settings) };
  if (req.body.plan) p.plan = req.body.plan;
  if (req.body.restartCampaign) p.campaignStart = Date.now();
  save();
  res.json(p);
}));

app.delete('/api/projects/:id', wrap(async (req, res) => {
  const db = getDb();
  db.projects = db.projects.filter((x) => x.id !== req.params.id);
  db.threads = db.threads.filter((x) => x.projectId !== req.params.id);
  db.replies = db.replies.filter((x) => x.projectId !== req.params.id);
  save();
  res.json({ ok: true });
}));

app.post('/api/projects/:id/plan', wrap(async (req, res) => res.json(await pipe.ensurePlan(proj(req.params.id), true))));
app.post('/api/projects/:id/scan', wrap(async (req, res) => res.json(await pipe.scan(proj(req.params.id)))));

app.get('/api/projects/:id/threads', wrap(async (req, res) => {
  const list = getDb().threads.filter((t) => t.projectId === req.params.id && (!req.query.status || req.query.status.split(',').includes(t.status)));
  res.json(list.sort((a, b) => b.fit - a.fit || b.createdUtc - a.createdUtc).slice(0, 300));
}));

app.get('/api/projects/:id/replies', wrap(async (req, res) => {
  res.json(getDb().replies.filter((r) => r.projectId === req.params.id).sort((a, b) => b.postedAt - a.postedAt));
}));

app.post('/api/threads/:id/draft', wrap(async (req, res) => {
  const t = thread(req.params.id);
  res.json(await pipe.draft(proj(t.projectId), t, req.body?.instructions || ''));
}));

app.put('/api/threads/:id', wrap(async (req, res) => {
  const t = thread(req.params.id);
  if (typeof req.body.draft === 'string') t.draft = req.body.draft;
  if (['skipped', 'review', 'qualified'].includes(req.body.status)) t.status = req.body.status;
  save();
  res.json(t);
}));

app.get('/api/threads/:id/check', wrap(async (req, res) => {
  const t = thread(req.params.id);
  res.json({ blocker: pipe.postingBlockers(proj(t.projectId), t) });
}));

app.post('/api/threads/:id/post', wrap(async (req, res) => {
  const t = thread(req.params.id);
  if (typeof req.body?.draft === 'string') t.draft = req.body.draft;
  res.json(await pipe.post(proj(t.projectId), t, { force: !!req.body?.force }));
}));

// For people who post by hand from their own account: paste the comment link to track it.
app.post('/api/threads/:id/mark-posted', wrap(async (req, res) => {
  const t = thread(req.params.id);
  const link = String(req.body?.permalink || '').trim();
  const commentId = reddit.parseCommentLink(link);
  if (!commentId) throw new Error('Paste the link to your comment (use "Share > Copy link" on the comment).');
  res.json(pipe.recordReply(proj(t.projectId), t, { commentId, permalink: link, method: 'manual' }));
}));

app.put('/api/replies/:id', wrap(async (req, res) => {
  const r = getDb().replies.find((x) => x.id === req.params.id);
  if (!r) throw new Error('Reply not found');
  res.json(pipe.setReplyStatus(r, req.body?.status));
}));

app.post('/api/track', wrap(async (req, res) => res.json(await pipe.track())));
app.get('/api/projects/:id/digest', wrap(async (req, res) => res.json(pipe.digest(proj(req.params.id)))));
app.post('/api/projects/:id/digest/send', wrap(async (req, res) => res.json({ sent: await pipe.sendDigest(proj(req.params.id)) })));
app.get('/api/projects/:id/subreddits', wrap(async (req, res) => res.json(pipe.subredditStats(proj(req.params.id)))));
app.post('/api/projects/:id/exclude', wrap(async (req, res) => {
  const p = proj(req.params.id);
  const sub = String(req.body?.subreddit || '').replace(/^\/?r\//i, '').trim();
  if (!sub) throw new Error('No subreddit given.');
  const list = pipe.splitList(p.excludeSubreddits);
  if (!list.some((x) => x.toLowerCase() === sub.toLowerCase())) list.push(sub);
  p.excludeSubreddits = list.join(', ');
  save();
  log(p.id, `r/${sub} added to the never-post list.`);
  res.json(p);
}));
app.get('/api/projects/:id/export.csv', wrap(async (req, res) => {
  const p = proj(req.params.id);
  res.set('Content-Type', 'text/csv').set('Content-Disposition', `attachment; filename="${p.name.replace(/[^a-z0-9]+/gi, '-')}-replies.csv"`).send(pipe.exportCsv(p));
}));
app.get('/api/log', (req, res) => res.json(getDb().log.filter((l) => !req.query.project || l.projectId === req.query.project).slice(0, 200)));

function numberize(o) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' && v.trim() !== '' && !isNaN(v) ? Number(v) : v]));
}

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Threadscout running on http://localhost:${PORT}`);
  console.log(`Thread discovery: ${reddit.mode()}`);
  if (!ai.hasAI()) console.log('No ANTHROPIC_API_KEY: using heuristic scoring and template drafts.');
  pipe.startScheduler();
});
