import { buildLogoutSetCookie } from './_auth.js';

export default async function handler(req, res) {
  res.setHeader('Set-Cookie', buildLogoutSetCookie());

  return res.status(200).json({ ok: true });
}
