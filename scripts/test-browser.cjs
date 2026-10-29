// Optional browser regression suite. Requires Playwright and a Chromium executable.
// API responses and energy records are synthetic; no connected account is accessed.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const chartScript = process.env.CHART_JS_TEST_PATH
  ? fs.readFileSync(process.env.CHART_JS_TEST_PATH, 'utf8')
  : 'window.Chart=class {constructor(canvas,config){this.config=config} destroy(){}};';
const sample = Array.from({ length: 96 }, (_, i) => ({
  time: String(Math.floor(i / 4)).padStart(2, '0') + ':' + String(i % 4 * 15).padStart(2, '0'),
  kwh: i >= 36 && i < 84 ? 0.001 : 1, hasImport: true, exportKwh: 0.1
}));
const csv = 'Report: SMT\nSynthetic test records\nUSAGE_DATE,USAGE_START_TIME,USAGE_KWH,CONSUMPTION_SURPLUSGENERATION\n' +
  sample.flatMap(r => ['10/19/2026,' + r.time + ',' + r.kwh + ',Consumption', '10/19/2026,' + r.time + ',' + r.exportKwh + ',Surplus Generation']).join('\n');

async function main() {
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let browser;
  let failures = 0, total = 0;
  try {
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
    browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const url = 'http://127.0.0.1:' + server.address().port;
    async function check(name, options, action) {
      total++;
      const width = options.width || 390;
      const context = await browser.newContext({ viewport: { width, height: options.height || 1024 }, isMobile: width < 600, hasTouch: true, timezoneId: options.timezone || 'UTC' });
      let diagnosticPage;
      const errors = [];
      try {
        const page = await context.newPage();
        diagnosticPage = page;
        // CI rendering can be busy; wait for state rather than relying on sleeps.
        page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        let driveMode = options.drive || 'empty';
        let listCalls = 0, activeDownloads = 0, peakDownloads = 0;
        await page.route('**/*', async route => {
          const requestUrl = route.request().url();
          if (requestUrl.startsWith(url) && !requestUrl.includes('/api/')) return route.continue();
          if (requestUrl.includes('/api/drive-list')) {
            listCalls++;
            if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
            if (options.batchFiles) return route.fulfill({ json: { files: options.batchFiles } });
            if (driveMode === 'network') return route.abort();
            if (driveMode === 'failure') return route.fulfill({ status: 400, body: 'offline' });
            if (driveMode === 'invalid-json') return route.fulfill({ contentType: 'application/json', body: 'invalid' });
            return route.fulfill({ json: { files: driveMode === 'success' || driveMode === 'partial' ? [
              { name: 'usage-2026-10-19.csv', token: 'synthetic-ok', mimeType: 'text/csv' },
              ...(driveMode === 'partial' ? [{ name: 'usage-2026-10-18.csv', token: 'synthetic-fail', mimeType: 'text/csv' }] : [])
            ] : [] } });
          }
          if (requestUrl.includes('/api/drive-file') && options.batchFiles) {
            const id = Number(new URL(requestUrl).searchParams.get('id'));
            activeDownloads++; peakDownloads = Math.max(peakDownloads, activeDownloads);
            await new Promise(resolve => setTimeout(resolve, (10 - id) * 20));
            try {
              return await route.fulfill({ contentType: 'text/csv', body: 'USAGE_DATE,USAGE_START_TIME,USAGE_KWH\n10/19/2026,21:00,' + id });
            } finally { activeDownloads--; }
          }
          if (requestUrl.includes('/api/drive-file')) return requestUrl.includes('synthetic-fail')
            ? route.fulfill({ status: 400, json: { error: 'Synthetic download failure' } })
            : route.fulfill({ contentType: 'text/csv', body: csv });
          if (requestUrl.includes('/api/weather')) {
            const date = new URL(requestUrl).searchParams.get('date');
            if (options.weatherDelay && date === '2026-10-19') await new Promise(resolve => setTimeout(resolve,options.weatherDelay));
            if (options.weather) return route.fulfill({json:{condition:options.weather==='html' ? '<img src=x onerror=window.weatherInjected=true>' : options.weather==='unknown' ? 'Unknown' : date==='2026-10-19' ? 'Overcast' : date==='2026-10-20' ? 'Rain' : 'Clear',rainInches:0,postalCode:'77494',...(options.weatherDetails || {highF:81.6,lowF:64.2,sunrise:'07:31',sunset:'18:40'})}});
            return route.fulfill({ status: 400, body: 'Unavailable' });
          }
          if (requestUrl.includes('chart.umd')) return options.missingChart ? route.abort() : route.fulfill({ contentType: 'application/javascript', body: chartScript });
          return route.abort();
        });
        await page.addInitScript(({ cache, storageBlocked, legacyWeather }) => {
          if (legacyWeather) localStorage.setItem('energyWeatherCacheV2',JSON.stringify({'2026-10-19':{cachedAt:Date.now(),data:{condition:'Old weather record'}}}));
          if (cache !== undefined) sessionStorage.setItem('energyDashboardCacheV3', typeof cache === 'string' ? cache : JSON.stringify(cache));
          if (storageBlocked) {
            Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
            Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
          }
        }, options);
        await page.goto(url);
        const load = () => page.evaluate(data => { readings = new Map([['2026-10-18', data], ['2026-10-19', data]]); renderAll(); }, sample);
        const ready = () => page.waitForFunction(() => !document.getElementById('drive-btn').disabled);
        await action({ page, load, ready, setDrive: mode => { driveMode = mode; }, listCalls: () => listCalls, peakDownloads: () => peakDownloads });
        // Allow microtasks, event handlers, and debounced renders to settle.
        await page.waitForTimeout(80);
        assert.deepEqual(errors, [], 'No unhandled browser exceptions');
        console.log('PASS ' + name);
      } catch (error) {
        failures++;
        console.error('FAIL ' + name + '\n' + error.stack);
        if(errors.length) console.error('Browser exceptions:',errors);
        if(diagnosticPage && !diagnosticPage.isClosed()) console.error('Report state:',await diagnosticPage.locator('#daytime-review-result').textContent().catch(()=>''),'Weather:',await diagnosticPage.locator('#insights-weather').textContent().catch(()=>''));
      } finally { await context.close(); }
    }
    const empty = async ({ page, ready }) => {
      await ready();
      assert.equal(await page.locator('#latest-day-import').textContent(), '—');
      assert.equal(await page.locator('#review-daytime-button').isDisabled(), true);
    };
    await check('cold startup without SMT data', {}, empty);
    await check('blocked browser storage', { storageBlocked: true }, empty);
    await check('invalid cached JSON', { cache: '{broken' }, empty);
    await check('malformed cached readings', { cache: { readings: { '2026-10-19': [null, { time: null, kwh: 'bad' }] } } }, async args => {
      await empty(args); await args.page.locator('#day-rate').fill('30');
    });
    await check('empty render, navigation and review calls', {}, async ({ page, ready }) => {
      await ready(); await page.evaluate(() => { renderAll(); selectDay('missing'); shiftDay(1); runDaytimeReview(); });
      assert.match(await page.locator('#daytime-review-result').textContent(), /Meter readings are incomplete/);
    });
    await check('delayed data arrival after first render', { drive: 'success', delay: 200 }, async ({ page }) => {
      assert.equal(await page.locator('#review-daytime-button').isDisabled(), true);
      await page.waitForFunction(() => document.getElementById('latest-day-import').textContent === '0.048 kWh');
      await page.locator('#review-daytime-button').click();
      assert.match(await page.locator('#daytime-review-result').textContent(), /grid electricity during paid hours/);
    });
    await check('cold startup Drive failure', { drive: 'failure' }, async ({ page, ready }) => {
      await ready(); assert.equal(await page.locator('#review-daytime-button').isDisabled(), true);
      assert.match(await page.locator('#drive-status').textContent(), /Error:/);
    });
    await check('network outage retries safely without cached data', { drive: 'network' }, async ({ page, ready, listCalls }) => {
      await ready(); assert.equal(await page.locator('#review-daytime-button').isDisabled(), true);
      assert.equal(listCalls(), 3); assert.match(await page.locator('#drive-status').textContent(), /Error:/);
    });
    await check('invalid Drive response', { drive: 'invalid-json' }, async ({ page, ready }) => {
      await ready(); assert.match(await page.locator('#drive-status').textContent(), /invalid file list/);
    });
    await check('cached data survives a failed refresh', { cache: { readings: { '2026-10-19': sample } }, drive: 'failure' }, async ({ page, ready }) => {
      await ready(); assert.equal(await page.locator('#latest-day-import').textContent(), '0.048 kWh');
      assert.match(await page.locator('#drive-status').textContent(), /previously loaded/);
    });
    await check('successful sync works when storage is blocked', { drive: 'success', storageBlocked: true }, async ({ page }) => {
      await page.waitForFunction(() => document.getElementById('latest-day-import').textContent === '0.048 kWh');
      assert.match(await page.locator('#drive-status').textContent(), /Refresh complete/);
    });
    await check('partial download failure remains visible and is not marked fully synced', { drive: 'partial' }, async ({ page, ready }) => {
      await ready(); assert.match(await page.locator('#drive-status').textContent(), /totals may be incomplete/);
      assert.equal(await page.evaluate(() => localStorage.getItem('lastSyncTime')), null);
    });
    await check('four parallel downloads preserve deterministic overlap merging', { batchFiles: Array.from({length:8}, (_,i) => ({id:String(i+1), name:'usage-2026-10-19-' + (i+1) + '.csv', mimeType:'text/csv'})) }, async ({page,ready,peakDownloads}) => {
      await ready();
      assert.equal(peakDownloads(), 4);
      assert.equal(await page.locator('#latest-night-import').textContent(), '8.000 kWh');
      assert.match(await page.locator('#drive-status').textContent(), /8 file/);
    });
    await check('manual retry after failed startup', { drive: 'failure' }, async ({ page, ready, setDrive }) => {
      await ready(); setDrive('success'); await page.locator('#drive-btn').click();
      await page.waitForFunction(() => document.getElementById('latest-day-import').textContent === '0.048 kWh');
    });
    await check('overlapping refresh calls are ignored', { delay: 150 }, async ({ page, listCalls }) => {
      await page.evaluate(() => syncFromDrive(true, 'manual'));
      assert.equal(listCalls(), 1);
    });
    await check('loading then clearing data resets all reports', {}, async ({ page, load, ready }) => {
      await ready(); await load(); await page.locator('#review-daytime-button').click();
      await page.evaluate(() => { readings.clear(); clearDashboard(); });
      assert.equal(await page.locator('#latest-day-import').textContent(), '—');
      assert.equal(await page.locator('#cost-daily').textContent(), '—');
      assert.equal(await page.locator('#review-daytime-button').isDisabled(), true);
      assert.equal(await page.locator('#hourly-table-body').textContent(), '');
    });
    await check('missing chart library leaves reports and table usable', { missingChart: true }, async ({ page, load, ready }) => {
      await ready(); await load(); await page.locator('#review-daytime-button').click();
      assert.match(await page.locator('#daytime-review-result').textContent(), /grid electricity during paid hours/);
      assert.match(await page.locator('#hourly-table-body').textContent(), /Oct/);
      assert.equal(await page.locator('.chart-unavailable').count(), 2);
    });
    await check('changing rates preserves usage, validates inputs, invalidates old review', {}, async ({ page, load, ready }) => {
      await ready(); await load(); await page.locator('#review-daytime-button').click();
      await page.locator('#day-rate').fill('');
      assert.equal(await page.locator('#cost-daily').textContent(), '—');
      assert.equal(await page.locator('#latest-day-import').textContent(), '0.048 kWh');
      assert.match(await page.locator('#daytime-review-result').textContent(), /Ready to review/);
      await page.locator('#day-rate').fill('50'); assert.equal(await page.locator('#cost-daily').textContent(), '$0.02');
    });
    await check('free hours update reports while preserving hourly tab', {}, async ({ page, load, ready }) => {
      await ready(); await load(); await page.getByRole('button', { name: 'Hourly Profile Table', exact: true }).click();
      await page.locator('#free-end').selectOption('8');
      assert.equal(await page.locator('#latest-day-import').textContent(), '4.048 kWh');
      assert.equal(await page.locator('#tab-hourly').isVisible(), true);
      await page.locator('#review-daytime-button').click(); assert.match(await page.locator('#daytime-review-result').textContent(), /8am–9pm/);
    });
    await check('free-night toggle before data arrival preserves one required all-day rate', {}, async ({page,ready,load})=>{
      await ready();
      assert.equal(await page.locator('#free-nights-enabled').isChecked(),true);
      await page.locator('#free-nights-enabled').uncheck();
      for(const id of ['free-start','free-end','night-rate'])assert.equal(await page.locator('#'+id).isDisabled(),true);
      assert.equal(await page.locator('#day-rate').isEnabled(),true);
      assert.equal(await page.locator('#day-rate-label').textContent(),'Electricity rate (¢/kWh)');
      await load();
      assert.equal(await page.locator('#latest-day-import').textContent(),'48.048 kWh');
      assert.equal(await page.locator('#latest-night-import').textContent(),'Not used');
      assert.equal(await page.locator('#cost-daily').textContent(),'$12.01');
      await page.locator('#day-rate').fill('');
      assert.equal(await page.locator('#cost-daily').textContent(),'—');
      assert.match(await page.locator('#rate-validation').textContent(),/electricity rate/);
      await page.locator('#day-rate').fill('30');
      assert.equal(await page.locator('#cost-daily').textContent(),'$14.41');
      await page.locator('#review-daytime-button').click();
      assert.match(await page.locator('.insight-takeaway-label').textContent(),/all 24 hours/);
      assert.ok((await page.locator('.insight-explanation').allTextContents()).every(text=>text.includes('paid electricity hours')));
    });
    await check('schedule toggle reclassifies every view and restores custom times and rates', {}, async ({page,ready,load})=>{
      await ready();await load();
      await page.locator('#free-start').selectOption('20');
      await page.locator('#free-end').selectOption('8');
      await page.locator('#night-rate').fill('2');
      await page.getByRole('button',{name:'Hourly Profile Table',exact:true}).click();
      await page.locator('#free-nights-enabled').uncheck();
      const split=await page.evaluate(()=>({
        free:charts['chart-daily'].data.datasets.filter(d=>d.label.includes('Free kWh')).flatMap(d=>d.data),
        boundaryLabels:charts['chart-detail'].data.labels.filter(x=>/🟢|🔴/.test(x)),
        cost: gridEnergyCost(readings.get('2026-10-19'),25,0).cost
      }));
      assert.ok(split.free.every(x=>x===0));assert.deepEqual(split.boundaryLabels,[]);
      assert.ok(Math.abs(split.cost-12.012)<1e-9);
      assert.equal(await page.locator('#tab-hourly').isVisible(),true);
      // A stale invalid night rate is irrelevant in all-day mode.
      await page.evaluate(()=>{document.getElementById('night-rate').value='';renderCostEstimates()});
      assert.equal(await page.locator('#cost-daily').textContent(),'$12.01');
      await page.locator('#free-nights-enabled').check();
      assert.equal(await page.locator('#cost-daily').textContent(),'—');
      await page.locator('#night-rate').fill('2');
      assert.equal(await page.locator('#free-start').inputValue(),'20');assert.equal(await page.locator('#free-end').inputValue(),'8');
      assert.equal(await page.locator('#latest-day-import').textContent(),'4.044 kWh');
      await page.locator('#review-daytime-button').click();
      assert.match(await page.locator('.insight-takeaway-label').textContent(),/8am–8pm/);
      assert.match(await page.locator('.insight-row').nth(1).getAttribute('class'),/level-review/);
      assert.equal(await page.locator('#tab-hourly').isVisible(),true);
    });
    await check('equal start and end hours are rejected safely', {}, async ({ page, load, ready }) => {
      await ready(); await load(); await page.locator('#free-end').selectOption('21');
      assert.equal(await page.locator('#free-end').inputValue(), '9');
      assert.equal(await page.locator('#latest-day-import').textContent(), '0.048 kWh');
      assert.match(await page.locator('#toast').textContent(), /different/);
    });
    await check('latest review remains pinned while historical day changes', {}, async ({ page, load, ready }) => {
      await ready(); await load(); await page.locator('#cost-day').selectOption('2026-10-18');
      await page.locator('#review-daytime-button').click();
      assert.match(await page.locator('#insights-date').textContent(), /Oct 19/);
      assert.equal(await page.locator('#day-select').inputValue(), '2026-10-18');
    });
    await check('rolling 30-day retention and 7/14/30 table choices cover all current reports', {}, async ({page,ready}) => {
      await ready();
      await page.evaluate(data => {
        readings = new Map(Array.from({length:60}, (_,i) => {
          const date = new Date('2026-10-19T12:00:00Z'); date.setUTCDate(date.getUTCDate()-i);
          return [date.toISOString().slice(0,10),data];
        }));
        renderAll();
      }, sample);
      assert.equal(await page.evaluate(()=>readings.size),30);
      assert.equal(await page.evaluate(()=>[...readings.keys()].sort()[0]),'2026-09-20');
      await page.getByRole('button',{name:'Hourly Profile Table',exact:true}).click();
      assert.deepEqual(await page.locator('#hourly-range option').evaluateAll(options=>options.map(option=>option.value)),['7','14','30']);
      for(const count of [7,14,30]) {
        await page.locator('#hourly-range').selectOption(String(count));
        assert.equal(await page.locator('#hourly-table-body tr').count(),count);
      }
      assert.match(await page.locator('#cost-weekly-note').textContent(),/7\/7 complete days/);
      await page.locator('#review-daytime-button').click();
      assert.equal(await page.evaluate(() => analyzeEnergyInsights(readings.get('2026-10-19'), {day:'2026-10-19',freeStart:21,freeEnd:9,history:[...readings.entries()].filter(([day])=>day<'2026-10-19').map(([day,intervals])=>({day,intervals}))}).measurements.baselineDays),28);
    });
    await check('partial, estimated and export-only data never get false reassurance', {}, async ({ page, ready }) => {
      await ready();
      for (const mode of ['partial', 'estimated', 'export-only']) {
        await page.evaluate(({ data, mode }) => {
          if (mode === 'partial') data.splice(40, 1);
          if (mode === 'estimated') data[40].importEstimated = true;
          if (mode === 'export-only') data.forEach(r => { r.hasImport = false; r.kwh = 0; });
          readings = new Map([['2026-10-19', data]]); renderAll(); runDaytimeReview();
        }, { data: sample, mode });
        assert.match(await page.locator('#daytime-review-result').textContent(), /Meter readings are incomplete/);
      }
    });
    for (const width of [390, 820]) {
      await check('hourly table interaction and horizontal scrolling at ' + width + 'px', { width }, async ({ page, ready, load }) => {
        await ready(); await load();
        await page.getByRole('button', { name: 'Hourly Profile Table', exact: true }).click();
        for (const metric of ['export', 'net', 'import']) {
          await page.locator('#hourly-metric').selectOption(metric);
          assert.equal(await page.locator('#hourly-table-body tr').count(), 2);
        }
        assert.deepEqual(await page.locator('#hourly-range option').evaluateAll(options => options.map(option => option.value)), ['7', '14', '30']);
        await page.locator('#hourly-range').selectOption('30');
        const fits = await page.evaluate(() => {
          const wrap = document.querySelector('#tab-hourly .data-table-wrap');
          wrap.scrollLeft = 200;
          return wrap.scrollLeft > 0 && wrap.getBoundingClientRect().right <= innerWidth + 1;
        });
        assert.equal(fits, true);
        await page.locator('#free-start').selectOption('20');
        assert.equal(await page.locator('#tab-hourly').isVisible(), true);
        assert.equal(await page.locator('#hourly-metric').inputValue(), 'import');
      });
    }
    await check('insights reuse weather for the SMT date instead of today', {weather:'known'}, async ({page,load,ready}) => {
      await ready(); await load(); await page.locator('#review-daytime-button').click();
      await page.waitForFunction(()=>!document.getElementById('insights-weather').hidden);
      assert.match(await page.locator('#insights-weather').textContent(),/77494 · Overcast/);
      assert.match(await page.locator('#insights-weather').textContent(),/High 82°F \/ Low 64°F/);
      assert.match(await page.locator('#insights-weather').textContent(),/Sunrise 7:31am · Sunset 6:40pm/);
      assert.match(await page.locator('#insights-date').textContent(),/Oct 19, 2026/);
      assert.equal(await page.locator('.insight-row').count(),3);
    });
    for (const weather of [undefined,'unknown']) await check('weather unavailable/unknown is omitted: '+weather,{weather},async ({page,load,ready})=>{
      await ready();await load();await page.locator('#review-daytime-button').click();await page.waitForTimeout(100);
      assert.equal(await page.locator('#insights-weather').isVisible(),false);
      assert.match(await page.locator('#daytime-review-result').textContent(),/grid electricity during paid hours/);
    });
    await check('late weather response cannot overwrite a newer report',{weather:'known',weatherDelay:500},async ({page,load,ready})=>{
      await ready();await load();await page.locator('#review-daytime-button').click();
      await page.evaluate(data=>{readings=new Map([['2026-10-20',data]]);renderAll();runDaytimeReview()},sample);
      await page.waitForFunction(()=>document.getElementById('insights-weather').textContent.includes('Rain'));
      await page.waitForTimeout(650);
      assert.match(await page.locator('#insights-weather').textContent(),/Rain/);
      assert.match(await page.locator('#insights-date').textContent(),/Oct 20/);
    });
    await check('late weather response stays hidden after clearing data',{weather:'known',weatherDelay:500},async ({page,load,ready})=>{
      await ready();await load();await page.locator('#review-daytime-button').click();
      await page.evaluate(()=>{readings.clear();clearDashboard()});await page.waitForTimeout(650);
      assert.equal(await page.locator('#insights-weather').isVisible(),false);
      assert.equal(await page.locator('#review-daytime-button').isDisabled(),true);
    });
    await check('late weather response stays hidden after a rate edit',{weather:'known',weatherDelay:500},async ({page,load,ready})=>{
      await ready();await load();await page.locator('#review-daytime-button').click();await page.locator('#day-rate').fill('50');
      await page.waitForTimeout(650);assert.equal(await page.locator('#insights-weather').isVisible(),false);
      assert.match(await page.locator('#daytime-review-result').textContent(),/Ready to review/);
      await page.locator('#review-daytime-button').click();assert.match(await page.locator('#daytime-review-result').textContent(),/2.4¢ at 50¢/);
    });
    await check('weather content is text, never injected HTML',{weather:'html'},async ({page,load,ready})=>{
      await ready();await load();await page.locator('#review-daytime-button').click();
      await page.waitForFunction(()=>!document.getElementById('insights-weather').hidden);
      assert.equal(await page.locator('#insights-weather img').count(),0);
      assert.equal(await page.evaluate(()=>window.weatherInjected),undefined);
    });
    await check('repeated reviews do not duplicate sections or modify charts, costs, or data',{},async ({page,load,ready})=>{
      await ready();await load();
      const before=await page.evaluate(()=>JSON.stringify({readings:[...readings],daily:document.getElementById('cost-daily').textContent,weekly:document.getElementById('cost-weekly').textContent,chart:charts['chart-daily'].config.data}));
      for(let i=0;i<5;i++)await page.locator('#review-daytime-button').click();
      assert.equal(await page.locator('.insight-row').count(),3);
      const after=await page.evaluate(()=>JSON.stringify({readings:[...readings],daily:document.getElementById('cost-daily').textContent,weekly:document.getElementById('cost-weekly').textContent,chart:charts['chart-daily'].config.data}));
      assert.equal(after,before);
    });
    await check('an analysis failure stays within its panel and preserves dashboard controls',{},async ({page,load,ready})=>{
      await ready();await load();await page.evaluate(()=>{analyzeEnergyInsights=()=>{throw new Error('synthetic analysis failure')}});
      await page.locator('#review-daytime-button').click();
      assert.match(await page.locator('#daytime-review-result').textContent(),/temporarily unavailable/);
      await page.locator('#day-rate').fill('50');assert.equal(await page.locator('#cost-daily').textContent(),'$0.02');
      await page.getByRole('button',{name:'Hourly Profile Table',exact:true}).click();assert.equal(await page.locator('#hourly-table-body tr').count(),2);
    });
    for (const weatherDetails of [{},{highF:null,lowF:'0',sunrise:'25:00',sunset:'bad'}]) {
      await check('optional weather omissions preserve condition and energy report '+JSON.stringify(weatherDetails),{weather:'known',weatherDetails},async ({page,load,ready})=>{
        await ready();await load();await page.locator('#review-daytime-button').click();
        await page.waitForFunction(()=>!document.getElementById('insights-weather').hidden);
        const text=await page.locator('#insights-weather').textContent();
        assert.match(text,/Overcast/);assert.doesNotMatch(text,/High|Low|Sunrise|Sunset/);
        assert.match(await page.locator('#daytime-review-result').textContent(),/grid electricity during paid hours/);
      });
    }
    await check('old condition-only weather cache does not hide new daily details',{weather:'known',legacyWeather:true},async ({page,load,ready})=>{
      await ready();await load();await page.locator('#review-daytime-button').click();
      await page.waitForFunction(()=>document.getElementById('insights-weather').textContent.includes('Sunrise'));
      assert.doesNotMatch(await page.locator('#insights-weather').textContent(),/Old weather record/);
    });
    await check('Tokyo browser displays the same America/Chicago sun times',{weather:'known',timezone:'Asia/Tokyo'},async ({page,load,ready})=>{
      await ready();await load();await page.locator('#review-daytime-button').click();
      await page.waitForFunction(()=>document.getElementById('insights-weather').textContent.includes('Sunrise'));
      assert.match(await page.locator('#insights-weather').textContent(),/Sunrise 7:31am · Sunset 6:40pm/);
    });
    await check('paid-hours takeaway and visibly separate sections replace ambiguous overall badges', {width:1100}, async ({page,load,ready})=>{
      await ready();await load();await page.locator('#review-daytime-button').click();
      assert.equal(await page.locator('.insight-status').count(),0);
      assert.equal(await page.locator('.insight-takeaway-label').textContent(),'Paid-hours grid use · 9am–9pm');
      assert.match(await page.locator('.insight-summary').textContent(),/only 0.048 kWh of grid electricity during paid hours/);
      assert.doesNotMatch(await page.locator('#daytime-review-result').textContent(),/Looks normal|Imports dropped/);
      assert.deepEqual(await page.locator('.insight-heading').allTextContents(),['Morning','Daytime','Night']);
      const sections=await page.locator('.insight-row').evaluateAll(rows=>rows.map(row=>({
        border:parseFloat(getComputedStyle(row).borderTopWidth),radius:parseFloat(getComputedStyle(row).borderRadius),
        background:getComputedStyle(row).backgroundColor,parentBackground:getComputedStyle(row.parentElement.parentElement).backgroundColor,
        headingColor:getComputedStyle(row.querySelector('h3')).color,headingId:row.querySelector('h3').id,label:row.getAttribute('aria-labelledby'),
        top:row.getBoundingClientRect().top,bottom:row.getBoundingClientRect().bottom
      })));
      assert.equal(new Set(sections.map(row=>row.headingColor)).size,1);
      sections.forEach((row,index)=>{assert.ok(row.border>=1&&row.radius>=8);assert.notEqual(row.background,row.parentBackground);assert.equal(row.headingId,row.label);if(index)assert.ok(row.top>sections[index-1].bottom)});
      assert.doesNotMatch(await page.locator('.insight-row').nth(0).textContent(),/paid hours began/);
      assert.match(await page.locator('.insight-row').nth(1).textContent(),/Grid use dropped when paid hours began/);
      await page.evaluate(data=>{data[40].kwh=0.6;readings=new Map([['2026-10-19',data]]);renderAll();runDaytimeReview()},sample);
      assert.deepEqual(await page.locator('.insight-heading').allTextContents(),['Morning','Daytime','Night']);
      assert.equal(await page.locator('.insight-row .insight-level').textContent(),'Below your spending limit');
      assert.equal(await page.locator('.insight-row .insight-level').evaluate(node=>node.closest('section').querySelector('h3').textContent),'Daytime');
      const colors=[];
      for(const [kwh,level,label] of [[0.5,'good','Below your spending limit'],[4,'review','Worth reviewing'],[8,'review','Worth reviewing'],[20,'high','High spending']]) {
        await page.evaluate(({data,kwh})=>{data.forEach((r,i)=>{if(i>=36&&i<84)r.kwh=0});data[40].kwh=kwh;readings=new Map([['2026-10-19',data]]);renderAll();runDaytimeReview()},{data:sample,kwh});
        const row=page.locator('.insight-row').nth(1);
        assert.match(await row.getAttribute('class'),new RegExp('level-'+level));
        assert.ok((await row.locator('.insight-level').textContent()).includes(label));
        colors.push(await row.evaluate(node=>getComputedStyle(node).borderTopColor));
      }
      assert.equal(new Set(colors).size,3);

    });
    await check('cost alert limits validate, persist and follow edited rates', {}, async ({page,ready,load})=>{
      await ready();await load();
      await page.evaluate(data=>{data.forEach((r,i)=>{if(i>=36&&i<84)r.kwh=0});data[40].kwh=8;readings=new Map([['2026-10-19',data]]);renderAll()},sample);
      await page.locator('#review-daytime-button').click();
      assert.match(await page.locator('.insight-takeaway .insight-level').textContent(),/Worth reviewing.*2.00/);
      await page.locator('.alert-settings summary').click();
      await page.locator('#alert-yellow').fill('3');
      assert.match(await page.locator('#daytime-review-result').textContent(),/Ready to review/);
      await page.locator('#review-daytime-button').click();
      assert.match(await page.locator('.insight-takeaway .insight-level').textContent(),/Below your spending limit/);
      await page.locator('#alert-red').fill('2');
      await page.locator('#review-daytime-button').click();
      assert.equal(await page.locator('.insight-row.level-good').count(),0);
      assert.match(await page.locator('#alert-validation').textContent(),/red higher than yellow/);
      await page.locator('#alert-red').fill('10');
      await page.reload();await ready();
      assert.equal(await page.locator('#alert-yellow').inputValue(),'3');assert.equal(await page.locator('#alert-red').inputValue(),'10');
      await load();await page.locator('#day-rate').fill('');await page.locator('#review-daytime-button').click();
      assert.match(await page.locator('.insight-takeaway .insight-level').textContent(),/valid electricity rate/);
      assert.equal(await page.locator('.insight-row.level-good').count(),0);
    });
    await check('half-cent cost display agrees with color and partial-data explanations', {}, async ({page,ready})=>{
      await ready();
      await page.evaluate(data=>{data.forEach(r=>r.kwh=0);data[40].kwh=3.98;readings=new Map([['2026-10-19',data]]);renderAll();runDaytimeReview()},sample);
      assert.equal(await page.locator('#latest-day-cost').textContent(),'$1.00');
      assert.equal(await page.locator('#cost-daily').textContent(),'$1.00');
      assert.equal(await page.locator('.insight-takeaway .insight-level').textContent(),'Worth reviewing · $1.00');
      await page.evaluate(()=>{readings.get('2026-10-19')[40].importEstimated=true;renderAll();runDaytimeReview()});
      assert.equal(await page.locator('.insight-row.level-good,.insight-row.level-review,.insight-row.level-high').count(),0);
      assert.match(await page.locator('.insight-row').nth(1).textContent(),/Cost based on available readings/);
    });
    await check('corrupt alert preferences fall back safely', {}, async ({page,ready})=>{
      await ready();await page.evaluate(()=>localStorage.setItem('energyAlertLimitsV1','{"yellow":5,"red":1}'));await page.reload();await ready();
      assert.equal(await page.locator('#alert-yellow').inputValue(),'1');assert.equal(await page.locator('#alert-red').inputValue(),'5');
    });
    await check('all-day paid assessment catches expensive overnight imports', {}, async ({page,ready,load})=>{
      await ready();await load();await page.locator('#free-nights-enabled').uncheck();
      await page.locator('#review-daytime-button').click();
      assert.match(await page.locator('.insight-takeaway .insight-level').textContent(),/High spending.*12.01/);
      assert.match(await page.locator('.insight-takeaway-label').textContent(),/all 24 hours/);
      assert.match(await page.locator('.insight-row').nth(1).textContent(),/Below your spending limit/);
    });
    for(const timezone of ['America/Chicago','Asia/Tokyo']) await check('DST cost and table agreement in '+timezone,{timezone},async ({page,ready})=>{
      await ready();
      for(const [day,spring] of [['2026-03-08',true],['2026-11-01',false]]) {
        await page.evaluate(day=>{readings=new Map([[day,[...new Set(insightExpectedTimes(day))].map(time=>({time,kwh:0.1,hasImport:true,exportKwh:0}))]]);renderAll();runDaytimeReview()},day);
        assert.match(await page.locator('#latest-day-import-note').textContent(),/Complete period/);
        assert.match(await page.locator('#latest-night-import-note').textContent(),spring?/Complete period/:/Partial period/);
        assert.match(await page.locator('.insight-summary').textContent(),spring?/23-hour/:/25-hour/);
        await page.getByRole('button',{name:'Hourly Profile Table',exact:true}).click();
        if(spring)assert.equal(await page.locator('#hourly-table-body tr').first().locator('td').nth(3).textContent(),'N/A');
        else assert.match(await page.locator('#hourly-table-body').textContent(),/repeated hour unverified/);
        await page.locator('#free-nights-enabled').uncheck();await page.locator('#review-daytime-button').click();
        assert.match(await page.locator('#latest-day-import-note').textContent(),spring?/Complete period/:/Partial period/);
        assert.match(await page.locator('.insight-takeaway .insight-level').textContent(),spring?/Worth reviewing/:/Incomplete/);
        await page.locator('#free-nights-enabled').check();
      }
    });
    for (const [width, height] of [[320, 568], [375, 667], [390, 844], [430, 932], [768, 1024], [820, 1180], [1024, 768], [1180, 820]]) {
      await check('touch layout ' + width + '×' + height, { width, height, weather:'known' }, async ({ page, load, ready }) => {
        await ready(); await load(); await page.locator('#review-daytime-button').click();
        await page.locator('.insight-takeaway').waitFor({state:'visible'});
        await page.waitForFunction(()=>document.getElementById('insights-weather').textContent.includes('Sunrise'));
        await page.locator('.alert-settings summary').click();
        const issues = await page.evaluate(() => {
          const issues = [];
          for (const id of ['latest-energy-widget', 'cost-widget', 'daytime-review-widget']) {
            const e = document.getElementById(id);
            if (e.scrollWidth > e.clientWidth + 1) issues.push(id + ' overflows');
          }
          for (const e of document.querySelectorAll('.settings-bar input:not([type=checkbox]),.settings-bar select,.free-night-toggle,#review-daytime-button')) {
            if (!e.getClientRects().length) continue;
            const rect = e.getBoundingClientRect();
            if (rect.right > innerWidth + 1 || rect.left < 0) issues.push(e.id + ' offscreen');
            if (rect.height < 44) issues.push(e.id + ' touch target below 44px');
            if (e.matches('input,select') && parseFloat(getComputedStyle(e).fontSize) < 16) issues.push(e.id + ' may trigger iOS focus zoom');
          }
          return issues;
        });
        assert.deepEqual(issues, []);
        if (process.env.BROWSER_QA_OUTPUT && [390, 820, 1024].includes(width)) {
          fs.mkdirSync(process.env.BROWSER_QA_OUTPUT, { recursive: true });
          await page.locator('#daytime-review-widget').screenshot({ path: path.join(process.env.BROWSER_QA_OUTPUT, 'dashboard-' + width + '.png') });
        }
      });
    }
    console.log(`${total - failures}/${total} browser scenarios passed (${process.env.CHART_JS_TEST_PATH ? 'actual Chart.js' : 'Chart.js stub; provide CHART_JS_TEST_PATH for chart integration'}).`);
    if (failures) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
