const { exec } = require('child_process');
const satellite = require('satellite.js');
const net = require('net');

const CELESTRAK_GROUP = process.env.CELESTRAK_GROUP || 'stations';
const CELESTRAK_URL = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${CELESTRAK_GROUP}&FORMAT=tle`;

const REFRESH_INTERVAL_MS = 2000;
const TCP_PORT = 30003;

// Absolute altitude floor in kilometers
const MIN_PLAUSIBLE_ALT_KM = 100;

const SYNTHETIC_HEX_BASE = 0xF00000;
const SYNTHETIC_HEX_SPAN = 0x0FFFFE;

let satRecords = [];
const clients = new Set();

// Start TCP Server
const server = net.createServer((socket) => {
  console.log(`Ultrafeeder connected from ${socket.remoteAddress}`);
  clients.add(socket);

  socket.on('end', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

server.listen(TCP_PORT, () => {
  console.log(`SBS/Basestation TCP Server listening on port ${TCP_PORT}`);
});

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
              name: name.replace(/[^a-zA-Z0-9]/g, "").substring(0, 8),
              noradId: satrec.satnum,
              satrec: satrec,
              hexId: (SYNTHETIC_HEX_BASE + (satrec.satnum % SYNTHETIC_HEX_SPAN))
                .toString(16).toUpperCase().padStart(6, '0')
            });
          }
        } catch (e) {}
      }
    }
    if (newSatRecords.length > 0) {
      satRecords = newSatRecords;
      console.log(`Loaded ${satRecords.length} satellites.`);
    }
  } catch (err) {
    console.error('TLE fetch error:', err.message);
  }
}

// Fixed Bearing Calculation (Handles IDL Crossing)
function calculateBearing(lat1, lon1, lat2, lon2) {
  const radLat1 = lat1 * Math.PI / 180, radLat2 = lat2 * Math.PI / 180;
  let dLon = (lon2 - lon1) * Math.PI / 180;
  
  if (dLon > Math.PI) dLon -= 2 * Math.PI;
  if (dLon < -Math.PI) dLon += 2 * Math.PI;

  const y = Math.sin(dLon) * Math.cos(radLat2);
  const x = Math.cos(radLat1) * Math.sin(radLat2) - Math.sin(radLat1) * Math.cos(radLat2) * Math.cos(dLon);
  return Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360);
}

function getSBSDateTime(dateObj) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const dStr = `${dateObj.getUTCFullYear()}/${pad(dateObj.getUTCMonth() + 1)}/${pad(dateObj.getUTCDate())}`;
  const tStr = `${pad(dateObj.getUTCHours())}:${pad(dateObj.getUTCMinutes())}:${pad(dateObj.getUTCSeconds())}.${pad(dateObj.getUTCMilliseconds(), 3)}`;
  return { dStr, tStr };
}

function broadcastTCP() {
  if (!satRecords.length || clients.size === 0) return;

  const now = new Date();
  const future = new Date(now.getTime() + 1000);
  const gmstNow = satellite.gstime(now);
  const gmstFuture = satellite.gstime(future);
  const { dStr, tStr } = getSBSDateTime(now);

  for (let sat of satRecords) {
    if (sat.satrec.error !== 0) continue;

    const posVelNow = satellite.propagate(sat.satrec, now);
    if (!posVelNow.position || !posVelNow.velocity) continue;

    const geoNow = satellite.eciToGeodetic(posVelNow.position, gmstNow);

    // Altitude floor check: Drop anything invalid or below 100km
    if (!Number.isFinite(geoNow.height) || geoNow.height < MIN_PLAUSIBLE_ALT_KM) {
      continue;
    }

    // Output raw rounded KM directly
    const altKm = Math.round(geoNow.height);
    if (!Number.isFinite(altKm) || altKm < MIN_PLAUSIBLE_ALT_KM) continue;

    const lat = satellite.degreesLat(geoNow.latitude);
    const lon = satellite.degreesLong(geoNow.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const latStr = lat.toFixed(4);
    const lonStr = lon.toFixed(4);

    const { x, y, z } = posVelNow.velocity;
    const speedKnots = Math.round(Math.sqrt(x * x + y * y + z * z) * 1943.84);

    // Lookahead calculation
    const posVelFuture = satellite.propagate(sat.satrec, future);
    let track = '';
    let vRate = '';

    if (posVelFuture.position && posVelFuture.velocity) {
      const geoFuture = satellite.eciToGeodetic(posVelFuture.position, gmstFuture);
      
      if (Number.isFinite(geoFuture.height) && geoFuture.height >= MIN_PLAUSIBLE_ALT_KM) {
        const altKmFuture = Math.round(geoFuture.height);
        const futLat = satellite.degreesLat(geoFuture.latitude);
        const futLon = satellite.degreesLong(geoFuture.longitude);

        if (Number.isFinite(futLat) && Number.isFinite(futLon)) {
          track = calculateBearing(lat, lon, futLat, futLon);
          // Vertical rate in km/min
          let rawVRate = Math.round((altKmFuture - altKm) * 60);

          // Freeze vRate near floor to prevent dead-reckoning extrapolation
          if (geoNow.height < MIN_PLAUSIBLE_ALT_KM + 50) {
            vRate = 0;
          } else {
            vRate = Math.max(-32640, Math.min(32640, rawVRate));
          }
        }
      }
    }

    const hexId = sat.hexId;

    // Construct SBS-1 Messages (altKm inserted into altitude field)
    const msg1 = `MSG,1,1,1,${hexId},1,${dStr},${tStr},${dStr},${tStr},${sat.name},,,,,,,,,,,0\r\n`;
    const msg3 = `MSG,3,1,1,${hexId},1,${dStr},${tStr},${dStr},${tStr},,${altKm},,,${latStr},${lonStr},,,,,,,0\r\n`;
    
    let msg4 = '';
    if (track !== '' && vRate !== '') {
      msg4 = `MSG,4,1,1,${hexId},1,${dStr},${tStr},${dStr},${tStr},,,${speedKnots},${track},,,${vRate},,,,,0\r\n`;
    }

    const payload = msg1 + msg3 + msg4;

    for (const client of clients) {
      if (client.writable) {
        client.write(payload, (err) => {
          if (err) clients.delete(client);
        });
      } else {
        clients.delete(client);
      }
    }
  }
}

updateTLEs();
setInterval(updateTLEs, 6 * 60 * 60 * 1000);
setInterval(broadcastTCP, REFRESH_INTERVAL_MS);
