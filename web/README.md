# WikiClaim (web)

A multiplayer game where you **buy Wikipedia articles at the price of a year
of their traffic plus a bonus for recent buzz** — like valuing a business at
its normal yearly run-rate plus a premium for a strong recent month — and
**earn credits every day for every real visitor** those articles get. Prices
and earnings both come from the live
[Wikimedia Pageviews API](https://wikimedia.org/api/rest_v1/#/Pageviews%20data).

Everyone starts with **5,000 credits**. Buy pages you think are undervalued (or
about to spike), collect their daily views as income, sell when you like, and
climb the shared net-worth leaderboard.

## The rules

- **Price of a page** = its average daily pageviews over the last 365 days
  (min 1), plus a premium equal to its raw view total over the last 30 days
  — a page steady at 10 views/day costs roughly 10 + 300 = 310. Human traffic
  only; bots excluded.
- **Buying** deducts the current price from your credits. You can own any
  number of pages you can afford, but only one position per page.
- **Earning**: each real calendar day, every page you own pays you credits
  equal to that day's view count. You start earning the day *after* you buy.
- **Settlement is automatic and lazy.** There's no cron job — whenever you
  load your dashboard, the server credits every page for each day that has
  become available since it was last settled. Wikimedia publishes pageview
  data with about a 1-day lag, so today's earnings show up tomorrow. A page
  owned for N days earns exactly N days of real traffic, and it works even if
  the server was offline.
- **Selling** returns the page's *current* price to your credits. Prices move
  as real-world traffic changes, so a page can be worth more or less than you
  paid.
- **Net worth** = credits + current value of all your pages. The leaderboard
  ranks everyone by net worth.
- **Predictions**: instead of owning a page, stake credits on whether its
  price will be higher or lower 24 hours from now. Resolves lazily (same
  pattern as daily earnings, no cron) against the real price move: guess
  right and get back more than your stake, guess wrong and get back less
  (floored at 0). A Wikimedia hiccup at resolution time refunds the stake
  rather than penalizing you.

## Run it locally

Requires Node.js 18+ (uses built-in `fetch`). From this `web/` folder:

```bash
npm install
cp .env.example .env   # then fill in CLERK_SECRET_KEY
npm start
```

Then open <http://localhost:3000>, sign up, and start trading. Set a custom
port with `PORT=8080 npm start`.

With no `DATABASE_URL` set, the app stores everything in a local JSON file
(`data/db.json`) — zero setup. Set `DATABASE_URL` to use Postgres instead.

## Authentication (Clerk)

Sign-up/sign-in is handled entirely by [Clerk](https://clerk.com) — this app
has no password storage of its own. **Signing in is required to buy, sell, or
place a prediction**; every mutating route verifies the request server-side,
not just the UI.

- **Frontend**: `public/index.html` loads Clerk via a CDN script tag (no
  bundler needed) using a publishable key — safe to be public, already
  hardcoded there. It mounts Clerk's own sign-in widget into `#clerk-auth`.
  `app.js` attaches the current Clerk session token as an `Authorization:
  Bearer <token>` header on every API call.
- **Backend**: `server.js` verifies that Bearer token against Clerk
  (`@clerk/backend`'s `verifyToken`) on every request. This needs
  **`CLERK_SECRET_KEY`** set — get it from your Clerk dashboard's *API Keys*
  page. **Never commit it or share it** — anyone with it can impersonate your
  users. Locally it's read from `web/.env` (see `.env.example`); on Railway,
  set it as a Variable instead (no `.env` file is deployed there).
- **Accounts are provisioned just-in-time**: the first time a Clerk user is
  seen, the server creates a matching internal record (5,000 starting credits)
  automatically — there's no separate "register" step in this app.
- If `CLERK_SECRET_KEY` isn't set, the server logs a warning on boot and
  treats every request as signed out — sign-in and all transactions fail
  closed rather than silently allowing unauthenticated access.

## Storage backends

The storage backend is chosen at startup from the environment:

- **No `DATABASE_URL`** → JSON file at `data/db.json`. Great for local dev.
- **`DATABASE_URL` set** → Postgres. Tables are created automatically on boot.

Both implement the same async interface (`db/json-store.js` and `db/pg-store.js`,
selected by `store.js`), so nothing else in the app changes between them.

SSL is automatic: off for `localhost` and Railway's private network
(`*.railway.internal`), on otherwise. Override with `DATABASE_SSL=true|false`.
See `.env.example`.

## Deploy to Railway

This is a monorepo — the game lives in `web/`, and a Manifest V3 browser
extension lives at the repo root. Railway builds from the repo root by
default, so the root [`package.json`](../package.json) is what it detects; its
`postinstall`/`start` scripts `cd` into `web/` to install and run the actual
server. **No Root Directory setting is needed.**

1. **Create the project** — in Railway, *New Project → Deploy from GitHub repo*
   and pick this repo. Leave Root Directory unset (repo root).
2. **Add Postgres** — *New → Database → Add PostgreSQL*.
3. **Wire the connection** — in the app service's *Variables*, add:
   ```
   DATABASE_URL = ${{Postgres.DATABASE_URL}}
   ```
   Railway resolves that to the Postgres plugin's connection string (private
   network, so no SSL needed — the app detects this automatically).
4. **Add your Clerk secret key** — same *Variables* tab:
   ```
   CLERK_SECRET_KEY = sk_...
   ```
   from your Clerk dashboard's *API Keys* page. Without this, the deployed
   app boots fine but no one can sign in or transact (see Authentication above).
5. **Deploy** — Railway auto-detects Node from the root `package.json`, runs
   `npm install` (which also installs `web/`'s dependencies via
   `postinstall`), then `npm start` (`node web/server.js`), and health-checks
   `/api/leaderboard` per [`railway.json`](../railway.json). On first boot the
   app creates its Postgres tables. Open the generated URL and play.

Verified locally by running the exact sequence Railway runs (`npm install`
then `npm start` from the repo root, not from `web/`) and confirming the
server boots, serves the SPA and API, and the healthcheck path returns 200.

## How it's built

No native dependencies beyond `pg`, so it installs cleanly on any platform.

- `server.js` — Express app: static hosting, JSON API, Clerk token verification.
- `game.js` — game rules: buying, selling, per-day settlement, portfolio,
  leaderboard. Uses atomic credit updates and a compare-and-set on settlement
  so concurrent requests can't double-credit.
- `wikimedia.js` — Wikipedia article search + pricing + daily pageview fetch.
- `store.js` — backend selector (JSON vs Postgres).
- `db/json-store.js` — JSON-file store for local dev (`data/db.json`).
- `db/pg-store.js` — Postgres store (auto-creates schema, atomic ops).
- `public/` — the single-page front end (`index.html`, `app.js`, `styles.css`).

### API (all JSON)

All routes marked "auth" require a Clerk session token as an `Authorization:
Bearer <token>` header; there's no separate register/login/logout — that's
entirely handled by Clerk's widget on the frontend.

| Method | Route              | Purpose                                   |
| ------ | ------------------ | ----------------------------------------- |
| GET    | `/api/me`          | Portfolio + settle earnings; JIT-provisions the account on first call (auth) |
| GET    | `/api/search?q=`   | Search articles, priced (auth)            |
| POST   | `/api/buy`         | Buy a page (auth)                         |
| POST   | `/api/sell`        | Sell a page (auth)                        |
| GET    | `/api/leaderboard` | Net-worth ranking                         |
| GET    | `/api/trending`    | Curated list of high-traffic articles     |
| GET    | `/api/categories`  | Category indexes (baskets of articles) for the ticker |
| GET    | `/api/history?article=&days=` | Daily view history for a chart (7-90 days) |
| GET    | `/api/portfolio-history?days=` | Combined daily views across your holdings (auth) |
| GET    | `/api/article?article=` | Detail bundle: price, meta, your position, watched (auth) |
| GET    | `/api/watchlist`   | Your watchlist, priced (auth)             |
| POST   | `/api/watchlist/toggle` | Watch/unwatch an article (auth)      |
| POST   | `/api/reprice`     | Force a fresh price check for one article (auth) |
| GET    | `/api/activity`    | Recent market events (claims, sells, joins, predictions) |
| POST   | `/api/bet`         | Place a 24h up/down price prediction (auth) |
| GET    | `/api/bets`        | Your open (settles due ones first) + resolved predictions (auth) |

The UI is **WikiMarket** — a light-themed, Robinhood-style trading dashboard:
left nav sidebar, header with global search and a category-index ticker
(each index is a basket of real articles priced from live pageviews),
a portfolio overview with an earnings chart and metric cards, a holdings
table with sparklines and real Wikipedia thumbnails, watchlist, market
movers, a live activity feed, and per-article detail pages with charts.

## Notes & limitations

- English Wikipedia only for now (the data model stores a project/lang per
  holding, so extending to other languages is straightforward).
- Auth/identity is entirely Clerk's; put the app behind HTTPS and add rate
  limiting before exposing it publicly, same as any real deployment.
- Reset the game by deleting `data/db.json` (JSON mode) or clearing the
  Postgres tables (`users`, `holdings`, `page_cache`, `watchlist`, `activity`,
  `bets`). Deleting rows doesn't touch Clerk — accounts stay valid there and
  simply get re-provisioned (with fresh starting credits) on next sign-in.
- Pageview prices are cached for 6 hours to be a good API citizen, so a
  page's price won't change more than a few times a day.
