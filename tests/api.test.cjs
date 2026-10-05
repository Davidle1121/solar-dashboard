const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { createHmac, timingSafeEqual } = require('node:crypto');

function loadDriveTokenHelpers() {
  const source = fs.readFileSync('api/_drive-token.js', 'utf8')
    .replace(/^import .*?;\n/mg, '')
    .replaceAll('export function ', 'function ')
    + '\nthis.createDriveFileToken = createDriveFileToken;'
    + '\nthis.verifyDriveFileToken = verifyDriveFileToken;';
  const context = { Buffer, createHmac, timingSafeEqual };
  vm.runInNewContext(source, context, { filename: 'api/_drive-token.js' });
  return context;
}

const { createDriveFileToken, verifyDriveFileToken } = loadDriveTokenHelpers();

function loadHandler(path, fetchImpl) {
  const source = fs.readFileSync(path, 'utf8')
    .replace(/^import .*?;\n/mg, '')
    .replace('export default async function handler', 'async function handler')
    + '\nthis.handler = handler;';
  const context = {
    Buffer, URLSearchParams, createDriveFileToken, fetch: fetchImpl,
    process, verifyDriveFileToken
  };
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
  assert.equal(listResponse.body.files[0].token, createDriveFileToken(file.id, 'test-key'));
  assert.equal(listResponse.body.files[0].name, 'usage-2026-10-04-1.csv');
  assert.doesNotMatch(JSON.stringify(listResponse.body), /private-customer-name/);

  const fileHandler = loadHandler('api/drive-file.js', async (url) => {
    assert.match(url, new RegExp(`/files/${file.id}\\?alt=media`));
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/csv' },
      arrayBuffer: async () => Buffer.from('date,kwh\n2026-10-04,1.2')
    };
  });
  const downloadResponse = await invoke(fileHandler, {
    id: listResponse.body.files[0].id,
    token: listResponse.body.files[0].token
  });
  assert.equal(downloadResponse.statusCode, 200);
  assert.equal(downloadResponse.headers['Content-Type'], 'text/csv');
  assert.match(downloadResponse.body.toString(), /2026-10-04/);
});

test('drive-file rejects ids without the signed proof returned by drive-list', async () => {
  process.env.DRIVE_API_KEY = 'test-key';
  process.env.DRIVE_FOLDER_ID = 'dashboard-folder';
  const handler = loadHandler('api/drive-file.js', async () => {
    throw new Error('download must not be attempted');
  });
  const res = await invoke(handler, { id: 'outside_file', token: 'invalid' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Invalid dashboard file token');
});

test('drive-file preserves Google download status and exposes a useful failure reason', async () => {
  process.env.DRIVE_API_KEY = 'test-key';
  process.env.DRIVE_FOLDER_ID = 'dashboard-folder';
  const id = 'valid_file';
  const handler = loadHandler('api/drive-file.js', async () => ({
    ok: false,
    status: 403,
    headers: { get: () => 'application/json' },
    arrayBuffer: async () => Buffer.from(JSON.stringify({ error: { message: 'API key restriction' } }))
  }));
  const res = await invoke(handler, { id, token: createDriveFileToken(id, 'test-key') });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Google Drive download failed: API key restriction');
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
