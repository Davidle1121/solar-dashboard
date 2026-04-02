import { isAuthenticated } from './_auth.js';

export default async function handler(req, res) {
  try {
    if (!isAuthenticated(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const apiKey = process.env.DRIVE_API_KEY;
    const { id, exportCsv } = req.query;

    if (!apiKey) {
      return res.status(500).json({ error: 'Missing DRIVE_API_KEY' });
    }
    if (!id) {
      return res.status(400).json({ error: 'Missing file id' });
    }

    const url = exportCsv === '1'
      ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=text/csv&key=${apiKey}`
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&key=${apiKey}`;

    const r = await fetch(url);
    const contentType = r.headers.get('content-type') || 'application/octet-stream';
    const buffer = await r.arrayBuffer();

    res.setHeader('Content-Type', contentType);
    return res.status(r.status).send(Buffer.from(buffer));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
