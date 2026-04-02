export default async function handler(req, res) {
  const isProd = process.env.NODE_ENV === 'production';

  res.setHeader(
    'Set-Cookie',
    [
      'site_auth=',
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      isProd ? 'Secure' : '',
      'Max-Age=0'
    ].filter(Boolean).join('; ')
  );

  return res.status(200).json({ ok: true });
}
