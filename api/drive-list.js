import { isAuthenticated } from './_auth.js';

export default async function handler(req, res) {
  try {
    if (!isAuthenticated(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const apiKey = process.env.DRIVE_API_KEY;
    const folderId = process.env.DRIVE_FOLDER_ID;

    if (!apiKey || !folderId) {
      return res.status(500).json({ error: 'Missing Vercel environment variables' });
    }

    const url =
      `https://www.googleapis.com/drive/v3/files` +
      `?q='${encodeURIComponent(folderId)}'+in+parents+and+trashed=false` +
      `&fields=files(id,name,mimeType,modifiedTime)` +
      `&orderBy=name&pageSize=1000&key=${apiKey}`;

    const r = await fetch(url);
    const text = await r.text();

    return res.status(r.status).send(text);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
