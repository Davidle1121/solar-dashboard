const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

// The plan form is the only way a rate or an alert limit reaches the engine, so
// these rules are what stop a negative, a letter or an absurd precision from
// ever being applied. They are asserted directly rather than through the DOM.
function plan() {
  const context = { window: { addEventListener() {} }, console, setTimeout, clearTimeout,
    document: { getElementById: () => ({ style: {}, value: '', setAttribute() {}, getContext() { return {}; } }) } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('index.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return context;
}
const base = { freeNights: true, freeStart: 21, freeEnd: 9, dayRate: '25', nightRate: '0', yellow: '1', red: '5' };
const problems = (context, patch) => context.planProblems({ ...base, ...patch });

test('rates reject signs, letters, exponents, spaces and empty values', () => {
  const c = plan();
  for (const bad of ['-5', '-0.1', '+5', 'abc', '1e3', '2 5', '25px', '', ' ', '.', '--1']) {
    assert.ok(problems(c, { dayRate: bad }).length, `day rate "${bad}" must be rejected`);
    assert.ok(problems(c, { nightRate: bad }).length, `night rate "${bad}" must be rejected`);
  }
});

test('rates reject precision finer than the unit and values past the ceiling', () => {
  const c = plan();
  assert.match(problems(c, { dayRate: '000000.00000001' })[0], /finer than 3 decimal places/);
  assert.match(problems(c, { dayRate: '25.1255' })[0], /finer than 3 decimal places/);
  assert.match(problems(c, { dayRate: '1000.001' })[0], /at most 1,000/);
  assert.match(problems(c, { dayRate: '999999' })[0], /at most 1,000/);
  assert.equal(problems(c, { dayRate: '25.125' }).length, 0);
  assert.equal(problems(c, { dayRate: '000025' }).length, 0, 'leading zeros are harmless');
  assert.equal(problems(c, { dayRate: '0' }).length, 0, 'a zero rate is legitimate');
  assert.equal(problems(c, { dayRate: '1000' }).length, 0);
});

test('alert limits require positive whole cents, with red above yellow', () => {
  const c = plan();
  // Finer than whole cents would save here but be refused by validAlertLimits(),
  // which would silently stop the banner colouring. The two must agree.
  assert.match(problems(c, { yellow: '3.005' })[0], /finer than whole cents/);
  assert.match(problems(c, { yellow: '0' })[0], /at least 0.01/);
  assert.ok(problems(c, { yellow: '-1' }).length);
  assert.match(problems(c, { yellow: '5', red: '2' }).pop(), /higher than the yellow limit/);
  assert.match(problems(c, { yellow: '5', red: '5' }).pop(), /higher than the yellow limit/);
  assert.equal(problems(c, { yellow: '3', red: '10' }).length, 0);
  for (const value of ['3.00', '3.5', '0.01']) assert.equal(problems(c, { yellow: value, red: '99' }).length, 0);
});

test('every accepted alert limit is one validAlertLimits also accepts', () => {
  const c = plan();
  for (const [yellow, red] of [['0.01', '0.02'], ['1', '5'], ['3.5', '10'], ['1000000', '1000000']]) {
    const refused = problems(c, { yellow, red }).length > 0;
    const usable = c.validAlertLimits({ yellow: Number(yellow), red: Number(red) });
    assert.equal(refused, !usable, `yellow ${yellow} / red ${red} must be judged the same by both`);
  }
});

test('free night hours must be distinct whole hours of the day', () => {
  const c = plan();
  assert.match(problems(c, { freeStart: 9, freeEnd: 9 })[0], /different hours/);
  for (const bad of [99, -1, 24, 9.5, NaN, '21']) {
    assert.match(problems(c, { freeStart: bad })[0], /whole hours of the day/, `hour ${bad} must be rejected`);
  }
  assert.equal(problems(c, { freeStart: 0, freeEnd: 23 }).length, 0);
  // With free nights off the window is unused, so it cannot block a save.
  assert.equal(problems(c, { freeNights: false, freeStart: 9, freeEnd: 9, nightRate: 'junk' }).length, 0);
});

test('a draft is accepted while typing but never with a sign, letter or overflow', () => {
  const c = plan();
  const rules = vm.runInContext("PLAN_NUMERIC_FIELDS['day-rate']", c);
  const draft = vm.runInContext('acceptableNumericDraft', c);
  for (const good of ['', '2', '25', '25.', '25.1', '25.125', '0', '1000']) {
    assert.ok(draft(good, rules), `"${good}" should be typable`);
  }
  for (const bad of ['-', '-5', '1e', 'abc', '2 5', '25.1255', '1001', '5000']) {
    assert.ok(!draft(bad, rules), `"${bad}" should be blocked while typing`);
  }
});

test('a rate is spelled back out in dollars per kWh, and only when it is usable', () => {
  const c = plan();
  assert.equal(c.formatRateEquivalent('25'), '25¢/kWh = $0.25 per kWh');
  assert.equal(c.formatRateEquivalent('12.5'), '12.5¢/kWh = $0.125 per kWh');
  assert.equal(c.formatRateEquivalent('9'), '9¢/kWh = $0.09 per kWh');
  assert.equal(c.formatRateEquivalent('0'), '0¢/kWh = $0 per kWh');
  assert.equal(c.formatRateEquivalent('100'), '100¢/kWh = $1 per kWh');
  for (const bad of ['', ' ', '-5', 'abc', '1e3', '.']) {
    assert.equal(c.formatRateEquivalent(bad), '', `"${bad}" must show no equivalent`);
  }
});

test('an unsaved draft never reaches a calculation once the form is live', () => {
  const c = plan();
  const values = { 'day-rate': '25', 'night-rate': '0', 'alert-yellow': '1', 'alert-red': '5' };
  c.document.getElementById = id => ({
    style: {}, setAttribute() {}, getContext() { return {}; },
    get value() { return values[id] === undefined ? '' : values[id]; },
    set value(next) { values[id] = next; },
    get checked() { return true; }
  });
  // Before the boot path runs, the inputs are the source of truth.
  assert.equal(c.readEnergyRate('day-rate'), 25);
  values['day-rate'] = '3';                       // mid-keystroke on the way to 30
  assert.equal(c.readEnergyRate('day-rate'), 3, 'form still authoritative before boot');

  // Once live, a dirty draft is ignored in favour of the applied plan: this is
  // what stops a Drive sync costing the history at a half-typed rate.
  vm.runInContext('planFormReady = true', c);
  vm.runInContext("appliedPlanState = {freeNights:true,freeStart:21,freeEnd:9,dayRate:'25',nightRate:'0',yellow:'1',red:'5'}", c);
  assert.equal(c.readEnergyRate('day-rate'), 25, 'draft rate must not be used');
  const limits = c.readAlertLimits();   // compared field-wise: the VM has its own Object prototype
  assert.equal(limits.yellow, 1);
  assert.equal(limits.red, 5);

  values['day-rate'] = '25';                      // draft matches applied again
  assert.equal(c.readEnergyRate('day-rate'), 25);
  values['day-rate'] = '40';
  vm.runInContext("appliedPlanState.dayRate = '40'", c);
  assert.equal(c.readEnergyRate('day-rate'), 40, 'a saved rate is used immediately');
});

test('period weather is taken from the hourly series, never from the daily range', () => {
  const c = plan();
  const span = { from: 0, to: 8 };
  const cached = { condition: 'Overcast', hours: [
    { hour: 0, tempF: 61.4, condition: 'Clear' },
    { hour: 1, tempF: 60.2, condition: 'Clear' },
    { hour: 7, tempF: 68.9, condition: 'Light rain' },
    { hour: 15, tempF: 84.0, condition: 'Overcast' }   // outside the span
  ] };
  c.readWeatherCache = () => cached;
  assert.equal(c.segmentWeather(['2026-10-27'], span), '60–69°F · Clear');
  // Daytime shares the cache but must describe only its own hours.
  assert.equal(c.segmentWeather(['2026-10-27'], { from: 9, to: 20 }), '84°F · Overcast');
  // A range would have to average conditions, which says very little.
  assert.equal(c.segmentWeather(['2026-10-27', '2026-10-26'], span), '');
  // No hourly series means no claim at all.
  c.readWeatherCache = () => ({ condition: 'Overcast', highF: 84, lowF: 61 });
  assert.equal(c.segmentWeather(['2026-10-27'], span), '');
  c.readWeatherCache = () => { throw new Error('storage blocked'); };
  assert.equal(c.segmentWeather(['2026-10-27'], span), '');
});
