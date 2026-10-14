const Solar=require('../solar-energy.js');
const {acquireSyncLock}=require('./sigen-sync-lock.cjs');
const PREFIX='sigenergy/';
async function blobStore(token=process.env.BLOB_READ_WRITE_TOKEN) {
  if(!token)throw new Error('Sigenergy storage is not configured');
  const sdk=await import('@vercel/blob');
  return {
    acquireSync:now=>acquireSyncLock(sdk,token,now),
    async list(){let cursor;const all=[];do{const p=await sdk.list({prefix:PREFIX,token,cursor});all.push(...p.blobs);cursor=p.hasMore?p.cursor:undefined;}while(cursor);return all;},
    async read(path){const r=await sdk.get(path,{access:'private',token,useCache:false});return r?.statusCode===200?JSON.parse(await new Response(r.stream).text()):null;},
    async write(record){await sdk.put(PREFIX+record.date+'.json',JSON.stringify(record),{access:'private',token,addRandomSuffix:false,allowOverwrite:true,contentType:'application/json',cacheControlMaxAge:60});},
    async remove(paths){if(paths.length)await sdk.del(paths,{token});}
  };
}
async function retainedRecords(store,now=new Date(),prune=false) {
  const allowed=new Set(Solar.retainedDates(now)),files=await store.list(),kept=[],expired=[];
  for(const file of files){const match=file.pathname.match(/^sigenergy\/(20\d{2}-\d{2}-\d{2})\.json$/);if(!match)continue;if(allowed.has(match[1]))kept.push(file);else expired.push(file.pathname);}
  // Run before upstream login, so retention also applies when the vendor is down.
  if(prune)await store.remove(expired);
  const records=[];
  for(const file of kept){const record=await store.read(file.pathname);if(record&&allowed.has(record.date)&&Array.isArray(record.samples))records.push(record);}
  return records.sort((a,b)=>a.date.localeCompare(b.date));
}
module.exports={blobStore,retainedRecords};
