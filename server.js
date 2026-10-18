// The COCO Boutique Hotel – website + management backend (Node 18+, no dependencies)
//
// Run:
//   ADMIN_USER=admin ADMIN_PASSWORD='a-long-password' SESSION_SECRET='long-random-text' node server.js
//
// Environment variables
//   ADMIN_USER / ADMIN_PASSWORD   Staff login for /admin (password: 10+ characters)
//   SESSION_SECRET                Signs login sessions (keep it fixed so staff stay logged in after restarts)
//   ADMIN_TOKEN                   (optional, legacy) a static token that also works for the API
//   ALLOWED_ORIGIN                Your website origin, e.g. https://yourdomain.com (default *)
//   ROOMS_TOTAL                   Number of Deluxe Rooms – turns on availability checks
//   RATE                          Price per room per night in rupees (default 5000)
//   TRUST_PROXY=1                 Set when behind nginx/Caddy/a host proxy so real visitor IPs are used
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   (optional) phone alerts for every new web booking
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET   (optional) online payment
//   PORT                          default 3000
//
// Files beside this one: hotel.html (public site), admin.html (staff dashboard), data.json (created automatically).
// Serve over HTTPS before going live.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const E = process.env;
const PORT = Number(E.PORT) || 3000;
const RATE = Number(E.RATE) || 5000;
const ROOMS = Number(E.ROOMS_TOTAL) || 0;
const ORIGIN = E.ALLOWED_ORIGIN || '*';
const LEGACY_TOKEN = E.ADMIN_TOKEN || '';
const ADMIN_USER = E.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = E.ADMIN_PASSWORD || '';
const SECRET = E.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_HOURS = 12;

const FILE = path.join(__dirname, 'data.json');
const HTML_FILE = path.join(__dirname, 'hotel.html');
const ADMIN_FILE = path.join(__dirname, 'admin.html');
const VENUES = ['hotel', 'kbowl', 'bcafe', 'deodar'];

if (!ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set – staff login is disabled.');
else if (ADMIN_PASSWORD.length < 10) console.warn('WARNING: use an ADMIN_PASSWORD of 10+ characters.');
if (!E.SESSION_SECRET) console.warn('NOTE: SESSION_SECRET not set – staff will be logged out whenever the server restarts.');

// ---------- storage ----------
let db = { bookings: [], reviews: [] };
try {
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  db.bookings = Array.isArray(saved.bookings) ? saved.bookings : [];
  db.reviews = Array.isArray(saved.reviews) ? saved.reviews : [];
} catch (e) {}
const save = () => {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, FILE);
};
const clip = (s, n) => String(s || '').trim().slice(0, n);
const nights = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

// ---------- rate limits ----------
const clientIp = req =>
  (E.TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') ||
  req.socket.remoteAddress || 'unknown';
const hits = {};
const limited = ip => {
  const now = Date.now();
  const a = (hits[ip] = (hits[ip] || []).filter(t => now - t < 600000));
  a.push(now);
  return a.length > 20;
};
const fails = {};
const loginBlocked = ip => (fails[ip] = (fails[ip] || []).filter(t => Date.now() - t < 900000)).length >= 5;

// ---------- staff auth (signed session tokens) ----------
const b64 = s => Buffer.from(s).toString('base64url');
const sign = data => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
const safeEq = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
function makeToken() {
  const payload = b64(JSON.stringify({ u: ADMIN_USER, exp: Date.now() + SESSION_HOURS * 3600000 }));
  return payload + '.' + sign(payload);
}
function readToken(t) {
  const [payload, sig] = String(t || '').split('.');
  if (!payload || !sig || !safeEq(sig, sign(payload))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return d.exp > Date.now() ? d : null;
  } catch (e) { return null; }
}
const admin = req => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return false;
  const t = h.slice(7);
  if (LEGACY_TOKEN && safeEq(t, LEGACY_TOKEN)) return true;
  return !!(ADMIN_PASSWORD && readToken(t));
};
const tickets = new Map(); // one-time, 60-second tickets for the live stream
setInterval(() => { for (const [k, v] of tickets) if (v < Date.now()) tickets.delete(k); }, 30000).unref();

// ---------- live events (Server-Sent Events) ----------
const clients = new Set();
function broadcast(event, data) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const c of clients) { try { c.write(msg); } catch (e) { clients.delete(c); } }
}
setInterval(() => { for (const c of clients) { try { c.write(': ping\n\n'); } catch (e) { clients.delete(c); } } }, 25000).unref();

function notify(text) { // optional phone alert via Telegram
  if (!E.TELEGRAM_BOT_TOKEN || !E.TELEGRAM_CHAT_ID) return;
  fetch('https://api.telegram.org/bot' + E.TELEGRAM_BOT_TOKEN + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: E.TELEGRAM_CHAT_ID, text })
  }).catch(e => console.error('Telegram notify failed:', e.message));
}

