const {timingSafeEqual}=require('node:crypto');
const Solar=require('../solar-energy.js');
const {blobStore,retainedRecords}=require('./sigen-store.cjs');
const {collectSigen}=require('./sigen-collector.cjs');
async function handleRead(req,res,{env=process.env,now=new Date(),store}={}) {
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({error:'Method not allowed'});}
  if(!store&&!env.BLOB_READ_WRITE_TOKEN)return res.status(503).json({error:'Sigenergy storage is not connected yet',days:[]});
  try {
    const days=await retainedRecords(store||await blobStore(env.BLOB_READ_WRITE_TOKEN),now);
    return res.status(200).json({version:1,timezone:'America/Chicago',retentionDays:7,days});
  }catch{return res.status(503).json({error:'Saved Sigenergy data is temporarily unavailable',days:[]});}
}
async function handleSync(req,res,{env=process.env,now=new Date(),collect=collectSigen}={}) {
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({error:'Method not allowed'});}
  const expected='Bearer '+env.CRON_SECRET,received=String(req.headers.authorization||'');
  if(!env.CRON_SECRET||Buffer.byteLength(received)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(received),Buffer.from(expected)))return res.status(401).json({error:'Unauthorized'});
  // Vercel cron uses UTC. One daily job at each candidate UTC hour handles DST;
  // only the candidate landing in Central's 3 AM hour contacts the vendor.
  if(Solar.chicagoParts(now).hour!==3)return res.status(200).json({status:'outside-central-sync-hour'});
  try{return res.status(200).json(await collect({env,now}));}
  catch{return res.status(503).json({error:'Sigenergy sync could not complete; check server configuration and provider access'});}
}
module.exports={handleRead,handleSync};
