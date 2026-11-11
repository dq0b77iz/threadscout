# Threadscout

A self-hosted tool that finds Reddit threads where people are asking for what you sell, scores them with AI, drafts a helpful reply that discloses your affiliation, lets you approve and post it, and tracks whether it stays up.

## What it does

- **Finds the right threads:** AI turns your product description into search phrases, target subreddits and ignore-words, then scans Reddit on a schedule.
- **Writes for each community:** drafts read the post, the top comments and the subreddit's rules before writing.
- **Respects the rules:** every thread gets a rules check (allowed / disallowed / unclear), and subreddits that ban promotion are skipped by default.
- **Always discloses:** the disclosure line is enforced, so a reply can't be posted without it.
- **Live report page:** a public, read-only `/report/<token>` page with no login.
- **Removal tracking:** one-click "Mark removed", plus automatic checks every 2 hours if you have Reddit API access.
- **Verified replies:** a reply counts as "Verified" after 72 hours up, with a live-vs-goal tracker and campaign end date.
- **Weekly leads email:** a weekly digest of the best threads, by email or as an in-app preview.

Also included:

- Fit score (0-100), buyer-intent label and suggested angle for every thread
- Review queue: edit, rewrite with instructions ("shorter, mention the free plan"), skip, or post
- Copy-paste posting with link tracking (or one-click API posting if you have Reddit API access)
- Account-safety pacing: daily cap, minimum gap between posts, per-subreddit cooldown
- Per-community results (posted, live, removed, avg score) with a one-click "never post here"
- CSV export of every reply
- Multiple products/projects in one dashboard, optional password protection

## Run it

Needs Node 22+.

```bash
npm install
cp .env.example .env   # optional, see below
npm start              # http://localhost:3000
```

With no keys it runs in **demo mode**: sample threads, template drafts, simulated posting. Useful for clicking around.

To go live, the only thing you need is `ANTHROPIC_API_KEY` (console.anthropic.com) in `.env`.

**Reddit API note:** Reddit stopped accepting new API applications on October 31, 2026 and closes its public API in March 2027. So by default Threadscout finds threads with Claude's web search (limited to reddit.com, ~$0.01 per search), and you post replies by hand from a logged-in account: "Copy & open thread", paste, then paste your comment link back to track it. Removals are marked by hand ("Mark removed"). If you ever get a Reddit commercial agreement, set `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` (plus `REDDIT_USERNAME` / `REDDIT_PASSWORD` for posting) and the app switches to the API, with automatic removal checks and one-click posting.

Optional:

- **Digest email (optional)**: `SMTP_*` settings, then add a digest email in the project's Setup tab.
- **Lock the dashboard**: set `APP_PASSWORD` if it's on a public server. Report pages stay public.

## How to use it

1. **New project**: describe the product, who buys it, competitors, tone and disclosure line.
2. **Find threads now**: builds the search plan, scans, scores, and drafts replies for the best fits.
3. **Review**: edit each draft, then Post reply (or Copy & open thread, post it yourself, and paste the comment link).
4. **Posted & report**: watch live/removed counts, share the report link, drop communities that remove you.

Auto-scan runs every 6 hours by default. Tune pacing and goals under Setup.

## Staying on the right side of Reddit

Reddit's rules and most subreddits allow product mentions only when they're relevant, disclosed and not spammy. Keep the daily cap low on new accounts, post from an account with real history, and skip threads where you wouldn't genuinely help. The app doesn't do votes, DMs, multiple accounts or undisclosed posts, on purpose.

## Files

```
server.js          Express API + scheduler
lib/pipeline.js    scan, score, draft, post, track, stats, digest
lib/ai.js          Anthropic calls (plan, score, draft) + no-key fallbacks
lib/websearch.js   thread discovery via Claude web search (default)
lib/reddit.js      Reddit OAuth API client (only with your own approved keys)
lib/mock.js        demo data
lib/store.js       JSON file database (data/db.json)
public/            dashboard + public report page
```

Selling it as a done-for-you service: the separate website (threadscout-site) handles payment through Stripe Payment Links and collects each customer's details. Each order becomes one project here, and the customer gets that project's report link. The JSON store is fine at that scale.