// ---------- http helpers ----------
function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS'
  });
  res.end(JSON.stringify(obj));
}
const body = req => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', chunk => {
    data += chunk;
    if (data.length > 20000) { reject(new Error('Request too large')); req.destroy(); }
  });
  req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
  req.on('error', reject);
});
function sendFile(res, file, extra) {
  fs.readFile(file, (err, html) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Could not load ' + path.basename(file) + '. Check that it is uploaded beside server.js.');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...extra });
    res.end(html);
  });
}

async function razorpay(path_, payload) {
  if (!E.RAZORPAY_KEY_ID || !E.RAZORPAY_KEY_SECRET) throw new Error('Online payment is not configured');
  const auth = Buffer.from(E.RAZORPAY_KEY_ID + ':' + E.RAZORPAY_KEY_SECRET).toString('base64');
  const response = await fetch('https://api.razorpay.com/v1' + path_, {
    method: 'POST', headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.description || 'Payment provider error');
  return result;
}

// ---------- bookings ----------
function makeBooking(b, source) {
  const staff = source === 'staff';
  const n = nights(b.ci, b.co);
  const rooms = +b.rm, guests = +b.gu;
  const today = new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.ci) || !/^\d{4}-\d{2}-\d{2}$/.test(b.co) || !(n >= 1 && n <= 30) || (b.ci < today && !staff))
    return { code: 400, error: 'Invalid dates' };
  if (!(rooms >= 1 && rooms <= 4) || !(guests >= 1 && guests <= 2 * rooms))
    return { code: 400, error: 'Each room sleeps 2 guests' };
  const name = clip(b.name, 80), phone = clip(b.phone, 20), email = clip(b.email, 120);
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || (staff && !email);
  if (name.length < 2 || !/^\+?[0-9 ()-]{10,15}$/.test(phone) || !emailOk)
    return { code: 400, error: 'Invalid contact details' };
  if (ROOMS) {
    for (let d = new Date(b.ci); d < new Date(b.co); d.setDate(d.getDate() + 1)) {
      const day = d.toISOString().slice(0, 10);
      const held = db.bookings.filter(x => x.status !== 'cancelled' && x.ci <= day && day < x.co).reduce((s, x) => s + x.rm, 0);
      if (held + rooms > ROOMS) return { code: 409, error: 'Sorry, no availability for those dates' };
    }
  }
  const booking = {
    ref: 'COCO-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
    ci: b.ci, co: b.co, rm: rooms, gu: guests, nights: n, total: n * rooms * RATE,
    name, phone, email, requests: clip(b.requests, 400),
    pay: b.pay === 'online' ? 'online' : 'hotel', paid: false,
    status: staff ? 'confirmed' : 'pending', source: staff ? 'staff' : 'web',
    at: new Date().toISOString()
  };
  db.bookings.push(booking);
  save();
  broadcast('booking.new', booking);
  if (!staff) notify('New booking ' + booking.ref + '\n' + name + ' · ' + phone + '\n' + b.ci + ' to ' + b.co + ' · ' + rooms + ' room(s), ' + guests + ' guest(s)\nTotal Rs ' + booking.total + ' · ' + booking.pay);
  return { booking };
}

