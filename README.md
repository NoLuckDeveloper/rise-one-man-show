# Rise One Man Show — Service (standalone deployable)

The public-hosting twin of the private Muse artifact `rise-one-man-show-service`:
a multi-company field-service SaaS. Companies sign up, get a **7-day free
trial**, then pay a monthly per-company subscription via Stripe, by plan:
Solo (1 user) **$10.99**, Team up to 3 users **$28.49**, Team up to 6 users
**$47.99**, Team up to 10 users **$64.99**. Seat caps count total users in
the company; plans can be switched anytime (prorated).

Stack: Node.js + Express + Postgres (`pg`) + the official `stripe` package.
Server-rendered pages, one small client JS file, no build step. Passwords are
hashed with Node's built-in scrypt; sessions are opaque tokens in Postgres.
Every tenant query is scoped by `company_id`.

## Features

- Company signup/login, Owner / Admin / Tech roles, add/deactivate users,
  owner/admin password resets
- Trial lifecycle: trialing → active → past_due → canceled / trial-ended lock
  (app locks to the billing page when a trial ends with no payment method)
- Stripe Checkout subscription signup (remaining trial days honored via
  `trial_period_days`), Stripe Billing Portal for card management, webhook
  handler (`customer.subscription.*`, `invoice.payment_failed`, `invoice.paid`)
  that keeps local subscription state in sync
- **TEST MODE**: if any Stripe env var is missing, billing is simulated
  in-app (clearly labeled) — add a test card, simulate a failed payment /
  retry, watch trials convert or lock. No code changes to go live.
- Field-service workflow per company: call intake → Bucket → Schedule →
  Start travel (browser GPS miles or manual) → Start job (clock-in) → job
  report (asset, work performed, parts as Quantity · Description · Cost,
  photos, follow-up with required date that chains a follow-up call; hours
  and parts accumulate across the chain) → End call (locked until the report
  is marked complete) → invoice (labor = chain hours × rate, parts billed at
  cost × parts multiplier, plus tax %) with printable report/invoice
- **Invoice payments**: every invoice carries a public pay link
  (`/pay/<unguessable token>`, no login) showing the invoice and, once the
  company connects Stripe, a **Pay** button. Companies connect their own
  Stripe account in Settings (Stripe Connect, Express) — checkout runs as a
  **direct charge on the company's account**, so money settles to the
  company and never passes through the platform. A Connect webhook (or the
  pay-page success return, as a fallback) marks the invoice paid. Owners /
  admins can also **Mark as paid** manually (Cash / Check / Venmo / PayPal /
  Other + optional reference + date) for off-card payments; paid method and
  date show on the invoice, as a Paid badge in Completed, and on the pay
  page, which refuses payment for an already-paid invoice. In TEST MODE,
  Connect is simulated locally so the whole flow works without keys.
- **Invoice email**: owners / admins can email an invoice (job summary,
  totals, Pay button linking to the pay page) to the customer's email.
  Customer email is a customer-level record, not just a call field: a
  `customers` row is keyed by `(company_id, customer_name)`, backfilled from
  the most recent non-empty email on existing calls, and upserted whenever a
  call is created or edited with an email. The Customers list and detail
  pages show the address with an inline editor for owners / admins (techs
  can read it), and "+ New call" / call edit forms prefill from the customer
  record. Invoice recipients resolve **customer record first**, then the
  chain root call's `customer_email`. When the final report transitions to
  complete with no follow-up pending — the point at which an invoice is
  generated — the app **auto-sends** the invoice if a recipient is on file
  and `RESEND_API_KEY` is set, recording `invoice_emailed_at` and the
  recipient on the root call; the invoice page shows an "Emailed to … on …"
  stamp. The manual **Email invoice** button remains as a resend and
  updates the stamp. With no recipient or no Resend key, auto-send is a
  silent no-op and job completion is never blocked; manual sending without
  a key shows a graceful "email isn't configured yet" notice.
- Completed tab (green Report / blue Invoice), Customers with site history
  and prefilled "+ New call", Weekly Log & printable Report (pay-period,
  monthly, quarterly totals; by-job breakdown), gas ⛽ / maintenance 🔧
  entries with receipt photos, per-company Settings
- **Dispatch**: every call has an assignee. Owners / admins assign calls on
  the create / edit forms (an "Unassigned" option leaves the call in the
  owner/admin-only pool); the Schedule page has a per-tech filter so they
  can view and build one tech's schedule. **Techs see only their own jobs**:
  bucket, scheduled, and completed lists are filtered to their assigned
  calls, unassigned calls are hidden from them, direct URLs to another
  tech's (or an unassigned) call return 404, and the job run flow
  (travel / start job / end job) refuses anything not assigned to them.
  Assignment changes are owner/admin only — a tech's submitted assignee
  is ignored, and a tech-created call is assigned to the creating tech so
  it stays visible to them. Follow-up calls inherit the original call's
  assignee. Customers and Log & Report stay company-wide in v1.
