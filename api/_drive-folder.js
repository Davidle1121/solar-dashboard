// Drive may return fewer than pageSize results while still having more pages.
// Listing and membership checks must follow nextPageToken before denying access.
export async function listDashboardFiles(apiKey, folderId, fields) {
  const files = [];
  const seenTokens = new Set();
  let pageToken;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: `nextPageToken,incompleteSearch,files(${fields})`,
      orderBy: 'name',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      key: apiKey
    });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`);
    if (!response.ok) return { ok: false, status: response.status };
    const data = await response.json();
    if (data.incompleteSearch || !Array.isArray(data.files)) {
      return { ok: false, status: 502 };
    }
    files.push(...data.files);
    pageToken = data.nextPageToken;
    if (pageToken && seenTokens.has(pageToken)) return { ok: false, status: 502 };
    if (pageToken) seenTokens.add(pageToken);
  } while (pageToken);
  return { ok: true, files };
}
