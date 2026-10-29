const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
function engine() {
  const context = {window:{addEventListener(){}}, console, setTimeout, clearTimeout};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return context;
}
function intervals(paid=0.001, free=0.2) {
  return Array.from({length:96},(_,i)=>({time:String(Math.floor(i/4)).padStart(2,'0')+':'+String(i%4*15).padStart(2,'0'), kwh:i>=36&&i<84?paid:free,hasImport:true,exportKwh:0}));
}
const options={day:'2026-10-27',freeStart:21,freeEnd:9,dayRate:25,nightRate:0};
function near(actual,expected) {assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`)}

test('October 27 arithmetic fixture matches supplied daily, period, export and peak totals',()=>{
  // Synthetic intervals reproduce the supplied totals. They do not purport to
  // reproduce that day's unavailable raw readings or measured weather.
  const c=engine(), rows=intervals();
  rows.forEach((r,i)=>{r.kwh=i<36?7.234/36:i<84?0.048/48:1.717/8;r.exportKwh=0.093/96});
  [0.9,2.905,1.4,0.97].forEach((kwh,index)=>{rows[84+index].kwh=kwh});
  const result=c.analyzeEnergyInsights(rows,options);
  assert.equal(result.status,'Looks normal');
  near(result.measurements.total.kwh,15.174);near(result.measurements.paid.kwh,0.048);near(result.measurements.exported.kwh,0.093);
  near(result.rows[0].measurements.kwh,7.234);near(result.rows[2].measurements.kwh,7.892);
  assert.match(result.rows[2].detail,/6.175 kWh from 9pm–10pm/);
  assert.equal(result.measurements.peakImport.time,'21:15');near(result.measurements.peakImport.averageKw,11.62);
  assert.match(result.rows[1].cost,/\$0\.012 at 25¢/);assert.match(result.exports,/0.093 kWh/);
  assert.match(c.analyzeEnergyInsights(rows,{...options,dayRate:15}).rows[1].cost,/\$0\.0072 at 15¢/);
});

test('zero imports and exports are measured zero, without invented percentages or anomalies',()=>{
  const result=engine().analyzeEnergyInsights(intervals(0,0),options);
  assert.equal(result.status,'Looks normal');assert.equal(result.rows.length,3);
  assert.match(result.exports,/0.000 kWh/);assert.match(result.rows[1].cost,/\$0\.00 at/);
  assert.doesNotMatch(JSON.stringify(result),/NaN|Infinity|%/);
});

test('large free-night charging and small paid spikes do not override spending severity',()=>{
  const c=engine(), rows=intervals(0.001,5);
  assert.equal(c.analyzeEnergyInsights(rows,options).status,'Looks normal');
  rows[56].kwh=0.6;
  const result=c.analyzeEnergyInsights(rows,options);
  assert.equal(result.status,'Looks normal');assert.equal(result.rows[1].category,'daytime');
  assert.equal(result.rows[1].tone,'good');assert.match(result.rows[1].detail,/2pm–2:15pm/);
  assert.ok(result.rows.every(row=>!/caused|powered by|battery state/i.test(row.text+row.detail)));
});

test('sustained small draws require adjacent intervals',()=>{
  const c=engine(),rows=intervals(0,0);
  rows[40].kwh=rows[41].kwh=0.125;
  assert.equal(c.analyzeEnergyInsights(rows,options).status,'Looks normal');
  assert.match(c.analyzeEnergyInsights(rows,options).rows[1].detail,/Largest recorded 15-minute/);
  rows[41].kwh=0;rows[42].kwh=0.125;
  assert.equal(c.analyzeEnergyInsights(rows,options).status,'Looks normal');
  assert.equal(c.analyzeEnergyInsights(rows,options).rows[1].detail,'');
});

test('recent baseline catches increased paid use and excludes incomplete or estimated history',()=>{
  const c=engine();
  const history=Array.from({length:8},(_,i)=>({day:'2026-10-'+(19+i),intervals:intervals(0,0)}));
  const result=c.analyzeEnergyInsights(intervals(0.015,0),{...options,history});
  assert.equal(result.status,'Looks normal');assert.match(result.rows[1].detail,/above your recent pattern/);
  history.forEach(item=>{item.intervals[40].importEstimated=true});
  const excluded=c.analyzeEnergyInsights(intervals(0.015,0),{...options,history});
  assert.equal(excluded.measurements.baselineDays,0);assert.equal(excluded.status,'Looks normal');
});

test('missing morning data prevents a whole-day normal verdict even when daytime is complete',()=>{
  const rows=intervals();rows.splice(0,1);
  const result=engine().analyzeEnergyInsights(rows,options);
  assert.equal(result.status,'Incomplete data');assert.match(result.rows[0].text,/Partial/);
  assert.equal(result.measurements.paid.complete,true);
});

test('estimated imports and partial exports retain honest independent quality labels',()=>{
  const c=engine(),rows=intervals();rows[40].importEstimated=true;delete rows[4].exportKwh;
  const result=c.analyzeEnergyInsights(rows,options);
  assert.equal(result.status,'Incomplete data');assert.match(result.rows[1].text,/Includes estimates/);
  assert.match(result.exports,/Partial readings/);
  rows[40].importEstimated=false;rows[40].exportEstimated=true;
  const exportOnlyEstimate=c.analyzeEnergyInsights(rows,options);
  assert.equal(exportOnlyEstimate.status,'Looks normal');assert.match(exportOnlyEstimate.exports,/Includes estimates/);
});

test('export-only data and absent data never invent zero imports or clear-weather claims',()=>{
  const c=engine(),rows=intervals();rows.forEach(r=>{r.hasImport=false;r.kwh=0;r.exportKwh=1});
  const result=c.analyzeEnergyInsights(rows,options);
  assert.equal(result.status,'Incomplete data');assert.equal(result.measurements.total.kwh,null);
  assert.match(result.exports,/96.000/);assert.ok(result.rows.every(row=>/No grid readings/.test(row.text)));
  for(const value of [null,undefined,{},[],[null,{},'x']])assert.equal(c.analyzeEnergyInsights(value,options).status,'Incomplete data');
  for(const value of [null,undefined,'bad',{}])assert.doesNotThrow(()=>c.analyzeEnergyInsights(rows,value));
});

test('invalid rates omit cost without changing measured imports and tiny valid charges stay accurate',()=>{
  const c=engine();
  for(const rate of [null,undefined,NaN,Infinity,-1,'15']) {
    const result=c.analyzeEnergyInsights(intervals(),{...options,dayRate:rate});
    assert.equal(result.rows[1].cost,'');near(result.measurements.paid.kwh,0.048);
  }
  assert.match(c.insightCost(0.000001,25),/under \$0\.0001/);
  assert.equal(c.insightCost(1e308,1e308),'');
});

test('changed schedules keep truthful chronological labels and reject ambiguity',()=>{
  const c=engine();
  const changed=c.analyzeEnergyInsights(intervals(),{...options,freeEnd:8});
  assert.ok(changed.rows.some(row=>/8am–9pm/.test(row.headline)));
  const reversed=c.analyzeEnergyInsights(intervals(),{...options,freeStart:9,freeEnd:21});
  assert.ok(reversed.rows.some(row=>row.category==='daytime'&&/during free hours/.test(row.text)));
  for(const settings of [{freeStart:21,freeEnd:21},{freeStart:NaN,freeEnd:8},{freeStart:-1,freeEnd:30}]) {
    const result=c.analyzeEnergyInsights(intervals(),{...options,...settings});
    assert.ok(result.rows.some(row=>/9am–9pm/.test(row.headline)));
  }
});

test('America/Chicago DST days are handled conservatively and independently of host timezone',()=>{
  const c=engine();
  assert.equal(c.insightExpectedTimes('2026-03-08').length,92);
  assert.equal(c.insightExpectedTimes('2026-11-01').length,100);
  const spring=intervals().filter(r=>!r.time.startsWith('02:'));
  assert.equal(c.analyzeEnergyInsights(spring,{...options,day:'2026-03-08'}).status,'Looks normal');
  const autumn=c.analyzeEnergyInsights(intervals(),{...options,day:'2026-11-01'});
  assert.equal(autumn.status,'Incomplete data');assert.equal(autumn.measurements.paid.complete,true);
});

test('analysis sanitizes duplicate revisions without mutating the source or accepting invalid intervals',()=>{
  const c=engine(),rows=intervals();rows.push({...rows[40],kwh:0.6,importRevision:123},null,{time:'25:00',kwh:5});
  const before=JSON.stringify(rows);const result=c.analyzeEnergyInsights(rows,options);
  assert.equal(JSON.stringify(rows),before);assert.equal(result.status,'Looks normal');
  assert.equal(result.measurements.peakPaid.kwh,0.6);
  const huge=intervals(1e308,1e308);
  assert.doesNotMatch(JSON.stringify(c.analyzeEnergyInsights(huge,options)),/Infinity|NaN/);
});

test('invalid history cannot manufacture a baseline from duplicate or future days',()=>{
  const c=engine(),zero=intervals(0,0);
  const history=Array.from({length:10},()=>({day:'2026-10-26',intervals:zero}));
  history.push({day:'2026-10-28',intervals:zero},{day:'2026-08-01',intervals:zero},null,{});
  const result=c.analyzeEnergyInsights(intervals(0.015,0),{...options,history});
  assert.equal(result.measurements.baselineDays,1);assert.equal(result.status,'Looks normal');
});

test('null, malformed and gapped data scenarios never throw or produce over three observations',()=>{
  const c=engine();
  for(let scenario=0;scenario<80;scenario++) {
    const rows=intervals();
    for(let i=scenario%9;i<rows.length;i+=9) {
      if(scenario%4===0)rows[i]=null;
      else if(scenario%4===1)rows[i].time='broken';
      else if(scenario%4===2)rows[i].importEstimated=true;
      else {rows[i].kwh=-1;rows[i].exportKwh=undefined}
    }
    const result=c.analyzeEnergyInsights(rows,{...options,dayRate:scenario%2?0:null});
    assert.equal(result.status,'Incomplete data');assert.ok(result.rows.length<=3);
    assert.doesNotMatch(JSON.stringify(result),/NaN|Infinity|undefined/);
  }
});

test('weather context rounds Fahrenheit and formats already-local sun times on two lines',()=>{
  const c=engine();
  const lines=c.insightWeatherLines({condition:'Overcast',postalCode:'77494',highF:81.6,lowF:64.2,sunrise:'07:31',sunset:'18:40'});
  assert.equal(lines.length,2);assert.match(lines[0],/77494 · Overcast · High 82°F \/ Low 64°F \(approx.\)/);
  assert.equal(lines[1],'Sunrise 7:31am · Sunset 6:40pm');
});

test('optional weather fields never invent zero temperatures or invalid sun times',()=>{
  const c=engine();
  const bare=c.insightWeatherLines({condition:'Cloudy'});
  assert.equal(bare.length,1);assert.doesNotMatch(bare[0],/High|Low|Sunrise|Sunset/);
  const bad=c.insightWeatherLines({condition:'Cloudy',highF:null,lowF:'0',sunrise:'25:00',sunset:'junk'});
  assert.equal(bad.length,1);assert.doesNotMatch(bad[0],/0°F|Sunrise|Sunset/);
  assert.match(c.insightWeatherLines({condition:'Clear',highF:0,lowF:-5})[0],/High 0°F \/ Low -5°F/);
  assert.doesNotMatch(c.insightWeatherLines({condition:'Clear',highF:40,lowF:80,sunrise:'19:00',sunset:'07:00'}).join(' '),/High|Low|Sunrise|Sunset/);
  for(const value of [null,{},undefined,{condition:'Unknown'}])assert.equal(c.insightWeatherLines(value).length,0);
});

test('versioned weather request bypasses condition-only HTTP caches and reuses the refreshed record',async()=>{
  const c=engine();const storage=new Map();let calls=0;
  c.localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)};
  c.fetch=async url=>{calls++;assert.match(url,/date=2026-10-27&v=3/);return{ok:true,json:async()=>({condition:'Cloudy',highF:82,lowF:64,sunrise:'07:31',sunset:'18:40'})}};
  assert.equal((await c.fetchWeatherForDate('2026-10-27')).highF,82);
  assert.equal((await c.fetchWeatherForDate('2026-10-27')).sunrise,'07:31');
  assert.equal(calls,1);
});

test('takeaway names paid-hours scope and sections keep a stable chronological order',()=>{
  const c=engine(), rows=intervals();
  const result=c.analyzeEnergyInsights(rows,options);
  assert.equal(result.takeawayLabel,'Paid-hours grid use · 9am–9pm');
  assert.match(result.summary,/only 0.048 kWh of grid electricity during paid hours/);
  assert.deepEqual(JSON.parse(JSON.stringify(result.rows.map(row=>row.name))),['Morning','Daytime','Night']);
  assert.equal(result.rows[0].timeRange,'midnight–9am');
  assert.equal(result.rows[0].explanation,'Electricity was free during these hours.');
  assert.doesNotMatch(result.rows[0].detail,/Imports dropped|paid hours began/);
  assert.match(result.rows[1].detail,/Grid use dropped when paid hours began at 9am and stayed very low/);
  rows[40].kwh=0.6;
  const warning=c.analyzeEnergyInsights(rows,options);
  assert.deepEqual(JSON.parse(JSON.stringify(warning.rows.map(row=>row.name))),['Morning','Daytime','Night']);
  assert.equal(warning.rows[1].tone,'good');assert.match(warning.summary,/paid-hours details/);
  rows.splice(0,1);
  assert.equal(c.analyzeEnergyInsights(rows,options).takeawayLabel,'Meter readings are incomplete');
});


test('paid-hours color bands include exact boundaries and match 25-cent costs',()=>{
  const c=engine();
  for(const [kwh,level,cost] of [[0,'good','$0.00'],[1,'good','$0.25'],[4,'review','$1.00'],[8,'review','$2.00'],[20,'high','$5.00'],[80,'high','$20.00']]) {
    const rows=intervals(0,0);rows[40].kwh=kwh;
    const result=c.analyzeEnergyInsights(rows,options);
    assert.equal(result.rows[1].level,level);assert.ok(result.rows[1].cost.includes(cost));
    assert.equal(result.rows[0].level,null);assert.equal(result.rows[2].level,null);
  }
  // Repeated decimal additions must not turn exactly $5 yellow.
  assert.equal(c.analyzeEnergyInsights(intervals(20/48,0),options).rows[1].level,'high');
});

test('color bands require complete actual paid readings and follow configured hours',()=>{
  const c=engine(),rows=intervals(0,0);rows[40].kwh=6;
  rows[40].importEstimated=true;
  assert.equal(c.analyzeEnergyInsights(rows,options).rows[1].level,null);
  rows[40].importEstimated=false;rows.splice(40,1);
  assert.equal(c.analyzeEnergyInsights(rows,options).rows[1].level,null);
  const missingMorning=intervals(0,0).slice(1);
  assert.equal(c.analyzeEnergyInsights(missingMorning,options).rows[1].level,'good');
  const reversed=c.analyzeEnergyInsights(intervals(0,0),{...options,freeStart:9,freeEnd:21});
  assert.equal(reversed.rows[1].level,null);
  const changed=c.analyzeEnergyInsights(intervals(0,0),{...options,freeEnd:8});
  assert.equal(changed.rows[1].level,'good');assert.equal(changed.rows[1].timeRange,'8am–9pm');
});


test('disabling free nights makes all hours paid with one rate and no free-window claims',()=>{
  const c=engine(),rows=intervals();
  const result=c.analyzeEnergyInsights(rows,{...options,freeNights:false,nightRate:null});
  near(result.measurements.paid.kwh,9.648);
  assert.equal(result.takeawayLabel,'Paid-hours grid use · all 24 hours');
  assert.ok(result.rows.every(row=>/paid electricity hours/.test(row.explanation)));
  assert.ok(result.rows.every(row=>row.cost.includes('25¢/kWh')));
  assert.equal(result.rows[0].level,null);assert.equal(result.rows[2].level,null);
  assert.equal(result.rows[1].level,'good');
  vm.runInContext('freeNightsEnabled=false',c);
  for(let h=0;h<24;h++)assert.equal(c.isFreeHour(h),false);
  const cost=c.gridEnergyCost(rows,25,0);
  near(cost.daytime.kwh,9.648);near(cost.nighttime.kwh,0);near(cost.cost,2.412);
  assert.equal(cost.complete,true);
  vm.runInContext('freeNightsEnabled=true;freeStartHour=20;freeEndHour=8',c);
  assert.equal(c.isFreeHour(8),false);assert.equal(c.isFreeHour(20),true);
  assert.equal(c.isFreeHour(7.75),true);assert.equal(c.isFreeHour(19.75),false);
});


test('dollar limits validate, use current rate, and do not diagnose equipment from spikes',()=>{
  const c=engine();
  for(const limits of [null,{}, {yellow:0,red:5},{yellow:5,red:1},{yellow:1,red:1},{yellow:NaN,red:5},{yellow:1,red:Infinity},{yellow:1.001,red:5}]) {
    const r=c.analyzeEnergyInsights(intervals(),{...options,alertLimits:limits});
    assert.equal(r.assessment.level,null);assert.equal(r.rows[1].level,null);
  }
  const rows=intervals(0,0);rows[40].kwh=8;
  assert.equal(c.analyzeEnergyInsights(rows,options).assessment.level,'review');
  assert.equal(c.analyzeEnergyInsights(rows,{...options,dayRate:100}).assessment.level,'high');
  assert.equal(c.analyzeEnergyInsights(rows,{...options,dayRate:0}).assessment.level,'good');
  for(const rate of [null,undefined,-1,NaN,Infinity,'25']) {
    const r=c.analyzeEnergyInsights(rows,{...options,dayRate:rate});
    assert.equal(r.assessment.level,null);assert.equal(r.rows[1].level,null);assert.equal(r.weekly.cost,null);
  }
  assert.equal(c.analyzeEnergyInsights(rows,{...options,alertLimits:{yellow:3,red:10}}).assessment.level,'good');
  const period={kwh:3.98,complete:true,estimated:false};
  assert.equal(c.assessEnergyCost(period,25,{yellow:1,red:5}).level,'review'); // $0.995 displays $1.00
});

test('weekly frequency uses seven calendar dates including the report day, with honest gaps',()=>{
  const c=engine();
  const make=kwh=>{const rows=intervals(0,0);rows[40].kwh=kwh;return rows};
  const history=Array.from({length:6},(_,i)=>({day:'2026-10-'+(21+i),intervals:make(0)}));
  history.push({day:'2026-10-20',intervals:make(80)},{day:'2026-10-28',intervals:make(80)});
  let r=c.analyzeEnergyInsights(make(8),{...options,history});
  assert.equal(r.weekly.completeDays,7);assert.equal(r.weekly.reviewDays,1);near(r.weekly.cost,2);
  history[0].intervals=make(8);history[1].intervals=make(8);
  r=c.analyzeEnergyInsights(make(8),{...options,history});
  assert.equal(r.weekly.reviewDays,3);near(r.weekly.cost,6);
  history[0].intervals[40].importEstimated=true;history[1].intervals.splice(40,1);history.splice(2,1);
  r=c.analyzeEnergyInsights(make(8),{...options,history});
  assert.equal(r.weekly.completeDays,4);assert.equal(r.weekly.observedDays,6);assert.equal(r.weekly.reviewDays,1);near(r.weekly.cost,4);
  // A rate edit recalculates comparison costs; it does not invent historical tariffs.
  near(c.analyzeEnergyInsights(make(8),{...options,dayRate:50,history}).weekly.cost,8);
});

test('2026 clock changes agree across cost cards, insights and completeness checks',()=>{
  const c=engine();
  for(const [day,count] of [['2026-03-08',92],['2026-11-01',100]]) {
    const times=[...new Set(c.insightExpectedTimes(day))];
    const rows=times.map(time=>({time,kwh:0.01,hasImport:true,exportKwh:0}));
    assert.equal(c.insightExpectedTimes(day).length,count);
    const insight=c.analyzeEnergyInsights(rows,{...options,day});
    const cost=c.gridEnergyCost(rows,25,0,day);
    assert.equal(cost.complete,insight.measurements.total.complete);
    assert.equal(cost.daytime.complete,true);assert.equal(insight.assessment.level,'good');
    assert.equal(cost.nighttime.complete,count===92);
    assert.equal(c.isCompleteDay(rows,day),count===92);
    near(cost.cost,insight.assessment.cost);
    assert.match(insight.summary,count===92?/23-hour/:/25-hour/);
    vm.runInContext('freeNightsEnabled=false',c);
    const allDay=c.gridEnergyCost(rows,25,0,day);
    assert.equal(allDay.complete,count===92);
    assert.equal(c.analyzeEnergyInsights(rows,{...options,day,freeNights:false}).assessment.level,count===92?'good':null);
    vm.runInContext('freeNightsEnabled=true',c);
  }
});


test('displayed dollars and alert colors agree at half-cent and repeated-decimal boundaries',()=>{
  const c=engine(),limits={yellow:1,red:5};
  for(const [cost,display,level] of [[0.994,'$0.99','good'],[0.995,'$1.00','review'],[4.994,'$4.99','review'],[4.995,'$5.00','high'],[19.995,'$20.00','high']]) {
    const result=c.assessEnergyCost({kwh:cost*4,complete:true,estimated:false},25,limits);
    assert.equal(c.formatEnergyCost(result.cost),display);assert.equal(result.level,level);
  }
  assert.equal(c.formatEnergyCost(NaN),'—');assert.equal(c.formatEnergyCost(Infinity),'—');
});

test('partial or estimated paid readings never become a factual historical comparison',()=>{
  const c=engine(),history=Array.from({length:8},(_,i)=>({day:'2026-10-'+(19+i),intervals:intervals(0,0)}));
  const rows=intervals(0,0);rows[40].kwh=80;rows[40].importEstimated=true;
  let result=c.analyzeEnergyInsights(rows,{...options,history});
  assert.equal(result.elevated,false);assert.equal(result.assessment.level,null);
  assert.match(result.rows[1].cost,/based on available readings/);
  assert.match(result.rows[1].detail,/Largest recorded 15-minute/);
  assert.doesNotMatch(result.rows[1].detail,/above your recent pattern/);
  rows[40].importEstimated=false;rows.splice(41,1);
  result=c.analyzeEnergyInsights(rows,{...options,history});
  assert.equal(result.elevated,false);assert.equal(result.assessment.level,null);
  assert.match(result.rows[1].cost,/based on available readings/);
});
