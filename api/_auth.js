const COOKIE_NAME = 'site_auth';


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
