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
    const membershipParams = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      key: apiKey
    });
    const membershipResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files?${membershipParams.toString()}`
    );
    if (!membershipResponse.ok) {
      return res.status(502).json({ error: 'Could not verify dashboard folder membership' });
    }
    const membership = await membershipResponse.json();
    if (!membership.files?.some(file => file.id === id)) {
      return res.status(403).json({ error: 'File is outside the dashboard folder' });
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
