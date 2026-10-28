const WEATHER_CODES = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Heavy freezing drizzle', 61: 'Light rain', 63: 'Rain',
  65: 'Heavy rain', 66: 'Freezing rain', 67: 'Heavy freezing rain', 71: 'Light snow',
  73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Light rain showers',
  81: 'Rain showers', 82: 'Heavy rain showers', 85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Severe thunderstorm with hail'
};

export default async function handler(req, res) {
  const date = String(req.query.date || '');
  if (!/^20\d{2}-[01]\d-[0-3]\d$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date' });
  }

  const requested = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(requested.getTime()) || requested.toISOString().slice(0,10) !== date) return res.status(400).json({error:'Invalid date'});

  // Coordinates stay in server-side configuration so the public client only learns
  // normalized weather output, not the dashboard owner's precise configured location.
  const latitude = process.env.WEATHER_LAT;
  const longitude = process.env.WEATHER_LON;
  if (!latitude || !longitude) {
    return res.status(500).json({ error: 'Weather location is not configured' });
  }

  const today = new Date();
  const daysFromToday = Math.round((requested - today) / 86400000);
  // Recent dates can be served by the forecast API; older dates require the archive.
  const endpoint = daysFromToday >= -7
    ? 'https://api.open-meteo.com/v1/forecast'
    : 'https://archive-api.open-meteo.com/v1/archive';
  const params = new URLSearchParams({
    latitude,
    longitude,
    start_date: date,
    end_date: date,
    precipitation_unit: 'inch',
    temperature_unit: 'fahrenheit',
    timezone: process.env.WEATHER_TIMEZONE || 'America/Chicago',
    daily: 'precipitation_sum,weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset'
  });

  try {
    const response = await fetch(`${endpoint}?${params.toString()}`);
    if (!response.ok) return res.status(502).json({ error: 'Weather service unavailable' });
    const data = await response.json();
    const rawCode = data.daily?.weather_code?.[0];
    const code = rawCode == null || rawCode === '' ? NaN : Number(rawCode);
    if (!Number.isInteger(code) || !WEATHER_CODES[code]) return res.status(502).json({error:'Weather condition unavailable'});
    const rain = Number(data.daily?.precipitation_sum?.[0]);
    // These are provider estimates for the requested day's configured location.
    // Missing optional data must never turn into 0°F or a fabricated sun time.
    const temperature = value => typeof value === 'number' && Number.isFinite(value) && value >= -150 && value <= 160 ? value : null;
    let highF = temperature(data.daily?.temperature_2m_max?.[0]);
    let lowF = temperature(data.daily?.temperature_2m_min?.[0]);
    if (highF != null && lowF != null && highF < lowF) { highF = null; lowF = null; }
    const localSunTime = value => {
      if (typeof value !== 'string' || !value.startsWith(date + 'T')) return null;
      const time = value.slice(11);
      return /^(?:[01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(time) ? time.slice(0,5) : null;
    };
    let sunrise = localSunTime(data.daily?.sunrise?.[0]);
    let sunset = localSunTime(data.daily?.sunset?.[0]);
    if (sunrise && sunset && sunrise >= sunset) { sunrise = null; sunset = null; }
    res.setHeader('Cache-Control', daysFromToday < 0 ? 'public, max-age=86400' : 'public, max-age=1800');
    return res.status(200).json({
      condition: WEATHER_CODES[code] || 'Unknown',
      rainInches: Number.isFinite(rain) ? rain : 0,
      ...(highF != null ? {highF} : {}),
      ...(lowF != null ? {lowF} : {}),
      ...(sunrise ? {sunrise} : {}),
      ...(sunset ? {sunset} : {}),
      // Optional owner-supplied label for the already configured location.
      // No postal lookup or new weather service is introduced.
      ...(/^\d{5}$/.test(process.env.WEATHER_POSTAL_CODE || '') ? {postalCode:process.env.WEATHER_POSTAL_CODE} : {})
    });
  } catch {
    return res.status(502).json({ error: 'Weather service unavailable' });
  }
}
