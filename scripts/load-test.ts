import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
dotenv.config()
import { fetchJsonWithRetry } from '../lib/provider-fetch'
import { fetchMetricsStore } from '../lib/metrics'

type Task = { name: string; run: () => Promise<void> }

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

async function runTasksSequentially(tasks: Task[], delayMs: number) {
  for (const t of tasks) {
    try { await t.run() } catch {}
    await sleep(delayMs)
  }
}

async function main() {
  const tasks: Task[] = []

  const waqiToken = process.env.WAQI_API_KEY
  if (waqiToken) {
    // Small bounds around (0,0) – inexpensive
    const boundsUrl = `https://api.waqi.info/map/bounds/?token=${waqiToken}&latlng=-1,-1,1,1`
    for (let i = 0; i < 5; i++) {
      tasks.push({ name: `waqi_bounds_${i}`, run: () => fetchJsonWithRetry(boundsUrl, { retries: 1, providerId: 'waqi', etagKey: `lt:waqi:b:${i}` }) })
    }
  }

  const weatherKey = process.env.WEATHERAPI_KEY
  if (weatherKey) {
    const waUrl = `https://api.weatherapi.com/v1/current.json?key=${weatherKey}&q=London&aqi=no`
    for (let i = 0; i < 5; i++) {
      tasks.push({ name: `weatherapi_${i}`, run: () => fetchJsonWithRetry(waUrl, { retries: 1, providerId: 'weatherapi', lastModifiedKey: `lt:wa:last:${i}` }) })
    }
  }

  // NOAA stations list (cheap, with ETag)
  tasks.push({ name: 'noaa_stations', run: () => fetchJsonWithRetry('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels', { retries: 1, providerId: 'noaa', etagKey: 'lt:noaa:stations' }) })

  const owmKey = process.env.OWM_API_KEY
  if (owmKey) {
    const geoUrl = `https://api.openweathermap.org/geo/1.0/direct?q=London&limit=1&appid=${owmKey}`
    for (let i = 0; i < 5; i++) {
      tasks.push({ name: `owm_geo_${i}`, run: () => fetchJsonWithRetry(geoUrl, { retries: 1, providerId: 'owm' }) })
    }
  }

  // Run with gentle pacing (400ms) to avoid bursts
  await runTasksSequentially(tasks, 400)

  const snapshot = fetchMetricsStore.snapshot()
  console.log(JSON.stringify({ success: true, http: snapshot }, null, 2))
}

main().catch((e) => {
  console.error('load-test error:', e)
  process.exit(1)
})


