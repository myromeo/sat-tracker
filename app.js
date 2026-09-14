const { exec } = require('child_process');
const satellite = require('satellite.js');
const fs = require('fs');
const express = require('express');

const CELESTRAK_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle';
const OUTPUT_PATH = '/data/aircraft.json';
const TEMP_OUTPUT_PATH = '/data/aircraft.json.tmp';
const REFRESH_INTERVAL_MS = 2000;

let satRecords = [];
let globalMessages = 0;

function fetchWithCurl(url) {
  return new Promise((resolve, reject) => {
    const command = `curl -sL -A "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36" "${url}"`;
    exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout);
    });
  });
}

async function updateTLEs() {
  try {
    const rawData = await fetchWithCurl(CELESTRAK_URL);
    if (rawData.includes('GP data has not updated')) return;

    const lines = rawData.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
    const newSatRecords = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('1 ') && lines[i + 1]?.startsWith('2 ')) {
        const name = (i > 0 && !lines[i - 1].startsWith('1 ')) ? lines[i - 1] : 'SAT';
        try {
          const satrec = satellite.twoline2satrec(lines[i], lines[i + 1]);
          if (satrec && satrec.satnum) {
            newSatRecords.push({
              name: name.replace(/[^a-zA-Z0-9 ]/g, "").substring(0, 8).trim(),
              noradId: satrec.satnum,
              satrec: satrec,
              messages: Math.floor(Math.random() * 100) // Initialize with a realistic baseline
            });
          }
        } catch (e) {}
      }
    }
    if (newSatRecords.length > 0) satRecords = newSatRecords;
  } catch (err) {
    console.error('TLE fetch error:', err.message);
  }
}

function calculateBearing(lat1, lon1, lat2, lon2) {
  const radLat1 = lat1 * Math.PI / 180, radLat2 = lat2 * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(radLat2);
  const x = Math.cos(radLat1) * Math.sin(radLat2) - Math.sin(radLat1) * Math.cos(radLat2) * Math.cos(dLon);
  return Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360);
}

function propagateGlobalSet() {
  if (!satRecords.length) return;

  const now = new Date();
  const future = new Date(now.getTime() + 1000);
  const nowUnix = now.getTime() / 1000;
  const gmstNow = satellite.gstime(now), gmstFuture = satellite.gstime(future);
  const aircraft = [];

  for (let sat of satRecords) {
    const posVelNow = satellite.propagate(sat.satrec, now);
    const posVelFuture = satellite.propagate(sat.satrec, future);

    if (posVelNow.position && posVelNow.velocity) {
      const geoNow = satellite.eciToGeodetic(posVelNow.position, gmstNow);
      const geoFuture = satellite.eciToGeodetic(posVelFuture.position, gmstFuture);
      
      const lat = satellite.degreesLat(geoNow.latitude);
      const lon = satellite.degreesLong(geoNow.longitude);
      const altFeet = Math.round(geoNow.height * 3280.84);
      const altFeetFuture = Math.round(geoFuture.height * 3280.84);

      const { x, y, z } = posVelNow.velocity;
      const speedKnots = Math.round(Math.sqrt(x*x + y*y + z*z) * 1943.84);
      const track = calculateBearing(lat, lon, satellite.degreesLat(geoFuture.latitude), satellite.degreesLong(geoFuture.longitude));
      const baroRate = Math.round((altFeetFuture - altFeet) * 60);
      const hexId = (0xA00000 + (sat.noradId % 0x0FFFFF)).toString(16).toUpperCase().padStart(6, '0');

      sat.messages += 1;
      globalMessages += 1;

      aircraft.push({
        hex: hexId,
        type: "adsb_icao",
        flight: sat.name,
        desc: "SATELLITE",
        r: "SAT",
        t: "SAT",
        lat: Number(lat.toFixed(4)),
        lon: Number(lon.toFixed(4)),
        altitude: altFeet,
        alt_baro: altFeet,
        alt_geom: altFeet,
        track: track,
        mag_heading: track,
        true_heading: track,
        speed: speedKnots,
        gs: speedKnots,
        baro_rate: baroRate,
        geom_rate: baroRate,
        category: "A5",
        seen: 0,
        seen_pos: 0,
        messages: sat.messages,
        nic: 8,          // Required to bypass tar1090 data-quality filters
        rc: 186,
        nac_p: 8,
        nac_v: 1,
        sil: 3,
        sil_type: "perhour",
        sda: 2
      });
    }
  }

  try {
    fs.writeFileSync(TEMP_OUTPUT_PATH, JSON.stringify({ now: nowUnix, messages: globalMessages, aircraft: aircraft }));
    fs.renameSync(TEMP_OUTPUT_PATH, OUTPUT_PATH);
  } catch (err) {
    console.error('File write error:', err.message);
  }
}

updateTLEs();
setInterval(updateTLEs, 6 * 60 * 60 * 1000);
setInterval(propagateGlobalSet, REFRESH_INTERVAL_MS);

const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});
app.get('/aircraft.json', (req, res) => fs.existsSync(OUTPUT_PATH) ? res.sendFile(OUTPUT_PATH) : res.status(503).json({ error: 'Initializing...' }));
app.listen(process.env.PORT || 3000, () => console.log(`API active`));
