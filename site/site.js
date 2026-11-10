(function () {
  const S = window.SITE;
  const $$ = (s) => document.querySelectorAll(s);

  // Fill text from config: <span data-cfg="supportEmail"></span>
  $$('[data-cfg]').forEach((el) => { el.textContent = S[el.dataset.cfg]; });
  $$('a[data-mail]').forEach((a) => { a.href = 'mailto:' + S.supportEmail; a.textContent = S.supportEmail; });
  $$('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear(); });

  // Plans: <span data-plan="starter" data-f="price"></span>, <a data-buy="starter">
  $$('[data-plan]').forEach((el) => {
    const p = S.plans[el.dataset.plan];
    const v = p[el.dataset.f];
    el.textContent = typeof v === 'number' && v >= 1000 ? v.toLocaleString('en-US') : v;
  });
  $$('[data-per]').forEach((el) => {
    const p = S.plans[el.dataset.per];
    el.textContent = '$' + (p.price / p.replies).toFixed(2) + ' per reply';
  });
  $$('[data-buy]').forEach((a) => { a.href = S.stripe[a.dataset.buy]; });

  // Forms: send to Web3Forms if a key is set, else open the visitor's email app.
  $$('form[data-form]').forEach((form) => {
    const msg = form.querySelector('.msg');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      if (data.botcheck) return;
      delete data.botcheck;
      const subject = `${S.brand}: ${form.dataset.form}${data.product ? ' for ' + data.product : ''}`;
      const btn = form.querySelector('button[type=submit]');

      if (!S.web3formsKey) {
        const body = Object.entries(data).map(([k, v]) => `${k}: ${v}`).join('\n');
        location.href = `mailto:${S.supportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        msg.className = 'msg ok';
        msg.textContent = 'Your email app should open with this filled in. Hit send and we\'ll take it from there.';
        return;
      }
      btn.disabled = true;
      msg.className = 'msg';
      msg.textContent = 'Sending...';
      try {
        const res = await fetch('https://api.web3forms.com/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ access_key: S.web3formsKey, subject, from_name: S.brand + ' website', ...data }),
        });
        const j = await res.json();
        if (!j.success) throw new Error(j.message || 'Send failed');
        if (form.dataset.next) { location.href = form.dataset.next; return; }
        form.reset();
        msg.className = 'msg ok';
        msg.textContent = form.dataset.done || 'Got it. Check your inbox.';
      } catch (err) {
        msg.className = 'msg err';
        msg.textContent = `That didn't go through (${err.message}). Email ${S.supportEmail} instead.`;
      } finally {
        btn.disabled = false;
      }
    });
  });

  // Intake page: show which plan was bought.
  const plan = new URLSearchParams(location.search).get('plan');
  if (plan && S.plans[plan]) {
    $$('[data-chosen]').forEach((el) => { el.textContent = `${S.plans[plan].name}: ${S.plans[plan].replies.toLocaleString('en-US')} replies over ${S.plans[plan].days} days`; });
    $$('input[name=plan]').forEach((i) => { i.value = plan; });
  }
})();
