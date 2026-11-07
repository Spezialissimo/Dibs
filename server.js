const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const sharp = require('sharp');
const bcrypt = require('bcryptjs');
const path = require('path');
const { pool, init, withTx } = require('./db');

const { PORT = 3000, ADMIN_PASSWORD, SESSION_SECRET, DATABASE_URL } = process.env;
if (!DATABASE_URL || !ADMIN_PASSWORD || !SESSION_SECRET) {
  console.error('Missing env vars. Required: DATABASE_URL, ADMIN_PASSWORD, SESSION_SECRET');
  process.exit(1);
}

const MIN_INCREMENT = 10; // cents
const MAX_PHOTOS_PER_UPLOAD = 10;
const STATUSES = ['available', 'reserved', 'gone'];
const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;

// A thrown UserError becomes a friendly flash message instead of a 500.
class UserError extends Error {}

// ---------- helpers ----------

const eur = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const money = (cents) => eur.format(cents / 100);
const price = (cents) => (cents === 0 ? 'Free' : money(cents));
const toInput = (cents) => (cents / 100).toFixed(2);
const when = (d) =>
  new Date(d).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam',
  });

// "2,50" / "2.50" / "2.5" / "€ 2" -> cents. Comma or point both work. Returns NaN if invalid.
function parseCents(value) {
  const s = String(value ?? '').replace(/[€\s]/g, '').replace(',', '.');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100);
}

const toId = (s) => (/^\d{1,9}$/.test(s) ? Number(s) : null);
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

// `leader` = highest accepted bidder. Pending offers don't count until accepted.
function badge(it) {
  const { leader } = it;
  if (it.status === 'gone') return { cls: 'gone', text: leader ? `Gone to ${leader}` : 'Gone' };
  if (it.status === 'reserved') return { cls: 'reserved', text: leader ? `Reserved for ${leader}` : 'Reserved' };
  if (!it.bidders) {
    return it.pending_count
      ? { cls: 'pending', text: it.pending_count === 1 ? 'Offer pending' : `${it.pending_count} offers pending` }
      : { cls: 'available', text: 'Available' };
  }
  if (it.bidders === 1) return { cls: 'dibs', text: `Dibs by ${leader}` };
  return { cls: 'auction', text: `Auction · ${it.bidders} people` };
}

function flash(req, type, msg) {
  req.session.flash = { type, msg };
}

// Resize uploads one at a time (keeps memory low on Render's 512 MB instance).
async function processImages(files = []) {
  const out = [];
  for (const file of files) {
    try {
      out.push(
        await sharp(file.buffer)
          .rotate() // respect phone EXIF orientation
          .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer()
      );
    } catch {
      throw new UserError(`Could not read "${file.originalname}". Please use JPEG, PNG or WebP photos.`);
    }
  }
  return out;
}

// Append photos after the item's current last photo.
async function addImages(db, itemId, buffers) {
  if (!buffers.length) return;
  const { rows: [{ max }] } = await db.query(
    'SELECT COALESCE(MAX(position), 0) AS max FROM images WHERE item_id = $1',
    [itemId]
  );
  for (const [i, data] of buffers.entries()) {
    await db.query('INSERT INTO images (item_id, position, data) VALUES ($1, $2, $3)', [itemId, max + i + 1, data]);
  }
}

async function getImageIds(itemId) {
  const { rows } = await pool.query('SELECT id FROM images WHERE item_id = $1 ORDER BY position, id', [itemId]);
  return rows.map((r) => r.id);
}

// ---------- queries ----------

const ITEM_SUMMARY_SQL = `
  SELECT i.id, i.name, i.description, i.start_price, i.status, i.created_at,
         (SELECT id FROM images WHERE item_id = i.id ORDER BY position, id LIMIT 1) AS cover_id,
         c.bid_count, c.bidders, c.pending_count, t.top, l.leader
  FROM items i
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE status <> 'rejected')::int AS bid_count,
           count(DISTINCT user_id) FILTER (WHERE status = 'accepted')::int AS bidders,
           count(*) FILTER (WHERE status = 'pending')::int AS pending_count
    FROM bids WHERE item_id = i.id
  ) c ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(x) AS top FROM (
      SELECT u.name, b.amount, b.status FROM bids b JOIN users u ON u.id = b.user_id
      WHERE b.item_id = i.id AND b.status <> 'rejected'
      ORDER BY b.amount DESC, b.created_at ASC LIMIT 3
    ) x
  ) t ON true
  LEFT JOIN LATERAL (
    SELECT u.name AS leader FROM bids b JOIN users u ON u.id = b.user_id
    WHERE b.item_id = i.id AND b.status = 'accepted'
    ORDER BY b.amount DESC, b.created_at ASC LIMIT 1
  ) l ON true`;

