# Deadhead

A marketplace for private-jet empty legs. FAA Part 135 operators post repositioning flights. Travelers search them using nearby airports, flexible dates and two-leg connections, then book the whole aircraft. The card is authorized at booking and charged only when the operator confirms.

It has no dependencies: Node 22 and its built-ins (HTTP server, crypto, SQLite) are all it needs. Stripe and email are called through their REST APIs, so `npm install` isn't required.

## What's in it

| Area | What it does |
|---|---|
| **Find a jet** | Searches open legs from verified operators. Radius matching (with drive time), ± day flexibility, two-leg chains across different operators (1–26 h connection, only shown when clearly cheaper than one charter), per-seat view and a retail-charter benchmark. |
| **Booking** | Leg is held atomically, so no double booking. Stripe Checkout with **manual capture**: card authorized now, captured on confirmation. If the operator declines, the request expires (default 48 h) or the traveler cancels, the hold is released. Without Stripe keys it runs in *request mode* and the desk invoices. |
| **Operators** | Self-serve signup, company profile with Part 135 certificate number, post/edit/withdraw/reopen/duplicate legs with a live discount estimate, and confirm or decline requests. Traveler phone and email are revealed only after confirmation. |
| **Desk (admin)** | Verifies or suspends operators (suspending withdraws their open legs), sees every booking with both parties' contacts, confirms or declines on an operator's behalf, messages travelers, and tracks GMV and fees. |
| **Accounts** | Email and password (scrypt), hashed session tokens, password reset by email, rate-limited auth. |
| **Alerts** | Travelers save routes and are emailed once per new matching leg. |
| **Email** | Welcome, request received, new request (operator), confirmed (both sides, with dispatch and passenger contacts), declined or cancelled, alerts, operator verified, password reset. |
| **Compliance** | Broker disclosure on every page and at `#broker`. Each listing shows the operating carrier and its certificate. Draft Terms and Privacy are marked for counsel review. |

## Run locally

```bash
cp .env.example .env          # set ADMIN_EMAILS to your email
npm start                     # http://localhost:8080
npm test                      # API + payment-flow tests (mock Stripe)
```

Sign up with the email in `ADMIN_EMAILS` to get the **Desk** tab.

## Deploy (Render, about 15 minutes)

1. Push this folder to a GitHub repository.
2. In Render, go to **New → Blueprint**, select the repository, and it reads `render.yaml`. That gives you one web service plus a 1 GB persistent disk at `/data` for the database.
3. Fill in the secret environment variables:
   - `BASE_URL`: your public URL, e.g. `https://deadhead.yourdomain.com`
   - `ADMIN_EMAILS`: your email
   - `SUPPORT_EMAIL`, `EMAIL_FROM`, `RESEND_API_KEY`
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
4. Add your custom domain in Render. HTTPS is automatic.

The Dockerfile works on any container host, such as Fly.io or Railway. Mount a volume at `/data`.

### Stripe

1. Use test keys (`sk_test_…`) first.
2. Under **Developers → Webhooks → Add endpoint**, use `https://YOUR_DOMAIN/api/stripe/webhook` with these events:
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `payment_intent.canceled`
3. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Test with card `4242 4242 4242 4242`, then switch to live keys.

Things to know about Stripe here:
- **Card authorizations last about 7 days.** The 48-hour confirmation window keeps well inside that.
- **High-ticket charges are normal for this business,** but Stripe will want your business verified. Tell them up front that you're an air charter broker, with ticket sizes of $5k–$100k.
- **Payouts to operators are manual.** Funds land in your Stripe balance and you pay operators off-platform under your broker agreement. Stripe Connect payouts are the natural next step.

### Email (Resend)

Verify your sending domain in Resend (it gives you DNS records to add), create an API key, and set `RESEND_API_KEY` and `EMAIL_FROM`. Until then, emails are written to the server log.

### Backups

The database is the single file at `DATABASE_FILE`. Back it up on a schedule, either with Render disk snapshots or with `sqlite3 /data/deadhead.db ".backup /data/backup-$(date +%F).db"` copied off-box.

## Launch checklist

- [ ] **DOT air charter broker rules (14 CFR Part 295).** Have aviation counsel confirm the disclosures, advertising and payment handling. Replace the draft Terms and Privacy (`public/app.js` → `renderLegal`).
- [ ] **Operator onboarding.** Before verifying, check each certificate against the FAA's Part 135 operator records, collect insurance certificates naming you, and sign a broker–operator agreement covering pricing, cancellations and payout timing.
- [ ] **Service fee.** Set `PLATFORM_FEE_PCT` (default 5%). It is shown to travelers as a separate line.
- [ ] **Stripe in live mode,** with the webhook endpoint configured and a test booking done end to end.
- [ ] **Email domain** verified, with SPF and DKIM passing.
- [ ] **Seed supply** before marketing to travelers: an empty marketplace converts poorly, so start with a handful of operators posting real legs.

## Architecture

```
server/
  index.js    boot, env checks, 60s sweeper (expire holds/requests), graceful shutdown
  app.js      routes + booking state machine
  db.js       SQLite (node:sqlite), WAL, migrations
  search.js   empty-leg search: radius, flex, two-leg chains
  stripe.js   Stripe REST client + webhook signature verification
  email.js    Resend client (logs when unconfigured)
  auth.js     scrypt passwords, hashed session tokens
  http.js     router, cookies, security headers (CSP, HSTS), rate limiter
  ref.js      airports, aircraft classes, distance/time-zone math (shared with browser)
public/       single-page site (no build step)
test/         end-to-end API tests incl. mocked Stripe
```

Booking states: `checkout` (card entry, legs held 35 min) → `requested` (authorized, waiting for operator) → `confirmed` (captured, legs booked). From `checkout` or `requested` a booking can also go to `declined` or `cancelled`, which releases the legs and the card hold.

**Scaling.** This version runs as a single instance with SQLite, which comfortably handles thousands of legs and bookings a day. Move to Postgres and a job queue before running more than one instance. The SQL is plain, and the in-process per-booking lock in `app.js` would become a row lock.
