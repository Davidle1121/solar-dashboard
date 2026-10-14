// Build-log metadata only: no reading values, point timestamps, account fields,
// credentials, or long identifiers. The IDs here identify measurement series.
const Solar=require('../solar-energy.js');
function describeHistory(date,raw,mapping={}) {
  const chart=raw?.chartData||(Array.isArray(raw?.dataSeries)?raw:null);
  if(!chart)return {chartPresent:false,series:[]};
  const unit=String(chart.unit||'').trim().toLowerCase();
  return {chartPresent:true,series:(Array.isArray(chart.dataSeries)?chart.dataSeries:[]).slice(0,20).map(series=>{
    const id=String(series.id??'');
    const safeId=/^(?:[A-Za-z][A-Za-z_-]{0,63}|\d{1,3})$/.test(id)?id:'[unrecognized identifier]';
    const points=Array.isArray(series.points)?series.points:[];
    const numeric=points.filter(p=>p?.value!=null&&String(p.value).trim()!==''&&Number.isFinite(Number(p.value)));
    const firstTime=String(points.find(p=>p?.time!=null)?.time??'');
    const timeFormat=/^\d{1,2}:\d{2}(?::\d{2})?$/.test(firstTime)?'clock':/^\d{4}[-/]?\d{2}[-/]?\d{2}/.test(firstTime)?'date-time':/^\d{10,13}$/.test(firstTime)?'epoch':'other';
    const normalized=Solar.normalizeHistory(date,[{chartData:{unit:chart.unit,dataSeries:[series]}}],mapping);
    return {id:safeId,unit:['kw','kwh','%'].includes(unit)?unit:'unrecognized',points:points.length,numericPoints:numeric.length,negativePoints:numeric.filter(p=>Number(p.value)<0).length,timeFormat,mappedMetrics:normalized.mappedMetrics,usableSamples:normalized.samples.length};
  })};
}
module.exports={describeHistory};
