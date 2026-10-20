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
      const context = await browser.newContext({ viewport: { width, height: options.height || 1024 }, isMobile: width < 600, hasTouch: true });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        const errors = [];
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
          if (requestUrl.includes('/api/weather')) return route.fulfill({ status: 400, body: 'Unavailable' });
          if (requestUrl.includes('chart.umd')) return options.missingChart ? route.abort() : route.fulfill({ contentType: 'application/javascript', body: chartScript });
          return route.abort();
        });
        await page.addInitScript(({ cache, storageBlocked }) => {
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
      assert.match(await page.locator('#daytime-review-result').textContent(), /Insufficient data/);
    });
    await check('delayed data arrival after first render', { drive: 'success', delay: 200 }, async ({ page }) => {
      assert.equal(await page.locator('#review-daytime-button').isDisabled(), true);
      await page.waitForFunction(() => document.getElementById('latest-day-import').textContent === '0.048 kWh');
      await page.locator('#review-daytime-button').click();
      assert.match(await page.locator('#daytime-review-result').textContent(), /Looks normal/);
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
      assert.match(await page.locator('#daytime-review-result').textContent(), /Looks normal/);
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
    await check('equal start and end hours are rejected safely', {}, async ({ page, load, ready }) => {
      await ready(); await load(); await page.locator('#free-end').selectOption('21');
      assert.equal(await page.locator('#free-end').inputValue(), '9');
      assert.equal(await page.locator('#latest-day-import').textContent(), '0.048 kWh');
      assert.match(await page.locator('#toast').textContent(), /different/);
    });
    await check('latest review remains pinned while historical day changes', {}, async ({ page, load, ready }) => {
      await ready(); await load(); await page.locator('#cost-day').selectOption('2026-10-18');
      await page.locator('#review-daytime-button').click();
      assert.match(await page.locator('#daytime-review-result').textContent(), /Oct 19/);
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
      assert.match(await page.locator('#daytime-review-result').textContent(),/28 previous complete/);
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
        assert.match(await page.locator('#daytime-review-result').textContent(), /Insufficient data/);
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
    for (const [width, height] of [[320, 568], [375, 667], [390, 844], [430, 932], [768, 1024], [820, 1180], [1024, 768], [1180, 820]]) {
      await check('touch layout ' + width + '×' + height, { width, height }, async ({ page, load, ready }) => {
        await ready(); await load(); await page.locator('#review-daytime-button').click();
        const issues = await page.evaluate(() => {
          const issues = [];
          for (const id of ['latest-energy-widget', 'cost-widget', 'daytime-review-widget']) {
            const e = document.getElementById(id);
            if (e.scrollWidth > e.clientWidth + 1) issues.push(id + ' overflows');
          }
          for (const e of document.querySelectorAll('.settings-bar input,.settings-bar select,#review-daytime-button')) {
            const rect = e.getBoundingClientRect();
            if (rect.right > innerWidth + 1 || rect.left < 0) issues.push(e.id + ' offscreen');
            if (rect.height < 44) issues.push(e.id + ' touch target below 44px');
            if (e.matches('input,select') && parseFloat(getComputedStyle(e).fontSize) < 16) issues.push(e.id + ' may trigger iOS focus zoom');
          }
          return issues;
        });
        assert.deepEqual(issues, []);
        if (process.env.BROWSER_QA_OUTPUT && [390, 820].includes(width)) {
          fs.mkdirSync(process.env.BROWSER_QA_OUTPUT, { recursive: true });
          await page.screenshot({ path: path.join(process.env.BROWSER_QA_OUTPUT, 'dashboard-' + width + '.png'), fullPage: true });
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
