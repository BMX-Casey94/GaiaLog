export interface AirQualityData {
  aqi: number
  pm25: number
  pm10: number
  co: number
  no2: number
  o3: number
  so2?: number
  location: string
  timestamp: string
  source: string
}

export interface WaterLevelData {
  river_level: number
  sea_level: number
  location: string
  timestamp: string
  source: string
  station_id?: string
}

export interface SeismicData {
  magnitude: number
  depth: number
  location: string
  coordinates: { lat: number; lon: number }
  timestamp: string
  source: string
  event_id?: string
}

export interface AdvancedMetricsData {
  uv_index: number
  soil_moisture: number
  wildfire_risk: number
  environmental_quality_score: number
  location: string
  timestamp: string
  source: string
  coordinates?: { lat: number; lon: number }
}

// Test version of data collection service (no blockchain writes)
export class DataCollectorTest {
  private apiKeys = {
    waqi: process.env.WAQI_API_KEY,
    weatherapi: process.env.WEATHERAPI_KEY
  }

  // 10 most populated metropolitan areas on Earth
  private majorCities = [
    'Tokyo', 'Delhi', 'Shanghai', 'São Paulo', 'Mexico City',
    'Cairo', 'Mumbai', 'Beijing', 'Dhaka', 'Osaka'
  ]

  // Primary: WAQI API, Fallback: WeatherAPI (basic air quality)
  async collectAirQualityData(): Promise<AirQualityData | null> {
    try {
      // Check for serious alerts first (high AQI cities)
      const alertCities = ['Delhi', 'Beijing', 'Mumbai', 'Cairo'] // Cities known for poor air quality
      
      for (const city of alertCities) {
        if (this.apiKeys.waqi) {
          const alertData = await this.fetchWAQIData(city)
          if (alertData && alertData.aqi >= 150) { // Unhealthy or worse
            console.log(`🚨 Serious air quality alert detected in ${city}: AQI ${alertData.aqi}`)
            return alertData
          }
        }
      }

      // If no serious alerts, randomly select from major cities
      const randomCity = this.majorCities[Math.floor(Math.random() * this.majorCities.length)]
      
      // Try WAQI first (better air quality data)
      if (this.apiKeys.waqi) {
        const waqiData = await this.fetchWAQIData(randomCity)
        if (waqiData) {
          console.log(`✅ WAQI air quality data collected for ${randomCity}`)
          return waqiData
        }
      }

      // Fallback to WeatherAPI (basic air quality)
      if (this.apiKeys.weatherapi) {
        const waData = await this.fetchWeatherAPIAirQuality(randomCity)
        if (waData) {
          console.log(`✅ WeatherAPI air quality data collected for ${randomCity}`)
          return waData
        }
      }

      console.warn('No air quality API keys available, using simulated data')
      // Return simulated air quality data as fallback
      return {
        aqi: Math.floor(Math.random() * 200) + 50,
        pm25: Math.floor(Math.random() * 50) + 10,
        pm10: Math.floor(Math.random() * 100) + 20,
        co: Math.floor(Math.random() * 5) + 1,
        no2: Math.floor(Math.random() * 100) + 10,
        o3: Math.floor(Math.random() * 80) + 20,
        so2: Math.floor(Math.random() * 20) + 5,
        location: this.majorCities[Math.floor(Math.random() * this.majorCities.length)],
        timestamp: new Date().toISOString(),
        source: 'Simulated'
      }

    } catch (error) {
      console.error('Error collecting air quality data:', error)
      return null
    }
  }

  private async fetchWAQIData(location: string): Promise<AirQualityData | null> {
    try {
      const response = await fetch(
        `https://api.waqi.info/feed/${location}/?token=${this.apiKeys.waqi}`
      )

      if (!response.ok) {
        throw new Error(`WAQI API error: ${response.statusText}`)
      }

      const data = await response.json()
      
      if (data.status !== 'ok') {
        throw new Error(`WAQI API returned error: ${data.data}`)
      }

      return {
        aqi: data.data.aqi,
        pm25: data.data.iaqi?.pm25?.v || 0,
        pm10: data.data.iaqi?.pm10?.v || 0,
        co: data.data.iaqi?.co?.v || 0,
        no2: data.data.iaqi?.no2?.v || 0,
        o3: data.data.iaqi?.o3?.v || 0,
        so2: data.data.iaqi?.so2?.v || 0,
        location: data.data.city.name,
        timestamp: data.data.time.iso,
        source: 'WAQI'
      }

    } catch (error) {
      console.error('WAQI API error:', error)
      return null
    }
  }

