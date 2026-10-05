const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function loadHandler(path, fetchImpl) {
  const source = fs.readFileSync(path, 'utf8')
    .replace('export default async function handler', 'async function handler')
    + '\nthis.handler = handler;';
  const context = { Buffer, URLSearchParams, fetch: fetchImpl, process };
  vm.runInNewContext(source, context, { filename: path });
  return context.handler;
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

  const listHandler = loadHandler('api/drive-list.js', async () => ({
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
  const fileHandler = loadHandler('api/drive-file.js', async (url) => {
    requestCount += 1;
    if (requestCount === 1) {
      assert.match(url, /files\?/);
      assert.match(url, /pageSize=1000/);
      return { ok: true, json: async () => ({ files: [{ id: file.id }] }) };
    }
    assert.match(url, new RegExp(`/files/${file.id}\\?alt=media`));
    return {
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
  const handler = loadHandler('api/drive-file.js', async () => ({
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
  const handler = loadHandler('api/drive-file.js', async () => ({ ok: false, status: 403 }));
  const res = await invoke(handler, { id: 'valid_file' });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'Could not verify dashboard folder membership');
});

test('weather endpoint returns only normalized condition and rainfall', async () => {
  process.env.WEATHER_LAT = '00.000';
  process.env.WEATHER_LON = '-00.000';
  const handler = loadHandler('api/weather.js', async (url) => {
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
