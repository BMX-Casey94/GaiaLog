import { collectAdsbLolStates, collectDigitrafficAisVessels, collectOpenAqAirQuality } from './backup-providers'

async function main(): Promise<void> {
  const aq = await collectOpenAqAirQuality(2)
  console.log('openaq_count', aq.length)

  const ac = await collectAdsbLolStates(5)
  console.log('adsb_count', ac.length)
  console.log('adsb_sample', JSON.stringify(ac[0] ?? null))
  console.log('adsb_again', (await collectAdsbLolStates(5)).length)

  const vessels = await collectDigitrafficAisVessels(5)
  console.log('ais_count', vessels.length)
  console.log('ais_sample', JSON.stringify(vessels[0] ?? null))
  const badTs = vessels.filter(v => !(v.timestamp > 1e12 && v.timestamp < 1e14))
  const mismatch = vessels.filter(v => v.speed !== v.sog || v.course !== v.cog)
  console.log('ais_bad_timestamps', badTs.length, 'ais_alias_mismatch', mismatch.length)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
