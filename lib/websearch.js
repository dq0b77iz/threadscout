// Thread discovery without the Reddit API.
// Reddit stopped accepting new API applications on Oct 31, 2026 and closes public API access in March 2027,
// so by default Threadscout finds threads through Claude's web search tool, restricted to reddit.com.
// Cost: $10 per 1,000 searches plus tokens (see docs/costs in the project).

const MODEL = () => process.env.ANTHROPIC_FAST_MODEL || process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';

export async function discover(p, queries, { maxAgeDays = 7, maxSearches = 10, subreddits = [] } = {}) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL(),
      max_tokens: 6000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches, allowed_domains: ['reddit.com'] }],
      messages: [{
        role: 'user',
        content: `Find recent Reddit posts (ideally from the last ${maxAgeDays} days, never older than 60 days) where someone is asking for, or would clearly benefit from, a product like this:

${p.name}: ${p.description}
Buyers: ${p.audience || 'n/a'}
${p.competitors ? `Alternatives people mention: ${p.competitors}` : ''}

Search phrases to try: ${queries.map((q) => `"${q}"`).join(', ')}
${subreddits.length ? `Communities worth checking: ${subreddits.map((s) => 'r/' + s).join(', ')}` : ''}

Only include individual post pages (URLs containing /comments/). Skip locked or archived posts if you can tell.
Return ONLY a JSON array, no other text:
[{"url": "...", "title": "...", "subreddit": "name without r/", "summary": "2-3 sentences in your own words: what the poster needs, constraints they mention, what they've tried", "ageDays": number or null}]`,
      }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic web search ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const text = j.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const searches = j.usage?.server_tool_use?.web_search_requests || 0;
  let arr = [];
  try {
    const s = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
    arr = JSON.parse(s);
  } catch {
    arr = [];
  }
  const now = Date.now() / 1000;
  const threads = arr
    .map((x) => {
      const m = String(x.url || '').match(/reddit\.com\/r\/([^/]+)\/comments\/([a-z0-9]+)/i);
      if (!m) return null;
      return {
        redditId: 't3_' + m[2].toLowerCase(),
        subreddit: x.subreddit || m[1],
        title: String(x.title || '').slice(0, 300),
        body: String(x.summary || '').slice(0, 1500),
        author: null,
        url: `https://www.reddit.com/r/${m[1]}/comments/${m[2]}/`,
        createdUtc: now - (Number(x.ageDays) >= 0 && x.ageDays !== null ? Number(x.ageDays) : maxAgeDays / 2) * 86400,
        numComments: null,
        score: null,
        locked: false,
        archived: false,
        over18: false,
        source: 'websearch',
      };
    })
    .filter(Boolean);
  return { threads, searches };
}