async function listItems() {
  const { rows } = await pool.query(
    `${ITEM_SUMMARY_SQL} ORDER BY (i.status = 'available') DESC, i.created_at DESC`
  );
  return rows;
}

async function getItem(id) {
  const { rows } = await pool.query(`${ITEM_SUMMARY_SQL} WHERE i.id = $1`, [id]);
  return rows[0];
}

async function getBids(itemId) {
  const { rows } = await pool.query(
    `SELECT b.id, b.amount, b.created_at, b.user_id, b.status, u.name
     FROM bids b JOIN users u ON u.id = b.user_id
     WHERE b.item_id = $1
     ORDER BY (b.status = 'rejected'), b.amount DESC, b.created_at ASC`,
    [itemId]
  );
  return rows;
}

// The bid every new bid must beat: highest bid that isn't rejected (pending offers count too).
async function topLiveBid(db, itemId) {
  const { rows } = await db.query(
    `SELECT amount, user_id, status FROM bids WHERE item_id = $1 AND status <> 'rejected'
     ORDER BY amount DESC, created_at ASC LIMIT 1`,
    [itemId]
  );
  return rows[0];
}

// ---------- app setup ----------

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
Object.assign(app.locals, { money, price, toInput, when, badge });

app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(cookieSession({ name: 'dibs', keys: [SESSION_SECRET], maxAge: NINETY_DAYS, sameSite: 'lax', httpOnly: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: MAX_PHOTOS_PER_UPLOAD },
}).array('images', MAX_PHOTOS_PER_UPLOAD);

// Load the logged-in user and any one-shot flash message.
app.use(async (req, res, next) => {
  res.locals.user = null;
  if (req.session.userId) {
    const { rows } = await pool.query('SELECT id, name FROM users WHERE id = $1', [req.session.userId]);
    if (rows[0]) res.locals.user = rows[0];
    else delete req.session.userId; // account was deleted
  }
  if (req.session.flash) {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
  }
  next();
});

// ---------- images (public, so admin pages can show them too) ----------

app.get('/img/:id', async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.sendStatus(404);
  const { rows } = await pool.query('SELECT data FROM images WHERE id = $1', [id]);
  if (!rows[0]) return res.sendStatus(404);
  // Image rows never change (reordering only changes `position`), so cache forever.
  res.set('Cache-Control', 'public, max-age=31536000, immutable').type('image/jpeg').send(rows[0].data);
});

// ---------- auth ----------

app.get('/login', (req, res) => {
  const nextUrl = safeNext(req.query.next);
  if (res.locals.user) return res.redirect(nextUrl);
  res.render('login', { title: 'Log in', nextUrl, name: '' });
});

app.post('/login', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const password = String(req.body.password || '');
  const nextUrl = safeNext(req.body.next);
  const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE lower(name) = lower($1)', [name]);
  if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) {
    return res.status(401).render('login', { title: 'Log in', nextUrl, name, error: 'Wrong name or password.' });
  }
  req.session.userId = rows[0].id;
  res.redirect(nextUrl);
});

app.post('/register', async (req, res) => {
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  const password = String(req.body.password || '');
  const nextUrl = safeNext(req.body.next);
  const fail = (error) => res.status(400).render('login', { title: 'Log in', nextUrl, name, error });

  if (!name || name.length > 40) return fail('Pick a name (max 40 characters).');
  if (password.length < 4) return fail('Password must be at least 4 characters.');

  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (name, password_hash) VALUES ($1, $2) RETURNING id',
      [name, hash]
    );
    req.session.userId = rows[0].id;
  } catch (err) {
    if (err.code === '23505') return fail(`"${name}" is taken. Log in instead, or pick another name.`);
    throw err;
  }
  flash(req, 'ok', `Welcome, ${name}!`);
  res.redirect(nextUrl);
});

app.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

// ---------- admin (HTTP Basic Auth, separate from user accounts) ----------

const admin = express.Router();

