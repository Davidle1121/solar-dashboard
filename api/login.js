import { buildAuthSetCookie } from './_auth.js';

const attemptsByIp = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function getIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(req) {
  const ip = getIp(req);
  const now = Date.now();
  const rec = attemptsByIp.get(ip) || { count: 0, startedAt: now };
  if (now - rec.startedAt > WINDOW_MS) {
    rec.count = 0;
    rec.startedAt = now;
  }
  rec.count += 1;
  attemptsByIp.set(ip, rec);
  return rec.count > MAX_ATTEMPTS;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (isRateLimited(req)) {
      return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    }

    const { password } = req.body || {};
    const expectedPassword = process.env.SITE_PASSWORD;

    if (!expectedPassword) {
      return res.status(500).json({ error: 'SITE_PASSWORD is not set in Vercel' });
    }

    if (!password || password !== expectedPassword) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    res.setHeader('Set-Cookie', buildAuthSetCookie());

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}
