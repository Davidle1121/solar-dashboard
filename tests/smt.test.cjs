const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function dashboard() {
  const elements = new Map();
  const context = {
    window: { addEventListener() {} },
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { style: {}, setAttribute(name, value) { this[name] = value; }, value: id === 'hourly-range' ? '14' : id === 'night-rate' ? '0' : 'import', getContext() { return {}; } });
      return elements.get(id);
    } },
    Chart: function (_canvas, config) { this.config = config; this.destroy = () => {}; },
    console, setTimeout, clearTimeout,
  };
  vm.createContext(context);
  const html = fs.readFileSync('index.html', 'utf8');
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  context.loadHourlyWeather = () => {};
  return { context, elements, run: code => vm.runInContext(code, context) };
}
const header = 'USAGE_DATE,REVISION_DATE,USAGE_START_TIME,USAGE_END_TIME,USAGE_KWH,ESTIMATED_ACTUAL,CONSUMPTION_SURPLUSGENERATION';
function csv(rows) { return header + '\n' + rows.map(r => '10/13/2026,' + r).join('\n'); }

test('SMT keeps both directions, estimated flags, zeros, and newest revisions independently', () => {
  const { context: c } = dashboard();
  const data = c.parseCSV(csv([
    '10/14/2026 01:00:00,00:00,00:15,2,A,Consumption',
    '10/14/2026 01:00:00,00:00,00:15,4,E,Surplus Generation',
    '10/13/2026 01:00:00,00:00,00:15,1,A,Consumption',
    '10/15/2026 01:00:00,00:00,00:15,5,A,Surplus Generation',
    '10/14/2026 01:00:00,00:15,00:30,0,A,Consumption',
    '10/14/2026 01:00:00,00:15,00:30,0,A,Surplus Generation',
  ]), 'usage.csv').get('2026-10-13');
  assert.equal(data.length, 2);
  assert.equal(data[0].kwh, 2);
  assert.equal(data[0].exportKwh, 5);
  assert.equal(data[0].exportEstimated, false);
  assert.equal(c.gridTotals(data).net, -3);
  assert.equal(c.gridTotals(data).exported, 5);
});

test('older import-only files and unmatched intervals do not invent exports or net values', () => {
  const { context: c } = dashboard();
  const old = c.parseCSV('USAGE_DATE,USAGE_START_TIME,USAGE_KWH\n10/13/2026,00:00,2', 'old.csv').get('2026-10-13');
  assert.equal(c.gridTotals(old).imported, 2);
  assert.equal(c.gridTotals(old).exported, null);
  assert.equal(c.gridTotals(old).net, null);
  c.mergeInterval(old, { time: '00:15', kwh: 0, hasImport: false, exportKwh: 1 });
  assert.equal(c.gridTotals(old).net, null);
  assert.equal(c.isCompleteDay(Array.from({length: 96}, (_, i) => ({time: String(i), kwh: 0, hasImport: false, exportKwh: 1}))), false);
});

test('cross-file merges preserve both directions and prefer newer values', () => {
  const { context: c } = dashboard();
  const items = [];
  c.mergeInterval(items, {time:'00:00', kwh:2, importRevision:20});
  c.mergeInterval(items, {time:'00:00', kwh:0, hasImport:false, exportKwh:4, exportRevision:10});
  c.mergeInterval(items, {time:'00:00', kwh:9, importRevision:10});
  assert.equal(items.length, 1);
  assert.equal(c.gridTotals(items).net, -2);
});

