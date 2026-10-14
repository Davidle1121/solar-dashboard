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

## Automatic Sigenergy history and storage

Run npm ci to install the pinned server dependency. Server-side Vercel variables:

- SIGEN_USERNAME and SIGEN_PASSWORD: sensitive mySigen monitoring-account credentials.
- SIGEN_REGION: us for North America (also supports eu, aus, apac, cn).
- BLOB_READ_WRITE_TOKEN: connect a **private** Vercel Blob store to this project.
- CRON_SECRET: a long random sensitive value. Vercel attaches it to cron requests.
- SIGEN_SYNC_PASSWORD: a separate strong passcode (16–256 characters), sensitive in
  Preview and Production. Redeploy after adding it. Never use the mySigen password
  or CRON_SECRET for this setting.

Enable the account and Blob variables in Preview and Production to test a branch.
Vercel cron schedules only run on the production deployment. There are two daily
UTC candidates, 08:00 and 09:00; the server only collects when America/Chicago is in
its 3 AM hour. This accommodates daylight saving without changing the schedule.
Vercel Hobby can dispatch daily jobs anywhere within that hour; it does not promise
an exact 3:00 AM execution. One candidate is skipped and successful same-date runs
are deduplicated. No browser visit or saved-data reload contacts the vendor.

The Sync Solar Data button in Daily View and Solar & Battery Table asks for the
owner passcode and sends an authenticated POST to /api/sigen-data. It rereads only
the last seven completed Central dates, then refreshes the graph and table. The
passcode is cleared from the input immediately and is never saved in browser
storage or placed in a URL. Wrong passcodes cannot trigger provider access. The
Reload saved data button only rereads Blob; it does not initiate collection.

Build, scheduled, and manual collection share a five-minute cooldown coordinated
by a conditional-write private Blob object, sigenergy-meta/sync-lock.json. This is
one fixed metadata object, not additional energy history. A recent run returns a
wait message; the daily schedule remains unchanged. If series mapping is missing,
manual sync exposes a Copy diagnostic action containing only the bounded schema
metadata described below. Share that diagnostic to finish verifying the mappings;
successful authentication alone does not mean solar/battery readings are ready.

On a configured deployment, a bootstrap collects up to seven completed days if the
store is empty. Subsequent daily runs collect yesterday, recheck the prior day for
late readings, and fill missing days within that seven-day window. A bounded run
may finish partially and catch up on a later run; existing usable records survive
provider failures. Entries outside the seven completed Central dates are deleted
before login, even when the upstream service is unavailable. Read responses filter
expired dates independently. Only sigenergy/YYYY-MM-DD.json objects are managed;
SMT data and other Blob namespaces are not deleted.

The collector authenticates and reads station energy/SOC history only. It does not
call inverter, battery, tariff, or operating-mode control APIs. Credentials, station
IDs, tokens, and raw response payloads are not stored. Private-app protocol source:
https://github.com/kefa8/sigen-download/blob/master/src/common.py

Check the redacted SIGEN_SYNC build line: synced means normalized sample records were
saved; partial means some history failed; mapping-required means the upstream data
has no recognized metric series; pending means configuration/provider access still
needs attention. A successful build alone does not prove storage or collection works.
Do not treat preview tests as evidence that the production cron has executed.

When no usable provider samples exist, the UI explicitly says solar/battery data is
not connected, labels the graph SMT Only, and hides empty legend entries and the
battery-percent panel. All metrics shows only rows with at least one measured value;
selecting an unavailable metric explicitly still shows its gaps. Saved empty date
records are not counted as usable history. A successful login is not data readiness.

Bootstrap logs include a bounded schema diagnostic containing generic measurement
series identifiers, units, point counts, coarse timestamp-format categories, and
recognized metrics. They exclude raw readings, point timestamps, station/account
identifiers, tokens, and credentials. Long/non-metric identifiers are redacted.
Use that build-log metadata to verify provider mappings before naming new aliases;
never guess signed battery/grid conventions or expose full API responses.

