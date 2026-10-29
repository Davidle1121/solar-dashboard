# Home Energy Dashboard

Personal dashboard for reviewing Smart Meter Texas electricity usage.

## Vercel configuration

Configure these values as Vercel environment variables; never commit their values:

- `DRIVE_API_KEY`
- `DRIVE_FOLDER_ID`
- `WEATHER_LAT`
- `WEATHER_LON`
- `WEATHER_TIMEZONE` (optional; defaults to `America/Chicago`)

Use a dedicated Google Drive folder containing only dashboard usage exports. The dashboard API
will reject download requests for files that are not direct children of that folder.

## SMT-only deployment

The dashboard reads SMT exports from the configured Google Drive folder. It has no
Sigenergy login, history requests, scheduled collection, Blob dependency, solar sync
button, or solar/battery table. Builds only validate code and publish static assets;
they do not contact an inverter provider. The daily import chart, Import/Export/Net table, daytime review, and costs use SMT.

After upgrading from the retired integration, remove all SIGEN_* variables from every
Vercel environment. CRON_SECRET and BLOB_READ_WRITE_TOKEN can also be removed if no
other feature uses them (this dashboard no longer does). Deploy this cleanup before
resuming a paused project. Retire previous Production and Preview deployments that
still contain the integration, because deleting variables does not change secrets
already captured by those deployments. The new configuration defines no cron jobs.

Old private Blob objects are no longer read or maintained. In Vercel Storage, delete
only the retired sigenergy/ and sigenergy-meta/ objects, or delete/disconnect the
store if it was dedicated to this integration. Do not delete an entire shared store.
No changes to the SMT/Drive variables or files are required.

## Design decisions and future reference

### Navigation and the 2026-10 redesign

- The page is split into three views behind a left rail: **Dashboard**, **Hourly
  Profile Table** and **Plan & Rates**. This replaced the two-tab strip. The old
  `tab-daily` / `tab-hourly` containers survive inside their views, and
  `applyViewVisibility()` is the single place that decides what is on screen, so
  `renderAll()`, the rail and the range toggle cannot disagree.
- The seven Electricity plan inputs moved off the Dashboard onto Plan & Rates.
  They used to sit above every figure on the page while being touched perhaps
  once a month.
- The Dashboard opens with a **verdict banner**: one sentence naming what the
  grid cost, coloured green/amber/red against the saved daily alert limits, with
  the largest single paid interval called out beneath it when it crosses
  `ENERGY_INSIGHT_RULES.peakInterval`. Partial or estimated readings render as
  "Not rated" rather than a reassuring green.
- A **Today / 7 Days / 30 Days** toggle re-scopes every card. `Today` is the
  default because the daily answer is why the site exists. There is no Year view:
  only the latest 30 days are retained.
- Five cards follow: Morning/Daytime/Night, Free Power vs Paid Power, Compared to
  Before, Cost Day by Day, and Sent to the Grid. The existing Daily Grid Import
  and 15-Minute Detail charts remain below them, unchanged.
- Morning/Daytime/Night is one **full-width row per period**, not three columns:
  three columns gave each period a third of the card and every label was cramped.
  Each row carries the period name, its exact hours, kWh, cost, a status chip, an
  hour-by-hour bar strip with every hour labelled, and one line of assessment.
  The rows render automatically; the Review latest day button still produces the
  detailed text report below them.
- Period boundaries come from `redesignSegments()`, which mirrors the
  `daytimePaid` rule in `analyzeEnergyInsights`: only a free window that wraps
  midnight (end < start) can define the spans. An inverted window would otherwise
  produce overlapping, double-counted periods, so it falls back to a plain
  12am / 9am / 9pm split and each row labels itself as mixed.
- Hourly averages keep a missing hour as `null` rather than zero, so a partial
  day cannot flatter a period total; the row says how many hours are missing.
- The Drive refresh button and the freshness chip live in the rail and are shown
  on the Dashboard only. An SMT export is uploaded by hand each day, so refresh
  is a daily action rather than a global header control.
