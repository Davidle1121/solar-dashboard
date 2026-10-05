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
  The listing endpoint creates a signed proof for each listed file ID, and the download endpoint
  verifies that proof locally. This avoids the extra Google metadata/list request that returned 403
  for valid files under some API-key configurations while still rejecting caller-invented IDs.
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
