// ===== Edit this file, then upload the whole folder to your host. =====
window.SITE = {
  brand: 'Threadscout',
  domain: 'threadscout.com',            // your domain, used in page text
  supportEmail: 'support@threadscout.com',
  operator: 'Your Company Name, City, Country', // legal name + address shown in the footer and terms

  // Stripe Payment Links (dashboard.stripe.com > Payment Links > New).
  // In each link, set "After payment" to: https://YOURDOMAIN/start.html?plan=starter (or growth / scale)
  stripe: {
    starter: 'https://buy.stripe.com/REPLACE_STARTER',
    growth: 'https://buy.stripe.com/REPLACE_GROWTH',
    scale: 'https://buy.stripe.com/REPLACE_SCALE',
  },

  // Free form backend: get a key at https://web3forms.com (free, 250 submissions/month).
  // Trial signups, intake forms and the weekly email list all arrive in your inbox.
  // Leave blank and forms fall back to opening the visitor's email app.
  web3formsKey: '',

  // Plans shown on the page. Change prices here and the page updates.
  plans: {
    starter: { name: 'Starter', price: 29, replies: 50, days: 7 },
    growth: { name: 'Growth', price: 89, replies: 200, days: 14 },
    scale: { name: 'Scale', price: 549, replies: 1000, days: 30 },
  },
};
