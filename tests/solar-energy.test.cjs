const test=require('node:test');
const assert=require('node:assert/strict');
const Solar=require('../solar-energy.js');
const {retainedRecords}=require('../lib/sigen-store.cjs');
const {collectSigen}=require('../lib/sigen-collector.cjs');
const {handleRead,handleSync}=require('../lib/sigen-handlers.cjs');
const {connectSigen}=require('../lib/sigen-client.cjs');
const now=new Date('2026-10-14T08:00:00Z'); // 3 AM Central during DST.
const chart=(id='PV_POWER',unit='kW')=>({chartData:{unit,dataSeries:[{id,points:[{time:'12:00',value:2},{time:'12:15',value:2}]}]}});
function store(initial={}) {
  const data=new Map(Object.entries(initial));const removed=[];
  return {data,removed,list:async()=>[...data.keys()].map(pathname=>({pathname})),read:async path=>data.get(path)||null,write:async record=>data.set('sigenergy/'+record.date+'.json',record),remove:async paths=>{for(const path of paths){removed.push(path);data.delete(path);}}};
}
function response(){return {headers:{},statusCode:200,setHeader(k,v){this.headers[k]=v},status(n){this.statusCode=n;return this},json(data){this.body=data;return this}};}

test('retention is seven completed Central dates across daylight saving and UTC midnight',()=>{
  assert.deepEqual(Solar.retainedDates(now),['2026-10-07','2026-10-08','2026-10-09','2026-10-10','2026-10-11','2026-10-12','2026-10-13']);
  assert.equal(Solar.retainedDates(new Date('2026-10-15T01:00:00Z')).at(-1),'2026-10-13');
  assert.equal(Solar.retainedDates(new Date('2026-03-09T08:00:00Z')).at(-1),'2026-03-08');
});

test('normalization validates dates, units, metric meaning, numeric zeros and SOC bounds',()=>{
  let day=Solar.normalizeHistory('2026-10-13',[chart(),chart('UNKNOWN'),chart('BATTERY_SOC','%')]);
  assert.equal(day.samples[0].solarKw,2);assert.equal(day.samples[0].socPct,2);assert.equal(day.unmappedSeriesCount,1);
  assert.equal(Solar.normalizeHistory('2026-10-13',[chart('PV_POWER','kWh')]).samples.length,0);
  assert.equal(Solar.normalizeHistory('2026-10-13',[chart('2')],{solarKw:'2'}).samples[0].solarKw,2);
  assert.equal(Solar.parseMinute('2026-10-13T17:00:00Z','2026-10-13'),720);
  assert.equal(Solar.parseMinute('2026-10-14 12:00','2026-10-13'),null);
  assert.equal(Solar.parseMinute('24:00','2026-10-13'),1440);
  assert.equal(Solar.parseMinute('25:00','2026-10-13'),null);
});

test('hourly kWh integration splits hour boundaries and flags gaps without fabricating zeros',()=>{
  const record={samples:[{minute:45,solarKw:2},{minute:60,solarKw:2},{minute:75,solarKw:2},{minute:120,solarKw:4},{minute:135,solarKw:4}]};
  const result=Solar.hourlyEnergy(record,'solarKw');
  assert.deepEqual(result.values.slice(0,4),[0.5,0.5,1,null]);
  assert.deepEqual(result.coverage.slice(0,4),[15,15,15,0]);
  assert.equal(result.total,2);
  assert.equal(Solar.hourlyEnergy({samples:[{minute:0,solarKw:0},{minute:15,solarKw:0}]},'solarKw').values[0],0);
  assert.equal(Solar.hourlyEnergy(record,'loadKw').total,null);
});

test('SOC is the last observed percent, not summed or interpolated through absent hours',()=>{
  const result=Solar.hourlySoc({samples:[{minute:0,socPct:20},{minute:55,socPct:40},{minute:120,socPct:60}]});
  assert.deepEqual(result.values.slice(0,3),[40,null,60]);assert.equal(result.total,60);
});

test('SMT aggregation keeps import and export coverage independent',()=>{
  const smt=[{time:'00:00',kwh:1,exportKwh:0},{time:'00:15',kwh:2}];
  assert.equal(Solar.hourlySmt(smt,'import').total,3);
  assert.equal(Solar.hourlySmt(smt,'export').coverage[0],15);
  assert.equal(Solar.hourlySmt([],'export').values[0],null);
});

test('expired blobs are actually deleted before upstream login, while other namespaces survive',async()=>{
  const s=store({'sigenergy/2026-10-06.json':{date:'2026-10-06',samples:[]},'sigenergy/2026-10-13.json':{date:'2026-10-13',samples:[{minute:0,solarKw:1}]},'other/data.json':{}});
  await assert.rejects(collectSigen({store:s,now,connect:async()=>{throw Error('outage')}}));
  assert.deepEqual(s.removed,['sigenergy/2026-10-06.json']);assert.ok(s.data.has('other/data.json'));assert.ok(s.data.has('sigenergy/2026-10-13.json'));
});