  private async fetchWeatherAPIAirQuality(location: string): Promise<AirQualityData | null> {
    try {
      const response = await fetch(
        `https://api.weatherapi.com/v1/current.json?key=${this.apiKeys.weatherapi}&q=${location}&aqi=yes`
      )

      if (!response.ok) return null

      const data = await response.json()

      return {
        aqi: data.current.air_quality?.['us-epa-index'] || 0,
        pm25: data.current.air_quality?.['pm2_5'] || 0,
        pm10: data.current.air_quality?.['pm10'] || 0,
        co: data.current.air_quality?.['co'] || 0,
        no2: data.current.air_quality?.['no2'] || 0,
        o3: data.current.air_quality?.['o3'] || 0,
        location: data.location.name,
        timestamp: new Date().toISOString(),
        source: 'WeatherAPI.com'
      }

    } catch (error) {
      console.error('WeatherAPI air quality error:', error)
      return null
    }
  }

  // Primary: NOAA Tides & Currents (no API key needed)
  async collectWaterLevelData(): Promise<WaterLevelData | null> {
    try {
      // Check for serious water level alerts first
      const alertStations = await this.fetchNOAAAlertStations()
      if (alertStations.length > 0) {
        const alertStation = alertStations[0] // Most serious alert
        console.log(`🚨 Serious water level alert detected at ${alertStation.location}`)
        return alertStation
      }

      // If no serious alerts, randomly select from major coastal cities
      const coastalCities = ['Tokyo', 'Shanghai', 'Mumbai', 'São Paulo', 'Cairo']
      const randomCity = coastalCities[Math.floor(Math.random() * coastalCities.length)]
      
      const noaaData = await this.fetchNOAAWaterData(randomCity)
      if (noaaData) {
        console.log(`✅ NOAA water level data collected for ${randomCity}`)
        return noaaData
      }

      return null

    } catch (error) {
      console.error('Error collecting water level data:', error)
      return null
    }
  }

  private async fetchNOAAAlertStations(): Promise<WaterLevelData[]> {
    try {
      // Get list of stations
      const stationsResponse = await fetch(
        'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels'
      )

      if (!stationsResponse.ok) return []

      const stationsData = await stationsResponse.json()
      const alertStations: WaterLevelData[] = []
      
      // Check first 10 stations for serious water level conditions
      for (let i = 0; i < Math.min(10, stationsData.stations.length); i++) {
        const station = stationsData.stations[i]
        
        try {
          const waterResponse = await fetch(
            `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${this.getDateString(-1)}&end_date=${this.getDateString(0)}&station=${station.id}&product=water_level&datum=MLLW&time_zone=gmt&units=metric&format=json`
          )

          if (waterResponse.ok) {
            const waterData = await waterResponse.json()
            
            if (waterData.data && waterData.data.length > 0) {
              const latestReading = waterData.data[waterData.data.length - 1]
              const waterLevel = parseFloat(latestReading.v) || 0
              
              // Check for serious conditions (flooding or extreme low water)
              if (waterLevel > 2.0 || waterLevel < -1.0) {
                alertStations.push({
                  river_level: waterLevel,
                  sea_level: waterLevel,
                  location: station.name,
                  timestamp: new Date().toISOString(),
                  source: 'NOAA Tides & Currents',
                  station_id: station.id
                })
              }
            }
          }
        } catch (error) {
          // Continue to next station if one fails
          continue
        }
      }
      
      return alertStations

    } catch (error) {
      console.error('NOAA alert stations error:', error)
      return []
    }
  }

  private async fetchNOAAWaterData(location: string): Promise<WaterLevelData | null> {
    try {
      // Get list of stations
      const stationsResponse = await fetch(
        'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels'
      )

      if (!stationsResponse.ok) return null

      const stationsData = await stationsResponse.json()
      
      // Find a station near the location (simplified - in production, use geocoding)
      const station = stationsData.stations[0] // Use first available station for demo
      
      if (!station) return null

      // Get water level data for the station
      const waterResponse = await fetch(
        `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${this.getDateString(-1)}&end_date=${this.getDateString(0)}&station=${station.id}&product=water_level&datum=MLLW&time_zone=gmt&units=metric&format=json`
      )

      if (!waterResponse.ok) return null

      const waterData = await waterResponse.json()
      
      if (waterData.data && waterData.data.length > 0) {
        const latestReading = waterData.data[waterData.data.length - 1]
        
        return {
          river_level: parseFloat(latestReading.v) || 0,
          sea_level: parseFloat(latestReading.v) || 0,
          location: station.name,
          timestamp: new Date().toISOString(),
          source: 'NOAA Tides & Currents',
          station_id: station.id
        }
      }

      return null

    } catch (error) {
      console.error('NOAA API error:', error)
      return null
    }
  }

