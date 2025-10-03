const fs = require('fs');

try {
  // Read and parse the JSON file
  const data = JSON.parse(fs.readFileSync('city.list.json', 'utf8'));

  // Create a writable stream for city_list.csv
  const outputStream = fs.createWriteStream('city_list.csv');

  // Write the CSV header
  outputStream.write('provider,station_code,name,country,lat,lon\n');

  // Write each city as a CSV line
  for (const city of data) {
    const lat = city?.coord?.lat ?? '';
    const lon = city?.coord?.lon ?? '';
    const name = (city?.name ?? '').replace(/"/g, '""'); // Escape quotes

    outputStream.write(`owm,${city.id},"${name}",${city.country},${lat},${lon}\n`);
  }

  // Close the stream
  outputStream.end(() => {
    console.log('CSV file "city_list.csv" written successfully.');
  });

} catch (err) {
  console.error('Error reading or parsing city.list.json:', err);
  process.exit(1);
}
