// The COCO Boutique Hotel – backend (Node 18+, no dependencies)
// Run:  ADMIN_TOKEN=choose-a-long-secret ALLOWED_ORIGIN=https://yourdomain.com node server.js
// Optional env: PORT=3000  ROOMS_TOTAL=<number of Deluxe Rooms>  RATE=5000
//               RAZORPAY_KEY_ID=...  RAZORPAY_KEY_SECRET=...   (enables online payment)
// Data is stored in data.json next to this file (fine to start; move to a database as you grow).
// Put it behind HTTPS (e.g. nginx / Caddy / your host's TLS) before going live.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const E = process.env, PORT = +E.PORT || 3000, RATE = +E.RATE || 5000, ROOMS = +E.ROOMS_TOTAL || 0;
const ORIGIN = E.ALLOWED_ORIGIN || '*', TOKEN = E.ADMIN_TOKEN || '';
const FILE = path.join(__dirname, 'data.json');
const HTML_FILE = path.join(__dirname, 'hotel.html');
const VENUES = ['hotel', 'kbowl', 'bcafe', 'deodar'];
let db = { bookings: [], reviews: [] };
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
const save = () => fs.writeFileSync(FILE, JSON.stringify(db, null, 1));
const clip = (s, n) => String(s || '').trim().slice(0, n);
const hits = {}; // very small rate limiter: 20 writes / 10 min / IP
const limited = ip => { const n = Date.now(), a = (hits[ip] = (hits[ip] || []).filter(t => n - t < 6e5)); a.push(n); return a.length > 20; };
const admin = req => TOKEN && (req.headers.authorization || '') === 'Bearer ' + TOKEN;
const nights = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS' });
  res.end(JSON.stringify(obj));
}
const body = req => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > 2e4) { req.destroy(); no(); } });
  req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch (e) { no(e); } }); });

