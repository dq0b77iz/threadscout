// Demo data so the app runs end to end with no API keys. Nothing here touches Reddit.
const SUBS = ['SaaS', 'smallbusiness', 'Entrepreneur', 'software', 'productivity', 'startups', 'webdev', 'sysadmin'];
const TEMPLATES = [
  ['Any good tool for {q}?', "We've been doing this by hand in spreadsheets and it's eating hours every week. Looking for something simple, ideally cheap. What do you all use?"],
  ['Recommendations for {q} that actually works', 'Tried two popular options and both were bloated and overpriced. Team of 5. Open to anything.'],
  ['Frustrated with my current {q} setup', "Our current tool keeps breaking and support takes days to answer. Thinking of switching, what's worked for you?"],
  ['Is there an alternative for {q}?', "The big name in this space just raised prices 40%. Need something similar that won't break the bank."],
  ['How do you handle {q}?', 'Curious how other small teams deal with this. Any workflows or apps you swear by?'],
  ['Show off your weekend project', 'Share what you built this weekend! Unrelated to anything specific.'],
];
let counter = 0;

export function search(q, { subreddit } = {}) {
  const now = Date.now() / 1000;
  return TEMPLATES.slice(0, 4 + (q.length % 3)).map((t, i) => {
    counter++;
    const sub = subreddit || SUBS[(q.length + i) % SUBS.length];
    const id = 't3_demo' + Math.abs(hash(q + i)).toString(36);
    return {
      redditId: id,
      subreddit: sub,
      title: t[0].replace('{q}', q),
      body: t[1],
      author: 'demo_user_' + ((counter * 7) % 97),
      url: `https://www.reddit.com/r/${sub}/comments/${id.slice(3)}/demo_thread/`,
      createdUtc: now - ((i + 1) * 3600 * 7),
      numComments: (i * 5) % 23,
      score: (i * 13) % 40,
      locked: false,
      archived: false,
      over18: false,
    };
  });
}

export function subredditInfo(sub) {
  const strict = ['startups', 'webdev'].includes(sub);
  return {
    rules: [
      { name: 'Be civil', desc: 'No harassment.' },
      strict
        ? { name: 'No self-promotion', desc: 'Do not promote your own product or link to it.' }
        : { name: 'Self-promotion must be disclosed', desc: 'You may mention your product when relevant if you disclose your affiliation. No spam.' },
    ],
    subscribers: 10000 + hash(sub) % 900000,
    description: `Demo community r/${sub}`,
  };
}

export function topComments() {
  return [
    { author: 'helper1', body: "I've used a few. Most are fine but pricing is the killer.", score: 12 },
    { author: 'helper2', body: 'Following, same problem here.', score: 4 },
  ];
}

export function postComment(thingId, threadUrl) {
  const cid = 'demo' + Math.random().toString(36).slice(2, 8);
  return { commentId: 't1_' + cid, permalink: threadUrl.replace(/\/$/, '') + '/' + cid + '/' };
}

export function commentStatus(fullnames) {
  return fullnames.map((f) => ({ commentId: f, score: 1 + (hash(f) % 9), status: hash(f) % 11 === 0 ? 'removed' : 'live' }));
}

function hash(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}