// ---------- server ----------
http.createServer(async (req, res) => {
  const ip = clientIp(req);
  const p = new URL(req.url, 'http://localhost').pathname;
  const q = new URL(req.url, 'http://localhost').searchParams;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ORIGIN,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS'
    });
    return res.end();
  }

  try {
    // pages
    if (req.method === 'GET' && (p === '/' || p === '/hotel.html')) return sendFile(res, HTML_FILE);
    if (req.method === 'GET' && (p === '/admin' || p === '/admin/'))
      return sendFile(res, ADMIN_FILE, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff' });

    // public: reviews + bookings
    if (req.method === 'GET' && p === '/api/reviews') {
      return send(res, 200, db.reviews.filter(r => r.published !== false)
        .map(({ id, venue, stars, name, comment, at }) => ({ id, venue, stars, name, comment, at })));
    }
    if (req.method === 'POST' && p === '/api/reviews') {
      if (limited(ip)) return send(res, 429, { error: 'Too many requests, please try later' });
      const b = await body(req), stars = +b.stars, comment = clip(b.comment, 800);
      if (!VENUES.includes(b.venue) || !(stars >= 1 && stars <= 5) || comment.length < 10) return send(res, 400, { error: 'Invalid review' });
      const review = { id: crypto.randomUUID(), venue: b.venue, stars: Math.round(stars), name: clip(b.name, 60), comment, at: new Date().toISOString(), published: true };
      db.reviews.push(review); save();
      broadcast('review.new', review);
      return send(res, 201, review);
    }
    if (req.method === 'POST' && p === '/api/bookings') {
      if (limited(ip)) return send(res, 429, { error: 'Too many requests, please try later' });
      const r = makeBooking(await body(req), 'web');
      if (r.error) return send(res, r.code, { error: r.error });
      return send(res, 201, { ref: r.booking.ref, status: r.booking.status, total: r.booking.total });
    }

    // public: payments
    if (req.method === 'POST' && p === '/api/payments/order') {
      if (!E.RAZORPAY_KEY_ID || !E.RAZORPAY_KEY_SECRET) return send(res, 501, { error: 'Online payment not configured' });
      const ob = await body(req), booking = db.bookings.find(x => x.ref === ob.ref);
      if (!booking) return send(res, 404, { error: 'Not found' });
      const order = await razorpay('/orders', { amount: booking.total * 100, currency: 'INR', receipt: booking.ref });
      booking.orderId = order.id; save();
      return send(res, 200, { id: order.id, amount: order.amount });
    }
    if (req.method === 'POST' && p === '/api/payments/verify') {
      const b = await body(req), booking = db.bookings.find(x => x.ref === b.ref);
      if (!booking || booking.orderId !== b.razorpay_order_id) return send(res, 404, { error: 'Not found' });
      const signature = crypto.createHmac('sha256', E.RAZORPAY_KEY_SECRET || '').update(b.razorpay_order_id + '|' + b.razorpay_payment_id).digest('hex');
      if (signature !== b.razorpay_signature) return send(res, 400, { error: 'Payment verification failed' });
      booking.paid = true; booking.paymentId = b.razorpay_payment_id; save();
      broadcast('booking.updated', booking);
      notify('Payment received for ' + booking.ref + ' (Rs ' + booking.total + ')');
      return send(res, 200, { ok: true });
    }

    // staff: login
    if (req.method === 'POST' && p === '/api/admin/login') {
      if (!ADMIN_PASSWORD) return send(res, 503, { error: 'Staff login is not configured on the server' });
      if (loginBlocked(ip)) return send(res, 429, { error: 'Too many failed attempts. Try again in 15 minutes.' });
      const b = await body(req);
      const ok = safeEq(clip(b.user, 80), ADMIN_USER) && safeEq(String(b.password || ''), ADMIN_PASSWORD);
      if (!ok) { fails[ip].push(Date.now()); return send(res, 401, { error: 'Incorrect ID or password' }); }
      fails[ip] = [];
      return send(res, 200, { token: makeToken(), user: ADMIN_USER, hours: SESSION_HOURS });
    }

    // staff: live stream (EventSource cannot send headers, so it uses a one-time ticket)
    if (req.method === 'GET' && p === '/api/admin/stream') {
      const t = q.get('ticket'), exp = tickets.get(t);
      tickets.delete(t);
      if (!exp || exp < Date.now()) return send(res, 401, { error: 'Unauthorised' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': ORIGIN
      });
      res.write('retry: 3000\n\nevent: hello\ndata: {}\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    // staff routes
    if (p.startsWith('/api/admin/') || p === '/api/bookings' || /^\/api\/(bookings|reviews)\/[^/]+$/.test(p)) {
      if (!admin(req)) return send(res, 401, { error: 'Unauthorised' });

      if (req.method === 'POST' && p === '/api/admin/ticket') {
        const t = crypto.randomBytes(16).toString('hex');
        tickets.set(t, Date.now() + 60000);
        return send(res, 200, { ticket: t });
      }
      if (req.method === 'POST' && p === '/api/admin/bookings') { // walk-in / phone booking
        const r = makeBooking(await body(req), 'staff');
        if (r.error) return send(res, r.code, { error: r.error });
        return send(res, 201, r.booking);
      }
      if (req.method === 'GET' && p === '/api/bookings') return send(res, 200, db.bookings);
      if (req.method === 'GET' && p === '/api/admin/reviews') return send(res, 200, db.reviews);

      const id = p.split('/')[3];
      if (req.method === 'PATCH' && p.startsWith('/api/bookings/')) {
        const booking = db.bookings.find(x => x.ref === id), b = await body(req);
        if (!booking) return send(res, 404, { error: 'Not found' });
        if (b.status !== undefined) {
          if (!['pending', 'confirmed', 'cancelled'].includes(b.status)) return send(res, 400, { error: 'Invalid status' });
          booking.status = b.status;
        }
        if (b.paid !== undefined) booking.paid = !!b.paid;
        save(); broadcast('booking.updated', booking);
        return send(res, 200, booking);
      }
      if (req.method === 'PATCH' && p.startsWith('/api/reviews/')) {
        const review = db.reviews.find(x => x.id === id);
        if (!review) return send(res, 404, { error: 'Not found' });
        review.published = !!(await body(req)).published;
        save(); broadcast('review.updated', review);
        return send(res, 200, review);
      }
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) return send(res, 500, { error: 'Server error' });
    res.end();
  }
}).listen(PORT, '0.0.0.0', () => console.log('COCO server listening on port ' + PORT));