test('initial collection fetches at most seven days, reuses one login and is idempotent',async()=>{
  const s=store();let logins=0;const dates=[];
  const connect=async()=>{logins++;return {history:async(date,soc)=>{dates.push(date);return chart(soc?'BATTERY_SOC':'PV_POWER',soc?'%':'kW')}}};
  const result=await collectSigen({store:s,now,connect});
  assert.equal(result.status,'synced');assert.equal(result.saved,7);assert.equal(s.data.size,7);assert.equal(logins,1);
  assert.deepEqual([...new Set(dates)].sort(),Solar.retainedDates(now));
  assert.equal((await collectSigen({store:s,now,connect})).status,'already-synced');assert.equal(logins,1);
  assert.equal((await collectSigen({store:s,now,connect,bootstrap:true})).status,'already-initialized');
});

test('missing optional SOC does not discard energy, and failures preserve prior usable records',async()=>{
  const s=store({'sigenergy/2026-10-13.json':{date:'2026-10-13',samples:[{minute:0,solarKw:2}]}});
  const result=await collectSigen({store:s,now,connect:async()=>({history:async(date,soc)=>{if(soc)throw Error('unsupported');return date==='2026-10-13'?{}:chart();}})});
  assert.equal(result.status,'partial');assert.equal(s.data.get('sigenergy/2026-10-13.json').samples[0].solarKw,2);
  assert.ok(s.data.get('sigenergy/2026-10-12.json').samples.length);
});

test('read endpoint filters expired data without contacting Sigenergy or leaking credentials',async()=>{
  const s=store({'sigenergy/2026-10-06.json':{date:'2026-10-06',samples:[]},'sigenergy/2026-10-13.json':{date:'2026-10-13',samples:[]}}),res=response();
  await handleRead({method:'GET'},res,{store:s,now});
  assert.equal(res.statusCode,200);assert.equal(res.body.days.length,1);assert.equal(res.headers['Cache-Control'],'private, no-store');
  assert.equal((await retainedRecords(s,now)).length,1);
});

test('cron requires authentication and only the 3 AM Central candidate collects in summer and winter',async()=>{
  let calls=0;const env={CRON_SECRET:'test-secret'},collect=async()=>{calls++;return {status:'synced'}};
  let res=response();await handleSync({method:'GET',headers:{}},res,{env,now,collect});assert.equal(res.statusCode,401);assert.equal(calls,0);
  const req={method:'GET',headers:{authorization:'Bearer test-secret'}};
  res=response();await handleSync(req,res,{env,now,collect});assert.equal(calls,1);
  res=response();await handleSync(req,res,{env,now:new Date('2026-10-14T09:00:00Z'),collect});assert.equal(calls,1);
  res=response();await handleSync(req,res,{env,now:new Date('2026-12-14T09:00:00Z'),collect});assert.equal(calls,2);
  res=response();await handleSync(req,res,{env,now:new Date('2026-12-14T08:00:00Z'),collect});assert.equal(calls,2);
});

test('collector client only authenticates and reads whitelisted vendor history paths',async()=>{
  const calls=[];
  const fetchImpl=async(url,options)=>{calls.push({url,options});const pathname=new URL(url).pathname;let data;
    if(pathname==='/auth/oauth/token')data={access_token:'test-token'};
    else if(pathname==='/device/owner/station/home')data={stationId:'test-station'};
    else {assert.match(pathname,/^\/data-process\/sigen\/station\/statistics\/v1\/(energy|soc)$/);data=chart();}
    return {ok:true,json:async()=>({code:0,data})};
  };
  const client=await connectSigen({SIGEN_USERNAME:'test',SIGEN_PASSWORD:'test',SIGEN_REGION:'us'},fetchImpl);
  await client.history('2026-10-13');await client.history('2026-10-13',true);
  assert.equal(calls[0].options.method,'POST');assert.ok(calls.slice(1).every(c=>!c.options.method));
  assert.ok(calls.every(c=>c.options.redirect==='error'));assert.equal(calls.length,4);
});

test('ambiguous repeated clock samples are not silently collapsed into complete energy',()=>{
  const raw=chart();raw.chartData.dataSeries[0].points.push({time:'12:00',value:3});
  const result=Solar.normalizeHistory('2026-10-13',[raw]);
  assert.equal(result.ambiguousSampleCount,1);
  assert.equal(result.samples.some(sample=>sample.minute===720),false);
  assert.equal(Solar.hourlyEnergy(result,'solarKw').total,null);
});

test('mapping diagnostics expose measurement identifiers and shape, never values, timestamps or account fields',()=>{
  const {describeHistory}=require('../lib/sigen-diagnostics.cjs');
  const raw={stationId:'PRIVATE-STATION-123456',owner:'PRIVATE-OWNER',chartData:{unit:'kW',dataSeries:[{id:'POWER_PV',points:[{time:'12:34',value:9876.543}]},{id:'NDXZZ1234567890',points:[]}]}};
  const schema=describeHistory('2026-10-13',raw);
  assert.equal(schema.series[0].id,'POWER_PV');assert.equal(schema.series[0].timeFormat,'clock');
  assert.equal(schema.series[0].numericPoints,1);assert.equal(schema.series[0].usableSamples,0);
  assert.equal(schema.series[1].id,'[unrecognized identifier]');
  assert.doesNotMatch(JSON.stringify(schema),/PRIVATE|9876|12:34|1234567890/);
});
