
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const E = process.env;
const PORT = Number(E.PORT) || 3000;
const RATE = Number(E.RATE) || 5000;
const ROOMS = Number(E.ROOMS_TOTAL) || 0;
const ORIGIN = E.ALLOWED_ORIGIN || '*';
const TOKEN = E.ADMIN_TOKEN || '';

const FILE = path.join(__dirname, 'data.json');
const HTML_FILE = path.join(__dirname, 'hotel.html');
const VENUES = ['hotel', 'kbowl', 'bcafe', 'deodar'];

let db = { bookings: [], reviews: [] };

try {
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  db.bookings = Array.isArray(saved.bookings) ? saved.bookings : [];
  db.reviews = Array.isArray(saved.reviews) ? saved.reviews : [];
} catch (e) {}

const save = () => fs.writeFileSync(FILE, JSON.stringify(db, null, 1));
const clip = (s, n) => String(s || '').trim().slice(0, n);
const hits = {};

const limited = ip => {
  const now = Date.now();
  const a = hits[ip] = (hits[ip] || []).filter(t => now - t < 600000);
  a.push(now);
  return a.length > 20;
};

const admin = req =>
  TOKEN && (req.headers.authorization || '') === 'Bearer ' + TOKEN;

const nights = (a, b) =>
  Math.round((new Date(b) - new Date(a)) / 86400000);

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
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
    if (data.length > 20000) {
      reject(new Error('Request too large'));
      req.destroy();
    }
  });

  req.on('end', () => {
    try {
      resolve(JSON.parse(data || '{}'));
    } catch (e) {
      reject(e);
    }
  });

  req.on('error', reject);
});

async function razorpay(path_, payload) {
  if (!E.RAZORPAY_KEY_ID || !E.RAZORPAY_KEY_SECRET) {
    throw new Error('Online payment is not configured');
  }

  const auth = Buffer.from(
    E.RAZORPAY_KEY_ID + ':' + E.RAZORPAY_KEY_SECRET
  ).toString('base64');

  const response = await fetch(
    'https://api.razorpay.com/v1' + path_,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + auth,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      result.error?.description || 'Payment provider error'
    );
  }

  return result;
}

