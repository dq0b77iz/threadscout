const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const state = { status: {}, projects: [], current: null, tab: 'review', leadFilter: 'qualified,review,filtered,skipped,posted' };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast on' + (err ? ' err' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = 'toast'), err ? 6000 : 3000);
}

async function busy(btn, label, fn) {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span>${label}`;
  try { return await fn(); }
  catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.innerHTML = old; }
}

const ago = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
};
const fitPill = (f) => `<span class="pill ${f >= 80 ? 'good' : f >= 60 ? 'acc' : 'warn'}">fit ${f}</span>`;
const rulesPill = (r) => r === 'allowed' ? '<span class="pill good">rules ok</span>' : r === 'disallowed' ? '<span class="pill bad">no promo</span>' : '<span class="pill">rules unclear</span>';
const intentLabel = (i) => String(i || '').replace(/_/g, ' ');

// ---------- Boot ----------
async function boot() {
  state.status = await api('/api/status');
  renderStatus();
  await loadProjects();
  const saved = localStorage.getItem('ts_project');
  const pick = state.projects.find((p) => p.id === saved) || state.projects[0];
  if (pick) select(pick.id); else renderSetup(null);
}

async function loadProjects() {
  state.projects = await api('/api/projects');
  if (state.current) state.current = state.projects.find((p) => p.id === state.current.id) || null;
  renderSidebar();
}

function renderStatus() {
  const s = state.status;
  $('#status').innerHTML = `
    <div><span class="dot ${s.ai ? 'ok' : 'demo'}"></span>AI: ${s.ai ? 'connected' : 'heuristic mode'}</div>
    <div><span class="dot ${s.mode === 'demo' ? 'demo' : 'ok'}"></span>Thread search: ${({ api: 'Reddit API', websearch: 'web search', demo: 'demo data' })[s.mode]}</div>
    <div><span class="dot ${s.redditPost ? 'ok' : ''}"></span>Posting: ${s.redditPost ? 'u/' + esc(s.redditUser) : 'manual'}</div>
    <div><span class="dot ${s.smtp ? 'ok' : ''}"></span>Email digest: ${s.smtp ? 'on' : 'off'}</div>`;
}

function renderSidebar() {
  $('#plist').innerHTML = state.projects.map((p) => `
    <div class="pitem ${state.current?.id === p.id ? 'on' : ''}" data-id="${p.id}">
      <span>${esc(p.name)}</span>${p.stats.inReview ? `<span class="n">${p.stats.inReview}</span>` : ''}
    </div>`).join('') || '<div style="color:var(--side-muted);font-size:13px">No projects yet</div>';
  document.querySelectorAll('.pitem').forEach((el) => (el.onclick = () => select(el.dataset.id)));
}

$('#newBtn').onclick = () => { state.current = null; renderSidebar(); renderSetup(null); };

function select(id) {
  state.current = state.projects.find((p) => p.id === id);
  localStorage.setItem('ts_project', id);
  renderSidebar();
  render();
}

// ---------- Layout ----------
function render() {
  const p = state.current;
  if (!p) return renderSetup(null);
  const tabs = [
    ['review', 'Review', p.stats.inReview],
    ['leads', 'All leads', p.stats.found],
    ['posted', 'Posted & report', p.stats.posted],
    ['setup', 'Setup'],
    ['activity', 'Activity'],
  ];
  $('#main').innerHTML = `
    ${state.status.demo ? '<div class="banner">Demo mode: no API keys set, so scans return sample threads and "posting" is simulated. Add ANTHROPIC_API_KEY to <code>.env</code> to go live.</div>' : ''}
    <div class="head">
      <div>
        <h1>${esc(p.name)}</h1>
        <div class="sub">${p.lastScanAt ? 'Last scan ' + ago(p.lastScanAt) : 'Not scanned yet'} · ${p.autoScan && !p.paused ? 'auto-scan every ' + (p.settings?.scanEveryHours || state.status.defaults.scanEveryHours) + 'h' : 'auto-scan off'}</div>
      </div>
      <div class="row"><button class="btn primary" id="scanBtn">Find threads now</button></div>
    </div>
    <div class="tabs">${tabs.map(([k, l, c]) => `<div class="tab ${state.tab === k ? 'on' : ''}" data-t="${k}">${l}${c ? `<span class="c">${c}</span>` : ''}</div>`).join('')}</div>
    <div id="view"></div>`;
  document.querySelectorAll('.tab').forEach((el) => (el.onclick = () => { state.tab = el.dataset.t; render(); }));
  $('#scanBtn').onclick = (e) => busy(e.target, 'Scanning...', async () => {
    const r = await api(`/api/projects/${p.id}/scan`, { method: 'POST' });
    toast(`Found ${r.found} posts, ${r.qualified} good fits, ${r.drafted} drafts ready.`);
    await loadProjects();
    state.tab = 'review';
    render();
  });
  ({ review: renderReview, leads: renderLeads, posted: renderPosted, setup: () => renderSetup(p), activity: renderActivity })[state.tab]();
}

// ---------- Review queue ----------
async function renderReview() {
  const p = state.current;
  const list = await api(`/api/projects/${p.id}/threads?status=review`);
  const v = $('#view');
  if (!list.length) {
    v.innerHTML = `<div class="empty"><h2>Nothing waiting for review</h2><p>Run a scan to find threads where people are asking for something like ${esc(p.name)}.<br>Good fits get a drafted reply here for you to edit and post.</p></div>`;
    return;
  }
  v.innerHTML = list.map(threadCard).join('');
  list.forEach((t) => wireCard(t));
}

function threadCard(t) {
  return `<div class="card" id="c_${t.id}">
    <div class="meta">
      <b>r/${esc(t.subreddit)}</b>${t.subscribers ? `<span>${Intl.NumberFormat('en', { notation: 'compact' }).format(t.subscribers)} members</span>` : ''}
      <span>${ago(t.createdUtc * 1000)}</span><span>${t.numComments} comments</span>
      ${fitPill(t.fit)} ${rulesPill(t.rules)} <span class="pill">${esc(intentLabel(t.intent))}</span>
    </div>
    <h3><a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.title)}</a></h3>
    ${t.body ? `<div class="excerpt" title="Click to expand">${esc(t.body)}</div>` : ''}
    <div class="why"><b>Why it fits:</b> ${esc(t.reason)}${t.angle ? `<br><b>Angle:</b> ${esc(t.angle)}` : ''}</div>
    <textarea class="draft">${esc(t.draft)}</textarea>
    <div class="row">
      ${state.status.redditPost || state.status.demo ? '<button class="btn primary" data-a="post">Post reply</button>' : ''}
      <button class="btn ${state.status.redditPost || state.status.demo ? '' : 'primary'}" data-a="copy">Copy & open thread</button>
      <button class="btn" data-a="manual">I posted it myself</button>
      <button class="btn" data-a="regen">Rewrite</button>
      <button class="btn ghost" data-a="skip">Skip</button>
    </div>
    <div class="inline" data-i="regen"><input type="text" placeholder="Optional: how to change it (shorter, mention free plan, no link...)"><button class="btn" data-a="regenGo">Rewrite draft</button></div>
    <div class="inline" data-i="manual"><input type="url" placeholder="Paste the link to your comment"><button class="btn" data-a="manualGo">Track it</button></div>
    <div class="block"></div>
  </div>`;
}

function wireCard(t) {
  const c = $('#c_' + t.id);
  const ta = $('.draft', c);
  const ex = $('.excerpt', c);
  if (ex) ex.onclick = () => ex.classList.toggle('open');
  let saveT;
  ta.oninput = () => { clearTimeout(saveT); saveT = setTimeout(() => api(`/api/threads/${t.id}`, { method: 'PUT', body: { draft: ta.value } }), 600); };
  api(`/api/threads/${t.id}/check`).then((r) => { $('.block', c).textContent = r.blocker ? '⚠ ' + r.blocker : ''; });
  const done = async (msg) => { toast(msg); c.remove(); await loadProjects(); if (!document.querySelector('.card')) render(); };
  c.onclick = async (e) => {
    const a = e.target.dataset.a;
    if (!a) return;
    if (a === 'post') busy(e.target, 'Posting...', async () => {
      const r = await api(`/api/threads/${t.id}/post`, { method: 'POST', body: { draft: ta.value } });
      await done('Posted. Tracking it on the report page.');
      if (r.permalink && !state.status.demo) window.open(r.permalink, '_blank');
    });
    if (a === 'copy') {
      try { await navigator.clipboard.writeText(ta.value); toast('Reply copied. Paste it in the thread, then click "I posted it myself".'); } catch { toast('Copy failed, select the text manually.', true); }
      window.open(t.url, '_blank');
      $('[data-i=manual]', c).classList.add('on');
    }
    if (a === 'manual' || a === 'regen') $(`[data-i=${a}]`, c).classList.toggle('on');
    if (a === 'manualGo') busy(e.target, 'Saving...', async () => {
      await api(`/api/threads/${t.id}/mark-posted`, { method: 'POST', body: { permalink: $('[data-i=manual] input', c).value } });
      await done('Tracking your comment.');
    });
    if (a === 'regenGo') busy(e.target, 'Writing...', async () => {
      const r = await api(`/api/threads/${t.id}/draft`, { method: 'POST', body: { instructions: $('[data-i=regen] input', c).value } });
      ta.value = r.draft;
      $('[data-i=regen]', c).classList.remove('on');
    });
    if (a === 'skip') { await api(`/api/threads/${t.id}`, { method: 'PUT', body: { status: 'skipped' } }); await done('Skipped.'); }
  };
}

// ---------- All leads ----------
async function renderLeads() {
  const p = state.current;
  const list = await api(`/api/projects/${p.id}/threads?status=${state.leadFilter}`);
  const opts = [['qualified,review,filtered,skipped,posted', 'All'], ['qualified,review', 'Good fits'], ['filtered', 'Filtered out'], ['skipped', 'Skipped'], ['posted', 'Replied']];
  $('#view').innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <select id="lf" style="width:auto">${opts.map(([v, l]) => `<option value="${v}" ${v === state.leadFilter ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="sub" style="color:var(--muted);font-size:13px">${list.length} threads. Leads are useful on their own: reply yourself, or just read what buyers are asking for.</span>
    </div>
    ${list.length ? `<table><tr><th>Thread</th><th>Fit</th><th>Intent</th><th>Status</th><th></th></tr>
      ${list.map((t) => `<tr>
        <td class="t"><a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.title)}</a><div class="meta">r/${esc(t.subreddit)} · ${ago(t.createdUtc * 1000)} · ${esc(t.reason)}</div></td>
        <td>${fitPill(t.fit)}<div style="margin-top:4px">${rulesPill(t.rules)}</div></td>
        <td>${esc(intentLabel(t.intent))}</td>
        <td>${esc(t.status)}</td>
        <td>${['qualified', 'filtered', 'skipped'].includes(t.status) ? `<button class="btn" data-d="${t.id}">Draft reply</button>` : ''}</td>
      </tr>`).join('')}</table>` : '<div class="empty"><p>No threads here yet.</p></div>'}`;
  $('#lf').onchange = (e) => { state.leadFilter = e.target.value; renderLeads(); };
  document.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => busy(b, 'Writing...', async () => {
    await api(`/api/threads/${b.dataset.d}/draft`, { method: 'POST' });
    toast('Draft ready in Review.');
    await loadProjects();
    state.tab = 'review';
    render();
  })));
}

// ---------- Posted + report ----------
async function renderPosted() {
  const p = state.current;
  const [list, subs] = await Promise.all([api(`/api/projects/${p.id}/replies`), api(`/api/projects/${p.id}/subreddits`)]);
  const s = p.stats;
  const reportUrl = `${location.origin}/report/${p.reportToken}`;
  const pct = Math.min(100, Math.round((s.live / Math.max(1, s.target)) * 100));
  $('#view').innerHTML = `
    <div class="stats">
      <div class="stat"><b>${s.live}/${s.target}</b><span>live replies vs goal</span><div class="bar"><i style="width:${pct}%"></i></div></div>
      <div class="stat"><b>${s.verified}</b><span>stayed up 72h+</span></div>
      <div class="stat"><b>${s.removed}</b><span>removed (${s.removalRate}%)</span></div>
      <div class="stat"><b>${s.upvotes}</b><span>upvotes earned</span></div>
      <div class="stat"><b>${s.subreddits}</b><span>communities</span></div>
      <div class="stat"><b>${s.replacementsNeeded}</b><span>still to post by ${new Date(s.campaignEnds).toLocaleDateString()}</span></div>
    </div>
    <div class="card row" style="justify-content:space-between">
      <div><b>Shareable report</b><div class="meta">Read-only page listing every reply and whether it's still up. No login needed.</div></div>
      <div class="row"><input type="text" readonly value="${esc(reportUrl)}" style="width:330px"><button class="btn" id="cp">Copy</button><a class="btn" href="${esc(reportUrl)}" target="_blank">Open</a><button class="btn" id="trk">Check status now</button><a class="btn" href="/api/projects/${p.id}/export.csv">Export CSV</a></div>
    </div>
    ${subs.length ? `<div class="card"><b>By community</b><div class="meta" style="margin-bottom:8px">Where replies stick and where they get pulled. Drop the communities that remove you.</div>
      <table><tr><th>Subreddit</th><th>Posted</th><th>Live</th><th>Removed</th><th>Avg score</th><th></th></tr>
      ${subs.map((x) => `<tr><td>r/${esc(x.subreddit)}</td><td>${x.posted}</td><td>${x.live}</td><td>${x.removed ? `<span class="pill ${x.removalRate >= 50 ? 'bad' : 'warn'}">${x.removed} (${x.removalRate}%)</span>` : '0'}</td><td>${x.avgScore}</td>
        <td>${x.excluded ? '<span class="meta">never post</span>' : `<button class="btn ghost" data-ex="${esc(x.subreddit)}">Never post here</button>`}</td></tr>`).join('')}</table></div>` : ''}
    ${list.length ? `<table><tr><th>Reply</th><th>Posted</th><th>Status</th><th>Score</th><th></th></tr>
      ${list.map((r) => `<tr>
        <td class="t"><a href="${esc(r.permalink)}" target="_blank" rel="noopener">${esc(r.threadTitle)}</a><div class="meta">r/${esc(r.subreddit)} · ${r.method === 'manual' ? 'posted by hand' : 'posted via app'}</div></td>
        <td>${ago(r.postedAt)}</td>
        <td>${r.status === 'live' ? (Date.now() - r.postedAt > 2.592e8 ? '<span class="pill good">verified</span>' : '<span class="pill acc">live</span>') : `<span class="pill bad">${esc(r.status)}</span>`}</td>
        <td>${r.score ?? '-'}</td>
        <td>${r.status === 'live' ? `<button class="btn ghost" data-st="${r.id}" data-v="removed">Mark removed</button>` : `<button class="btn ghost" data-st="${r.id}" data-v="live">Mark live</button>`}</td></tr>`).join('')}</table>` : '<div class="empty"><p>No replies posted yet.</p></div>'}`;
  document.querySelectorAll('[data-st]').forEach((b) => (b.onclick = async () => {
    await api(`/api/replies/${b.dataset.st}`, { method: 'PUT', body: { status: b.dataset.v } });
    await loadProjects();
    render();
  }));
  document.querySelectorAll('[data-ex]').forEach((b) => (b.onclick = async () => {
    await api(`/api/projects/${p.id}/exclude`, { method: 'POST', body: { subreddit: b.dataset.ex } });
    toast(`r/${b.dataset.ex} won't be scanned or posted to again.`);
    await loadProjects();
    render();
  }));
  $('#cp').onclick = () => navigator.clipboard.writeText(reportUrl).then(() => toast('Report link copied.'));
  $('#trk').onclick = (e) => busy(e.target, 'Checking...', async () => {
    const r = await api('/api/track', { method: 'POST' });
    toast(r.manual ? 'Automatic checks need Reddit API access. Open each link and use "Mark removed" if it\'s gone.' : `Checked ${r.checked} replies, ${r.removed} newly removed.`, !!r.manual);
    await loadProjects();
    render();
  });
}