- Platform admin view: every company, trialing/active counts, estimated MRR
  (sum of trialing/active companies' plan rates, with a per-plan breakdown),
  extend trial +7 days, cancel, remove demo

## Run locally

You need a Postgres database (local install, Docker, or a free Render/Neon DB).

```bash
cp .env.example .env      # fill in DATABASE_URL and SESSION_SECRET
npm install
npm start                 # runs migrations (idempotent) then serves
```

Open http://localhost:3000 — sign up a company and you're in a 7-day trial.
Without Stripe keys the app runs in TEST MODE billing. Add `SEED_DEMO=true`
to `.env` to also create the demo company (demo@demo.com / demo1234,
trialing, sample calls). Platform admin defaults to
platform@rise.local / platform123 unless you set `PLATFORM_ADMIN_EMAIL` /
`PLATFORM_ADMIN_PASSWORD` — set them before any public launch (and rotate
the demo password / remove the demo company).

## Deploy to Render (exact steps)

1. **Push this repo to GitHub** (private repo is fine).
   - If you are applying only the **customer email + invoice auto-send**
     change on top of a deployment that already has invoice payments, and
     you upload files individually instead of pushing the whole repo, the
     upload list for this change is: `server/db.js`, `server/index.js`,
     `server/views.js`, and `README.md`. (`server/mailer.js` and
     `server/payments.js` are unchanged by this update.)
2. **Create the Blueprint**: Render Dashboard → **New +** → **Blueprint** →
   connect the repo → **Apply**. `render.yaml` creates:
   - web service `rise-one-man-show` (Starter plan, always-on — required so
     paying customers never hit a sleeping app), start command `npm start`
     (migrations run automatically at boot)
   - Postgres `rise-db` (basic plan), wired into `DATABASE_URL`
3. **Set secret env vars** on the web service (Dashboard → Environment):
   `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_PRICE_ID`,
   `STRIPE_PRICE_TIER_3`, `STRIPE_PRICE_TIER_6`, `STRIPE_PRICE_TIER_10`,
   `STRIPE_WEBHOOK_SECRET` (from steps 5–6 below; until set, the app runs in
   TEST MODE), `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`.
   `SESSION_SECRET` is auto-generated by the Blueprint; `APP_BASE_URL` is
   preset to `https://riseonemanshow.com` — update it if your domain differs.
   `SEED_DEMO` stays `false` in production.
4. **Add the custom domain**: web service → Settings → Custom Domains →
   add `riseonemanshow.com` and `www.riseonemanshow.com`. Render shows the
   exact DNS targets; typically:
   - Apex (`riseonemanshow.com`): Render gives an **A record IP** to copy
     (Render supports apex domains via a single A record — copy the value
     shown in your dashboard, it is account-specific)
   - `www`: **CNAME** → your service's `*.onrender.com` hostname
   In **Wix** (domain registrar): Domains → riseonemanshow.com → DNS Records →
   delete Wix's default parking A/CNAME records for `@` and `www`, add the
   records above. Wait for Render to issue the free TLS certificate
   (status "Verified" — can take a while for DNS to propagate).
5. **Stripe product & prices** (Stripe Dashboard, live mode):
   Products → Add product → name **Rise One Man Show**, then add four
   monthly recurring prices on that product: **$10.99** → copy the price ID
   (`price_...`) into `STRIPE_PRICE_ID` (Solo); **$28.49** → into
   `STRIPE_PRICE_TIER_3`; **$47.99** → into `STRIPE_PRICE_TIER_6`;
   **$64.99** → into `STRIPE_PRICE_TIER_10`. Copy the live secret +
   publishable keys into `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY`.
   A tier with no price configured is simply not offered at signup.
   Also enable the Billing Portal: Settings → Billing → Customer portal →
   activate (allow payment-method updates and cancellation).
6. **Stripe webhook**: Developers → Webhooks → Add endpoint →
   URL `https://riseonemanshow.com/webhooks/stripe`, events:
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.paid`.
   Copy the signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`, then
   redeploy/restart the service so it picks up all four Stripe vars — the
   app leaves TEST MODE automatically.
7. **Go-live check**: sign up a real test company, confirm the trial banner
   counts down from 7, add your own card via Billing → Checkout, confirm in
   Stripe that the subscription exists with a 7-day trial, and that the
   webhook deliveries succeed. Rotate the platform admin password if you
   haven't, and remove/ignore the demo company (it only exists if
   `SEED_DEMO=true`).
