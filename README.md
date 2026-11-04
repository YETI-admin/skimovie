# Powder to the People — fundraising thermometer

TV thermometer for Y.E.T.I.'s ski movie night (North Bend Theater, Nov 12, 2026).
Standalone app: Node + Express + SQLite (`node:sqlite`), plain HTML/CSS/JS.
Hosted on Azure App Service `yeti-skimovie` (resource group `rg-skimovie`).

- `/` — full-screen thermometer for the TV (polls every 5 s, keeps the last total if offline)
- `/admin` — PIN-protected: cash entries, goal, event start, manual adjustment, source status, CSV exports
- `/webhook/stripe` — Stripe webhook (signature checked)
- `/healthz` — shows which secrets are configured (never their values)

## How the total is counted

Total = Give Lively campaign gifts + other Stripe payments since the event start + cash + manual adjustment.

- **Give Lively gifts** are charged on Y.E.T.I.'s Stripe account and carry metadata.
  A charge with `gl_charge_id` is a Give Lively charge; it counts (any date) when
  `campaign_slug` matches `GIVELIVELY_CAMPAIGN_SLUG`. Only Y.E.T.I.'s share counts
  (`gross_amount_to_nonprofit`), not the optional tip to Give Lively.
- **Other Stripe payments** (card reader, payment links…) count when created on/after the event start.
- Refunds are subtracted. Charge IDs are unique, so nothing is counted twice.
- Webhooks update the total within seconds; a full re-check against Stripe runs every minute
  in case a webhook is missed.

The Give Lively page itself is not read: it is behind bot protection and has no public API.

## Privacy

Only amounts, times, charge IDs and payment method type are stored. No names, emails,
addresses, card details, descriptions or metadata values are saved or logged.
Cash entries are totals, not individual donors.

## Settings (App Service → Environment variables)

| Name | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Restricted key: Charges and Refunds = Read, Payment Intents = Read |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from the Stripe webhook endpoint |
| `ADMIN_PIN` | Admin PIN |
| `ADMIN_NAMES` | Comma-separated names for the "entered by" list |
| `SESSION_SECRET` | Random string for signing admin cookies |
| `EVENT_START` | Default `2026-11-12T12:00:00-08:00` (admin can change) |
| `GOAL_CENTS` | Default `2000000` (admin can change) |
| `GIVELIVELY_CAMPAIGN_SLUG` | `powder-to-the-people-north-bend-ski-movie-night-fundraiser` |
| `DATA_DIR` | `/home/data` on Azure (persistent) |

Stripe webhook endpoint: `https://yeti-skimovie.azurewebsites.net/webhook/stripe`,
events `charge.succeeded`, `charge.refunded`, `charge.updated`.

Run only **one** instance (SQLite).

## Local

```
npm install
npm test
ADMIN_PIN=1234 STRIPE_WEBHOOK_SECRET=whsec_test node server.js
```
