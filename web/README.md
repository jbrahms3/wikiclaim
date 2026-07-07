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

## Run it

Requires Node.js 18+ (uses built-in `fetch`). From this `web/` folder:

```bash
npm install
npm start
```

Then open <http://localhost:3000>, sign up, and start trading. Set a custom
port with `PORT=8080 npm start`.

## How it's built

No database engine and no native dependencies, so it installs cleanly on any
platform.

- `server.js` — Express app: static hosting, JSON API, cookie/token auth.
- `game.js` — game rules: buying, selling, per-day settlement, portfolio,
  leaderboard.
- `wikimedia.js` — Wikipedia article search + pricing + daily pageview fetch.
- `store.js` — tiny JSON-file-backed data store (`data/db.json`), persisted on
  every mutation.
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

## Notes & limitations

- English Wikipedia only for now (the data model stores a project/lang per
  holding, so extending to other languages is straightforward).
- Passwords are hashed with bcrypt. Sessions are opaque tokens in an
  HttpOnly cookie. This is a game demo, not hardened production auth — put it
  behind HTTPS and add rate limiting before exposing it publicly.
- Data lives in `data/db.json`. Delete that file to reset the whole game.
- Pageview prices are cached for 6 hours to be a good API citizen, so a
  page's price won't change more than a few times a day.
