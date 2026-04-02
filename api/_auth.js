import crypto from 'crypto';

const COOKIE_NAME = 'site_auth';
const COOKIE_TTL_SECONDS = 60 * 60 * 24 * 30;

function getSecret() {
  return process.env.SITE_AUTH_SECRET || process.env.SITE_PASSWORD || '';
}

function sign(value) {
  const secret = getSecret();
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function parseCookies(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map(v => v.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      const idx = pair.indexOf('=');
      if (idx <= 0) return acc;
      const key = pair.slice(0, idx);
      const value = pair.slice(idx + 1);
      acc[key] = value;
      return acc;
    }, {});
}

export function createAuthCookieValue() {
  const exp = Math.floor(Date.now() / 1000) + COOKIE_TTL_SECONDS;
  const payload = String(exp);
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

export function verifyAuthCookieValue(token = '') {
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!expStr || !sig || !Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
    return false;
  }

  const expected = sign(expStr);
  const got = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

export function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[COOKIE_NAME] || '';
  return verifyAuthCookieValue(token);
}

export function buildAuthSetCookie() {
  const isProd = process.env.NODE_ENV === 'production';
  const token = createAuthCookieValue();
  return [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    isProd ? 'Secure' : '',
    `Max-Age=${COOKIE_TTL_SECONDS}`
  ].filter(Boolean).join('; ');
}

export function buildLogoutSetCookie() {
  const isProd = process.env.NODE_ENV === 'production';
  return [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    isProd ? 'Secure' : '',
    'Max-Age=0'
  ].filter(Boolean).join('; ');
}

