import { listDashboardFiles } from './_drive-folder.js';

export default async function handler(req, res) {
  try {
    const apiKey = process.env.DRIVE_API_KEY;
    const folderId = process.env.DRIVE_FOLDER_ID;
    const { id, exportCsv } = req.query;

    if (!apiKey || !folderId) {
      return res.status(500).json({ error: 'Missing Drive configuration' });
    }
    if (!id) {
      return res.status(400).json({ error: 'Missing file id' });
    }
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      return res.status(400).json({ error: 'Invalid file id' });
    }

    // Validate membership on every request instead of trusting an id supplied by
    // the browser. Use the same files.list operation as drive-list: some API-key
    // Drive configurations permit folder listing and media download but reject a
    // standalone files.get metadata request with 403.
    const membership = await listDashboardFiles(apiKey, folderId, 'id');
    if (!membership.ok) {
      return res.status(502).json({ error: 'Could not verify dashboard folder membership' });
    }
    if (!membership.files.some(file => file.id === id)) {
      return res.status(403).json({ error: 'File is outside the dashboard folder' });
    }

    // Folder listing already establishes direct membership. Some API-key policies
    // allow listing and media download but reject standalone metadata requests.
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
