const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const originalFetch = globalThis.fetch;
const configNames = ['DRIVE_API_KEY', 'DRIVE_FOLDER_ID', 'WEATHER_LAT', 'WEATHER_LON'];
const originalConfig = Object.fromEntries(configNames.map(name => [name, process.env[name]]));
test.beforeEach(() => {
  process.env.DRIVE_API_KEY = 'test-key';
  process.env.DRIVE_FOLDER_ID = 'dashboard-folder';
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of configNames) {
    if (originalConfig[name] === undefined) delete process.env[name];
    else process.env[name] = originalConfig[name];
  }
});

async function loadHandler(path, fetchImpl) {
  globalThis.fetch = fetchImpl;
  return (await import(pathToFileURL(resolve(path)).href)).default;
}

function response() {
  return {
    body: undefined,
    headers: {},
    statusCode: 200,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; }
  };
}

async function invoke(handler, query = {}) {
  const res = response();
  await handler({ query }, res);
  return res;
}

test('a file returned by drive-list can pass membership validation and download', async () => {
  process.env.DRIVE_API_KEY = 'test-key';
  process.env.DRIVE_FOLDER_ID = 'dashboard-folder';
  const file = {
    id: 'drive_file-123',
    name: 'private-customer-name.csv',
    mimeType: 'text/csv',
    modifiedTime: '2026-10-04T12:00:00Z'
  };

  const listHandler = await loadHandler('api/drive-list.js', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ files: [file] })
  }));
  const listResponse = await invoke(listHandler);
  assert.equal(listResponse.statusCode, 200);
  assert.equal(listResponse.body.files[0].id, file.id);
  assert.equal(listResponse.body.files[0].name, 'usage-2026-10-04-1.csv');
  assert.doesNotMatch(JSON.stringify(listResponse.body), /private-customer-name/);

  let requestCount = 0;
  const fileHandler = await loadHandler('api/drive-file.js', async (url) => {
    requestCount += 1;
    if (requestCount === 1) {
      assert.match(url, /files\?/);
      assert.match(url, /pageSize=1000/);
      return { ok: true, json: async () => ({ files: [{ id: file.id }] }) };
    }
    assert.match(url, new RegExp(`/files/${file.id}\\?alt=media`));
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/csv' },
      arrayBuffer: async () => Buffer.from('date,kwh\n2026-10-04,1.2')
    };
  });
  const downloadResponse = await invoke(fileHandler, { id: listResponse.body.files[0].id });
  assert.equal(downloadResponse.statusCode, 200);
  assert.equal(downloadResponse.headers['Content-Type'], 'text/csv');
  assert.match(downloadResponse.body.toString(), /2026-10-04/);
  assert.equal(requestCount, 2);
});

test('drive-file rejects ids that are not present in the configured folder', async () => {
  process.env.DRIVE_API_KEY = 'test-key';
  process.env.DRIVE_FOLDER_ID = 'dashboard-folder';
  const handler = await loadHandler('api/drive-file.js', async () => ({
    ok: true,
    json: async () => ({ files: [] })
  }));
  const res = await invoke(handler, { id: 'outside_file' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'File is outside the dashboard folder');
});

test('drive-file reports membership lookup failures separately from access denial', async () => {
  process.env.DRIVE_API_KEY = 'test-key';
  process.env.DRIVE_FOLDER_ID = 'dashboard-folder';
  const handler = await loadHandler('api/drive-file.js', async () => ({ ok: false, status: 403 }));
  const res = await invoke(handler, { id: 'valid_file' });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'Could not verify dashboard folder membership');
});