// ---------- Setup ----------
function renderSetup(p) {
  const isNew = !p;
  p = p || { tone: 'Friendly and direct. Helpful first, product second.', autoScan: true, settings: {} };
  const s = { ...state.status.defaults, ...(p.settings || {}) };
  const target = isNew ? $('#main') : $('#view');
  const f = (k, label, hint = '', type = 'text', full = false) => `<div class="${full ? 'full' : ''}"><label>${label}</label><input type="${type}" name="${k}" value="${esc(p[k] || '')}">${hint ? `<small>${hint}</small>` : ''}</div>`;
  const ta = (k, label, hint = '', rows = 3) => `<div class="full"><label>${label}</label><textarea name="${k}" rows="${rows}">${esc(p[k] || '')}</textarea>${hint ? `<small>${hint}</small>` : ''}</div>`;
  const n = (k, label, hint) => `<div><label>${label}</label><input type="number" name="s_${k}" value="${s[k]}">${hint ? `<small>${hint}</small>` : ''}</div>`;
  target.innerHTML = `
    ${isNew ? `<div class="head"><div><h1>New project</h1><div class="sub">Tell it what you sell. It'll work out where your buyers are asking for it.</div></div></div>` : ''}
    <form class="form card" id="sf">
      ${f('name', 'Product name *')}
      ${f('url', 'Link people should visit', '', 'url')}
      ${ta('description', 'What you sell *', 'Plain words: what it does and the problem it solves.')}
      ${ta('audience', 'Who buys it', 'e.g. "Small agencies with 2-10 people who juggle client approvals"', 2)}
      ${f('pricing', 'Pricing', 'Optional, e.g. "free plan, $12/mo pro"')}
      ${f('competitors', 'Competitors / what people use now', 'Comma separated. Used to find "alternative to X" posts.')}
      ${ta('differentiators', "What's different about it", '', 2)}
      ${f('tone', 'Reply tone', '', 'text', true)}
      ${f('disclosure', 'Disclosure line', `Added to every reply. Default: "Disclosure: I work on ${esc(p.name || 'your product')}."`, 'text', true)}

      <h3>Targeting</h3>
      ${f('subreddits', 'Focus subreddits', 'Comma separated. AI suggestions are added automatically.')}
      ${f('excludeSubreddits', 'Never post in', 'Comma separated')}
      ${f('extraKeywords', 'Extra search phrases', 'Comma separated')}
      ${f('negativeKeywords', 'Ignore posts containing', 'Comma separated, e.g. hiring, job')}

      <h3>Pacing & goals</h3>
      ${n('minFit', 'Minimum fit score (0-100)', 'Only threads above this get a draft.')}
      ${n('draftsPerScan', 'Drafts per scan')}
      ${n('dailyCap', 'Max replies per day', 'Keep it low on a new account.')}
      ${n('minGapMinutes', 'Minutes between replies')}
      ${n('subCooldownHours', 'Hours before replying in the same subreddit again')}
      ${n('maxAgeDays', 'Only threads newer than (days)')}
      ${n('scanEveryHours', 'Auto-scan every (hours)')}
      ${n('targetReplies', 'Goal: live replies')}
      ${n('campaignDays', 'Campaign length (days)')}
      ${n('searchesPerScan', 'Web searches per scan', 'About $0.01 each. Only used without Reddit API access.')}
      <div><label>&nbsp;</label><label class="check"><input type="checkbox" name="autoScan" ${p.autoScan ? 'checked' : ''}> Auto-scan on a schedule</label>
      <label class="check"><input type="checkbox" name="s_skipDisallowed" ${s.skipDisallowed ? 'checked' : ''}> Skip subs whose rules ban promotion</label></div>

      <h3>Weekly lead digest</h3>
      ${f('digestEmail', 'Send leads to', state.status.smtp ? 'A weekly email with the best threads, even ones you don\'t reply to.' : 'Needs SMTP settings in .env to send. You can still preview it below.', 'email')}

      <div class="full row" style="justify-content:space-between;margin-top:6px">
        <div class="row"><button class="btn primary" type="submit">${isNew ? 'Create project' : 'Save changes'}</button>
        ${isNew ? '' : '<button class="btn" type="button" id="restart">Restart campaign clock</button>'}</div>
        ${isNew ? '' : '<button class="btn danger" type="button" id="del">Delete project</button>'}
      </div>
    </form>
    ${isNew ? '' : `
    <div class="card">
      <div class="row" style="justify-content:space-between"><b>AI search plan</b><button class="btn" id="replan">Regenerate</button></div>
      ${p.plan ? `<div class="meta" style="margin:10px 0 4px">Search phrases</div><div class="chips">${p.plan.queries.map((q) => `<span class="chip">${esc(q)}</span>`).join('')}</div>
      <div class="meta" style="margin:10px 0 4px">Communities</div><div class="chips">${p.plan.subreddits.map((q) => `<span class="chip">r/${esc(q)}</span>`).join('')}</div>
      <div class="meta" style="margin:10px 0 4px">Ignored words</div><div class="chips">${(p.plan.negativeKeywords || []).map((q) => `<span class="chip">${esc(q)}</span>`).join('')}</div>` : '<p class="meta">Generated on the first scan.</p>'}
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between"><b>Digest preview</b><div class="row"><button class="btn" id="dprev">Preview</button>${state.status.smtp ? '<button class="btn" id="dsend">Send now</button>' : ''}</div></div>
      <div id="dout"></div>
    </div>`}`;

  $('#sf').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { settings: {} };
    for (const [k, v] of fd.entries()) {
      if (k.startsWith('s_')) body.settings[k.slice(2)] = v;
      else body[k] = v;
    }
    body.autoScan = fd.has('autoScan');
    body.settings.skipDisallowed = fd.has('s_skipDisallowed');
    const btn = e.submitter;
    await busy(btn, 'Saving...', async () => {
      const saved = isNew
        ? await api('/api/projects', { method: 'POST', body })
        : await api(`/api/projects/${p.id}`, { method: 'PUT', body });
      if (isNew) await api(`/api/projects/${saved.id}`, { method: 'PUT', body: { settings: body.settings } });
      await loadProjects();
      toast(isNew ? 'Project created. Click "Find threads now" to run the first scan.' : 'Saved.');
      state.tab = isNew ? 'review' : 'setup';
      select(saved.id);
    });
  };
  if (isNew) return;
  $('#restart').onclick = async () => { await api(`/api/projects/${p.id}`, { method: 'PUT', body: { restartCampaign: true } }); await loadProjects(); toast('Campaign clock restarted.'); };
  $('#del').onclick = (e) => {
    if (e.target.dataset.sure) {
      api(`/api/projects/${p.id}`, { method: 'DELETE' }).then(async () => { state.current = null; await loadProjects(); boot(); });
    } else { e.target.dataset.sure = 1; e.target.textContent = 'Click again to delete everything'; }
  };
  $('#replan').onclick = (e) => busy(e.target, 'Thinking...', async () => { await api(`/api/projects/${p.id}/plan`, { method: 'POST' }); await loadProjects(); render(); });
  $('#dprev').onclick = async () => {
    const items = await api(`/api/projects/${p.id}/digest`);
    $('#dout').innerHTML = items.length ? `<ol>${items.map((i) => `<li><a href="${esc(i.url)}" target="_blank">${esc(i.title)}</a> <span class="meta">r/${esc(i.subreddit)} · fit ${i.fit}</span></li>`).join('')}</ol>` : '<p class="meta">No leads in the last 7 days yet.</p>';
  };
  if ($('#dsend')) $('#dsend').onclick = (e) => busy(e.target, 'Sending...', async () => { const r = await api(`/api/projects/${p.id}/digest/send`, { method: 'POST' }); toast(`Digest sent with ${r.sent} leads.`); });
}

// ---------- Activity ----------
async function renderActivity() {
  const list = await api(`/api/log?project=${state.current.id}`);
  $('#view').innerHTML = `<div class="card log">${list.map((l) => `<div class="${l.level}">${new Date(l.at).toLocaleString()} · ${esc(l.msg)}</div>`).join('') || 'No activity yet.'}</div>`;
}

boot().catch((e) => toast(e.message, true));
