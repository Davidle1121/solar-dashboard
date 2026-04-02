export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { password } = req.body || {};
    const expectedPassword = process.env.SITE_PASSWORD;

    if (!expectedPassword) {
      return res.status(500).json({ error: 'SITE_PASSWORD is not set in Vercel' });
    }

    if (!password || password !== expectedPassword) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    const isProd = process.env.NODE_ENV === 'production';

    res.setHeader(
      'Set-Cookie',
      [
        'site_auth=ok',
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        isProd ? 'Secure' : '',
        'Max-Age=2592000'
      ].filter(Boolean).join('; ')
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}
