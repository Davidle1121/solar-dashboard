import { verifyDriveFileToken } from './_drive-token.js';

export default async function handler(req, res) {
  try {
    const apiKey = process.env.DRIVE_API_KEY;
    const folderId = process.env.DRIVE_FOLDER_ID;
    const { id, token, exportCsv } = req.query;

    if (!apiKey || !folderId) {
      return res.status(500).json({ error: 'Missing Drive configuration' });
    }
    if (!id) {
      return res.status(400).json({ error: 'Missing file id' });
    }
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      return res.status(400).json({ error: 'Invalid file id' });
    }

    // drive-list signs every id it obtained from the configured folder. Verifying
    // that proof locally preserves the folder boundary without a second Google
    // metadata/list request, which caused valid API-key downloads to fail with 403.
    if (!verifyDriveFileToken(id, token, apiKey)) {
      return res.status(403).json({ error: 'Invalid dashboard file token' });
    }

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