http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || 'unknown';
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ORIGIN,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS'
    });
    return res.end();
  }

  try {
    // Serve the hotel homepage instead of returning JSON 404.
    if (
      req.method === 'GET' &&
      (p === '/' || p === '/hotel.html')
    ) {
      return fs.readFile(HTML_FILE, (err, html) => {
        if (err) {
          res.writeHead(500, {
            'Content-Type': 'text/plain; charset=utf-8'
          });
          return res.end(
            'The hotel homepage could not be loaded. Check that hotel.html is uploaded beside server.js.'
          );
        }

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        res.end(html);
      });
    }

    // Public reviews: only published reviews.
    if (req.method === 'GET' && p === '/api/reviews') {
      return send(
        res,
        200,
        db.reviews
          .filter(r => r.published !== false)
          .map(({ id, venue, stars, name, comment, at }) => ({
            id, venue, stars, name, comment, at
          }))
      );
    }

    if (req.method === 'POST' && p === '/api/reviews') {
      if (limited(ip)) {
        return send(res, 429, {
          error: 'Too many requests, please try later'
        });
      }

      const b = await body(req);
      const stars = +b.stars;
      const comment = clip(b.comment, 800);

      if (
        !VENUES.includes(b.venue) ||
        !(stars >= 1 && stars <= 5) ||
        comment.length < 10
      ) {
        return send(res, 400, { error: 'Invalid review' });
      }

      const review = {
        id: crypto.randomUUID(),
        venue: b.venue,
        stars: Math.round(stars),
        name: clip(b.name, 60),
        comment,
        at: new Date().toISOString(),
        published: true
      };

      db.reviews.push(review);
      save();
      return send(res, 201, review);
    }

    if (req.method === 'POST' && p === '/api/bookings') {
      if (limited(ip)) {
        return send(res, 429, {
          error: 'Too many requests, please try later'
        });
      }

      const b = await body(req);
      const n = nights(b.ci, b.co);
      const rooms = +b.rm;
      const guests = +b.gu;
      const today = new Date().toISOString().slice(0, 10);

      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(b.ci) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(b.co) ||
        !(n >= 1 && n <= 30) ||
        b.ci < today
      ) {
        return send(res, 400, { error: 'Invalid dates' });
      }

      if (
        !(rooms >= 1 && rooms <= 4) ||
        !(guests >= 1 && guests <= 2 * rooms)
      ) {
        return send(res, 400, {
          error: 'Each room sleeps 2 guests'
        });
      }

      const name = clip(b.name, 80);
      const phone = clip(b.phone, 20);
      const email = clip(b.email, 120);

      if (
        name.length < 2 ||
        !/^\+?[0-9 ()-]{10,15}$/.test(phone) ||
        !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
      ) {
        return send(res, 400, {
          error: 'Invalid contact details'
        });
      }

      if (ROOMS) {
        for (
          let d = new Date(b.ci);
          d < new Date(b.co);
          d.setDate(d.getDate() + 1)
        ) {
          const day = d.toISOString().slice(0, 10);

          const held = db.bookings
            .filter(x =>
              x.status !== 'cancelled' &&
              x.ci <= day &&
              day < x.co
            )
            .reduce((sum, x) => sum + x.rm, 0);

          if (held + rooms > ROOMS) {
            return send(res, 409, {
              error: 'Sorry, no availability for those dates'
            });
          }
        }
      }

      const booking = {
        ref: 'COCO-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
        ci: b.ci,
        co: b.co,
        rm: rooms,
        gu: guests,
        nights: n,
        total: n * rooms * RATE,
        name,
        phone,
        email,
        requests: clip(b.requests, 400),
        pay: b.pay === 'online' ? 'online' : 'hotel',
        paid: false,
        status: 'pending',
        at: new Date().toISOString()
      };

      db.bookings.push(booking);
      save();

      return send(res, 201, {
        ref: booking.ref,
        status: booking.status,
        total: booking.total
      });
    }

    if (req.method === 'POST' && p === '/api/payments/order') {
      if (!E.RAZORPAY_KEY_ID || !E.RAZORPAY_KEY_SECRET) {
        return send(res, 501, {
          error: 'Online payment not configured'
        });
      }

      const ob = await body(req);
      const booking = db.bookings.find(x => x.ref === ob.ref);

      if (!booking) {
        return send(res, 404, { error: 'Not found' });
      }

      const order = await razorpay('/orders', {
        amount: booking.total * 100,
        currency: 'INR',
        receipt: booking.ref
      });

      booking.orderId = order.id;
      save();

      return send(res, 200, {
        id: order.id,
        amount: order.amount
      });
    }

    if (req.method === 'POST' && p === '/api/payments/verify') {
      const b = await body(req);
      const booking = db.bookings.find(x => x.ref === b.ref);

      if (!booking || booking.orderId !== b.razorpay_order_id) {
        return send(res, 404, { error: 'Not found' });
      }

      const signature = crypto
        .createHmac('sha256', E.RAZORPAY_KEY_SECRET || '')
        .update(b.razorpay_order_id + '|' + b.razorpay_payment_id)
        .digest('hex');

      if (signature !== b.razorpay_signature) {
        return send(res, 400, {
          error: 'Payment verification failed'
        });
      }

      booking.paid = true;
      booking.paymentId = b.razorpay_payment_id;
      save();

      return send(res, 200, { ok: true });
    }

    // Staff routes require ADMIN_TOKEN.
    if (
      p === '/api/bookings' ||
      p === '/api/admin/reviews' ||
      /^\/api\/(bookings|reviews)\/[^/]+$/.test(p)
    ) {
      if (!admin(req)) {
        return send(res, 401, { error: 'Unauthorised' });
      }

      if (req.method === 'GET' && p === '/api/bookings') {
        return send(res, 200, db.bookings);
      }

      if (req.method === 'GET' && p === '/api/admin/reviews') {
        return send(res, 200, db.reviews);
      }

      const id = p.split('/')[3];

      if (req.method === 'PATCH' && p.startsWith('/api/bookings/')) {
        const booking = db.bookings.find(x => x.ref === id);
        const status = (await body(req)).status;

        if (
          !booking ||
          !['pending', 'confirmed', 'cancelled'].includes(status)
        ) {
          return send(res, 400, { error: 'Invalid' });
        }

        booking.status = status;
        save();
        return send(res, 200, booking);
      }

      if (req.method === 'PATCH' && p.startsWith('/api/reviews/')) {
        const review = db.reviews.find(x => x.id === id);

        if (!review) {
          return send(res, 404, { error: 'Not found' });
        }

        review.published = !!(await body(req)).published;
        save();
        return send(res, 200, review);
      }
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      return send(res, 500, {
        error: 'Server error'
      });
    }
    res.end();
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log('COCO server listening on port ' + PORT);
});