8. **Enable Stripe Connect** (invoice card payments; Dashboard, live mode):
   - Developers / Settings → **Connect** → get started: platform type
     **Express**, and complete the platform profile (business details,
     branding — name, icon, brand color). Stripe may ask for your own
     account verification before Connect activates.
   - Each company then connects from **Settings → Invoice payments** in the
     app (owner only) — Stripe hosts the onboarding; the app stores the
     account id and whether `charges_enabled` has flipped on.
   - **Connect webhook destination**: Developers → Webhooks → Add
     destination → scope **Connected accounts** (this is a *separate*
     destination from the step-6 platform one) → URL
     `https://riseonemanshow.com/webhooks/stripe`, event
     `checkout.session.completed`. Copy its signing secret into
     `STRIPE_CONNECT_WEBHOOK_SECRET` and redeploy. (If you skip this, the
     pay page still records payments via its success-return check, but the
     webhook is the reliable path.)
9. **Resend (invoice email)**: create a Resend account → **Domains** → add
   `riseonemanshow.com` and add the DNS records Resend shows (DKIM/SPF) in
   **Wix** DNS → wait for the domain to show **Verified** → create an API
   key → set `RESEND_API_KEY` on the web service and redeploy. Invoices are
   sent from `invoices@riseonemanshow.com` with reply-to set to the company
   owner's email. Until this is done, the Email invoice button shows an
   "email isn't configured yet" notice — nothing breaks.

## Environment variables

| Var | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `SESSION_SECRET` | yes | Signs session cookies (any long random string) |
| `APP_BASE_URL` | yes | Public URL, used for Stripe return URLs |
| `STRIPE_SECRET_KEY` | for live billing | Stripe live secret key |
| `STRIPE_PUBLISHABLE_KEY` | for live billing | Stripe live publishable key |
| `STRIPE_PRICE_ID` | for live billing | Solo $10.99/month recurring price ID |
| `STRIPE_PRICE_TIER_3` | for live billing | Team up to 3 users, $28.49/month recurring price ID |
| `STRIPE_PRICE_TIER_6` | for live billing | Team up to 6 users, $47.99/month recurring price ID |
| `STRIPE_PRICE_TIER_10` | for live billing | Team up to 10 users, $64.99/month recurring price ID |
| `STRIPE_WEBHOOK_SECRET` | for live billing | Webhook signing secret |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | for invoice payments | Signing secret of the Connected-accounts webhook destination; falls back to `STRIPE_WEBHOOK_SECRET` if unset |
| `RESEND_API_KEY` | for invoice email | Resend API key; without it, invoice emailing shows a graceful not-configured notice |
| `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` | recommended | Platform admin login (dev defaults otherwise) |
| `SEED_DEMO` | no | `true` seeds Demo Doors LLC on first boot |
| `PORT` | no | Set automatically by Render |

## Notes / v1 pragmatism

- Migrations are `CREATE TABLE IF NOT EXISTS` DDL run at every boot —
  idempotent, no migration framework yet.
- Job-report and receipt photos are stored inline as downscaled JPEG
  data URLs (client-side, max ~1200px). Fine for v1; move to object storage
  (e.g. an S3 bucket) before photo volume grows.
- Receipt "scan" in this standalone v1 attaches the photo only — no OCR
  autofill (the Muse artifact had it; add an OCR API later if wanted).
- User "invites" are admin-created accounts (Users page) in v1. The only
  email the app sends is invoices (via Resend, when `RESEND_API_KEY` is
  set). Password resets are done by an owner/admin, or by the platform
  admin for owners.
- Invoice payment state lives on the call chain's **root call** (invoices
  are derived from chains, so there is no separate invoices table):
  `payment_status` / `payment_method` / `payment_reference` / `paid_at`,
  plus `pay_token` (unguessable, unique) for the public pay page. Invoice
  totals are still computed live from chain hours/parts + company settings,
  matching the existing invoice model — if rates change after a job, the
  displayed total changes too; the recorded payment (method/date/reference)
  does not.
- The invoice recipient is resolved from the **customers table first**
  (`customers.email` for the root call's company + customer name), with the
  root call's `customer_email` as the fallback. Follow-up calls are created
  with the customer-record address when one exists, so a Customers-page
  edit is not overwritten by a stale address stored on an older call.
  Successful sends (automatic at invoice generation, or manual/resend)
  stamp `invoice_emailed_at` + `invoice_email_recipient` on the root call.
- The trial-ended lock and period roll-forward are evaluated lazily on each
  request (plus Stripe webhooks in live mode) — no cron jobs needed.
