// Simple test for data collection without blockchain
const fetch = require('node-fetch');

async function testSimpleDataCollection() {
  console.log('🧪 Testing simple data collection...\n');

  // Test WeatherAPI (we have this key)
  console.log('1️⃣ Testing WeatherAPI.com...');
  try {
    const response = await fetch(
      `https://api.weatherapi.com/v1/current.json?key=${process.env.WEATHERAPI_KEY}&q=London&aqi=yes`
    );
    const data = await response.json();
    console.log(`✅ WeatherAPI: ${data.location?.name} - ${data.current?.temp_c}°C`);
    console.log(`   Air Quality: ${data.current?.air_quality?.['us-epa-index'] || 'N/A'}`);
  } catch (error) {
    console.log('❌ WeatherAPI failed:', error.message);
  }

  // Test USGS (no key needed)
  console.log('\n2️⃣ Testing USGS Earthquake API...');
  try {
    const response = await fetch(
      'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=2024-01-01&endtime=2024-01-02&minmagnitude=2.5&orderby=time'
    );
    const data = await response.json();
    console.log(`✅ USGS API: ${data.features?.length || 0} earthquakes found`);
  } catch (error) {
    console.log('❌ USGS API failed:', error.message);
  }

  // Test NOAA (no key needed)
  console.log('\n3️⃣ Testing NOAA Tides & Currents API...');
  try {
    const response = await fetch(
      'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels'
    );
    const data = await response.json();
    console.log(`✅ NOAA API: ${data.stations?.length || 0} stations found`);
  } catch (error) {
    console.log('❌ NOAA API failed:', error.message);
  }

  console.log('\n🎉 Simple API testing completed!');
  console.log('\nNote: The POST /api/data/collect endpoint might hang because:');
  console.log('- It tries to write to blockchain (requires BSV keys)');
  console.log('- It tries to use WAQI API (requires API key)');
  console.log('- It tries to write to Supabase (requires Supabase keys)');
}

testSimpleDataCollection();