The provider's response shape and units were connection-tested, but series semantics
must still match the actual installation. The normalizer accepts explicitly named
power series (for example PV_POWER, LOAD_POWER, BATTERY_CHARGE_POWER,
BATTERY_DISCHARGE_POWER, GRID_IMPORT_POWER, GRID_EXPORT_POWER) and BATTERY_SOC.
Unknown series remain unavailable, never guessed from ordering or signed values.
If the account uses different verified identifiers, SIGEN_SERIES_MAP can hold a
non-secret JSON mapping, for example {"solarKw":"VERIFIED_SOLAR_SERIES_ID"}.
Allowed keys are solarKw, loadKw, batteryChargeKw, batteryDischargeKw, gridImportKw,
gridExportKw, and socPct. Mapping a signed combined battery/grid series directly to
an unsigned metric is not supported: its sign meaning needs separate validation.
No unvalidated series should be used to claim self-consumption or battery savings.

The Home Energy Profile replaces the former import/export/net graph. It plots
Sigenergy sampled kW and SMT interval-average kW, with grid export below zero, plus
a separate battery-percent panel. The Solar & Battery Table offers source-labelled
hourly rows, metric/date filters, and a Copy Table action for exactly the visible
view. Dates and hours are joined in Central time; absent sources show gaps or —.
Sigenergy hourly kWh are trapezoidal estimates between adjacent valid samples at
most 15 minutes apart. Longer gaps are not filled; partial coverage is marked *.
SOC is the last observed percent in the hour, not a sum. SMT remains the source for
utility cost calculations. Only seven Sigenergy days are retained; SMT retention
is unchanged. Naive provider timestamps are treated as station-local Central time;
explicit timezone offsets are converted to Central.

The static build publishes only index.html, login.html, and solar-energy.js under
public/. Server code and dependencies are not copied to static output. API handlers
remain under api/ for Vercel serverless routing. The old connection probe remains
available via npm run probe:sigen but no longer logs in during normal builds.

## Design decisions and future reference

### Dashboard scope

- The live navigation contains **Daily View**, **Hourly Profile Table**, and **Solar & Battery Table**.
  The former Weekly view and the chat assistant were removed because they were not part of the
  regular workflow. Their rendering code was removed as well, rather than merely hidden, to avoid
  maintaining and running unused features.
- The summary strip intentionally shows three daily averages: total usage, usage during the
  configured free-night period, and usage during the paid period. Changing either free-night
  selector recalculates these cards, chart segments, and table colors immediately from the readings
  already in memory; a Drive refresh is not required.
- Summary averages prefer complete days. A day with at least 92 quarter-hour readings is considered
  complete so the 23-hour daylight-saving transition is accepted while genuinely partial imports
  are kept out of the headline averages. If no complete day exists, available data is shown rather
  than leaving every card blank.

### Free nights and estimated energy charges

- Free nights default to 9 PM–9 AM; paid hours are 9 AM–9 PM. Changing the selectors
  immediately updates import colors, free/paid totals, and cost estimates.
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
- Net grid import is **import minus export**. The net summary card and hourly net cells use green for net export, red for net import,
  and gray for balance.
- The hourly table offers Import, Export, and Net views and always includes all three
  daily totals. The selected metric and kWh units are included when copying the table.
  Existing free-night and paid-period figures continue to use imports only.
- Missing export readings remain unavailable, rather than becoming zero. Net values
  require matching import/export coverage; the export/net average cards use only
  matching complete days. Asterisks flag estimated readings. Partial-day graph/table
  totals represent the available intervals.
- Overlapping files merge each direction independently, preferring newer SMT revision
  timestamps. The cache/sync version forces an initial refresh after this update so
  previously discarded exports are loaded. Energy data remains in session storage.
- Solar-production, battery, and self-sufficiency cards still require inverter data.

### Hourly table and weather

- The hourly table defaults to the most recent 14 days to stay readable and avoid unnecessary
  weather requests. The selector can show 7, 30, or all loaded days when a larger export is needed.
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
- Sigenergy solar/battery data stays separate from SMT meter readings. Validate provider
  identifiers, units, and sign conventions before adding derived self-consumption or savings.
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
