export interface AirQualityData {
  timestamp: string
  location: string
  aqi: number
  pm25: number
  pm10: number
  o3: number
  no2: number
  so2: number
  co: number
  status: string
  source: string
}

export interface WaterLevelData {
  timestamp: string
  stations: Array<{
    id: string
    name: string
    level: string
    unit: string
    status: string
    trend: string
  }>
  source: string
}

export interface SeismicData {
  timestamp: string
  recent_events: Array<{
    id: string
    magnitude: string
    location: string
    depth: number
    time: string
    coordinates: {
      lat: number
      lon: number
    }
  }>
  status: string
  source: string
}

export interface AdvancedMetricsData {
  timestamp: string
  soil_moisture: {
    value: number
    unit: string
    status: string
  }
  wildfire_risk: {
    level: number
    status: string
    affected_areas: string[]
  }
  uv_index: {
    value: number
    status: string
  }
  precipitation: {
    value: number
    unit: string
    forecast: string
  }
  source: string
}

class ApiClient {
  private baseUrl = "/api"

  async fetchAirQuality(): Promise<AirQualityData> {
    const response = await fetch(`${this.baseUrl}/air-quality`)
    if (!response.ok) {
      throw new Error("Failed to fetch air quality data")
    }
    return response.json()
  }

  async fetchWaterLevels(): Promise<WaterLevelData> {
    const response = await fetch(`${this.baseUrl}/water-levels`)
    if (!response.ok) {
      throw new Error("Failed to fetch water level data")
    }
    return response.json()
  }

  async fetchSeismicData(): Promise<SeismicData> {
    const response = await fetch(`${this.baseUrl}/seismic`)
    if (!response.ok) {
      throw new Error("Failed to fetch seismic data")
    }
    return response.json()
  }

  async fetchAdvancedMetrics(): Promise<AdvancedMetricsData> {
    const response = await fetch(`${this.baseUrl}/advanced-metrics`)
    if (!response.ok) {
      throw new Error("Failed to fetch advanced metrics")
    }
    return response.json()
  }
}

export const apiClient = new ApiClient()
