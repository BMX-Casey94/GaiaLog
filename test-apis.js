// Test script for GaiaLog APIs
const fetch = require('node-fetch');

async function testAPIs() {
  console.log('🧪 Testing GaiaLog APIs...\n');

  // Test 1: USGS Earthquake API (no key needed)
  console.log('1️⃣ Testing USGS Earthquake API...');
  try {
    const usgsResponse = await fetch(
      'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=2024-01-01&endtime=2024-01-02&minmagnitude=2.5&orderby=time'
    );
    const usgsData = await usgsResponse.json();
    console.log(`✅ USGS API: ${usgsData.features?.length || 0} earthquakes found`);
  } catch (error) {
    console.log('❌ USGS API failed:', error.message);
  }

  // Test 2: NOAA Tides & Currents API (no key needed)
  console.log('\n2️⃣ Testing NOAA Tides & Currents API...');
  try {
    const noaaResponse = await fetch(
      'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels'
    );
    const noaaData = await noaaResponse.json();
    console.log(`✅ NOAA API: ${noaaData.stations?.length || 0} stations found`);
  } catch (error) {
    console.log('❌ NOAA API failed:', error.message);
  }

  // Test 3: WeatherAPI.com (we have this key!)
  console.log('\n3️⃣ Testing WeatherAPI.com...');
  try {
    const weatherResponse = await fetch(
      `https://api.weatherapi.com/v1/current.json?key=${process.env.WEATHERAPI_KEY}&q=London&aqi=yes`
    );
    const weatherData = await weatherResponse.json();
    console.log(`✅ WeatherAPI: ${weatherData.location?.name} - ${weatherData.current?.temp_c}°C`);
    console.log(`   Air Quality: ${weatherData.current?.air_quality?.['us-epa-index'] || 'N/A'}`);
  } catch (error) {
    console.log('❌ WeatherAPI failed:', error.message);
  }

  console.log('\n🎉 API testing completed!');
}

testAPIs();
