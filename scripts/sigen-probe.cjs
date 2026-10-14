// Read-only private-app API probe. Protocol reference (unofficial, may change):
// https://github.com/kefa8/sigen-download/blob/master/src/common.py
const { createCipheriv } = require('node:crypto');

const REGIONS = Object.freeze({
  us: 'https://api-us.sigencloud.com/',
  eu: 'https://api-eu.sigencloud.com/',
  aus: 'https://api-aus.sigencloud.com/',
  apac: 'https://api-apac.sigencloud.com/',
  cn: 'https://api-cn.sigenergy.com/'
});

class ProbeFailure extends Error {
  constructor(stage, reason, httpStatus) {
    super('Sigenergy probe failed');
    this.stage = stage;
    this.reason = reason;
    this.httpStatus = httpStatus;
  }
}

function encryptPassword(password) {
  // This fixed AES key/IV is the app protocol, not a replacement for HTTPS.
  const key = Buffer.from('sigensigensigenp');
  const cipher = createCipheriv('aes-128-cbc', key, key);
  return Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]).toString('base64');
}

function yesterdayChicago(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const get = name => parts.find(part => part.type === name).value;
  const date = new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day')) - 1));
  return date.toISOString().slice(0, 10);
}

function summarizeHistory(data) {
  const chart = data?.chartData;
  const series = Array.isArray(chart?.dataSeries) ? chart.dataSeries : [];
  const points = series.flatMap(item => Array.isArray(item.points) ? item.points : []);
  const numeric = points.filter(point => point?.value !== null && point?.value !== undefined &&
    String(point.value).trim() !== '' && Number.isFinite(Number(point.value)));
  const rawUnit = String(chart?.unit || '').trim().toLowerCase();
  const unit = ({ kw: 'kW', kwh: 'kWh', '%': '%' })[rawUnit] || null;
  // Never log raw fields, series IDs, values, timestamps, station IDs, or tokens.
  return { seriesCount: series.length, pointCount: points.length,
    numericPointCount: numeric.length,
    pointsWithTime: numeric.filter(point => typeof point.time === 'string' && point.time.trim()).length,
    unit };
}

async function runProbe({ env = process.env, fetchImpl = globalThis.fetch, now = new Date(), ifConfigured = false } = {}) {
  const required = ['SIGEN_USERNAME', 'SIGEN_PASSWORD', 'SIGEN_REGION'];
  const missing = required.filter(name => !env[name]);
  if (missing.length) return { status: ifConfigured ? 'skipped' : 'failed', stage: 'configuration', reason: 'missing-variables', missing };
  const region = env.SIGEN_REGION.trim().toLowerCase();
  const base = REGIONS[region];
  if (!base) return { status: 'failed', stage: 'configuration', reason: 'unsupported-region' };
  const date = yesterdayChicago(now);
  let stage = 'login';
  const request = async (path, options = {}) => {
    let response;
    try {
      response = await fetchImpl(new URL(path, base), {
        ...options, redirect: 'error', signal: AbortSignal.timeout(15000)
      });
    } catch {
      throw new ProbeFailure(stage, 'network-or-timeout');
    }
    if (!response.ok) throw new ProbeFailure(stage, 'upstream-http-error', response.status);
    let payload;
    try { payload = await response.json(); }
    catch { throw new ProbeFailure(stage, 'invalid-json'); }
    if (payload?.code !== 0 && payload?.code !== '0') throw new ProbeFailure(stage, 'upstream-rejected-request');
    let data = payload.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { throw new ProbeFailure(stage, 'unexpected-response'); }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ProbeFailure(stage, 'unexpected-response');
    return data;
  };
  try {
    // The only POST is authentication. No inverter/battery control paths are used.
    const auth = await request('auth/oauth/token', {
      method: 'POST', headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from('sigen:sigen').toString('base64')
      },
      body: new URLSearchParams({ username: env.SIGEN_USERNAME, password: encryptPassword(env.SIGEN_PASSWORD), grant_type: 'password' }).toString()
    });
    if (typeof auth.access_token !== 'string' || !auth.access_token) throw new ProbeFailure(stage, 'token-missing');
    const headers = { Authorization: 'Bearer ' + auth.access_token, Accept: 'application/json' };
    stage = 'system-discovery';
    const station = await request('device/owner/station/home', { headers });
    if (!station.stationId || !['string', 'number'].includes(typeof station.stationId)) throw new ProbeFailure(stage, 'system-not-found');
    const history = async flag => {
      const params = new URLSearchParams({dateFlag: flag, startDate: date.replaceAll('-', ''), endDate: date.replaceAll('-', ''), stationId: String(station.stationId)});
      return summarizeHistory(await request('data-process/sigen/station/statistics/v1/energy?' + params, { headers }));
    };
    stage = 'intraday-history';
    const intraday = await history('1');
    stage = 'daily-history';
    const daily = await history('2');
    // A successful login with empty/unrecognized history is not a usable data test.
    const usable = intraday.numericPointCount > 0 && intraday.pointsWithTime > 0 && intraday.unit === 'kW' &&
      daily.numericPointCount > 0 && daily.pointsWithTime > 0 && daily.unit === 'kWh';
    return { status: usable ? 'passed' : 'inconclusive', stage: 'history', region, date,
      timezone: 'America/Chicago', login: 'passed', systemDiscovery: 'passed',
      intraday, daily, ...(usable ? {} : { reason: 'history-missing-or-unrecognized' }) };
  } catch (error) {
    // Upstream errors can echo credentials. Emit only our fixed diagnostics.
    return { status: 'failed', stage, reason: error instanceof ProbeFailure ? error.reason : 'unexpected-response',
      ...(error instanceof ProbeFailure && error.httpStatus ? { httpStatus: error.httpStatus } : {}) };
  }
}

if (require.main === module) {
  runProbe({ ifConfigured: process.argv.includes('--if-configured') }).then(result => {
    console.log('SIGEN_PROBE ' + JSON.stringify(result));
    if (result.status !== 'passed' && result.status !== 'skipped') process.exitCode = 1;
  }).catch(() => {
    console.log('SIGEN_PROBE {"status":"failed","reason":"internal-error"}');
    process.exitCode = 1;
  });
}
module.exports = { runProbe, encryptPassword, yesterdayChicago, summarizeHistory };
