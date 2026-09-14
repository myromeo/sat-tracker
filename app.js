const axios = require('axios');
const satellite = require('satellite.js');
const fs = require('fs');

const CELESTRAK_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json';
const OUTPUT_PATH = '/data/aircraft.json';
const REFRESH_INTERVAL_MS = 5000; // Recalculate every 5s for global scale

let satRecords = [];

// Fetch full global active payload set
async function updateTLEs() {
  try {
    console.log('Fetching active satellites from CelesTrak...');
    const response = await axios.get(CELESTRAK_URL);
    
    satRecords = response.data.map(sat => ({
      name: sat.OBJECT_NAME || 'SAT',
      noradId: sat.NORAD_CAT_ID,
      satrec: satellite.jsonToSatrec(sat)
    })).filter(s => s.satrec);

    console.log(`Successfully loaded ${satRecords.length} global satellites.`);
  } catch (err) {
    console.error('Error fetching CelesTrak data:', err.message);
  }
}

// Process positions across the entire global set
function propagateGlobalSet() {
  if (!satRecords.length) return;

  const now = new Date();
  const gmst = satellite.gstime(now);
  const aircraft = [];

  for (let i = 0; i < satRecords.length; i++) {
    const sat = satRecords[i];
    const posVel = satellite.propagate(sat.satrec, now);

    if (posVel.position && typeof posVel.position !== 'boolean') {
      const positionGd = satellite.eciToGeodetic(posVel.position, gmst);
      
      const lat = satellite.degreesLat(positionGd.latitude);
      const lon = satellite.degreesLong(positionGd.longitude);
      const altFeet = Math.round(positionGd.height * 3280.84); // km to feet

      // Synthetic hex identifier based on NORAD ID
      const hexId = `SAT${sat.noradId.toString(16).padStart(5, '0')}`.toUpperCase();

      aircraft.push({
        hex: hexId,
        flight: sat.name.padEnd(8).substring(0, 8),
        lat: Number(lat.toFixed(4)),
        lon: Number(lon.toFixed(4)),
        altitude: altFeet,
        track: 0,
        speed: 14000, // Nominal orbital speed estimate in knots
        category: "A5",
        type: "SAT",
        seen: 0
      });
    }
  }

  const dump1090Payload = {
    now: Math.floor(Date.now() / 1000),
    messages: aircraft.length,
    aircraft: aircraft
  };

  // Atomic write to volume
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(dump1090Payload));
}

// Run initial fetch and timers
updateTLEs();
setInterval(updateTLEs, 6 * 60 * 60 * 1000); // Refetch CelesTrak every 6 hours
setInterval(propagateGlobalSet, REFRESH_INTERVAL_MS);
