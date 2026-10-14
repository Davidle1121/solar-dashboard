const { encryptPassword } = require('../scripts/sigen-probe.cjs');
const HOSTS={us:'api-us.sigencloud.com',eu:'api-eu.sigencloud.com',aus:'api-aus.sigencloud.com',apac:'api-apac.sigencloud.com',cn:'api-cn.sigenergy.com'};
async function connectSigen(env=process.env,fetchImpl=globalThis.fetch) {
  const host=HOSTS[env.SIGEN_REGION?.trim().toLowerCase()];
  if(!host||!env.SIGEN_USERNAME||!env.SIGEN_PASSWORD)throw new Error('Sigenergy configuration is missing');
  let token;
  // Fixed read-only paths; no arbitrary URL, command, inverter, or settings API.
  async function request(path,options={}) {
    const r=await fetchImpl('https://'+host+'/'+path,{...options,redirect:'error',signal:AbortSignal.timeout(7000)});
    if(!r.ok)throw new Error('Sigenergy request failed');
    const payload=await r.json();if(payload.code!==0&&payload.code!=='0')throw new Error('Sigenergy request rejected');
    const data=typeof payload.data==='string'?JSON.parse(payload.data):payload.data;
    if(!data||typeof data!=='object')throw new Error('Sigenergy response unavailable');return data;
  }
  const auth=await request('auth/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Authorization:'Basic '+Buffer.from('sigen:sigen').toString('base64')},body:new URLSearchParams({username:env.SIGEN_USERNAME,password:encryptPassword(env.SIGEN_PASSWORD),grant_type:'password'}).toString()});
  token=auth.access_token;if(typeof token!=='string'||!token)throw new Error('Sigenergy login failed');
  const headers={Authorization:'Bearer '+token,Accept:'application/json'};
  const station=await request('device/owner/station/home',{headers});
  if(!station.stationId||!['string','number'].includes(typeof station.stationId))throw new Error('Sigenergy system not found');
  return {history:async(date,soc=false)=>{
    if(!/^20\d{2}-\d{2}-\d{2}$/.test(date))throw new Error('Invalid history date');
    const params=new URLSearchParams({stationId:String(station.stationId),dateFlag:'1',startDate:date.replaceAll('-',''),endDate:date.replaceAll('-','')});
    return request('data-process/sigen/station/statistics/v1/'+(soc?'soc':'energy')+'?'+params,{headers});
  }};
}
module.exports={connectSigen};
