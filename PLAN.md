# Dibs: Implementation Plan

A tiny web app for giving away or selling my stuff before the move. Friends and colleagues browse items, call dibs, and bid against each other when more than one person wants the same thing.

**Guiding principle:** ship in an evening. One service, one database, no build step, no accounts.

---

## 1. How it works

| Concept | Rule |
|---|---|
| **Identity** | Simple accounts with a **name and password**, no email. Every page except `/login` requires being logged in. On the first visit, people land on `/login`, which has two buttons: **Log in** and **Create account**. Names are unique and case-insensitive ("alice" and "Alice" are the same account). A login cookie keeps people signed in for 90 days, and the same name and password work on any device. |
| **Forgotten password** | There's no email reset. The friend asks you, and you set a new password for them from `/admin`. |
| **Item price** | The admin sets a starting price for each item, in euros with cents (e.g. €2.50). `0` means free. |
| **Dibs** | The first person to click **"Dibs!"** places a bid at the starting price. The item now shows "Dibs by Alice". |
| **Auction** | Anyone else can then place a bid of at least `current highest + €0.10`. Once there are 2 or more bidders, the card shows "Auction: 3 bids, highest €25.40 (Bob)". |
| **Lowball offers** | Anyone can offer any amount, as long as it beats the current top (non-rejected) bid or offer by €0.10. Bids at or above the asking price count immediately. Bids below it are **pending** until the admin **accepts** them (they then count, and higher pending offers are accepted too) or **rejects** them (they stop counting, and the minimum drops back). When a higher bid or offer comes in (or the admin accepts one), lower pending offers are rejected automatically, so at most one offer waits per item. Once an offer is accepted, any higher bid counts straight away. Raising your own pending offer replaces it. |
| **Withdrawing** | On the product page, anyone with a bid on the item sees **"Remove my dibs"**. Clicking it deletes all their bids on that item, and the next-highest bid becomes the leader. This only works while the item is still available. It works from any device the person is logged in on. |
| **Closing** | The admin closes items by hand from `/admin` and marks them **Reserved** or **Gone**. Bidding and withdrawing stop, and the card shows the winner. There are no timers or cron jobs. |

The auction rule ("first bid = dibs, later bids must be higher") keeps the logic to one table and one check.

**Money is stored as whole cents** (`INTEGER`). The app converts euros to cents when a form is submitted and back when it displays a price, which avoids floating-point rounding errors.
---

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node 20 + Express** | One process serves pages, API and images |
| Views | **EJS templates + a bit of vanilla JS** | Server-rendered, no frontend build |
| Styling | **Pico.css** (single CDN `<link>`) | Looks decent with no custom CSS work |
| DB | **Postgres** (via the `pg` package) | Render's disk is temporary, so SQLite would be wiped on every deploy or restart |
| Images | Stored **in Postgres as `bytea`**, resized to ≤1000px JPEG with `sharp` on upload | No S3 or Cloudinary account needed. Images of about 100 KB each fit easily in a free DB |
| Uploads | `multer` (memory storage) | Simple |
| User auth | **`bcryptjs`** to hash passwords + **`cookie-session`** for a signed login cookie (key from the `SESSION_SECRET` env var) | Pure JavaScript, nothing to compile on Render. Storing hashes rather than plain passwords costs one line, and friends often reuse passwords |
| Admin auth | HTTP Basic Auth on `/admin*`, password read from the `ADMIN_PASSWORD` env var | About 5 lines of code. Separate from user accounts, so it works even before any account exists |

### Hosting decisions
- **Database: Neon** (free tier, no expiry). Everything is stored there, including images.
- **App: Render free web service.** Render's temporary disk doesn't matter here, because the app never writes to disk. Every deploy or restart is safe.
- **Cold starts:** the free service sleeps after about 15 min idle, and the first request after that takes about 30–50 s. If that's annoying during sale week, a free UptimeRobot monitor can ping it every 5 minutes to keep it awake.

---

## 3. Data model

```sql
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,                   -- bcrypt
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX ON users (lower(name));

CREATE TABLE items (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT DEFAULT '',
  start_price  INTEGER NOT NULL DEFAULT 0,      -- cents, 0 = free
  status       TEXT NOT NULL DEFAULT 'available', -- available | reserved | gone
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- Several photos per item, ordered by position. The first one is the homepage cover.
-- The admin reorders them with ◀ / ▶ buttons.
CREATE TABLE images (
  id          SERIAL PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  data        BYTEA NOT NULL                     -- always JPEG, resized to ≤1200px on upload
);

CREATE TABLE bids (
  id          SERIAL PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      INTEGER NOT NULL,                  -- cents
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON bids(item_id);
```

The app runs these statements with `CREATE TABLE IF NOT EXISTS` on startup, so no migration tool is needed.

---

## 4. Routes

### Auth
| Method | Path | Purpose |
|---|---|---|
| GET | `/login` | Name and password form with **Log in** and **Create account** buttons |
| POST | `/login` | Checks the password against the hash and sets `session.userId`. On failure it shows "Wrong name or password" |
| POST | `/register` | Creates the user if the name is free (otherwise "Name taken"), then logs them in. Password must be at least 4 characters |
| POST | `/logout` | Clears the session |