test('hourly table highlights net export green, import red, and balance gray', () => {
  const { context: c, elements, run } = dashboard();
  run(`readings = new Map([
    ['2026-10-11', [{time:'00:00',kwh:2,exportKwh:4}]],
    ['2026-10-12', [{time:'00:00',kwh:4,exportKwh:2}]],
    ['2026-10-13', [{time:'00:00',kwh:2,exportKwh:2}]]
  ]);`);
  elements.get('hourly-metric') || c.document.getElementById('hourly-metric');
  elements.get('hourly-metric').value = 'net';
  run('renderHourlyTable([...readings.keys()])');
  const body = elements.get('hourly-table-body').innerHTML;
  assert.match(body, /color:#3fb950;background:">-2.00/);
  assert.match(body, /color:#f85149;background:">2.00/);
  assert.match(body, /—/);
  assert.match(elements.get('hourly-table-head').innerHTML, /Net \(kWh\)/);
  assert.match(elements.get('hourly-table-head').innerHTML, /Export kWh/);
});

test('SMT XLSX rows share the bidirectional CSV parser', () => {
  const { context: c } = dashboard();
  const data = c.parseXLSXRows([
    header.split(','),
    ['10/13/2026','10/14/2026 01:00:00','00:00','00:15',1,'A','Consumption'],
    ['10/13/2026','10/14/2026 01:00:00','00:00','00:15',3,'E','Surplus Generation'],
  ], 'usage.xlsx').get('2026-10-13');
  assert.equal(c.gridTotals(data).net, -2);
  assert.equal(c.gridTotals(data).estimated, true);
});

test('session cache serialization retains exports, coverage, revision, and quality', () => {
  const { context: c } = dashboard();
  const source = c.parseCSV(csv([
    '10/14/2026 01:00:00,00:00,00:15,1,A,Consumption',
    '10/14/2026 01:00:00,00:00,00:15,0,E,Surplus Generation',
  ]), 'usage.csv');
  const restored = c.deserializeReadingsMap(JSON.parse(JSON.stringify(c.serializeReadingsMap(source))));
  const reading = restored.get('2026-10-13')[0];
  assert.equal(reading.hasImport, true);
  assert.equal(reading.exportKwh, 0);
  assert.equal(reading.exportEstimated, true);
  assert.ok(reading.exportRevision > 0);
  assert.equal(c.gridTotals(restored.get('2026-10-13')).net, 1);
});

test('default free nights end at 9am, with paid hours from 9am through 8:59pm', () => {
  const { context: c } = dashboard();
  assert.equal(c.isFreeHour(8), true);
  assert.equal(c.isFreeHour(9), false);
  assert.equal(c.isFreeHour(20), false);
  assert.equal(c.isFreeHour(21), true);
  const intervals = ['08:45', '09:00', '20:45', '21:00'].map(time => ({time, kwh: 1, exportKwh: 99}));
  assert.equal(c.periodEnergyCost(intervals, 25).kwh, 2);
  assert.equal(c.periodEnergyCost(intervals, 25).cost, 0.5);
  assert.equal(c.periodEnergyCost(intervals, 0).cost, 0);
});

test('costs flag partial data, exclude export-only readings, and accept complete zero imports', () => {
  const { context: c } = dashboard();
  assert.equal(c.periodEnergyCost([{time:'12:00',kwh:0,hasImport:false,exportKwh:8}],25).cost, null);
  assert.equal(c.periodEnergyCost([],25).cost, null);
  assert.equal(c.periodEnergyCost([{time:'12:00',kwh:1,importEstimated:true}],25).estimated, true);
  assert.equal(c.periodEnergyCost([{time:'12:00',kwh:1}],25).complete, false);
  const intervals = Array.from({length:48}, (_, i) => ({time: String(9 + Math.floor(i / 4)).padStart(2, '0') + ':' + String(i % 4 * 15).padStart(2,'0'),kwh:0}));
  assert.equal(c.periodEnergyCost(intervals,25).complete, true);
  assert.equal(c.periodEnergyCost(intervals,25).cost, 0);
});

test('cost widget recalculates selected-day and trailing seven-day costs without using older data', () => {
  const { context: c, run } = dashboard();
  c.document.getElementById('day-rate').value = '25';
  run("readings = new Map([['2026-10-06',[{time:'12:00',kwh:100}]],['2026-10-07',[{time:'12:00',kwh:4}]],['2026-10-13',[{time:'09:00',kwh:8},{time:'21:00',kwh:100}]]]); currentDayIndex=2; renderCostEstimates();");
  assert.equal(c.document.getElementById('cost-daily').textContent, '$2.00');
  assert.equal(c.document.getElementById('cost-weekly').textContent, '$3.00');
  assert.match(c.document.getElementById('cost-weekly-note').textContent, /2\/7 days/);
  c.document.getElementById('day-rate').value = '50';
  c.renderCostEstimates();
  assert.equal(c.document.getElementById('cost-daily').textContent, '$4.00');
  assert.equal(c.document.getElementById('cost-weekly').textContent, '$6.00');
  run('freeEndHour=10; renderCostEstimates();');
  assert.equal(c.document.getElementById('cost-daily').textContent, '$0.00');
  assert.equal(c.document.getElementById('cost-weekly').textContent, '$2.00');
  c.document.getElementById('day-rate').value = '-1';
  c.renderCostEstimates();
  assert.equal(c.document.getElementById('cost-daily').textContent, '—');
  assert.match(c.document.getElementById('rate-validation').textContent, /non-negative/);
  c.document.getElementById('day-rate').value = '';
  c.renderCostEstimates();
  assert.equal(c.document.getElementById('cost-weekly').textContent, '—');
});

test('latest-day cards stay pinned to newest readings while historical selection and both rates change', () => {
  const { context: c, run } = dashboard();
  c.document.getElementById('day-rate').value = '25';
  c.document.getElementById('night-rate').value = '0';
  run("readings = new Map([['2026-10-10',[{time:'12:00',kwh:4},{time:'22:00',kwh:2}]],['2026-10-13',[{time:'09:00',kwh:8},{time:'00:00',kwh:3},{time:'21:00',kwh:7,importEstimated:true}]]]); currentDayIndex=0; renderCostEstimates();");
  assert.match(c.document.getElementById('latest-energy-date').textContent, /Oct 13/);
  assert.equal(c.document.getElementById('latest-day-import').textContent, '8.000 kWh');
  assert.equal(c.document.getElementById('latest-night-import').textContent, '10.000 kWh');
  assert.equal(c.document.getElementById('latest-day-cost').textContent, '$2.00');
  assert.equal(c.document.getElementById('latest-night-cost').textContent, '$0.00');
  assert.equal(c.document.getElementById('cost-daily').textContent, '$1.00');
  assert.match(c.document.getElementById('latest-night-import-note').textContent, /estimated/);
  c.document.getElementById('night-rate').value = '10';
  c.renderCostEstimates();
  assert.equal(c.document.getElementById('latest-night-cost').textContent, '$1.00');
  assert.equal(c.document.getElementById('cost-daily').textContent, '$1.20');
  assert.equal(c.document.getElementById('cost-weekly').textContent, '$1.20');
  run('currentDayIndex=1; renderCostEstimates();');
  assert.equal(c.document.getElementById('cost-daily').textContent, '$3.00');
  assert.equal(c.document.getElementById('cost-weekly').textContent, '$4.20');
  c.document.getElementById('day-rate').value = '50';
  c.renderCostEstimates();
  assert.equal(c.document.getElementById('latest-day-cost').textContent, '$4.00');
  assert.equal(c.document.getElementById('cost-daily').textContent, '$5.00');
  assert.equal(c.document.getElementById('cost-weekly').textContent, '$7.20');
});

test('missing nighttime imports show unavailable while measured zero usage shows zero cost', () => {
  const { context: c, run } = dashboard();
  c.document.getElementById('day-rate').value = '25';
  run("readings = new Map([['2026-10-13',[{time:'12:00',kwh:1},{time:'22:00',kwh:0,hasImport:false,exportKwh:5}]]]); renderCostEstimates();");
  assert.equal(c.document.getElementById('latest-night-import').textContent, '—');
  assert.equal(c.document.getElementById('latest-night-cost').textContent, '—');
  assert.match(c.document.getElementById('cost-daily-note').textContent, /Partial day/);
  run("readings.get('2026-10-13')[1].hasImport=true; renderCostEstimates();");
  assert.equal(c.document.getElementById('latest-night-import').textContent, '0.000 kWh');
  assert.equal(c.document.getElementById('latest-night-cost').textContent, '$0.00');
});

test('invalid night rates preserve import data and valid day costs but invalidate combined totals', () => {
  const { context: c, run } = dashboard();
  c.document.getElementById('day-rate').value = '25';
  run("readings = new Map([['2026-10-13',[{time:'12:00',kwh:4},{time:'22:00',kwh:2}]]]);");
  for (const invalid of ['', '-1', 'abc']) {
    c.document.getElementById('night-rate').value = invalid;
    c.renderCostEstimates();
    assert.equal(c.document.getElementById('latest-night-import').textContent, '2.000 kWh');
    assert.equal(c.document.getElementById('latest-day-cost').textContent, '$1.00');
    assert.equal(c.document.getElementById('latest-night-cost').textContent, '—');
    assert.equal(c.document.getElementById('cost-daily').textContent, '—');
    assert.equal(c.document.getElementById('cost-weekly').textContent, '—');
  }
});

test('nighttime windows include both ends of the same calendar day and update with selectors', () => {
  const { context: c, run } = dashboard();
  const intervals = ['00:00','08:45','09:00','20:45','21:00','23:45'].map(time => ({time,kwh:1}));
  assert.equal(c.periodEnergyCost(intervals,10,true).kwh, 4);
  assert.equal(c.gridEnergyCost(intervals,25,10).cost, 0.9);
  run('freeEndHour=8;');
  assert.equal(c.periodEnergyCost(intervals,10,true).kwh, 3);
  assert.equal(c.gridEnergyCost(intervals,25,10).cost, 1.05);
});

function reviewIntervals(daytimeKwh = 0, nighttimeKwh = 4) {
  return Array.from({length:96}, (_,i) => ({time: String(Math.floor(i/4)).padStart(2,'0') + ':' + String(i%4*15).padStart(2,'0'), kwh: i >= 36 && i < 84 ? daytimeKwh : nighttimeKwh, hasImport:true}));
}

test('daytime review ignores large night charging and uses latest day independently of selection', () => {
  const {context:c, run} = dashboard();
  c.sample = reviewIntervals(0.001, 8);
  run("readings.set('2026-10-19',sample); currentDayIndex=0");
  const result = c.daytimeReview(['2026-10-19']);
  assert.equal(result.status,'Looks normal');
  assert.match(result.lines[0],/0.048 kWh/);
  assert.match(result.lines.join(' '),/Baseline not established/);
});

test('daytime review catches paid-hours spikes and refuses reassurance for incomplete or estimated data', () => {
  const {context:c, run} = dashboard();
  c.sample = reviewIntervals();
  c.sample[40].kwh = 0.6;
  run("readings.set('2026-10-19',sample)");
  assert.equal(c.daytimeReview(['2026-10-19']).status,'Worth checking');
  c.sample[40].importEstimated = true;
  assert.equal(c.daytimeReview(['2026-10-19']).status,'Insufficient data');
  c.sample.splice(40,1);
  assert.equal(c.daytimeReview(['2026-10-19']).status,'Insufficient data');
  run('readings.clear()');
  assert.equal(c.daytimeReview([]).status,'Insufficient data');
});

test('daytime review follows changed free hours and compares with actual complete prior days', () => {
  const {context:c, run} = dashboard();
  c.prior = reviewIntervals(0.001);
  c.latest = reviewIntervals(0.02);
  run("for(let d=10;d<19;d++) readings.set('2026-10-'+d,prior); readings.set('2026-10-19',latest)");
  const result = run('daytimeReview([...readings.keys()].sort())');
  assert.equal(result.status,'Worth checking');
  assert.match(result.lines.join(' '),/twice the recent median/);
  run('freeStartHour=9; freeEndHour=21');
  assert.match(c.daytimeReview(['2026-10-19']).lines[0],/9pm–9am/);
});

test('SMT CSV detects headers after metadata without discarding header-first data', () => {
  const {context:c} = dashboard();
  const data = 'Report: SMT\nDownloaded October 20\n USAGE_DATE , USAGE_START_TIME , USAGE_KWH , CONSUMPTION_SURPLUSGENERATION \n10/19/2026, 21:15 ,3.5, Consumption \n10/19/2026, 09:00 ,1.2, Surplus Generation ';
  const parsed = c.parseCSV(data,'usage.csv').get('2026-10-19');
  assert.equal(parsed.length,2);
  assert.equal(parsed.find(r=>r.time==='21:15').kwh,3.5);
  assert.equal(parsed.find(r=>r.time==='09:00').exportKwh,1.2);
});

test('behavior summaries separate imports and exports and use exclusive end boundaries', () => {
  const {context:c} = dashboard();
  const sample = reviewIntervals(0.001,1).map(r=>({...r, exportKwh:0.25}));
  const result = c.reviewBehaviors(sample);
  assert.equal(result.firstHour.kwh,4);
  assert.equal(result.overnightLoad.kwh,24);
  assert.equal(result.paidExport.kwh,12);
  assert.equal(result.paidImport.complete,true);
  assert.equal(result.firstHour.complete,true);
  assert.equal(result.paidExport.complete,true);
  delete sample[36].exportKwh;
  assert.equal(c.reviewBehaviors(sample).paidExport.complete,false);
  assert.equal(c.reviewBehaviors(sample).paidImport.complete,true);
  assert.equal(c.reviewBehaviors(reviewIntervals()).paidExport.kwh,null);
});

test('behavior summaries follow changed free windows including midnight and mark estimates', () => {
  const {context:c,run} = dashboard();
  const sample = reviewIntervals(1,1);
  sample[0].importEstimated=true;
  run('freeStartHour=0; freeEndHour=6');
  const result = c.reviewBehaviors(sample);
  assert.equal(result.firstHour.kwh,4);
  assert.equal(result.firstHour.estimated,true);
  assert.equal(result.overnightLoad.kwh,20);
  assert.equal(result.paidImport.kwh,72);
  assert.match(result.lines.join(' '),/includes estimated readings/);
});

test('cached invalid dates, intervals and energy values are discarded while valid directions survive', () => {
  const {context:c} = dashboard();
  const restored = c.deserializeReadingsMap({
    'bad-date': [{time:'12:00',kwh:1}],
    '2026-02-30': [{time:'12:00',kwh:1}],
    '2026-10-19': [null, {}, {time:'25:00',kwh:1}, {time:'12:05',kwh:1},
      {time:'12:00',kwh:'2'}, {time:'12:15',kwh:-1},
      {time:'12:30',kwh:2,importRevision:1}, {time:'12:30',kwh:3,importRevision:2},
      {time:'12:45',kwh:null,exportKwh:1}]
  });
  assert.equal(restored.size,1);
  const rows=restored.get('2026-10-19');
  assert.equal(rows.length,2);
  assert.equal(rows[0].kwh,3);
  assert.equal(rows[1].hasImport,false);
  assert.equal(rows[1].exportKwh,1);
  assert.equal(c.deserializeReadingsMap(null).size,0);
});

test('CSV ignores malformed values, invalid times and dates without inventing today', () => {
  const {context:c} = dashboard();
  const data = 'USAGE_DATE,USAGE_START_TIME,USAGE_KWH\n'+[
    '10/19/2026,09:00,0', '10/19/2026,24:00,1', '10/19/2026,09:05,1',
    '10/19/2026,09:15,bad', '10/19/2026,09:30,', '10/19/2026,09:45,-1',
    '10/19/2026,10:00,1junk', '02/30/2026,10:15,1', ',10:30,1',
    '2026-10-19,10:45,2', '10/19/2026,11:00 trailing,2'
  ].join('\n');
  const parsed = c.parseCSV(data,'usage.csv');
  assert.equal(parsed.size,1);
  assert.equal(parsed.get('2026-10-19').length,2);
  assert.equal(c.gridTotals(parsed.get('2026-10-19')).imported,2);
  assert.equal(c.parseCSV('', 'usage.csv').size,0);
  assert.equal(c.parseCSV('USAGE_START_TIME,USAGE_KWH\n09:00,1','usage.csv').size,0);
});

test('quoted SMT identifier apostrophes and escaped quotes do not shift CSV columns', () => {
  const {context:c} = dashboard();
  const parsed=c.parseCSV('ESIID,USAGE_DATE,USAGE_START_TIME,USAGE_KWH,CONSUMPTION_SURPLUSGENERATION\n"\'123",10/19/2026," 09:00 ",1," Consumption "','usage.csv');
  assert.equal(parsed.get('2026-10-19')[0].kwh,1);
  assert.equal(c.splitCSVLine('"Report, meter ""A""",next')[0],'Report, meter "A"');
});

test('XLSX SMT headers after metadata use the same cleaned bidirectional parser', () => {
  const {context:c} = dashboard();
  const rows=[['Report, meter "A"'],[],['USAGE_DATE','USAGE_START_TIME','USAGE_KWH','CONSUMPTION_SURPLUSGENERATION'],['10/19/2026',' 09:00 ',1,'Consumption'],['10/19/2026',' 09:00 ',2,'Surplus Generation']];
  const result=c.parseXLSXRows(rows,'usage.xlsx');
  assert.equal(c.gridTotals(result.get('2026-10-19')).net,-1);
});

test('blocked or corrupt sync preferences never interrupt refresh logic', () => {
  const {context:c,run} = dashboard();
  c.localStorage={getItem(){throw new Error('blocked')},setItem(){throw new Error('blocked')}};
  assert.equal(c.shouldAutoSync(),true);
  assert.doesNotThrow(()=>c.markSyncedNow());
  assert.doesNotThrow(()=>c.updateLastSyncLabel());
  for(const time of ['bad','',String(Date.now()+86400000)]) {
    c.localStorage={getItem(key){return key==='driveSyncVersion'?'smt-import-export-v2':time}};
    assert.equal(c.shouldAutoSync(),true);
  }
});

test('sustained review requires adjacent measured intervals, not a gap in a partial feed', () => {
  const {context:c,run} = dashboard();
  c.sample=reviewIntervals(0,1);
  c.sample[40].kwh=0.125; c.sample[41].kwh=0.125;
  run("readings.set('2026-10-19',sample)");
  assert.equal(c.daytimeReview(['2026-10-19']).status,'Worth checking');
  assert.match(c.daytimeReview(['2026-10-19']).lines.join(' '),/Sustained grid draw/);
  c.sample[41].kwh=0; c.sample[42].kwh=0.125;
  assert.equal(c.daytimeReview(['2026-10-19']).status,'Looks normal');
});

test('review baseline excludes incomplete and estimated prior paid periods', () => {
  const {context:c,run} = dashboard();
  c.good=reviewIntervals(0.001,1);
  c.estimated=reviewIntervals(0.001,1);c.estimated[40].importEstimated=true;
  c.partial=reviewIntervals(0.001,1);c.partial.splice(40,1);
  run("readings.set('2026-10-17',estimated);readings.set('2026-10-18',partial);readings.set('2026-10-19',good)");
  assert.match(c.daytimeReview(['2026-10-17','2026-10-18','2026-10-19']).lines.join(' '),/Baseline not established/);
});

test('download pool caps concurrency, keeps listing order and isolates failed tasks', async () => {
  const {context:c} = dashboard();
  let active=0, peak=0;
  const results=await c.mapWithConcurrency([0,1,2,3,4,5,6,7],4,async value=>{
    active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,(8-value)*2));
    active--;
    if(value===2)throw new Error('synthetic failure');
    return value;
  });
  assert.equal(peak,4);
  assert.equal(active,0);
  assert.equal(results.length,8);
  assert.equal(results[2].error.message,'synthetic failure');
  for(const i of [0,1,3,4,5,6,7])assert.equal(results[i].value,i);
  assert.equal((await c.mapWithConcurrency([],4,()=>assert.fail())).length,0);
});