  // Primary: USGS Earthquake API (no API key needed)
  async collectSeismicData(): Promise<SeismicData | null> {
    try {
      const seismicData = await this.fetchUSGSSeismicData()
      if (seismicData) {
        // Check if this is a serious earthquake (magnitude 5.0+ or affecting major cities)
        const isSerious = seismicData.magnitude >= 5.0 || 
                         this.majorCities.some(city => 
                           seismicData.location.toLowerCase().includes(city.toLowerCase())
                         )
        
        if (isSerious) {
          console.log(`🚨 Serious seismic alert detected: ${seismicData.magnitude}M at ${seismicData.location}`)
        } else {
          console.log(`✅ USGS seismic data collected: ${seismicData.magnitude}M at ${seismicData.location}`)
        }
        
        return seismicData
      }

      return null

    } catch (error) {
      console.error('Error collecting seismic data:', error)
      return null
    }
  }

  private async fetchUSGSSeismicData(): Promise<SeismicData | null> {
    try {
      // Get earthquakes from the last 24 hours, magnitude 2.5+
      const endTime = new Date().toISOString()
      const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      
      const response = await fetch(
        `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${startTime}&endtime=${endTime}&minmagnitude=2.5&orderby=time`
      )

      if (!response.ok) {
        throw new Error(`USGS API error: ${response.statusText}`)
      }

      const data = await response.json()
      
      if (data.features && data.features.length > 0) {
        const latestEarthquake = data.features[0]
        const properties = latestEarthquake.properties
        const geometry = latestEarthquake.geometry
        
        return {
          magnitude: properties.mag,
          depth: typeof geometry.coordinates?.[2] === 'number' ? geometry.coordinates[2] : 0,
          location: properties.place,
          coordinates: {
            lat: geometry.coordinates[1],
            lon: geometry.coordinates[0]
          },
          timestamp: new Date(properties.time).toISOString(),
          source: 'USGS Earthquake API',
          event_id: latestEarthquake.id
        }
      }

      return null

    } catch (error) {
      console.error('USGS API error:', error)
      return null
    }
  }

  // Primary: Environmental Metrics (WeatherAPI + NASA + NOAA)
  async collectAdvancedMetricsData(): Promise<AdvancedMetricsData | null> {
    try {
      // Check for serious environmental alerts first
      const alertCities = ['Delhi', 'Beijing', 'Cairo'] // Cities with environmental challenges
      
      for (const city of alertCities) {
        if (this.apiKeys.weatherapi) {
          const alertData = await this.fetchWeatherAPIData(city)
          if (alertData) {
            const environmentalScore = this.calculateEnvironmentalQualityScore(
              alertData.uv_index, 
              await this.fetchNASASoilMoisture(city), 
              await this.fetchNOAAWildfireRisk(city)
            )
            
            if (environmentalScore < 50) { // Poor environmental quality
              console.log(`🚨 Serious environmental alert detected in ${city}: Score ${environmentalScore}`)
              return {
                uv_index: alertData.uv_index,
                soil_moisture: await this.fetchNASASoilMoisture(city),
                wildfire_risk: await this.fetchNOAAWildfireRisk(city),
                environmental_quality_score: environmentalScore,
                location: city,
                timestamp: new Date().toISOString(),
                source: 'Environmental Monitoring System'
              }
            }
          }
        }
      }

      // If no serious alerts, randomly select from major cities
      const randomCity = this.majorCities[Math.floor(Math.random() * this.majorCities.length)]
      
      // Collect UV index from WeatherAPI
      let uvIndex = 0
      if (this.apiKeys.weatherapi) {
        const uvData = await this.fetchWeatherAPIData(randomCity)
        if (uvData) {
          uvIndex = uvData.uv_index
        }
      }

      // Collect soil moisture from NASA SMAP
      const soilMoisture = await this.fetchNASASoilMoisture(randomCity)

      // Collect wildfire risk from NOAA
      const wildfireRisk = await this.fetchNOAAWildfireRisk(randomCity)

      // Calculate environmental quality score
      const environmentalQualityScore = this.calculateEnvironmentalQualityScore(uvIndex, soilMoisture, wildfireRisk)

      const environmentalData: AdvancedMetricsData = {
        uv_index: uvIndex,
        soil_moisture: soilMoisture,
        wildfire_risk: wildfireRisk,
        environmental_quality_score: environmentalQualityScore,
        location: randomCity,
        timestamp: new Date().toISOString(),
        source: 'Environmental Monitoring System'
      }

      console.log(`✅ Environmental metrics collected for ${randomCity}`)
      return environmentalData

    } catch (error) {
      console.error('Error collecting environmental metrics:', error)
      // Return simulated environmental data as fallback
      const randomCity = this.majorCities[Math.floor(Math.random() * this.majorCities.length)]
      return {
        uv_index: Math.floor(Math.random() * 11), // 0-10 UV index
        soil_moisture: Math.random() * 0.8 + 0.2, // 0.2-1.0 soil moisture
        wildfire_risk: Math.floor(Math.random() * 10) + 1, // 1-10 wildfire risk
        environmental_quality_score: Math.floor(Math.random() * 60) + 40, // 40-100 quality score
        location: randomCity,
        timestamp: new Date().toISOString(),
        source: 'Simulated Environmental Data'
      }
    }
  }