### Public (logged in)
Middleware redirects to `/login` when there's no session. It also redirects back to the page the person originally asked for after login, so shared item links work.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Grid of item cards: image, name, and a status badge (Available / Dibs by X / Auction: N bids, top €Y / Reserved / Gone) |
| GET | `/item/:id` | Product page: large image, name, description, start price, bid list (newest first), and the Dibs/Bid form |
| POST | `/item/:id/bid` | Body `{ amount }`, bidder taken from the session. Validates that the item is `available`, the amount is at least `start_price` when there are no bids, and at least `max + 10` cents otherwise. Redirects back to the item page |
| POST | `/item/:id/withdraw` | If the item is still `available`, deletes the logged-in user's bids on it. Redirects back to the item page |
| GET | `/img/:id` | Serves the image bytes with `Cache-Control: public, max-age=86400` |

The bid check runs inside a transaction (`SELECT ... FOR UPDATE` on the item row), so two simultaneous bids can't both win.

### Admin (Basic Auth)
| Method | Path | Purpose |
|---|---|---|
| GET | `/admin` | Table of all items: thumbnail, name, price, status, bid count, top bid, and Edit/Delete links. Includes an "Add item" form |
| POST | `/admin/items` | Create an item (multipart: name, description, start_price, image) |
| GET | `/admin/items/:id` | Edit form plus the full bid list, with a delete button per bid |
| POST | `/admin/items/:id` | Update fields. Optionally replace the image. Change the status |
| POST | `/admin/items/:id/delete` | Delete the item |
| POST | `/admin/bids/:id/delete` | Remove a bid |
| GET | `/admin/users` | List of users with their bid counts |
| POST | `/admin/users/:id/password` | Set a new password for a user who forgot theirs |
| POST | `/admin/users/:id/delete` | Delete a user and their bids, e.g. a typo account |

---

## 5. Frontend details

- **Header:** shows "Hi, Alice" and a **Log out** button.
- **Card grid:** CSS grid with `repeat(auto-fill, minmax(220px, 1fr))` and `object-fit: cover` images in a square aspect ratio. The whole card is an `<a>` linking to `/item/:id`.
- **Bid form:** if there are no bids, it shows one big **"Dibs! (€X / Free)"** button. Otherwise it shows a number input (`step="0.10"`) prefilled with `top + €0.10` and a **"Bid"** button. When the status isn't `available`, it shows "Reserved for Bob" instead.
- **Remove my dibs:** the server highlights the viewer's own bids and renders the **"Remove my dibs"** button only for people who have bids on the item, with a confirmation prompt.
- **Sorting:** available items first, then by `created_at desc`.
- Mobile-first, because people will open the link from WhatsApp or Slack.

---

## 6. Project layout

```
Dibs/
├── package.json        # express, ejs, pg, multer, sharp, bcryptjs, cookie-session
├── server.js           # all routes + DB init (~250 lines)
├── db.js               # pg Pool + schema bootstrap
├── views/
│   ├── layout.ejs      # head, Pico.css, header with user + logout
│   ├── login.ejs
│   ├── index.ejs
│   ├── item.ejs
│   ├── admin.ejs
│   ├── admin-edit.ejs
│   └── admin-users.ejs
├── public/app.js       # confirm prompts, small helpers
└── render.yaml         # optional blueprint
```

---

## 7. Deployment (Render)

1. Create a free Postgres on **neon.tech** and copy the connection string.
2. Push the repo to GitHub.
3. In Render, create a **New Web Service** from the repo:
   - Runtime: Node. Build command: `npm install`. Start command: `node server.js`
   - Instance type: **Free**
   - Env vars: `DATABASE_URL=<neon url>`, `ADMIN_PASSWORD=<something>`, `SESSION_SECRET=<long random string>`, `NODE_VERSION=20`
4. Open `https://<app>.onrender.com/admin`, log in, and upload the items.
5. Share the root URL with friends.

Set `ssl: { rejectUnauthorized: false }` in the `pg` Pool config, because Neon and Render both require SSL.

---

## 8. Milestones

| # | Step | Est. |
|---|---|---|
| 1 | Scaffold Express + EJS + Pico, connect to the DB, bootstrap the schema | 30 min |
| 2 | Admin: Basic Auth, create/list/edit/delete items, image upload with sharp resize | 1 h |
| 3 | Public homepage card grid + `/img/:id` | 30 min |
| 4 | Product page + bid logic with the transactional check | 45 min |
| 5 | Accounts: login/register page, sessions, login-required middleware | 45 min |
| 6 | "Remove my dibs" (withdraw route + button) | 20 min |
| 7 | Admin users page: reset password, delete user | 20 min |
| 8 | Deploy to Render with Neon and smoke test from a phone | 30 min |
| **Total** | | **≈ 4.5 h** |

### Nice-to-haves (only if time allows)
- Optional pickup-by date for each item, shown on the card
- Admin "Export CSV" of winners, to message people about pickups
- Payment note on the product page (e.g. "Tikkie / cash on pickup")
- Auto-refresh the item page every 30 s during busy auctions

### Explicitly out of scope
Email addresses and email password reset, email notifications, payments, timed auctions, rate limiting, and CSRF protection.
