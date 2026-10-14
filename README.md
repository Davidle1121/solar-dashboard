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

## Sigenergy private-app API connection test

The connection-test branch runs a server-side diagnostic during the Vercel build.
Configure SIGEN_USERNAME and SIGEN_PASSWORD as sensitive environment variables,
and SIGEN_REGION as a regular variable (us for North America). For a feature-branch
preview, the variables must be available in Vercel's Preview environment as well as
any Production environment where you want to run the diagnostic. Values are never
written to files, browser code, or diagnostic output.

The explicit build command in vercel.json runs npm run build. Its outputDirectory
is the repository root, where index.html and login.html live; there is no generated
public directory. API handlers remain under api/ for Vercel's serverless routing.
The probe only logs
in, discovers the account's home station, and reads yesterday's intraday and daily
history, using America/Chicago to match the SMT dashboard. It does not change any
inverter or battery setting, create an HTTP endpoint, or implement scheduled imports.
The private protocol is based on the community sigen-download implementation:
https://github.com/kefa8/sigen-download/blob/master/src/common.py

Look for the single SIGEN_PROBE JSON line in Vercel's build logs:

- passed: authentication, station access, and numeric history with recognized kW
  and kWh units were observed. Field meanings and values still need validation
  before connecting the importer to dashboard calculations.
- skipped: one or more variable names were missing. A successful deployment with
  this result does not validate Sigenergy access.
- failed: the stage and fixed reason identify a login, permission, network, or
  response-format issue. Vendor response bodies and exception messages are omitted
  because they can contain account data. Configured failures fail the build.
- inconclusive: login and station discovery worked, but usable history or expected
  units were absent. This also fails the build; do not treat it as import readiness.

The probe makes a new login on each configured build and has no automatic retries.
Avoid repeated redeployments while diagnosing authentication or rate-limit failures.
This is a temporary connection diagnostic; replace the build hook with a scheduled
collector after validating access. No historical readings or tokens are persisted.

For local development with credentials securely injected into the process, use
npm run probe:sigen. npm test uses mocked responses and never contacts Sigenergy.

## Design decisions and future reference

### Dashboard scope

- The live navigation intentionally contains only **Daily View** and **Hourly Profile Table**.
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
- Net grid import is **import minus export**. The daily Import / Export / Net graph,
  net summary card, and hourly net cells use green for net export, red for net import,
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
- Solar and battery placeholders remain dormant for a future SIGEnergy import. New production or
  battery data should remain separate from grid readings until its source format and units are
  validated.
- If hourly-table weather grows beyond condition and rainfall, add fields to `api/weather.js` and
  return only the normalized values required by the UI rather than forwarding raw provider data.

## Local verification

Run the dependency-free API regression suite before deployment:

```bash
npm test
npm run check
```

The tests exercise the complete mocked Drive flow—listing, filename sanitization, folder-membership
verification, and media download—plus denial/error behavior and normalized weather output.
