/* Shared by the browser and collector. Power samples are not energy readings:
 * integrate only adjacent samples, and expose coverage instead of filling gaps. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SolarEnergy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const METRICS = ['solarKw','loadKw','batteryChargeKw','batteryDischargeKw','gridImportKw','gridExportKw','socPct'];
  const ALIASES = {
    solarKw:['PV_POWER','SOLAR_POWER','solarKw','pvPower'],
    loadKw:['LOAD_POWER','HOME_POWER','HOME_CONSUMPTION_POWER','loadKw','loadPower'],
    batteryChargeKw:['BATTERY_CHARGE_POWER','BATTERY_CHARGING_POWER','ESS_CHARGE_POWER','batteryChargeKw'],
    batteryDischargeKw:['BATTERY_DISCHARGE_POWER','BATTERY_DISCHARGING_POWER','ESS_DISCHARGE_POWER','batteryDischargeKw'],
    gridImportKw:['GRID_IMPORT_POWER','GRID_BUY_POWER','gridImportKw'],
    gridExportKw:['GRID_EXPORT_POWER','GRID_SELL_POWER','gridExportKw'],
    socPct:['BATTERY_SOC','STATE_OF_CHARGE','socPct']
  };
  const key = value => String(value || '').replace(/[^a-z0-9]/gi,'').toLowerCase();
  function chicagoParts(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
    const get = name => parts.find(p => p.type === name).value;
    return {date:get('year')+'-'+get('month')+'-'+get('day'),hour:Number(get('hour')),minute:Number(get('minute'))};
  }
  function shiftDate(date, days) { const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10); }
  function retainedDates(now = new Date()) { const last=shiftDate(chicagoParts(now).date,-1);return Array.from({length:7},(_,i)=>shiftDate(last,i-6)); }
  function parseMinute(value,date) {
    const text=String(value ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) {
      const stamp=new Date(text);if(!Number.isFinite(stamp.getTime()))return null;
      const p=chicagoParts(stamp);return p.date===date ? p.hour*60+p.minute : p.date===shiftDate(date,1)&&p.hour===0&&p.minute===0 ? 1440 : null;
    }
    const match=text.match(/^(?:(\d{4}-?\d{2}-?\d{2})[ T])?(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if(!match)return null;
    if(match[1]&&match[1].replaceAll('-','')!==date.replaceAll('-',''))return null;
    const h=Number(match[2]),m=Number(match[3]);
    return h===24&&m===0?1440:h<24&&m<60?h*60+m:null;
  }
  function normalizeHistory(date, histories, mapping = {}) {
    const samples=new Map(), mapped=new Set(), ambiguous=new Set();let unmappedSeriesCount=0;
    for(const raw of histories) {
      const chart=raw?.chartData||(Array.isArray(raw?.dataSeries)?raw:null);
      const unit=String(chart?.unit||'').trim().toLowerCase();
      if(!['kw','%'].includes(unit))continue;
      for(const series of Array.isArray(chart.dataSeries)?chart.dataSeries:[]) {
        const metric=METRICS.find(m=>mapping[m]!=null ? String(mapping[m])===String(series.id) : ALIASES[m].some(alias=>key(alias)===key(series.id)));
        if(!metric || (metric==='socPct'?unit!=='%':unit!=='kw')){unmappedSeriesCount++;continue;}
        for(const point of Array.isArray(series.points)?series.points:[]) {
          const minute=parseMinute(point.time,date);
          if(minute==null||point.value==null||String(point.value).trim()==='')continue;
          const value=Number(point.value);
          if(!Number.isFinite(value)||value<0||value>(metric==='socPct'?100:100000))continue;
          if(!samples.has(minute))samples.set(minute,{minute});
          const identity=metric+':'+minute;
          // Repeated local-clock samples (for example the autumn DST fold) cannot
          // be treated as one continuous hour. Leave them unavailable.
          if(ambiguous.has(identity))continue;
          if(Object.hasOwn(samples.get(minute),metric)){delete samples.get(minute)[metric];ambiguous.add(identity);continue;}
          samples.get(minute)[metric]=value;mapped.add(metric);
        }
      }
    }
    return {date,samples:[...samples.values()].filter(sample=>METRICS.some(metric=>Number.isFinite(sample[metric]))).sort((a,b)=>a.minute-b.minute),mappedMetrics:[...mapped],unmappedSeriesCount,ambiguousSampleCount:ambiguous.size};
  }
  function hourlyEnergy(record, metric) {
    const values=Array(24).fill(null),coverage=Array(24).fill(0);
    const samples=record?.samples||[];
    for(let i=1;i<samples.length;i++) {
      const a=samples[i-1],b=samples[i],gap=b.minute-a.minute;
      if(gap<=0||gap>15||!Number.isFinite(a[metric])||!Number.isFinite(b[metric]))continue;
      // Split at hour boundaries; never bridge a missing/long interval.
      for(let start=a.minute;start<b.minute;) {
        const hour=Math.floor(start/60);if(hour<0||hour>=24)break;
        const end=Math.min(b.minute,(hour+1)*60);
        const left=a[metric]+(b[metric]-a[metric])*(start-a.minute)/gap;
        const right=a[metric]+(b[metric]-a[metric])*(end-a.minute)/gap;
        values[hour]=(values[hour]??0)+(left+right)/2*(end-start)/60;
        coverage[hour]+=end-start;start=end;
      }
    }
    return {values,coverage,total:values.some(v=>v!=null)?values.reduce((s,v)=>s+(v??0),0):null};
  }
  function hourlySoc(record) {
    const values=Array(24).fill(null);
    for(const sample of record?.samples||[]) if(sample.minute<1440&&Number.isFinite(sample.socPct))values[Math.floor(sample.minute/60)]=sample.socPct;
    return {values,coverage:values.map(v=>v==null?0:1),total:[...values].reverse().find(v=>v!=null)??null};
  }
  function hourlySmt(intervals, direction) {
    const values=Array(24).fill(null),coverage=Array(24).fill(0);
    for(const r of intervals||[]) {
      const hour=Number(r.time.split(':')[0]);
      const value=direction==='import'?(r.hasImport===false?null:r.kwh):r.exportKwh;
      if(hour>=0&&hour<24&&Number.isFinite(value)){values[hour]=(values[hour]??0)+value;coverage[hour]+=15;}
    }
    return {values,coverage,total:values.some(v=>v!=null)?values.reduce((s,v)=>s+(v??0),0):null};
  }
  return {METRICS,retainedDates,chicagoParts,shiftDate,parseMinute,normalizeHistory,hourlyEnergy,hourlySoc,hourlySmt};
});
