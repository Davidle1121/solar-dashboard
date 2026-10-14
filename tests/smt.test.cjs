const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function dashboard() {
  const elements = new Map();
  const context = {
    window: { addEventListener() {} },
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { style: {}, setAttribute(name, value) { this[name] = value; }, value: id === 'hourly-range' ? '14' : 'import', getContext() { return {}; } });
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

test('chart and hourly table highlight net export green, import red, and balance gray', () => {
  const { context: c, elements, run } = dashboard();
  run(`readings = new Map([
    ['2026-10-11', [{time:'00:00',kwh:2,exportKwh:4}]],
    ['2026-10-12', [{time:'00:00',kwh:4,exportKwh:2}]],
    ['2026-10-13', [{time:'00:00',kwh:2,exportKwh:2}]]
  ]); renderBalanceChart([...readings.keys()]);`);
  const chart = run("charts['chart-balance'].config");
  assert.deepEqual(Array.from(chart.data.datasets[2].data), [-2, 2, 0]);
  assert.deepEqual(Array.from(chart.data.datasets[2].backgroundColor), ['#3fb950','#f85149','#7d8590']);
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
  assert.equal(c.paidEnergyCost(intervals, 25).kwh, 2);
  assert.equal(c.paidEnergyCost(intervals, 25).cost, 0.5);
  assert.equal(c.paidEnergyCost(intervals, 0).cost, 0);
});

test('costs flag partial data, exclude export-only readings, and accept complete zero imports', () => {
  const { context: c } = dashboard();
  assert.equal(c.paidEnergyCost([{time:'12:00',kwh:0,hasImport:false,exportKwh:8}],25).cost, null);
  assert.equal(c.paidEnergyCost([],25).cost, null);
  assert.equal(c.paidEnergyCost([{time:'12:00',kwh:1,importEstimated:true}],25).estimated, true);
  assert.equal(c.paidEnergyCost([{time:'12:00',kwh:1}],25).complete, false);
  const intervals = Array.from({length:48}, (_, i) => ({time: String(9 + Math.floor(i / 4)).padStart(2, '0') + ':' + String(i % 4 * 15).padStart(2,'0'),kwh:0}));
  assert.equal(c.paidEnergyCost(intervals,25).complete, true);
  assert.equal(c.paidEnergyCost(intervals,25).cost, 0);
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
  assert.equal(c.document.getElementById('cost-daily').textContent, '—');
  assert.equal(c.document.getElementById('cost-weekly').textContent, '$2.00');
  c.document.getElementById('day-rate').value = '-1';
  c.renderCostEstimates();
  assert.equal(c.document.getElementById('cost-daily').textContent, '—');
  assert.match(c.document.getElementById('rate-validation').textContent, /non-negative/);
  c.document.getElementById('day-rate').value = '';
  c.renderCostEstimates();
  assert.equal(c.document.getElementById('cost-weekly').textContent, '—');
});
