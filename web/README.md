# WikiClaim (web)

A multiplayer game where you **buy Wikipedia articles at the price of their
daily traffic** and **earn credits every day for every real visitor** those
articles get. Prices and earnings both come from the live
[Wikimedia Pageviews API](https://wikimedia.org/api/rest_v1/#/Pageviews%20data).

Everyone starts with **250 credits**. Buy pages you think are undervalued (or
about to spike), collect their daily views as income, sell when you like, and
climb the shared net-worth leaderboard.

## The rules

- **Price of a page** = its average daily pageviews over the last 30 days
  (human traffic only; bots excluded). Minimum price is 1.
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
npm start
```

Then open <http://localhost:3000>, sign up, and start trading. Set a custom
port with `PORT=8080 npm start`.

With no `DATABASE_URL` set, the app stores everything in a local JSON file
(`data/db.json`) — zero setup. Set `DATABASE_URL` to use Postgres instead.

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
4. **Deploy** — Railway auto-detects Node from the root `package.json`, runs
   `npm install` (which also installs `web/`'s dependencies via
   `postinstall`), then `npm start` (`node web/server.js`), and health-checks
   `/api/leaderboard` per [`railway.json`](../railway.json). On first boot the
   app creates its Postgres tables. Open the generated URL and play.

Verified locally by running the exact sequence Railway runs (`npm install`
then `npm start` from the repo root, not from `web/`) and confirming the
server boots, serves the SPA and API, and the healthcheck path returns 200.

## How it's built

No native dependencies beyond `pg`, so it installs cleanly on any platform.

- `server.js` — Express app: static hosting, JSON API, cookie/token auth.
- `game.js` — game rules: buying, selling, per-day settlement, portfolio,
  leaderboard. Uses atomic credit updates and a compare-and-set on settlement
  so concurrent requests can't double-credit.
- `wikimedia.js` — Wikipedia article search + pricing + daily pageview fetch.
- `store.js` — backend selector (JSON vs Postgres).
- `db/json-store.js` — JSON-file store for local dev (`data/db.json`).
- `db/pg-store.js` — Postgres store (auto-creates schema, atomic ops).
- `public/` — the single-page front end (`index.html`, `app.js`, `styles.css`).

### API (all JSON)

| Method | Route              | Purpose                                   |
| ------ | ------------------ | ----------------------------------------- |
| POST   | `/api/register`    | Create account (250 starting credits)     |
| POST   | `/api/login`       | Log in                                    |
| POST   | `/api/logout`      | Log out                                   |
| GET    | `/api/me`          | Portfolio + settle earnings (auth)        |
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
- Passwords are hashed with bcrypt. Sessions are opaque tokens in an
  HttpOnly cookie. This is a game demo, not hardened production auth — put it
  behind HTTPS and add rate limiting before exposing it publicly.
- Reset the game by deleting `data/db.json` (JSON mode) or clearing the
  Postgres tables (`users`, `holdings`, `sessions`, `page_cache`, `watchlist`,
  `activity`, `bets`).
- Pageview prices are cached for 6 hours to be a good API citizen, so a
  page's price won't change more than a few times a day.
