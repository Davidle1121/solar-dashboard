const test=require('node:test');
const assert=require('node:assert/strict');
const {handleManualSync}=require('../lib/sigen-handlers.cjs');
const {acquireSyncLock,COOLDOWN_MS}=require('../lib/sigen-sync-lock.cjs');
const {collectSigen}=require('../lib/sigen-collector.cjs');
const now=new Date('2026-10-14T18:00:00Z');
const key='test-only-owner-passcode';
function response(){return {headers:{},setHeader(k,v){this.headers[k]=v},status(n){this.statusCode=n;return this},json(body){this.body=body;return this}};}
test('manual sync rejects unconfigured, wrong, missing and oversized passcodes before collection',async()=>{
  for(const [env,headers,status] of [[{}, {},503],[{SIGEN_SYNC_PASSWORD:'short'},{},503],[{SIGEN_SYNC_PASSWORD:key},{},401],[{SIGEN_SYNC_PASSWORD:key},{'x-solar-sync-key':'wrong'},401],[{SIGEN_SYNC_PASSWORD:key},{'x-solar-sync-key':'x'.repeat(257)},401]]){
    const res=response();let called=false;
    await handleManualSync({method:'POST',headers},res,{env,collect:async()=>{called=true}});
    assert.equal(res.statusCode,status);assert.equal(called,false);assert.equal(res.headers['Cache-Control'],'no-store');assert.ok(!JSON.stringify(res.body).includes(key));
  }
});
test('manual sync enforces POST and passes force only after authenticating the owner',async()=>{
  const env={SIGEN_SYNC_PASSWORD:key};let calls=0;
  const collect=async options=>{calls++;assert.equal(options.force,true);assert.equal(options.now,now);return {status:'synced',mappedDays:7}};
  const invalid=response();await handleManualSync({method:'GET',headers:{}},invalid,{env,collect});assert.equal(invalid.statusCode,405);assert.equal(calls,0);
  const valid=response();await handleManualSync({method:'POST',headers:{'x-solar-sync-key':key}},valid,{env,now,collect});assert.equal(valid.statusCode,200);assert.equal(valid.body.mappedDays,7);assert.equal(calls,1);
});
test('manual sync reports cooldown and redacts provider failures',async()=>{
  for(const [collect,status] of [[async()=>({status:'cooldown',retryAfter:123}),429],[async()=>{throw new Error('private vendor token')},503]]){
    const res=response();await handleManualSync({method:'POST',headers:{'x-solar-sync-key':key}},res,{env:{SIGEN_SYNC_PASSWORD:key},collect});
    assert.equal(res.statusCode,status);assert.ok(!JSON.stringify(res.body).includes('private vendor token'));if(status===429)assert.equal(res.headers['Retry-After'],'123');
  }
});
function lockSdk(){
  let record=null,etag=0;
  class BlobPreconditionFailedError extends Error{}
  return {BlobPreconditionFailedError,get:async()=>record?{statusCode:200,stream:new Response(record).body,blob:{etag:String(etag)}}:null,
    put:async(path,body,options)=>{assert.equal(path,'sigenergy-meta/sync-lock.json');assert.equal(options.access,'private');if(record&&(!options.allowOverwrite||options.ifMatch!==String(etag)))throw new BlobPreconditionFailedError();record=body;etag++;}};
}
test('shared lock allows one concurrent run, blocks for five minutes, and then renews with ETag',async()=>{
  const sdk=lockSdk();const attempts=await Promise.all([acquireSyncLock(sdk,'test',now),acquireSyncLock(sdk,'test',now)]);
  assert.equal(attempts.filter(a=>a.acquired).length,1);
  assert.deepEqual(await acquireSyncLock(sdk,'test',new Date(+now+60000)),{acquired:false,retryAfter:240});
  assert.deepEqual(await acquireSyncLock(sdk,'test',new Date(+now+COOLDOWN_MS)),{acquired:true});
});
test('storage errors fail closed instead of allowing an uncoordinated provider login',async()=>{
  const sdk=lockSdk();sdk.put=async()=>{throw new Error('Storage unavailable')};
  await assert.rejects(acquireSyncLock(sdk,'test',now),/Storage unavailable/);
});
function memoryStore(){const data=new Map();return {data,list:async()=>[...data.keys()].map(pathname=>({pathname})),read:async path=>data.get(path),remove:async paths=>paths.forEach(path=>data.delete(path)),write:async day=>data.set('sigenergy/'+day.date+'.json',day)};}
test('owner sync refreshes all seven completed days even after a successful scheduled run',async()=>{
  const store=memoryStore();store.data.set('sigenergy/2026-10-13.json',{date:'2026-10-13',samples:[{minute:0,solarKw:0}],syncDate:'2026-10-14'});
  store.data.set('sigenergy/2026-10-01.json',{date:'2026-10-01',samples:[]});
  let logins=0;const requested=[];
  const connect=async()=>{logins++;return {history:async(date,soc)=>{requested.push([date,soc]);return {chartData:{unit:soc?'%':'kW',dataSeries:[{id:soc?'BATTERY_SOC':'PV_POWER',points:[{time:'12:00',value:2},{time:'12:15',value:2}]}]}}}}};
  assert.equal((await collectSigen({now,store,connect})).status,'already-synced');assert.equal(logins,0);
  const result=await collectSigen({now,store,connect,force:true});assert.equal(result.status,'synced');assert.equal(result.mappedDays,7);assert.ok(result.schema);assert.equal(logins,1);assert.equal(requested.length,14);assert.equal(store.data.size,7);assert.equal(requested[0][0],'2026-10-13');assert.equal(requested.at(-1)[0],'2026-10-07');
});
test('cooldown prevents forced collector from contacting the provider',async()=>{
  const store=memoryStore();store.acquireSync=async()=>({acquired:false,retryAfter:200});
  const result=await collectSigen({now,store,force:true,connect:async()=>assert.fail('must not log in')});assert.deepEqual(result,{status:'cooldown',retryAfter:200});
});

