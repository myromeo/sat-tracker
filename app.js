const { exec } = require('child_process');
const satellite = require('satellite.js');
const fs = require('fs');

const CELESTRAK_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle';
const OUTPUT_PATH = '/data/aircraft.json';
const REFRESH_INTERVAL_MS = 5000; // Recalculate every 5s

let satRecords = [];

// Use native curl to bypass Cloudflare fingerprinting on the Pi
function fetchWithCurl(url) {
  return new Promise((resolve, reject) => {
    const command = `curl -sL -A "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36" "${url}"`;
    exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        return reject(error);
      }
      resolve(stdout);
    });
  });
}

async function updateTLEs() {
  try {
    console.log('Fetching active satellites from CelesTrak via curl...');
    const rawData = await fetchWithCurl(CELESTRAK_URL);

    const lines = rawData.split(/\r?\n/);
    satRecords = [];

    for (let i = 0; i < lines.length - 2; i += 3) {
      const name = lines[i].trim();
      const line1 = lines[i + 1].trim();
      const line2 = lines[i + 2].trim();

      if (line1.startsWith('1 ') && line2.startsWith('2 ')) {
        const satrec = satellite.twoline2satrec(line1, line2);
        satRecords.push({
          name: name,
          noradId: satrec.satnum,
          satrec: satrec
        });
      }
    }

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

      const hexId = `SAT${sat.noradId.toString(16).padStart(5, '0')}`.toUpperCase();

      aircraft.push({
        hex: hexId,
        flight: sat.name.padEnd(8).substring(0, 8),
        lat: Number(lat.toFixed(4)),
        lon: Number(lon.toFixed(4)),
        altitude: altFeet,
        track: 0,
        speed: 14000,
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

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(dump1090Payload));
}

// Run initial fetch and timers
updateTLEs();
setInterval(updateTLEs, 6 * 60 * 60 * 1000); // Refetch CelesTrak every 6 hours
setInterval(propagateGlobalSet, REFRESH_INTERVAL_MS);
