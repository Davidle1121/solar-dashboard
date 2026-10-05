import { createDriveFileToken } from './_drive-token.js';

export default async function handler(req, res) {
  try {
    const apiKey = process.env.DRIVE_API_KEY;
    const folderId = process.env.DRIVE_FOLDER_ID;

    if (!apiKey || !folderId) {
      return res.status(500).json({ error: 'Missing Vercel environment variables' });
    }

    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id,name,mimeType,modifiedTime)',
      orderBy: 'name',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      key: apiKey
    });
    const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;

    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: 'Drive listing failed' });

    // Never expose original export names: utility filenames may contain a customer,
    // premise, meter, or account identifier even when the parsed readings do not.
    const files = (data.files || []).map((file, index) => {
      const extension = file.mimeType === 'application/vnd.google-apps.spreadsheet'
        ? 'csv'
        : String(file.name || '').split('.').pop().toLowerCase();
      const safeExtension = ['csv', 'xlsx', 'xml'].includes(extension) ? extension : 'data';
      const date = String(file.modifiedTime || '').slice(0, 10) || 'undated';
      return {
        id: file.id,
        name: `usage-${date}-${index + 1}.${safeExtension}`,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime
      };
    });

    return res.status(200).json({ files });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