test('weather endpoint returns only normalized condition and rainfall', async () => {
  process.env.WEATHER_LAT = '00.000';
  process.env.WEATHER_LON = '-00.000';
  const handler = await loadHandler('api/weather.js', async (url) => {
    assert.match(url, /precipitation_sum%2Cweather_code/);
    return {
      ok: true,
      json: async () => ({ daily: { weather_code: [2], precipitation_sum: [0.17] } })
    };
  });
  const res = await invoke(handler, { date: new Date().toISOString().slice(0, 10) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual({ ...res.body }, { condition: 'Partly cloudy', rainInches: 0.17 });
  assert.ok(res.headers['Cache-Control']);
});

test('drive-list includes and sanitizes later pages even when the first page is short', async () => {
  const urls = [];
  const handler = await loadHandler('api/drive-list.js', async url => {
    const params = new URL(url).searchParams;
    urls.push(params);
    assert.match(params.get('fields'), /nextPageToken/);
    assert.equal(params.get('q'), "'dashboard-folder' in parents and trashed=false");
    return { ok: true, json: async () => params.has('pageToken')
      ? { files: [{ id: 'second', name: 'private-name.xlsx', modifiedTime: '2026-09-15', mimeType: 'application/octet-stream' }] }
      : { files: [{ id: 'first', name: 'private.csv', modifiedTime: '2026-10-01' }], nextPageToken: 'next-page' } };
  });
  const res = await invoke(handler);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.files.length, 2);
  assert.equal(res.body.files[1].name, 'usage-2026-09-15-2.xlsx');
  assert.equal(urls[1].get('pageToken'), 'next-page');
  assert.doesNotMatch(JSON.stringify(res.body), /private/);
});

test('drive-file downloads a later-page member without a standalone metadata request', async () => {
  const urls = [];
  const handler = await loadHandler('api/drive-file.js', async url => {
    const parsed = new URL(url);
    urls.push(parsed);
    if (parsed.pathname.endsWith('/files')) {
      return { ok: true, json: async () => parsed.searchParams.has('pageToken')
        ? { files: [{ id: 'later-file' }] }
        : { files: [], nextPageToken: 'second-page' } };
    }
    assert.equal(parsed.searchParams.get('alt'), 'media');
    assert.equal(parsed.pathname, '/drive/v3/files/later-file');
    return { ok: true, status: 200, headers: { get: () => 'text/csv' }, arrayBuffer: async () => Buffer.from('usage_kwh\n1') };
  });
  const res = await invoke(handler, { id: 'later-file' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.toString(), 'usage_kwh\n1');
  assert.equal(urls.length, 3);
  assert.equal(urls[1].searchParams.get('pageToken'), 'second-page');
});

test('drive-file denies nonmembers only after completing folder pagination', async () => {
  let requests = 0;
  const handler = await loadHandler('api/drive-file.js', async () => ({
    ok: true,
    json: async () => ++requests === 1 ? { files: [{ id: 'other' }], nextPageToken: 'next' } : { files: [] }
  }));
  const res = await invoke(handler, { id: 'outside-file' });
  assert.equal(res.statusCode, 403);
  assert.equal(requests, 2);
});

test('a failed later membership page is a verification failure, not an outside-folder denial', async () => {
  let requests = 0;
  const handler = await loadHandler('api/drive-file.js', async () => ++requests === 1
    ? { ok: true, json: async () => ({ files: [], nextPageToken: 'next' }) }
    : { ok: false, status: 403 });
  const res = await invoke(handler, { id: 'valid-file' });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'Could not verify dashboard folder membership');
});

test('incomplete or repeating folder searches fail closed without downloading', async () => {
  for (const page of [
    { files: [{ id: 'file' }], incompleteSearch: true },
    { files: [{ id: 'file' }], nextPageToken: 'repeat' }
  ]) {
    let requests = 0;
    const handler = await loadHandler('api/drive-file.js', async () => {
      requests++;
      assert.ok(requests <= 2);
      return { ok: true, json: async () => page };
    });
    const res = await invoke(handler, { id: 'file' });
    assert.equal(res.statusCode, 502);
  }
});

test('drive-file preserves Google Sheets CSV export after membership validation', async () => {
  let requests = 0;
  const handler = await loadHandler('api/drive-file.js', async url => {
    if (++requests === 1) return { ok: true, json: async () => ({ files: [{ id: 'sheet' }] }) };
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/drive/v3/files/sheet/export');
    assert.equal(parsed.searchParams.get('mimeType'), 'text/csv');
    return { ok: true, status: 200, headers: { get: () => 'text/csv' }, arrayBuffer: async () => Buffer.from('usage_kwh\n2') };
  });
  const res = await invoke(handler, { id: 'sheet', exportCsv: '1' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.toString(), 'usage_kwh\n2');
});