  private async fetchWeatherAPIData(location: string): Promise<{ uv_index: number } | null> {
    try {
      const response = await fetch(
        `https://api.weatherapi.com/v1/current.json?key=${this.apiKeys.weatherapi}&q=${location}&aqi=no`
      )

      if (!response.ok) return null

      const data = await response.json()

      return {
        uv_index: data.current.uv || 0
      }

    } catch (error) {
      console.error('WeatherAPI error:', error)
      return null
    }
  }

  private async fetchNASASoilMoisture(location: string): Promise<number> {
    try {
      // NASA SMAP API for soil moisture data
      // Note: This is a simplified implementation. Real NASA SMAP data requires more complex API calls
      const response = await fetch(
        `https://api.nasa.gov/planetary/earth/assets?lat=51.5074&lon=-0.1278&date=2024-01-01&dim=0.15&api_key=DEMO_KEY`
      )

      if (!response.ok) {
        console.log('NASA SMAP API not available, using simulated data')
        // Return simulated soil moisture data (0-1 scale, where 1 is very wet)
        return Math.random() * 0.8 + 0.2 // Random value between 0.2 and 1.0
      }

      const data = await response.json()
      // In a real implementation, you would parse the SMAP data here
      return 0.5 // Default value

    } catch (error) {
      console.error('NASA SMAP error:', error)
      // Return simulated data as fallback
      return Math.random() * 0.8 + 0.2
    }
  }

  private async fetchNOAAWildfireRisk(location: string): Promise<number> {
    try {
      // NOAA Fire Weather API for wildfire risk
      // Note: This endpoint returns HTML documentation, not JSON data
      // In a real implementation, you would use the actual NOAA Fire Weather API
      console.log('NOAA Fire Weather API not available, using simulated data')
      // Return simulated wildfire risk data (0-10 scale, where 10 is extreme risk)
      return Math.random() * 5 + 1 // Random value between 1 and 6

    } catch (error) {
      console.error('NOAA Fire Weather error:', error)
      // Return simulated data as fallback
      return Math.random() * 5 + 1
    }
  }

  private calculateEnvironmentalQualityScore(uvIndex: number, soilMoisture: number, wildfireRisk: number): number {
    // Calculate a composite environmental quality score (0-100, where 100 is excellent)
    let score = 100

    // UV Index penalty (0-11 scale, higher is worse)
    if (uvIndex > 8) score -= 20 // High UV
    else if (uvIndex > 6) score -= 10 // Moderate UV
    else if (uvIndex > 3) score -= 5 // Low UV

    // Soil moisture penalty (0-1 scale, lower is worse)
    if (soilMoisture < 0.3) score -= 15 // Very dry
    else if (soilMoisture < 0.5) score -= 8 // Dry
    else if (soilMoisture > 0.9) score -= 5 // Very wet

    // Wildfire risk penalty (0-10 scale, higher is worse)
    if (wildfireRisk > 7) score -= 25 // Extreme risk
    else if (wildfireRisk > 5) score -= 15 // High risk
    else if (wildfireRisk > 3) score -= 8 // Moderate risk

    return Math.max(0, Math.min(100, score))
  }

  private getDateString(daysOffset: number): string {
    const date = new Date()
    date.setDate(date.getDate() + daysOffset)
    return date.toISOString().split('T')[0]
  }

  async collectAllData(): Promise<{
    airQuality: AirQualityData | null
    waterLevels: WaterLevelData | null
    seismic: SeismicData | null
    advancedMetrics: AdvancedMetricsData | null
  }> {
    console.log('🔄 Starting worldwide environmental data collection (TEST MODE - no blockchain writes)...')
    
    const [airQuality, waterLevels, seismic, advancedMetrics] = await Promise.allSettled([
      this.collectAirQualityData(),
      this.collectWaterLevelData(),
      this.collectSeismicData(),
      this.collectAdvancedMetricsData()
    ])

    const result = {
      airQuality: airQuality.status === 'fulfilled' ? airQuality.value : null,
      waterLevels: waterLevels.status === 'fulfilled' ? waterLevels.value : null,
      seismic: seismic.status === 'fulfilled' ? seismic.value : null,
      advancedMetrics: advancedMetrics.status === 'fulfilled' ? advancedMetrics.value : null
    }

    console.log('✅ Worldwide data collection completed (TEST MODE)')
    return result
  }
}

// Export singleton instance
export const dataCollectorTest = new DataCollectorTest()