test('calendar history includes exactly 30 dates across a month boundary', () => {
  const {context:c} = dashboard();
  assert.equal(c.calendarWindowStart('2026-10-19',30),'2026-09-20');
  assert.equal(c.calendarWindowStart('2026-03-01',30),'2026-01-31');
  assert.equal(c.calendarWindowStart('2024-03-01',30),'2024-02-01');
  const source = new Map(['2026-09-19','2026-09-20','2026-10-19'].map(day=>[day,[{time:'12:00',kwh:1}]]));
  const recent=c.retainRecentReadings(source);
  assert.equal(recent.size,2);
  assert.equal(recent.has('2026-09-19'),false);
  assert.equal(recent.has('2026-09-20'),true);
  assert.equal(source.size,3);
});

test('hourly choices enforce calendar windows, with gaps and invalid old all selection', () => {
  const {context:c} = dashboard();
  const days=['2026-09-19','2026-09-20','2026-10-05','2026-10-06','2026-10-12','2026-10-13','2026-10-19'];
  const select=c.document.getElementById('hourly-range');
  select.value='7';assert.equal(c.getVisibleHourlyDays(days).join(','),'2026-10-13,2026-10-19');
  select.value='14';assert.equal(c.getVisibleHourlyDays(days).join(','),'2026-10-06,2026-10-12,2026-10-13,2026-10-19');
  select.value='30';assert.equal(c.getVisibleHourlyDays(days).length,6);
  select.value='all';assert.equal(c.getVisibleHourlyDays(days).length,4);assert.equal(select.value,'14');
  select.value='invalid';assert.equal(c.getVisibleHourlyDays(days).length,4);
  assert.equal(c.getVisibleHourlyDays([]).length,0);
});

