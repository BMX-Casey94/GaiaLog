# 🌍 Worldwide Environmental API Setup Guide

## Overview
This guide will help you set up the recommended free-tier APIs for worldwide environmental data collection in GaiaLog.

## 🚀 Quick Start (Essential APIs)

### 1. **World Air Quality Index (WAQI) API**
**Best for: Air Quality Data (Global Coverage)**

**Setup Steps:**
1. Visit: https://aqicn.org/data-platform/token/
2. Click "Get Token" and register for free
3. Copy your API key immediately
4. **Free Tier**: 1,000 calls/month
5. **Coverage**: 11,000+ stations worldwide

**Add to .env.local:**
```bash
WAQI_API_KEY=your_waqi_token_here
```

### 2. **OpenWeatherMap API**
**Best for: Weather & Air Quality (Global Coverage)**

**Setup Steps:**
1. Visit: https://openweathermap.org/api
2. Sign up for free account
3. Wait 2 hours for API key activation
4. **Free Tier**: 1,000 calls/day
5. **Coverage**: Global

**Add to .env.local:**
```bash
OPENWEATHERMAP_API_KEY=your_openweathermap_key_here
```

### 3. **WeatherAPI.com (Backup)**
**Best for: Enhanced Weather Data (Global Coverage)**

**Setup Steps:**
1. Visit: https://www.weatherapi.com/
2. Sign up for free account
3. Get API key immediately
4. **Free Tier**: 1,000,000 calls/month
5. **Coverage**: Global

**Add to .env.local:**
```bash
WEATHERAPI_KEY=your_weatherapi_key_here
```

## 🔧 No API Key Required (Unlimited Free)

### 4. **USGS Earthquake API**
**Best for: Seismic Activity (Global Coverage)**

**Setup Steps:**
1. No registration required
2. No API key needed
3. **Free Tier**: Unlimited
4. **Coverage**: Global

**Example API Call:**
```bash
curl "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=2024-01-01&endtime=2024-01-02&minmagnitude=2.5"
```

### 5. **NOAA Tides & Currents API**
**Best for: Water Levels (US Coastal + International)**

**Setup Steps:**
1. No registration required
2. No API key needed
3. **Free Tier**: Unlimited
4. **Coverage**: US coastal areas + international

**Example API Call:**
```bash
curl "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=20240101&end_date=20240102&station=9447130&product=water_level&datum=MLLW&time_zone=gmt&units=metric&format=json"
```

## 📊 Data Coverage by API

| Data Type | Primary API | Backup API | Coverage | Free Tier |
|-----------|-------------|------------|----------|-----------|
| **Air Quality** | WAQI | OpenWeatherMap | Global | 1,000 calls/month |
| **Weather** | OpenWeatherMap | WeatherAPI.com | Global | 1,000 calls/day |
| **Seismic** | USGS | EMSC | Global | Unlimited |
| **Water Levels** | NOAA | NASA | US + Global | Unlimited |

## 🔄 Implementation Strategy

### Phase 1: Core Setup (Start Here)
```bash
# Essential APIs for immediate functionality
WAQI_API_KEY=your_waqi_key
OPENWEATHERMAP_API_KEY=your_openweathermap_key
```

### Phase 2: Enhanced Coverage
```bash
# Additional APIs for redundancy and better coverage
WEATHERAPI_KEY=your_weatherapi_key
```

### Phase 3: Advanced Features (Optional)
```bash
# For enhanced features and regional coverage
EMSC_API_KEY=your_emsc_key
IBM_ENVIRONMENTAL_API_KEY=your_ibm_key
```

## 🧪 Testing Your APIs

### Test WAQI API:
```bash
curl "https://api.waqi.info/feed/London/?token=YOUR_WAQI_TOKEN"
```

### Test OpenWeatherMap:
```bash
curl "http://api.openweathermap.org/data/2.5/weather?q=London&appid=YOUR_OWM_KEY&units=metric"
```

### Test USGS Earthquake:
```bash
curl "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=2024-01-01&endtime=2024-01-02&minmagnitude=2.5"
```

### Test NOAA Water Levels:
```bash
curl "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels"
```

## 📈 Rate Limits & Usage

### Recommended Collection Schedule:
- **Every 15 minutes**: Air Quality, Weather
- **Every hour**: Water Levels
- **Every 6 hours**: Seismic Activity

### Monthly Usage Estimates:
- **WAQI**: ~2,880 calls/month (2 locations, every 15 min)
- **OpenWeatherMap**: ~2,880 calls/month (2 locations, every 15 min)
- **WeatherAPI**: ~2,880 calls/month (backup)
- **USGS**: ~120 calls/month (every 6 hours)
- **NOAA**: ~720 calls/month (every hour)

## 🌐 Worldwide Coverage Strategy

### Air Quality Monitoring:
1. **Primary**: WAQI (11,000+ stations globally)
2. **Backup**: OpenWeatherMap (global coverage)
3. **Focus Areas**: Major cities, industrial areas, pollution hotspots

### Water Level Monitoring:
1. **Primary**: NOAA (US coastal + international)
2. **Backup**: NASA Global Water Monitor
3. **Focus Areas**: Major rivers, coastal areas, flood-prone regions

### Seismic Activity:
1. **Primary**: USGS (global earthquake monitoring)
2. **Backup**: EMSC (European-Mediterranean focus)
3. **Focus Areas**: Seismic zones, fault lines, volcanic regions

### Weather & Advanced Metrics:
1. **Primary**: OpenWeatherMap (global weather)
2. **Backup**: WeatherAPI.com (enhanced features)
3. **Focus Areas**: Climate monitoring, extreme weather events

## 🔐 Security Best Practices

1. **Never commit API keys to version control**
2. **Use environment variables for all API keys**
3. **Rotate API keys regularly**
4. **Monitor API usage to stay within free tiers**
5. **Implement rate limiting in your application**

## 🚨 Troubleshooting

### Common Issues:

**WAQI API:**
- Token not working: Wait 24 hours after registration
- Rate limit exceeded: Reduce collection frequency

**OpenWeatherMap:**
- API key not working: Wait 2 hours after registration
- 401 errors: Check API key format

**USGS/NOAA:**
- No data returned: Check date formats (YYYY-MM-DD)
- Network errors: These APIs are very reliable

## 📞 Support Resources

- **WAQI**: https://aqicn.org/support/
- **OpenWeatherMap**: https://openweathermap.org/support
- **WeatherAPI**: https://www.weatherapi.com/support
- **USGS**: https://earthquake.usgs.gov/contactus/
- **NOAA**: https://tidesandcurrents.noaa.gov/contact.html

## 🎯 Next Steps

1. **Set up your API keys** using the links above
2. **Add them to your .env.local file**
3. **Test each API** using the curl commands
4. **Deploy your updated data collector**
5. **Monitor your blockchain transactions** for successful data logging

Your GaiaLog system will now collect worldwide environmental data and log it immutably to the BSV blockchain! 🌍🔗