admin.use((req, res, next) => {
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (password === ADMIN_PASSWORD) {
      res.locals.isAdmin = true;
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Dibs admin"').status(401).send('Admin password required.');
});

function readItemForm(req) {
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  const rawPrice = String(req.body.start_price || '').trim();
  const startPrice = rawPrice === '' ? 0 : parseCents(rawPrice);
  if (!name) throw new UserError('Name is required.');
  if (!Number.isFinite(startPrice)) throw new UserError('Price must be a number like 5 or 2,50.');
  return { name, description, startPrice };
}

admin.get('/', async (req, res) => {
  res.render('admin', { title: 'Admin', items: await listItems() });
});

admin.post('/items', upload, async (req, res) => {
  try {
    const { name, description, startPrice } = readItemForm(req);
    const images = await processImages(req.files);
    await withTx(async (db) => {
      const { rows: [item] } = await db.query(
        'INSERT INTO items (name, description, start_price) VALUES ($1, $2, $3) RETURNING id',
        [name, description, startPrice]
      );
      await addImages(db, item.id, images);
    });
    flash(req, 'ok', `Added "${name}".`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    flash(req, 'error', err.message);
  }
  res.redirect('/admin');
});

admin.get('/items/:id', async (req, res) => {
  const id = toId(req.params.id);
  const item = id && (await getItem(id));
  if (!item) return res.status(404).send('Item not found.');
  const bids = await getBids(id);
  res.render('admin-edit', {
    title: `Edit ${item.name}`,
    item,
    imageIds: await getImageIds(id),
    bids,
    leaderId: bids.find((b) => b.status === 'accepted')?.id,
    statuses: STATUSES,
  });
});

admin.post('/items/:id', upload, async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.sendStatus(404);
  try {
    const { name, description, startPrice } = readItemForm(req);
    const status = STATUSES.includes(req.body.status) ? req.body.status : 'available';
    const images = await processImages(req.files);
    await withTx(async (db) => {
      await db.query(
        `UPDATE items SET name = $2, description = $3, start_price = $4, status = $5, updated_at = now()
         WHERE id = $1`,
        [id, name, description, startPrice, status]
      );
      await addImages(db, id, images);
    });
    flash(req, 'ok', images.length ? `Saved, ${images.length} photo(s) added.` : 'Saved.');
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    flash(req, 'error', err.message);
  }
  res.redirect(`/admin/items/${id}`);
});

// Reorder a photo: dir = left | right. Positions are rewritten as 1..n.
admin.post('/images/:id/move', async (req, res) => {
  const id = toId(req.params.id);
  const itemId = await withTx(async (db) => {
    const { rows: [img] } = await db.query('SELECT item_id FROM images WHERE id = $1', [id]);
    if (!img) return null;
    // Lock the item so two reorders of the same item can't interleave.
    await db.query('SELECT 1 FROM items WHERE id = $1 FOR UPDATE', [img.item_id]);
    const { rows } = await db.query('SELECT id FROM images WHERE item_id = $1 ORDER BY position, id', [img.item_id]);
    const ids = rows.map((r) => r.id);
    const i = ids.indexOf(id);
    const j = { left: i - 1, right: i + 1 }[req.body.dir];
    if (j !== undefined && j >= 0 && j < ids.length && j !== i) {
      const [moved] = ids.splice(i, 1);
      ids.splice(j, 0, moved);
      await db.query(
        `UPDATE images SET position = t.pos
         FROM unnest($1::int[]) WITH ORDINALITY AS t(id, pos) WHERE images.id = t.id`,
        [ids]
      );
    }
    return img.item_id;
  });
  res.redirect(itemId ? `/admin/items/${itemId}#photos` : '/admin');
});

admin.post('/images/:id/delete', async (req, res) => {
  const id = toId(req.params.id);
  const { rows } = await pool.query('DELETE FROM images WHERE id = $1 RETURNING item_id', [id]);
  if (!rows[0]) return res.redirect('/admin');
  flash(req, 'ok', 'Photo deleted.');
  res.redirect(`/admin/items/${rows[0].item_id}#photos`);
});

admin.post('/items/:id/delete', async (req, res) => {
  const id = toId(req.params.id);
  if (id) await pool.query('DELETE FROM items WHERE id = $1', [id]);
  flash(req, 'ok', 'Item deleted.');
  res.redirect('/admin');
});

admin.post('/bids/:id/delete', async (req, res) => {
  const id = toId(req.params.id);
  const { rows } = await pool.query('DELETE FROM bids WHERE id = $1 RETURNING item_id', [id]);
  if (!rows[0]) return res.redirect('/admin');
  flash(req, 'ok', 'Bid removed.');
  res.redirect(`/admin/items/${rows[0].item_id}#bids`);
});

// Accept an offer: it now counts, and any higher pending offers count too
// (if this price is fine, a higher one obviously is); lower pending offers are rejected.
// Others can keep outbidding.
admin.post('/bids/:id/accept', async (req, res) => {
  const id = toId(req.params.id);
  const itemId = await withTx(async (db) => {
    const { rows: [bid] } = await db.query('SELECT item_id, amount FROM bids WHERE id = $1', [id]);
    if (!bid) return null;
    await db.query('SELECT 1 FROM items WHERE id = $1 FOR UPDATE', [bid.item_id]);
    await db.query(`UPDATE bids SET status = 'accepted' WHERE id = $1`, [id]);
    await db.query(
      `UPDATE bids SET status = 'accepted' WHERE item_id = $1 AND status = 'pending' AND amount > $2`,
      [bid.item_id, bid.amount]
    );
    await db.query(
      `UPDATE bids SET status = 'rejected' WHERE item_id = $1 AND status = 'pending' AND amount < $2`,
      [bid.item_id, bid.amount]
    );
    return bid.item_id;
  });
  if (!itemId) return res.redirect('/admin');
  flash(req, 'ok', 'Offer accepted.');
  res.redirect(`/admin/items/${itemId}#bids`);
});

// Reject: the bid stops counting. The minimum drops back, so anyone can make a new offer.
admin.post('/bids/:id/reject', async (req, res) => {
  const id = toId(req.params.id);
  const { rows } = await pool.query(`UPDATE bids SET status = 'rejected' WHERE id = $1 RETURNING item_id`, [id]);
  if (!rows[0]) return res.redirect('/admin');
  flash(req, 'ok', 'Offer rejected.');
  res.redirect(`/admin/items/${rows[0].item_id}#bids`);
});

admin.get('/users', async (req, res) => {
  const { rows: users } = await pool.query(
    `SELECT u.id, u.name, u.created_at, count(b.id)::int AS bid_count
     FROM users u LEFT JOIN bids b ON b.user_id = u.id
     GROUP BY u.id ORDER BY lower(u.name)`
  );
  res.render('admin-users', { title: 'Users', users });
});

admin.post('/users/:id/password', async (req, res) => {
  const id = toId(req.params.id);
  const password = String(req.body.password || '');
  if (password.length < 4) {
    flash(req, 'error', 'Password must be at least 4 characters.');
  } else {
    const { rows } = await pool.query(
      'UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING name',
      [id, await bcrypt.hash(password, 10)]
    );
    if (rows[0]) flash(req, 'ok', `New password set for ${rows[0].name}.`);
  }
  res.redirect('/admin/users');
});

admin.post('/users/:id/delete', async (req, res) => {
  const id = toId(req.params.id);
  const { rows } = await pool.query('DELETE FROM users WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) flash(req, 'ok', `Deleted ${rows[0].name} and their bids.`);
  res.redirect('/admin/users');
});

app.use('/admin', admin);

// ---------- everything below requires a logged-in user ----------

app.use((req, res, next) => {
  if (res.locals.user) return next();
  const nextUrl = req.method === 'GET' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
  res.redirect(`/login${nextUrl}`);
});

app.get('/', async (req, res) => {
  res.render('index', { items: await listItems() });
});

app.get('/item/:id', async (req, res) => {
  const id = toId(req.params.id);
  const item = id && (await getItem(id));
  if (!item) return res.status(404).render('notfound', { title: 'Not found' });

  const bids = await getBids(id);
  const me = res.locals.user.id;
  const top = bids.find((b) => b.status !== 'rejected'); // the bid to beat
  const leader = bids.find((b) => b.status === 'accepted');
  const minBid = top ? top.amount + MIN_INCREMENT : 0;
  // Lowest accepted offer below the asking price = the price I agreed to lower it to.
  const lowballs = bids.filter((b) => b.status === 'accepted' && b.amount < item.start_price).map((b) => b.amount);
  res.render('item', {
    lowballedPrice: lowballs.length ? Math.min(...lowballs) : null,
    title: item.name,
    item,
    imageIds: await getImageIds(id),
    bids,
    minBid,
    leaderId: leader?.id,
    isTop: top?.user_id === me && top.status === 'accepted',
    myPending: top?.user_id === me && top.status === 'pending' ? top : null,
    // The one-click "Dibs!" at the asking price, while nobody has an accepted bid yet.
    showDibs: !leader && item.start_price >= minBid,
    // Below-asking offers need approval only until someone has an accepted bid.
    needsApproval: !leader && item.start_price > 0,
    hasMyBids: bids.some((b) => b.user_id === me),
  });
});

app.post('/item/:id/bid', async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.sendStatus(404);
  const me = res.locals.user.id;
  const amount = parseCents(req.body.amount);

  try {
    if (!Number.isFinite(amount)) throw new UserError('Enter an amount like 5 or 2,50.');
    const result = await withTx(async (db) => {
      // Lock the item row so two simultaneous bids can't both pass the check.
      const { rows: [item] } = await db.query('SELECT status, start_price FROM items WHERE id = $1 FOR UPDATE', [id]);
      if (!item) throw new UserError('That item no longer exists.');
      if (item.status !== 'available') throw new UserError('Sorry, this item is no longer available.');

      const top = await topLiveBid(db, id);
      if (top?.user_id === me && top.status === 'accepted') throw new UserError("You're already the highest bidder.");
      const min = top ? top.amount + MIN_INCREMENT : 0;
      if (amount < min) throw new UserError(`The minimum is ${money(min)}.`);

      const { rows: [{ has_leader }] } = await db.query(
        `SELECT EXISTS (SELECT 1 FROM bids WHERE item_id = $1 AND status = 'accepted') AS has_leader`,
        [id]
      );
      // Counts straight away if it meets the asking price, or beats an offer the owner already accepted.
      const status = amount >= item.start_price || has_leader ? 'accepted' : 'pending';

      // Raising your own offer replaces your earlier pending offers.
      await db.query(`DELETE FROM bids WHERE item_id = $1 AND user_id = $2 AND status = 'pending'`, [id, me]);
      await db.query('INSERT INTO bids (item_id, user_id, amount, status) VALUES ($1, $2, $3, $4)', [id, me, amount, status]);
      // Lower offers still waiting for approval are rejected straight away.
      await db.query(
        `UPDATE bids SET status = 'rejected' WHERE item_id = $1 AND status = 'pending' AND amount < $2`,
        [id, amount]
      );
      return { status, first: !has_leader };
    });
    let msg;
    if (result.status === 'pending') msg = `Offer of ${money(amount)} sent. You'll see here when it's accepted or rejected.`;
    else if (result.first) msg = "Dibs! It's yours unless someone outbids you.";
    else msg = `Bid of ${money(amount)} placed!`;
    flash(req, 'ok', msg);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    flash(req, 'error', err.message);
  }
  res.redirect(`/item/${id}`);
});

app.post('/item/:id/withdraw', async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.sendStatus(404);
  try {
    await withTx(async (db) => {
      const { rows: [item] } = await db.query('SELECT status FROM items WHERE id = $1 FOR UPDATE', [id]);
      if (!item) throw new UserError('That item no longer exists.');
      if (item.status !== 'available') throw new UserError('This item is closed. Ask the owner if you need to back out.');
      const { rowCount } = await db.query('DELETE FROM bids WHERE item_id = $1 AND user_id = $2', [id, res.locals.user.id]);
      if (!rowCount) throw new UserError("You don't have any dibs on this item.");
    });
    flash(req, 'ok', 'Your dibs have been removed.');
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    flash(req, 'error', err.message);
  }
  res.redirect(`/item/${id}`);
});

// ---------- errors ----------

app.use((req, res) => res.status(404).render('notfound', { title: 'Not found' }));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: 'One of the photos is too large (max 15 MB each).',
      LIMIT_FILE_COUNT: `Upload at most ${MAX_PHOTOS_PER_UPLOAD} photos at a time.`,
      LIMIT_UNEXPECTED_FILE: `Upload at most ${MAX_PHOTOS_PER_UPLOAD} photos at a time.`,
    };
    flash(req, 'error', messages[err.code] || err.message);
    return res.redirect(req.get('Referer') || '/admin');
  }
  console.error(err);
  res.status(500).send('Something went wrong. Please try again.');
});

init()
  .then(() => app.listen(PORT, () => console.log(`Dibs listening on http://localhost:${PORT}`)))
  .catch((err) => {
    console.error('Could not initialise the database:', err);
    process.exit(1);
  });
