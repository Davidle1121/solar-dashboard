export default async function handler(req, res) {
  try {
    const apiKey = process.env.DRIVE_API_KEY;
    const { id, exportCsv } = req.query;

    if (!apiKey) {
      return res.status(500).json({ error: 'Missing DRIVE_API_KEY' });
    }
    if (!id) {
      return res.status(400).json({ error: 'Missing file id' });
    }
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      return res.status(400).json({ error: 'Invalid file id' });
    }

    // Keep this as a single Google media/export request. Extra metadata or folder
    // verification calls proved incompatible with the production API-key policy.
    const url = exportCsv === '1'
      ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=text/csv&key=${apiKey}`
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&key=${apiKey}`;

    const r = await fetch(url);
    const contentType = r.headers.get('content-type') || 'application/octet-stream';
    const buffer = await r.arrayBuffer();

    if (!r.ok) {
      let detail = '';
      try {
        detail = JSON.parse(Buffer.from(buffer).toString()).error?.message || '';
      } catch {
        // Google occasionally returns a plain-text error; keep the client message generic.
      }
      const suffix = detail ? `: ${detail}` : '';
      return res.status(r.status).json({ error: `Google Drive download failed${suffix}` });
    }

    res.setHeader('Content-Type', contentType);
    return res.status(r.status).send(Buffer.from(buffer));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
