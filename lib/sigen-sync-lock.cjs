const LOCK_PATH='sigenergy-meta/sync-lock.json';
const COOLDOWN_MS=5*60*1000;
// One tiny private metadata object coordinates builds, cron, and manual requests.
// Conditional writes prevent simultaneous serverless instances from both logging in.
async function acquireSyncLock(sdk,token,now=new Date()) {
  const existing=await sdk.get(LOCK_PATH,{access:'private',token,useCache:false});
  let previous;
  if(existing?.statusCode===200)previous=JSON.parse(await new Response(existing.stream).text());
  const remaining=Number(previous?.until)-now.getTime();
  if(remaining>0)return {acquired:false,retryAfter:Math.ceil(remaining/1000)};
  try {
    await sdk.put(LOCK_PATH,JSON.stringify({until:now.getTime()+COOLDOWN_MS}),{
      access:'private',token,addRandomSuffix:false,contentType:'application/json',cacheControlMaxAge:60,
      ...(existing?.statusCode===200?{allowOverwrite:true,ifMatch:existing.blob.etag}:{allowOverwrite:false})
    });
    return {acquired:true};
  }catch(error){
    if(error instanceof sdk.BlobPreconditionFailedError||/already exists/i.test(error.message||''))return {acquired:false,retryAfter:300};
    throw error;
  }
}
module.exports={acquireSyncLock,LOCK_PATH,COOLDOWN_MS};
