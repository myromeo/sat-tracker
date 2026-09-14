const { exec } = require('child_process');
const satellite = require('satellite.js');
const fs = require('fs');
const express = require('express');

const CELESTRAK_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle';
const OUTPUT_PATH = '/data/aircraft.json';
const REFRESH_INTERVAL_MS = 2000; // Recalculate positions every 2 seconds for smooth map movement

let satRecords = [];

// Use native curl to bypass Cloudflare fingerprinting on Linux/Raspberry Pi
function fetchWithCurl(url) {
  return new Promise((resolve, reject) => {
    const command = `curl -sL -A "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36" "${url}"`;
    exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
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

    // Rate-limit safety check
    if (rawData.includes('GP data has not updated since your last successful download')) {
      console.warn('CelesTrak rate limit reached. Retaining existing satellite cache.');
      return;
    }

    const lines = rawData
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0);

    const newSatRecords = [];

    // TLE pair scanner
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('1 ') && (i + 1 < lines.length) && lines[i + 1].startsWith('2 ')) {
        const line1 = lines[i];
        const line2 = lines[i + 1];
        
        let name = 'SAT';
        if (i > 0 && !lines[i - 1].startsWith('1 ') && !lines[i - 1].startsWith('2 ')) {
          name = lines[i - 1];
        }

        try {
          const satrec = satellite.twoline2satrec(line1, line2);
          if (satrec && satrec.satnum) {
            newSatRecords.push({
              name: name,
              noradId: satrec.satnum,
              satrec: satrec
            });
          }
        } catch (e) {
          // Ignore bad individual records
        }
      }
    }

    if (newSatRecords.length > 0) {
      satRecords = newSatRecords;
      console.log(`Successfully loaded ${satRecords.length} global satellites.`);
    } else {
      console.warn('No valid TLE records parsed. Retaining existing cache.');
    }

  } catch (err) {
    console.error('Error fetching CelesTrak data:', err.message);
  }
}

// Calculate Bearing / Track angle between two geodetic points
function calculateBearing(lat1, lon1, lat2, lon2) {
  const radLat1 = lat1 * Math.PI / 180;
  const radLat2 = lat2 * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const y = Math.sin(dLon) * Math.cos(radLat2);
  const x = Math.cos(radLat1) * Math.sin(radLat2) -
            Math.sin(radLat1) * Math.cos(radLat2) * Math.cos(dLon);

  let brng = Math.atan2(y, x) * 180 / Math.PI;
  return Math.round((brng + 360) % 360);
}

// Calculate orbital parameters and generate dump1090 JSON
function propagateGlobalSet() {
  if (!satRecords.length) return;

  const now = new Date();
  const future = new Date(now.getTime() + 1000); // 1-second lookahead for bearing/climb derivation

  const currentEpoch = Math.floor(now.getTime() / 1000);
  const gmstNow = satellite.gstime(now);
  const gmstFuture = satellite.gstime(future);

  const aircraft = [];

  for (let i = 0; i < satRecords.length; i++) {
    const sat = satRecords[i];
    
    // Propagate current and lookahead positions
    const posVelNow = satellite.propagate(sat.satrec, now);
    const posVelFuture = satellite.propagate(sat.satrec, future);

    if (posVelNow.position && typeof posVelNow.position !== 'boolean' && posVelNow.velocity) {
      const geoNow = satellite.eciToGeodetic(posVelNow.position, gmstNow);
      const geoFuture = satellite.eciToGeodetic(posVelFuture.position, gmstFuture);
      
      const lat = satellite.degreesLat(geoNow.latitude);
      const lon = satellite.degreesLong(geoNow.longitude);
      const altFeet = Math.round(geoNow.height * 3280.84); // Kilometers to feet

      const latFuture = satellite.degreesLat(geoFuture.latitude);
      const lonFuture = satellite.degreesLong(geoFuture.longitude);
      const altFeetFuture = Math.round(geoFuture.height * 3280.84);

      // Derive Ground Speed (Knots) from ECI Velocity Vector (km/s -> knots)
      const vx = posVelNow.velocity.x;
      const vy = posVelNow.velocity.y;
      const vz = posVelNow.velocity.z;
      const speedKmS = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const speedKnots = Math.round(speedKmS * 1943.84);

      // Derive True Heading / Track (0 - 359°)
      const track = calculateBearing(lat, lon, latFuture, lonFuture);

      // Derive Vertical Rate / Climb Rate (ft/min)
      const baroRate = Math.round((altFeetFuture - altFeet) * 60);

      // Strict 6-Character ICAO Hex ID Mapping (Range: A00000 - AFFFFF)
      const hexId = (0xA00000 + (sat.noradId % 0x0FFFFF)).toString(16).toUpperCase().padStart(6, '0');

      aircraft.push({
        hex: hexId,
        flight: sat.name.padEnd(8).substring(0, 8),
        lat: Number(lat.toFixed(4)),
        lon: Number(lon.toFixed(4)),
        altitude: altFeet,
        alt_baro: altFeet,
        alt_geom: altFeet,
        track: track,
        speed: speedKnots,
        gs: speedKnots,
        baro_rate: baroRate,
        category: "A5",        // Large heavy aircraft / Spacecraft category
        type: "SAT",
        seen: 0.1,             // Signal freshness indicator (seconds)
        seen_pos: 0.1,
        messages: 500
      });
    }
  }

  const dump1090Payload = {
    now: currentEpoch,
    messages: aircraft.length,
    aircraft: aircraft
  };

  try {
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(dump1090Payload));
  } catch (err) {
    console.error('Error writing aircraft.json:', err.message);
  }
}

// Initialization and Timers
updateTLEs();
setInterval(updateTLEs, 6 * 60 * 60 * 1000); // Fetch updated TLEs every 6 hours
setInterval(propagateGlobalSet, REFRESH_INTERVAL_MS);

// Express HTTP API Server
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.get('/aircraft.json', (req, res) => {
  if (fs.existsSync(OUTPUT_PATH)) {
    res.sendFile(OUTPUT_PATH);
  } else {
    res.status(503).json({ error: 'Satellite data initializing...' });
  }
});

app.listen(PORT, () => {
  console.log(`Satellite data API active on port ${PORT}`);
});
