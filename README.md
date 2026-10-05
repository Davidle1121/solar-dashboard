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
