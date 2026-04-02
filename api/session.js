export default async function handler(req, res) {
  const cookieHeader = req.headers.cookie || '';
  const isAuthed = cookieHeader
    .split(';')
    .map(v => v.trim())
    .some(v => v === 'site_auth=ok');

  return res.status(200).json({ authenticated: isAuthed });
}