async function razorpay(path_, payload) {
  const auth = Buffer.from(E.RAZORPAY_KEY_ID + ':' + E.RAZORPAY_KEY_SECRET).toString('base64');
  const r = await fetch('https://api.razorpay.com/v1' + path_, { method: 'POST', headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const j = await r.json(); if (!r.ok) throw new Error((j.error && j.error.description) || 'Payment provider error'); return j;
}

http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress, u = new URL(req.url, 'http://x'), p = u.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, {});
  try {
    // Serve the Coming Soon homepage.
    if (req.method === 'GET' && (p === '/' || p === '/hotel.html')) {
      return fs.readFile(HTML_FILE, (err, html) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('The homepage could not be loaded. Make sure hotel.html is beside server.js.');
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        res.end(html);
      });
    }
    if (req.method === 'GET' && p === '/api/reviews')   // public: published reviews only
      return send(res, 200, db.reviews.filter(r => r.published !== false).map(({ id, venue, stars, name, comment, at }) => ({ id, venue, stars, name, comment, at })));
    if (req.method === 'POST' && p === '/api/reviews') {
      if (limited(ip)) return send(res, 429, { error: 'Too many requests, please try later' });
      const b = await body(req), s = +b.stars, c = clip(b.comment, 800);
      if (!VENUES.includes(b.venue) || !(s >= 1 && s <= 5) || c.length < 10) return send(res, 400, { error: 'Invalid review' });
      const r = { id: crypto.randomUUID(), venue: b.venue, stars: Math.round(s), name: clip(b.name, 60), comment: c, at: new Date().toISOString(), published: true };
      db.reviews.push(r); save(); return send(res, 201, r);
    }
    if (req.method === 'POST' && p === '/api/bookings') {
      if (limited(ip)) return send(res, 429, { error: 'Too many requests, please try later' });
      const b = await body(req), n = nights(b.ci, b.co), rm = +b.rm, gu = +b.gu;
      const today = new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.ci) || !/^\d{4}-\d{2}-\d{2}$/.test(b.co) || !(n >= 1 && n <= 30) || b.ci < today) return send(res, 400, { error: 'Invalid dates' });
      if (!(rm >= 1 && rm <= 4) || !(gu >= 1 && gu <= 2 * rm)) return send(res, 400, { error: 'Each room sleeps 2 guests' });
      const name = clip(b.name, 80), phone = clip(b.phone, 20), email = clip(b.email, 120);
      if (name.length < 2 || !/^\+?[0-9 ()-]{10,15}$/.test(phone) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'Invalid contact details' });
      if (ROOMS) { // availability: count rooms already held for any overlapping night
        for (let d = new Date(b.ci); d < new Date(b.co); d.setDate(d.getDate() + 1)) {
          const day = d.toISOString().slice(0, 10);
          const held = db.bookings.filter(x => x.status !== 'cancelled' && x.ci <= day && day < x.co).reduce((s, x) => s + x.rm, 0);
          if (held + rm > ROOMS) return send(res, 409, { error: 'Sorry, no availability for those dates' });
        }
      }
      const bk = { ref: 'COCO-' + crypto.randomBytes(3).toString('hex').toUpperCase(), ci: b.ci, co: b.co, rm, gu, nights: n, total: n * rm * RATE,
        name, phone, email, requests: clip(b.requests, 400), pay: b.pay === 'online' ? 'online' : 'hotel', paid: false, status: 'pending', at: new Date().toISOString() };
      db.bookings.push(bk); save(); return send(res, 201, { ref: bk.ref, status: bk.status, total: bk.total });
    }
    if (req.method === 'POST' && p === '/api/payments/order') {
      if (!E.RAZORPAY_KEY_ID) return send(res, 501, { error: 'Online payment not configured' });
      const ob = await body(req), bk = db.bookings.find(x => x.ref === ob.ref); if (!bk) return send(res, 404, { error: 'Not found' });
      const o = await razorpay('/orders', { amount: bk.total * 100, currency: 'INR', receipt: bk.ref });
      bk.orderId = o.id; save(); return send(res, 200, { id: o.id, amount: o.amount });
    }
    if (req.method === 'POST' && p === '/api/payments/verify') { // verifies Razorpay's signature server-side
      const b = await body(req), bk = db.bookings.find(x => x.ref === b.ref);
      if (!bk || bk.orderId !== b.razorpay_order_id) return send(res, 404, { error: 'Not found' });
      const sig = crypto.createHmac('sha256', E.RAZORPAY_KEY_SECRET || '').update(b.razorpay_order_id + '|' + b.razorpay_payment_id).digest('hex');
      if (sig !== b.razorpay_signature) return send(res, 400, { error: 'Payment verification failed' });
      bk.paid = true; bk.paymentId = b.razorpay_payment_id; save(); return send(res, 200, { ok: true });
    }
    // ---- staff routes (Authorization: Bearer ADMIN_TOKEN) ----
    if (p === '/api/bookings' || p === '/api/admin/reviews' || /^\/api\/(bookings|reviews)\/[^/]+$/.test(p)) {
      if (!admin(req)) return send(res, 401, { error: 'Unauthorised' });
      if (req.method === 'GET' && p === '/api/bookings') return send(res, 200, db.bookings);
      if (req.method === 'GET' && p === '/api/admin/reviews') return send(res, 200, db.reviews);
      const id = p.split('/')[3];
      if (req.method === 'PATCH' && p.startsWith('/api/bookings/')) {
        const bk = db.bookings.find(x => x.ref === id), s = (await body(req)).status;
        if (!bk || !['pending', 'confirmed', 'cancelled'].includes(s)) return send(res, 400, { error: 'Invalid' });
        bk.status = s; save(); return send(res, 200, bk);
      }
      if (req.method === 'PATCH' && p.startsWith('/api/reviews/')) {
        const r = db.reviews.find(x => x.id === id); if (!r) return send(res, 404, { error: 'Not found' });
        r.published = !!(await body(req)).published; save(); return send(res, 200, r);
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) { send(res, 500, { error: e.message || 'Server error' }); }
}).listen(PORT, '0.0.0.0', () => console.log('COCO backend on :' + PORT + (TOKEN ? '' : '  (set ADMIN_TOKEN to enable staff routes)')));