test('Drive scope uses rolling days with next-day buffer and retains undated files', () => {
  const {context:c} = dashboard();
  const files=[{name:'usage-2026-10-20.csv'}, {name:'usage-2026-09-20.csv'}, {name:'usage-2026-09-19.csv'}, {name:'undated.csv'}, {name:'invalid-2026-02-30.csv'}];
  const scoped=c.selectRecentDriveFiles(files);
  assert.equal(scoped.length,4);
  assert.equal(scoped.some(file=>file.name==='usage-2026-09-19.csv'),false);
  assert.equal(scoped.some(file=>file.name==='undated.csv'),true);
  assert.equal(c.selectRecentDriveFiles([]).length,0);
});

test('session cache payload prunes old history without losing latest import/export flags', () => {
  const {context:c,run} = dashboard();
  run("readings=new Map([['2026-09-19',[{time:'12:00',kwh:1}]],['2026-09-20',[{time:'12:00',kwh:2}]],['2026-10-19',[{time:'12:00',kwh:3,exportKwh:4,importEstimated:true}]]])");
  const payload=c.buildDashboardCachePayload();
  assert.equal(Object.keys(payload.readings).length,2);
  assert.equal(payload.readings['2026-10-19'][0].exportKwh,4);
  assert.equal(payload.readings['2026-10-19'][0].importEstimated,true);
});
