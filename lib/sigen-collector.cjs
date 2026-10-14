const Solar=require('../solar-energy.js');
const {connectSigen}=require('./sigen-client.cjs');
const {describeHistory}=require('./sigen-diagnostics.cjs');
const {blobStore,retainedRecords}=require('./sigen-store.cjs');
async function collectSigen({env=process.env,now=new Date(),store,connect=connectSigen,bootstrap=false,force=false,clock=Date.now}={}) {
  store=store||await blobStore(env.BLOB_READ_WRITE_TOKEN);
  const records=await retainedRecords(store,now,true);
  const today=Solar.chicagoParts(now).date,dates=Solar.retainedDates(now);
  if(bootstrap&&records.some(r=>r.samples.length))return {status:'already-initialized'};
  if(!bootstrap&&!force&&records.some(r=>r.syncDate===today))return {status:'already-synced'};
  if(store.acquireSync){const lock=await store.acquireSync(now);if(!lock.acquired)return {status:'cooldown',retryAfter:lock.retryAfter};}
  const started=clock();
  const previous=store.readSyncStatus?await store.readSyncStatus():null;
  // One overwritten summary survives reloads. No account data, credentials, raw
  // responses, or error messages are persisted. Rejected/skipped runs leave it alone.
  const attempt={startedAt:now.toISOString(),source:force?'manual':bootstrap?'deployment':'scheduled',status:'running',lastSuccessfulAt:previous?.lastSuccessfulAt||null};
  const saveStatus=async result=>{
    const completedAt=new Date(+now+Math.max(0,clock()-started)).toISOString();
    const summary={...attempt,...result,completedAt,lastSuccessfulAt:result.status==='synced'?completedAt:attempt.lastSuccessfulAt};
    if(store.writeSyncStatus)await store.writeSyncStatus(summary);
  };
  if(store.writeSyncStatus)await store.writeSyncStatus(attempt);
  try {
    let mapping={};
    if(env.SIGEN_SERIES_MAP){mapping=JSON.parse(env.SIGEN_SERIES_MAP);if(!mapping||typeof mapping!=='object'||Array.isArray(mapping))throw new Error('Invalid series mapping');}
    const client=await connect(env);
    let saved=0,failed=0,mappedDays=0;let schema;
    // Newest first, at most seven days. Revisit recent days for delayed readings.
    const wanted=[...dates].reverse().filter((date,i)=>force||i<2||!records.some(r=>r.date===date&&r.samples.length));
    for(const date of wanted) {
      if(clock()-started>40000){failed++;break;}
      try {
        const energy=await client.history(date);
        let soc;
        // SOC is optional: missing support must not discard usable power history.
        try{soc=await client.history(date,true);}catch{}
        if((bootstrap||force)&&!schema)schema={energy:describeHistory(date,energy,mapping),soc:soc?describeHistory(date,soc,mapping):{status:'unavailable'}};
        const normalized=Solar.normalizeHistory(date,[energy,soc],mapping);
        // Retain an older usable copy if a temporary vendor response is empty.
        if(!normalized.samples.length&&records.some(r=>r.date===date&&r.samples.length)){failed++;continue;}
        const record={...normalized,updatedAt:now.toISOString()};
        await store.write(record);saved++;if(record.samples.length)mappedDays++;
      } catch {failed++;}
    }
    // Only mark a whole run complete when every attempted day succeeded.
    // A failed run remains retryable and never deletes a valid in-window record.
    if(saved&&failed===0) {
      const latest=await store.read('sigenergy/'+dates[6]+'.json');
      if(latest){latest.syncDate=today;await store.write(latest);}
    }
    const result={status:failed?(saved?'partial':'failed'):mappedDays?'synced':saved?'mapping-required':'no-data',saved,mappedDays,failed};
    await saveStatus(result);
    return {...result,retentionDays:7,...(schema?{schema}:{})};
  }catch(error){
    // Keep a previous successful timestamp even when a later login/request fails.
    // If storage itself fails, retain the original error and never invent success.
    try{await saveStatus({status:'failed'});}catch{}
    throw error;
  }
}
module.exports={collectSigen};