- `renderRedesign()` is wrapped in try/catch deliberately. These cards are an
  overview; if one fails, the charts, hourly table and cost widget that the rest
  of the dashboard depends on must still render.
- No card names an appliance. The meter reports one whole-house figure per
  interval, so a large overnight draw is described by its shape ("a large
  sustained draw, the kind an EV or home energy storage makes while charging")
  rather than attributed to a device. `tests/smt-only.test.cjs` forbids the word
  that previously named the retired integration, which is why that wording avoids
  it.

### Saved plan settings

- Rates, free-night hours and alert limits are saved under `energyPlanV1` in
  `localStorage` by the **Save settings** button and restored on load. Before
  this they reset to 25¢ / 0¢ / 9pm–9am on every reload.
- Editing a control still previews immediately, exactly as before; Save only
  controls whether the change survives a reload. The Save button is disabled
  until the form differs from what is stored and validates. Invalid input blocks
  the save, names the problem and outlines the offending field; it never silently
  falls back to the previous values.
- A stored plan that no longer validates is discarded on load rather than
  applied, and every storage read and write is wrapped in try/catch so blocked or
  corrupt storage cannot stop the page booting.
- Reset to defaults clears the stored plan as well as restoring the defaults.

### Dashboard scope

- The live navigation contains **Daily View** and **Hourly Profile Table**.
  The former Weekly view and the chat assistant were removed because they were not part of the
  regular workflow. Their rendering code was removed as well, rather than merely hidden, to avoid
  maintaining and running unused features.
- Usage and estimated cost share one panel. The latest SMT date remains independent
  of historical day selection, and trailing seven-day costs remain available.
- The five average summary cards have been removed. The charts and hourly table
  retain detailed usage and import/export information for the latest 30 calendar days.
- **Energy Insights** reviews the newest SMT day on demand, using local rules and
  the configured free-night hours and rates. It shows one short assessment, up to
  three morning/daytime/night rows with exact hours, and a daily export line.
  Unexpected paid-hour activity is identified in the takeaway and its section; expected free-window charging is
  informational. Percentages and extra graphs are deliberately omitted.
- Initial paid-use rules remain: over 1 kWh per paid period, a 0.5 kWh quarter-hour
  peak, or two consecutive 0.125 kWh intervals. With at least seven complete,
  actual prior paid periods (up to 28 within the 30-day history), paid imports also
  flag when above both twice the median and the median plus 0.5 kWh. Low paid use
  is at most 0.1 kWh. Constants are documented in `ENERGY_INSIGHT_RULES`; there are
  no additional user controls. No equipment or solar-production cause is inferred.
- Missing or estimated imports prevent a whole-day normal verdict. Import/export
  quality is independent, unknown exports remain unavailable, and partial figures
  represent observed intervals only. Very small energy charges use cents to avoid
  hiding sub-cent differences. Existing cost cards keep their original formatting.
- Historical weather is optional context for the SMT date, using the existing
  weather endpoint and configured `WEATHER_LAT`/`WEATHER_LON`. For the requested
  77494 area, those existing coordinates must correspond to that area. An optional
  `WEATHER_POSTAL_CODE=77494` labels the configured location; it does not geocode or
  verify coordinates. Without it the label is Local weather. Missing/unknown
  conditions are omitted; no guessed cloudiness or weather-based cause is shown.
- Data, date/rate/free-hour changes invalidate an old report. A generation counter
  prevents delayed weather responses from updating newer or cleared reports.
- CSV parsing detects the SMT header after optional report metadata and also supports
  header-first files. Headers and time fields are trimmed; import/export directions
  and their revision and quality flags remain separate.

### Free nights and estimated energy charges

- Free nights are enabled by default (9 PM–9 AM). The checkbox, hours and rates
  reset to their defaults on reload, independently of cached SMT readings.
  Turning free nights off disables the time selectors and night rate; the day
  field becomes Electricity rate and applies to all 24 hours. A valid rate remains
  required. Turning the checkbox back on restores the current hours and night rate.
  Every split uses `isFreeHour`, including insights, cost estimates, chart colors,
  daily/monthly totals and hourly tables. Edits invalidate the old insights report.
- Alert settings use daily dollar limits (yellow defaults to $1; red to $5).
  Green is below yellow, yellow starts at yellow, and red starts at red. Limits
  must be positive cent amounts with red higher than yellow. Comparison uses
  displayed cent precision, using the same rounding for dollar labels and colors.
  Historical-increase statements require complete actual current readings;
  partial/estimated costs explicitly say they use available readings. Valid preferences are saved under energyAlertLimitsV1
  in this browser only; corrupt/blocked storage falls back safely. Invalid current
  entries suppress classification, rather than silently reusing saved values.
- Costs use imports only and the current paid rate/schedule. The paid-hours
  takeaway assesses the entire paid window (all 24 hours when free nights are off).
  Daytime color assesses only its displayed, fully paid period; free/mixed rows
  have no spending color. Missing rates, partial or estimated readings do not
  receive a reassuring green. High spending is a review prompt, not a fault diagnosis.
- Weekly context covers seven calendar days ending on the report date, including
  that day. Frequency counts only complete actual paid periods; missing dates
  are not replaced with older days. Available partial/estimated costs remain
  labeled as such. Historical costs are recalculated with current settings, not
  represented as actual past billed tariffs. Median comparisons use up to 28
  prior complete actual paid periods, requiring seven; spikes/history are
  informational and cannot override the spending color.
- Costs, insights and hourly-table completeness share America/Chicago calendar
  expectations. Spring days have 92 quarters and the nonexistent 2 AM table hour
  says N/A. Fall days have 100 quarters: the parser keys by wall time and cannot
  distinguish the repeated 1 AM hour from revisions. Never sum duplicates to
  pretend this is fixed. Mark affected periods partial and explain the clock
  change. Paid periods outside the repeated hour can still be complete. This
  conservative limitation applies to November 1, 2026 and future fall changes.
- Four latest-day cards show daytime import/cost and nighttime import/cost for the
  newest available SMT date, independently of the historical day selected below.
  Nighttime means midnight–9 AM plus 9 PM–midnight on that same calendar date;
  changing the night selectors updates both period splits.
- Day and night rates are editable in cents per kWh. They default to 25 cents for
  daytime and 0 cents for nighttime on every page reload and are never stored.
  Refreshing Drive data within the same page keeps the entered rates.
- The selected-day and trailing seven-day estimates include both rates. Missing and
  partial periods are identified; missing readings are not projected. Even at a zero
  rate, a period without import readings shows unavailable rather than a zero charge.
  Estimates exclude delivery charges, taxes, fixed fees, and export credits.
- Copy Table reads the currently rendered hourly table, including the selected energy
  metric, visible date range, daily totals, and displayed weather, as tab-separated text.

### SMT import, export, and net energy

- SMT CSV files (and XLSX files with the same columns) retain Consumption as grid
  import and Surplus Generation as grid export. Export is surplus sent to the grid,
  not total solar production or total household consumption.
- Net grid import is **import minus export**. Hourly net cells use green for net export, red for net import,
  and gray for balance.
- The hourly table offers Import, Export, and Net views and always includes all three
  daily totals. The selected metric and kWh units are included when copying the table.
  Existing free-night and paid-period figures continue to use imports only.
- Missing export readings remain unavailable, rather than becoming zero. Net values
  require matching import/export coverage. Asterisks flag estimated readings. Partial-day graph/table
  totals represent the available intervals.
- Overlapping files merge each direction independently, preferring newer SMT revision
  timestamps. The cache/sync version forces an initial refresh after this update so
  previously discarded exports are loaded. Energy data remains in session storage.

### Hourly table and weather

- The hourly table defaults to the most recent 14 days to stay readable and avoid unnecessary
  weather requests. The selector offers only 7, 14, and 30 calendar days.
- Weather is plain text in the date cell (`condition | Rain 0.00 in`) so copied output remains useful
  in spreadsheets and AI prompts. The Copy button emits tab-separated text and includes a daily
  total column.
- Browser weather loading uses no more than three concurrent workers. This keeps a large historical
  table from creating a burst of requests while still filling visible rows progressively.
- Exact coordinates are intentionally read only by the server-side weather endpoint from Vercel
  environment variables. The browser receives only condition and rainfall, and the UI uses the
  neutral label `Local weather`. Future weather fields should follow the same pattern rather than
  exposing coordinates in client code.
- Historical weather responses are cached because past conditions do not change. Current/future
  responses expire so forecasts can refresh.

### Privacy and Drive boundaries

- Authentication is intentionally deferred. Until it is added, treat the deployment URL as public
  and keep the configured Drive folder dedicated to non-account dashboard exports.
- The listing endpoint replaces original Drive filenames before sending them to the browser because
  exported filenames can contain names, meter identifiers, or other personal information.
- The download endpoint rechecks that every requested file is a direct child of `DRIVE_FOLDER_ID`.
  This prevents the API key from turning the endpoint into a general-purpose Drive file proxy.
  It performs that check with the same folder-list operation used by the listing endpoint because
  some API-key configurations allow listing and downloading but return 403 for a standalone Drive
  metadata lookup. Both routes follow every listing page before deciding membership; a short page
  is not proof that the folder listing is complete. Incomplete or failed membership searches return
  a verification error rather than incorrectly declaring the file outside the folder.
- Parsed energy readings are cached only in `sessionStorage`, so closing the browser session clears
  them. Small non-energy preferences and weather summaries may still use `localStorage`.

### Future extensions

- If access control is added, enforce it inside every data API route—not only with a client-side
  login screen. A signed, `HttpOnly`, `Secure`, `SameSite=Strict` cookie is the intended lightweight
  approach for this single-user dashboard.
- If hourly-table weather grows beyond condition and rainfall, add fields to `api/weather.js` and
  return only the normalized values required by the UI rather than forwarding raw provider data.

## Local verification

Install with npm ci, then run the regression suite before deployment:

```bash
npm test
npm run check
```

The tests exercise the complete mocked Drive flow—listing, filename sanitization, folder-membership
verification, and media download—plus denial/error behavior and normalized weather output.

## Regression checks

- `npm test`: parser, energy/cost/review, cache, and API regressions.
- `npm run build`: validates server scripts, compiles the inline dashboard JavaScript
  for syntax errors, checks unique element IDs, then prepares browser assets.
- `npm run test:browser`: optional real-browser regression suite. Requires Playwright
  and a Chromium executable in the test environment. Uses `/usr/bin/chromium` when
  available, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. All API responses and
  energy records are synthetic; no connected account is used. The suite binds an
  ephemeral localhost port.
- Set `CHART_JS_TEST_PATH` to a local copy of the dashboard's Chart.js 4.4.1 UMD
  bundle to exercise actual chart rendering; otherwise charts are stubbed and the
  suite prints that limitation. Optional `BROWSER_QA_OUTPUT` captures phone/tablet
  screenshots outside the published assets.

Because the redesign moved the plan controls, the Drive button and the review
button onto separate views, each browser scenario now opens the owning view
first (`openPlan`, `openDashboard`, `openHourly` in `scripts/test-browser.cjs`).
Reading hidden text still works; Playwright only refuses to *act* on a control
that is not visible.

Browser scenarios cover cold and delayed startup, failed/partial syncs, manual
retry, duplicate refresh requests, disabled storage, bad cache, clearing data,
missing chart assets, rate/date/free-hour edits, and incomplete/estimated data.
Phone/tablet layout checks cover widths 320, 375, 390, 430, 768, 820, 1024, and
1180 pixels, touch targets, input font sizing, and report overflow. This is
Chromium viewport testing, not validation on physical iOS devices or Safari.
Free-night start and end must differ; an ambiguous equal-time edit is rejected
without changing the current settings. Failed/partial downloads remain visible
and do not record a fully successful sync. Valid previously loaded data remains
available after a failed refresh. Browser storage is optional.

### Drive download performance

Reports retain the latest 30 calendar days ending on the newest actual SMT data
date. File selection uses a rolling 31-day export/upload-date window to allow
for next-day delivery; undated files are included and actual usage dates determine
which readings remain. Recently uploaded historical exports may still need to be
downloaded before their contents can be filtered. Up to four SMT files download and parse concurrently. Results
merge in listing order, preserving equal-revision overlap behavior regardless of
network completion order. Per-file retries, folder membership checks, partial
failure warnings, and the session-only energy cache remain in place. Progress
shows completed files out of the pending total. This reduces sequential network
waiting; Google Drive latency and folder verification still contribute to load time.

### History and hourly table ranges

The hourly selector offers only 7, 14 (default), and 30 calendar days, ending on
its newest data date. Missing days do not extend the date range to fill rows.
Restored session data and newly synchronized readings are limited to 30 days;
cache payloads also retain only those days. This covers the weekly chart,
latest/selected-day costs, and review's 28-prior-period baseline when enough actual
readings are available. A seven-day cost estimate for a day near the oldest
retained date can be partial and remains labeled with its available coverage.
The removed All loaded data option and obsolete monthly aggregate calculations
are no longer used. Files in Google Drive are never deleted by this cutoff.

### Energy Insights maintenance and test notes

`analyzeEnergyInsights` returns structured results and runs on sanitized copies;
it never changes the dashboard readings, chart data, existing cost estimates,
Drive sync, or table selection. The existing `daytime-review-*` IDs and review
entry point remain for compatibility. Detailed legacy diagnostic helpers retain
separate tests; the visible panel uses the new concise engine.

Insight periods use America/Chicago wall times and end-exclusive boundaries.
The spring clock-change day expects 92 quarters. The fall day expects 100;
since wall-time keyed SMT data cannot prove that both repeated hours are present,
that case remains conservatively partial. Inverted/daytime free windows use
chronological morning/day/night spans and explicitly label free, paid, or mixed
usage. No fixed 9 AM/9 PM assumptions are used for paid-use detection.

The October 27 regression fixture is synthetic data matching the owner's supplied
aggregates (15.174 kWh import, 0.093 export, 7.234 morning, 0.048 paid, 6.175 from
9–10 PM, 2.905 at 9:15 PM / 11.62 kW). It validates arithmetic, not that day's
unavailable original interval readings or weather. Other cases cover zero usage,
partial/estimated/export-only data, invalid rates, duplicate revisions, missing
weather, clock changes, duplicate history, and malformed inputs. Browser tests
exercise stale weather responses, repeated clicks, safe text rendering, isolated
analysis failures, unchanged charts/costs, and phone/tablet layouts.

### Approximate daily weather and daylight context

Energy Insights adds the existing provider's Fahrenheit daily high/low and local
sunrise/sunset beneath the SMT date. These are approximate values for the
configured location, not measurements at the house or indicators of actual solar
production. The existing weather request includes the four extra daily fields;
there is no new provider, geocoding request, or additional per-panel API call.
Temperatures round to whole °F. Times retain the provider's local wall time
(`WEATHER_TIMEZONE`, default America/Chicago), independent of the viewer's phone
or browser timezone. Missing, malformed, inverted, or wrong-date optional values
are omitted individually, never replaced with zero or invented estimates.
Weather cache V3 and the versioned request URL refresh previous condition-only
storage/HTTP records once; SMT caching and
Drive downloads are unchanged. Old API responses without the new fields remain
compatible. Model/weather differences must not alter energy classifications or
claim that sunrise/sunset equals the useful solar-production window.

### Insight section ownership and wording

The top takeaway is explicitly scoped to **paid-hours grid use**, not a verdict on
solar output, battery health, or all-day system operation. The internal status
remains available to the engine/tests but is not displayed as a vague Looks normal
badge. Missing/estimated readings instead get a clearly named meter-data notice.

Morning, Daytime, and Night always remain stacked in chronological order. Each
has its own bordered background, a consistent white heading, explicit hours, a
From the grid reading, and explanatory text inside the same labelled section.
Desktop sections align the reading and explanation across the available width;
phones stack them inside each section. Warnings use Check this period and a border,
not heading colors. The 9 AM transition explanation belongs to Daytime and is
shown only when complete actual paid-period readings support the low-use claim.
