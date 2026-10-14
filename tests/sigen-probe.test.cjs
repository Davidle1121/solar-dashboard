const test = require('node:test');
const assert = require('node:assert/strict');
const { createDecipheriv } = require('node:crypto');
const { runProbe, encryptPassword, yesterdayChicago } = require('../scripts/sigen-probe.cjs');

const env = { SIGEN_USERNAME: 'test-account@example.invalid', SIGEN_PASSWORD: 'test-password', SIGEN_REGION: 'us' };
const now = new Date('2026-10-15T01:00:00Z'); // Still October 14 in Texas.
function ok(data) { return { ok: true, status: 200, json: async () => ({ code: 0, data }) }; }
function chart(unit) {
  return {chartData: {unit, dataSeries: [{id:'PRIVATE-SERIES', points:[{time:'12:00',value:'1.2'}]}]}};
}
function client(overrides = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({url, options});
    assert.equal(url.origin, 'https://api-us.sigencloud.com');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    if (overrides.response) return overrides.response(url, options);
    if (url.pathname === '/auth/oauth/token') return ok({access_token:'PRIVATE-TOKEN', refresh_token:'PRIVATE-REFRESH'});
    assert.equal(options.headers.Authorization, 'Bearer PRIVATE-TOKEN');
    if (url.pathname === '/device/owner/station/home') return ok({stationId:'PRIVATE-STATION',address:'PRIVATE-ADDRESS'});
    assert.equal(url.pathname, '/data-process/sigen/station/statistics/v1/energy');
    assert.equal(url.searchParams.get('startDate'), '20261013');
    assert.equal(url.searchParams.get('endDate'), '20261013');
    return ok(chart(url.searchParams.get('dateFlag') === '1' ? 'kW' : 'kWh'));
  }};
}

test('private API probe encrypts login, reads yesterday in Texas, and never calls control endpoints', async () => {
  const mock = client();
  const result = await runProbe({env,now,fetchImpl:mock.fetchImpl});
  assert.equal(result.status,'passed');
  assert.equal(result.date,'2026-10-13');
  assert.equal(mock.calls.length,4);
  assert.equal(mock.calls[0].options.method,'POST');
  const body = new URLSearchParams(mock.calls[0].options.body);
  assert.equal(body.get('username'),env.SIGEN_USERNAME);
  assert.notEqual(body.get('password'),env.SIGEN_PASSWORD);
  assert.equal(body.get('grant_type'),'password');
  const key=Buffer.from('sigensigensigenp');
  const decipher=createDecipheriv('aes-128-cbc',key,key);
  assert.equal(Buffer.concat([decipher.update(Buffer.from(body.get('password'),'base64')),decipher.final()]).toString(),env.SIGEN_PASSWORD);
  assert.equal(body.get('password'),encryptPassword(env.SIGEN_PASSWORD));
  assert.ok(mock.calls.slice(1).every(call => !call.options.method || call.options.method === 'GET'));
  assert.equal(result.intraday.unit,'kW');
  assert.equal(result.daily.unit,'kWh');
  assert.equal(result.daily.numericPointCount,1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|test-account|test-password/);
});

test('missing variables and unsupported regions never attempt login', async () => {
  const fetchImpl = () => { throw new Error('Must not make network requests'); };
  assert.equal((await runProbe({env:{},fetchImpl})).status,'failed');
  assert.equal((await runProbe({env:{},fetchImpl,ifConfigured:true})).status,'skipped');
  assert.equal((await runProbe({env:{...env,SIGEN_REGION:'https://other.example'},fetchImpl})).reason,'unsupported-region');
});

test('authentication and network failures are sanitized and stop further requests', async () => {
  for (const response of [
    async () => ({ok:false,status:401,json:async()=>({msg:env.SIGEN_PASSWORD})}),
    async () => ({ok:true,status:200,json:async()=>({code:123,msg:'PRIVATE-TOKEN '+env.SIGEN_PASSWORD})}),
    async () => {throw new Error('PRIVATE-TOKEN '+env.SIGEN_PASSWORD)},
    async () => ({ok:true,status:200,json:async()=>{throw new Error('PRIVATE-TOKEN')}})
  ]) {
    const mock=client({response});
    const result=await runProbe({env,now,fetchImpl:mock.fetchImpl});
    assert.equal(result.status,'failed');
    assert.equal(result.stage,'login');
    assert.equal(mock.calls.length,1);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE-|test-password/);
  }
});

test('missing station access is distinguished from failed login', async () => {
  let count=0;
  const result=await runProbe({env,now,fetchImpl:async()=>ok(++count===1?{access_token:'PRIVATE-TOKEN'}:{})});
  assert.equal(result.reason,'system-not-found');
  assert.equal(result.stage,'system-discovery');
  assert.equal(count,2);
});

test('empty or incorrectly labeled historical data cannot pass the probe', async () => {
  for (const history of [{},chart('unknown'),{chartData:{unit:'kW',dataSeries:[{points:[{value:null,time:'12:00'}]}]}}]) {
    let count=0;
    const result=await runProbe({env,now,fetchImpl:async()=>ok(++count===1?{access_token:'PRIVATE-TOKEN'}:count===2?{stationId:'PRIVATE-ID'}:history)});
    assert.equal(result.status,'inconclusive');
    assert.equal(result.reason,'history-missing-or-unrecognized');
  }
});

test('Chicago yesterday remains correct around UTC midnight and daylight-saving transitions', () => {
  assert.equal(yesterdayChicago(new Date('2026-10-15T01:00:00Z')),'2026-10-13');
  assert.equal(yesterdayChicago(new Date('2026-10-15T06:00:00Z')),'2026-10-14');
  assert.equal(yesterdayChicago(new Date('2026-03-09T06:00:00Z')),'2026-03-08');
  assert.equal(yesterdayChicago(new Date('2026-11-02T07:00:00Z')),'2026-11-01');
});
