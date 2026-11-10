THREADSCOUT WEBSITE: HOW TO LAUNCH

1. Buy a domain (Namecheap, Cloudflare, Porkbun, ~$10-15/yr).

2. Stripe (stripe.com): create 3 Payment Links (Starter $29, Growth $89, Scale $549).
   In each link, under "After payment", choose "Don't show confirmation page" and redirect to:
     https://YOURDOMAIN/start.html?plan=starter   (growth / scale for the others)

3. Forms: get a free access key at web3forms.com using your support email.

4. Open config.js and fill in: domain, supportEmail, operator (legal name + city), the 3 Stripe links,
   web3formsKey. Prices also live there.

5. Read terms.html and privacy.html. They're templates; have them checked for your country.

6. Upload the whole folder:
   - Easiest: drag the folder onto app.netlify.com/drop (free), then connect your domain in Netlify.
   - Or Cloudflare Pages (free), or your domain host's file manager / FTP into public_html.

Pages: index.html (sales page), start.html (form after payment), thanks.html, terms.html, privacy.html.
Fonts are included (Familjen Grotesk, open font license), so nothing loads from Google.

Running orders: each new order email = one project in the Threadscout app. Send the customer the
project's report link (Posted & report tab) once the first reply is up.
