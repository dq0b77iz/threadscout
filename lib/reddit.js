// Reddit API client (official OAuth API). Falls back to demo data when no credentials are set.
import * as mock from './mock.js';

const UA = process.env.REDDIT_USER_AGENT || `web:threadscout:1.0 (by /u/${process.env.REDDIT_USERNAME || 'unknown'})`;
const tokens = { user: null, app: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const hasReadCreds = () => !!(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
export const hasPostCreds = () => hasReadCreds() && !!(process.env.REDDIT_USERNAME && process.env.REDDIT_PASSWORD);
// 'api' = your own approved Reddit app, 'websearch' = Claude web search (default since Reddit closed new API access),
// 'demo' = sample data, no keys at all.
export const mode = () => (hasReadCreds() ? 'api' : process.env.ANTHROPIC_API_KEY ? 'websearch' : 'demo');
export const isDemo = () => mode() === 'demo';
export const canTrack = () => mode() !== 'websearch';

// kind 'user' = logged in as your account (needed to post); 'app' = anonymous view (used to detect removals).
async function getToken(kind) {
  if (kind === 'user' && !hasPostCreds()) kind = 'app';
  const t = tokens[kind];
  if (t && Date.now() < t.exp - 60_000) return t.value;
  const body = kind === 'user'
    ? new URLSearchParams({ grant_type: 'password', username: process.env.REDDIT_USERNAME, password: process.env.REDDIT_PASSWORD })
    : new URLSearchParams({ grant_type: 'client_credentials' });
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString('base64'),
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`Reddit auth failed (${res.status}): ${j.error || ''} ${j.message || ''}`.trim());
  tokens[kind] = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

async function api(pathname, { method = 'GET', form, as = 'user', tries = 3 } = {}) {
  const t = await getToken(as);
  const res = await fetch('https://oauth.reddit.com' + pathname, {
    method,
    headers: {
      Authorization: 'Bearer ' + t,
      'User-Agent': UA,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const remaining = Number(res.headers.get('x-ratelimit-remaining'));
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (res.status === 429 && tries > 1) {
    await sleep(((reset || 5) + 1) * 1000);
    return api(pathname, { method, form, as, tries: tries - 1 });
  }
  if (!res.ok) throw new Error(`Reddit ${method} ${pathname.split('?')[0]} -> ${res.status}`);
  if (!Number.isNaN(remaining) && remaining < 3 && reset) await sleep((reset + 1) * 1000);
  return res.json();
}

function mapPost(d) {
  return {
    redditId: d.name,
    subreddit: d.subreddit,
    title: d.title,
    body: (d.selftext || '').slice(0, 4000),
    author: d.author,
    url: 'https://www.reddit.com' + d.permalink,
    createdUtc: d.created_utc,
    numComments: d.num_comments,
    score: d.score,
    locked: !!d.locked,
    archived: !!d.archived,
    over18: !!d.over_18,
  };
}

export async function search(q, { timeRange = 'week', limit = 25, subreddit } = {}) {
  if (isDemo()) return mock.search(q, { subreddit });
  const base = subreddit ? `/r/${encodeURIComponent(subreddit)}/search?restrict_sr=1&` : '/search?';
  const j = await api(`${base}q=${encodeURIComponent(q)}&sort=new&t=${timeRange}&limit=${limit}&type=link&raw_json=1`, { as: 'app' });
  return (j.data?.children || []).filter((c) => c.kind === 't3').map((c) => mapPost(c.data));
}

export async function subredditInfo(sub) {
  if (isDemo()) return mock.subredditInfo(sub);
  if (!hasReadCreds()) return { rules: [], subscribers: null, description: '' };
  const [rules, about] = await Promise.all([
    api(`/r/${encodeURIComponent(sub)}/about/rules?raw_json=1`, { as: 'app' }).catch(() => ({ rules: [] })),
    api(`/r/${encodeURIComponent(sub)}/about?raw_json=1`, { as: 'app' }).catch(() => null),
  ]);
  return {
    rules: (rules.rules || []).map((r) => ({ name: r.short_name, desc: (r.description || '').slice(0, 600) })),
    subscribers: about?.data?.subscribers ?? null,
    description: about?.data?.public_description || '',
  };
}

export async function topComments(postFullname, limit = 8) {
  if (isDemo()) return mock.topComments();
  if (!hasReadCreds()) return [];
  const id = postFullname.replace(/^t3_/, '');
  const j = await api(`/comments/${id}?limit=${limit}&depth=1&sort=top&raw_json=1`, { as: 'app' });
  return (j[1]?.data?.children || [])
    .filter((c) => c.kind === 't1')
    .map((c) => ({ author: c.data.author, body: (c.data.body || '').slice(0, 700), score: c.data.score }));
}

export async function postComment(thingId, text, threadUrl) {
  if (!hasPostCreds()) {
    if (isDemo()) return mock.postComment(thingId, threadUrl);
    throw new Error('No Reddit API access, so post by hand: use "Copy & open thread", then paste your comment link.');
  }
  const j = await api('/api/comment', { method: 'POST', form: { api_type: 'json', thing_id: thingId, text }, tries: 1 });
  const errs = j.json?.errors || [];
  if (errs.length) throw new Error(errs.map((e) => e.slice(0, 2).join(': ')).join('; '));
  const c = j.json?.data?.things?.[0]?.data || {};
  const commentId = c.name || (c.id ? 't1_' + c.id : null);
  const permalink = c.permalink
    ? 'https://www.reddit.com' + c.permalink
    : `${threadUrl.replace(/\/$/, '')}/${(commentId || '').replace('t1_', '')}/`;
  return { commentId, permalink };
}

// Checks comments as a logged-out viewer so mod removals show up as "[removed]".
export async function commentStatus(fullnames) {
  if (!fullnames.length) return [];
  if (isDemo()) return mock.commentStatus(fullnames);
  if (!hasReadCreds()) return [];
  const out = [];
  for (let i = 0; i < fullnames.length; i += 100) {
    const j = await api(`/api/info?id=${fullnames.slice(i, i + 100).join(',')}&raw_json=1`, { as: 'app' });
    for (const c of j.data?.children || []) {
      const d = c.data;
      const removed = d.body === '[removed]' || !!d.removed_by_category || d.banned_by;
      const deleted = d.body === '[deleted]' || d.author === '[deleted]';
      out.push({ commentId: d.name, score: d.score, status: removed ? 'removed' : deleted ? 'deleted' : 'live' });
    }
  }
  return out;
}

export function parseCommentLink(link) {
  const m = String(link).match(/comments\/([a-z0-9]+)\/[^/]*\/([a-z0-9]+)/i);
  return m ? 't1_' + m[2] : null;
}
