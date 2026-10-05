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

    // Validate the parent on every request instead of trusting an id supplied by the
    // browser. This keeps this route scoped to the dedicated dashboard folder.
    const metadataParams = new URLSearchParams({
      fields: 'id,parents,trashed',
      supportsAllDrives: 'true',
      key: apiKey
    });
    const metadataResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?${metadataParams.toString()}`
    );
    if (!metadataResponse.ok) {
      return res.status(metadataResponse.status).json({ error: 'File is unavailable' });
    }
    const metadata = await metadataResponse.json();
    if (metadata.trashed || !metadata.parents?.includes(folderId)) {
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
