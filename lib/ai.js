// AI layer: search planning, thread scoring, reply drafting. Uses the Anthropic Messages API.
// Without ANTHROPIC_API_KEY it falls back to simple heuristics so the app still runs.

const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const FAST_MODEL = () => process.env.ANTHROPIC_FAST_MODEL || process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
export const hasAI = () => !!process.env.ANTHROPIC_API_KEY;

async function ask(system, user, { maxTokens = 1500, fast = false } = {}) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: fast ? FAST_MODEL() : MODEL(),
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  return j.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const s = fenced ? fenced[1] : text;
  const start = s.search(/[[{]/);
  const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  return JSON.parse(s.slice(start, end + 1));
}

function productBrief(p) {
  return [
    `Product name: ${p.name}`,
    `What it is / what it does: ${p.description}`,
    `Who buys it: ${p.audience || 'n/a'}`,
    `Link: ${p.url || 'n/a'}`,
    p.pricing ? `Pricing: ${p.pricing}` : '',
    p.differentiators ? `Why it's different: ${p.differentiators}` : '',
    p.competitors ? `Competitors / alternatives people mention: ${p.competitors}` : '',
  ].filter(Boolean).join('\n');
}

// 1) Turn a product description into Reddit search queries + communities.
export async function planSearch(p) {
  if (!hasAI()) return heuristicPlan(p);
  const out = await ask(
    'You plan Reddit lead discovery. Output only JSON.',
    `${productBrief(p)}

Produce search queries that would surface Reddit posts where someone is ACTIVELY looking for a product like this: asking for recommendations, looking for alternatives to a competitor, complaining about a problem this product solves, or asking "how do I do X".
Queries should be 2-5 words each, the way real people phrase posts (not marketing language). Include competitor-alternative queries if competitors are given.

Return JSON:
{"queries": [12-16 strings], "subreddits": [8-12 subreddit names without r/ where these buyers hang out and where helpful product mentions are commonly tolerated], "negativeKeywords": [5-10 words that signal an irrelevant post, e.g. jobs, hiring]}`,
    { maxTokens: 900 }
  );
  const j = parseJson(out);
  return {
    queries: (j.queries || []).slice(0, 16),
    subreddits: (j.subreddits || []).map((s) => String(s).replace(/^\/?r\//i, '')).slice(0, 12),
    negativeKeywords: (j.negativeKeywords || []).slice(0, 10),
  };
}

// 2) Score a batch of threads for buying intent, fit, and whether sub rules allow a disclosed mention.
export async function scoreThreads(p, threads, rulesBySub) {
  if (!hasAI()) return threads.map((t) => heuristicScore(p, t, rulesBySub[t.subreddit]));
  const items = threads.map((t, i) => ({
    i,
    subreddit: t.subreddit,
    title: t.title,
    body: t.body.slice(0, 1200),
    comments: t.numComments ?? 'unknown',
    rules: (rulesBySub[t.subreddit]?.rules || []).map((r) => `${r.name}: ${r.desc}`.slice(0, 300)),
  }));
  const out = await ask(
    'You qualify Reddit threads as sales leads. Be strict: most threads are NOT a fit. Output only JSON.',
    `${productBrief(p)}

For each thread below decide:
- fit: 0-100. 80+ means the poster is clearly asking for something this product does. 50-79 means related and a helpful mention would be welcome. Under 50 means irrelevant, or the product would not genuinely help.
- intent: one of "asking_for_recommendation", "seeking_alternative", "problem_complaint", "how_to", "discussion", "irrelevant".
- rules: "allowed" if the subreddit rules permit a disclosed product mention in comments, "disallowed" if they forbid self-promotion/links, "unclear" otherwise. If no rules are listed, use what you know about that subreddit's stance on self-promotion.
- reason: one short sentence.
- angle: one short sentence on how a genuinely helpful reply would approach it.

Threads:
${JSON.stringify(items, null, 1)}

Return JSON array: [{"i":0,"fit":0,"intent":"","rules":"","reason":"","angle":""}, ...] with one entry per thread.`,
    { maxTokens: 300 + threads.length * 160, fast: true }
  );
  const arr = parseJson(out);
  return threads.map((t, i) => {
    const r = arr.find((x) => x.i === i) || {};
    return {
      fit: Math.max(0, Math.min(100, Number(r.fit) || 0)),
      intent: r.intent || 'discussion',
      rules: r.rules || 'unclear',
      reason: r.reason || '',
      angle: r.angle || '',
    };
  });
}

// 3) Draft a reply that actually helps, mentions the product once, and discloses the affiliation.
export async function draftReply(p, thread, info, comments, extra = '') {
  const disclosure = disclosureLine(p);
  if (!hasAI()) return ensureDisclosure(heuristicDraft(p, thread), disclosure);
  const out = await ask(
    `You write Reddit comments for a real person who works on a product. Write like a normal, knowledgeable redditor: plain, casual, specific, no marketing words, no emojis, no headings, no bullet lists unless the post asks for a comparison. Never invent facts, reviews, customers, or numbers. Never pretend to be a neutral user.`,
    `${productBrief(p)}

Tone notes from the owner: ${p.tone || 'friendly, direct, helpful first'}

Subreddit: r/${thread.subreddit}
Subreddit rules: ${(info?.rules || []).map((r) => `${r.name}: ${r.desc}`).join(' | ').slice(0, 1500) || 'none listed'}
Post title: ${thread.title}
Post body${thread.source === 'websearch' ? ' (summary from web search)' : ''}: ${thread.body.slice(0, 2500) || '(no body)'}
Top existing comments: ${(comments || []).map((c) => `- ${c.body}`).join('\n').slice(0, 2000) || 'none'}
Suggested angle: ${thread.angle || 'answer the question directly'}
${extra ? `Extra instructions for this draft: ${extra}` : ''}

Write one comment (60-160 words) that:
1. Answers the poster's actual question first with useful advice that stands on its own, even without the product.
2. Mentions ${p.name} once, naturally, as one option, with the link ${p.url || ''} only if the subreddit rules allow links.
3. Doesn't repeat what top comments already said.
4. Ends with this exact disclosure line on its own line: "${disclosure}"

Return only the comment text.`,
    { maxTokens: 700 }
  );
  return ensureDisclosure(out.replace(/^["']|["']$/g, ''), disclosure);
}

export function disclosureLine(p) {
  return (p.disclosure || `Disclosure: I work on ${p.name}.`).trim();
}

function ensureDisclosure(text, disclosure) {
  return text.includes(disclosure) ? text.trim() : `${text.trim()}\n\n${disclosure}`;
}

// ---------- Heuristic fallbacks (no API key) ----------
const STOP = new Set('a an the and or for with to of in on is are be it that this your you we our my i at by from as tool app software platform service helps help people who'.split(' '));

function words(s) {
  return String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g)?.filter((w) => !STOP.has(w)) || [];
}

function heuristicPlan(p) {
  const kw = [...new Set(words(p.description))].slice(0, 6);
  const core = kw.slice(0, 3).join(' ') || p.name;
  const queries = [
    `best ${core}`, `${core} recommendation`, `alternative to ${(p.competitors || '').split(',')[0]?.trim() || core}`,
    `looking for ${kw[0] || core}`, `${kw[0] || core} tool`, `how to ${kw.slice(0, 2).join(' ')}`,
  ];
  return { queries: [...new Set(queries)], subreddits: ['SaaS', 'smallbusiness', 'Entrepreneur', 'software', 'productivity'], negativeKeywords: ['hiring', 'job', 'salary'] };
}

function heuristicScore(p, t, info) {
  const kw = new Set(words(`${p.description} ${p.audience} ${p.competitors}`));
  const text = words(`${t.title} ${t.body}`);
  const overlap = text.filter((w) => kw.has(w)).length;
  const asking = /\b(any|recommend|recommendation|alternative|looking for|what do you use|suggest|best)\b/i.test(t.title + ' ' + t.body);
  const fit = Math.min(95, overlap * 9 + (asking ? 45 : 10));
  const rulesText = (info?.rules || []).map((r) => r.name + ' ' + r.desc).join(' ').toLowerCase();
  const rules = /no self-promo|no promotion|do not promote|no advertising/.test(rulesText) ? 'disallowed' : /disclose|self-promotion must/.test(rulesText) ? 'allowed' : 'unclear';
  return {
    fit,
    intent: asking ? 'asking_for_recommendation' : 'discussion',
    rules,
    reason: asking ? 'Poster is asking for options (heuristic, add an API key for real scoring).' : 'Loose keyword match (heuristic).',
    angle: 'Share practical advice first, then mention the product as one option.',
  };
}

function heuristicDraft(p, t) {
  return `I'd start by writing down the two or three things you actually need day to day, since most tools in this space do the basics and differ on price and how much setup they need. Try a couple on a free plan with your real workflow for a week before committing.

If it helps, ${p.name} is one option worth a look${p.url ? ` (${p.url})` : ''}. ${p.description.split('.')[0]}.`;
}