test('persistent sync status records real outcomes and retains the last successful update',async()=>{
  const store=memoryStore();let summary;const writes=[];
  store.readSyncStatus=async()=>summary;
  store.writeSyncStatus=async value=>{summary={...value};writes.push(summary)};
  const good={chartData:{unit:'kW',dataSeries:[{id:'PV_POWER',points:[{time:'12:00',value:2}]}]}};
  const collect=options=>collectSigen({now,store,force:true,clock:()=>100,...options});
  await collect({connect:async()=>({history:async(_date,soc)=>soc?null:good})});
  assert.equal(writes[0].status,'running');assert.equal(summary.status,'synced');assert.equal(summary.lastSuccessfulAt,now.toISOString());assert.equal(summary.mappedDays,7);
  const success=summary.lastSuccessfulAt;
  await collect({connect:async()=>{throw new Error('SECRET login details')}}).then(()=>assert.fail('must reject'),()=>{});
  assert.equal(summary.status,'failed');assert.equal(summary.lastSuccessfulAt,success);assert.doesNotMatch(JSON.stringify(summary),/SECRET|schema|chartData/);
  store.data.clear();
  await collect({connect:async()=>({history:async()=>({chartData:{unit:'kW',dataSeries:[{id:'UNKNOWN',points:[{time:'12:00',value:2}]}]}})})});
  assert.equal(summary.status,'mapping-required');assert.equal(summary.mappedDays,0);assert.equal(summary.lastSuccessfulAt,success);
  await collect({connect:async()=>({history:async()=>{throw new Error('private provider error')}})});
  assert.equal(summary.status,'failed');assert.equal(summary.failed,7);assert.equal(summary.lastSuccessfulAt,success);
  await collect({connect:async()=>({history:async(date,soc)=>{if(soc)return null;if(date==='2026-10-13')throw new Error('outage');return good}})});
  assert.equal(summary.status,'partial');assert.equal(summary.saved,6);assert.equal(summary.lastSuccessfulAt,success);
  const before=JSON.stringify(summary);store.acquireSync=async()=>({acquired:false,retryAfter:50});
  await collect({connect:async()=>assert.fail('no login during cooldown')});assert.equal(JSON.stringify(summary),before);
});

test('read endpoint returns only safe persisted status fields and tolerates status storage outages',async()=>{
  const {handleRead}=require('../lib/sigen-handlers.cjs');const store=memoryStore();
  store.data.set('sigenergy/2026-10-13.json',{date:'2026-10-13',samples:[{minute:0,solarKw:1}]});
  store.readSyncStatus=async()=>({status:'synced',startedAt:now.toISOString(),completedAt:now.toISOString(),lastSuccessfulAt:now.toISOString(),saved:7,mappedDays:7,failed:0,source:'manual',password:'SECRET',schema:{token:'SECRET'}});
  let res=response();await handleRead({method:'GET'},res,{now,store});assert.equal(res.body.sync.status,'synced');assert.equal(res.body.sync.mappedDays,7);assert.equal(res.body.days.length,1);assert.doesNotMatch(JSON.stringify(res.body),/SECRET|source|schema/);
  store.readSyncStatus=async()=>{throw new Error('Blob unavailable')};
  res=response();await handleRead({method:'GET'},res,{now,store});assert.equal(res.statusCode,200);assert.equal(res.body.days.length,1);assert.equal(res.body.sync,null);assert.equal(res.body.syncStatusUnavailable,true);
});
