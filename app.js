const { exec } = require('child_process');
const satellite = require('satellite.js');
const net = require('net');

const CELESTRAK_GROUP = process.env.CELESTRAK_GROUP || 'stations';
const CELESTRAK_URL = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${CELESTRAK_GROUP}&FORMAT=tle`;

const REFRESH_INTERVAL_MS = 2000;
const TCP_PORT = 30003;

// Anything computed below this is treated as bad propagation (decayed/garbage
// TLE), not a real position. Even the lowest crewed stations orbit at
// several hundred km, so this is a safe floor for the "stations" group.
const MIN_PLAUSIBLE_ALT_KM = 100;

// ICAO Annex 10, Vol III, Appendix to Chapter 9: address blocks whose first
// bits are 1011 / 1101 / 1111 are reserved for future use and are NOT
// allocated to any State. 0xF00000-0xFFFFFE (bit pattern 1111) is therefore
// guaranteed not to collide with a real, currently-assigned aircraft ICAO24
// address. The old 0xA00000 base sat inside the real USA allocation block,
// so synthetic satellite hex codes could (and did) coincide with genuine
// registered aircraft, which is why tar1090 was picking up a real aircraft's
// type/registration for a satellite track.
const SYNTHETIC_HEX_BASE = 0xF00000;
const SYNTHETIC_HEX_SPAN = 0x0FFFFE; // stay clear of the 0xFFFFFF all-call address

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
              // Fixed, non-ICAO-colliding hex derived once per satellite so it
              // stays stable across TLE refreshes.
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

function calculateBearing(lat1, lon1, lat2, lon2) {
  const radLat1 = lat1 * Math.PI / 180, radLat2 = lat2 * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(radLat2);
  const x = Math.cos(radLat1) * Math.sin(radLat2) - Math.sin(radLat1) * Math.cos(radLat2) * Math.cos(dLon);
  return Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360);
}

// Generate Basestation Date/Time format
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
  const gmstNow = satellite.gstime(now), gmstFuture = satellite.gstime(future);
  const { dStr, tStr } = getSBSDateTime(now);

  for (let sat of satRecords) {
    // satellite.js can still hand back a "successful" (non-false) position
    // for TLEs that are long decayed or otherwise numerically broken - this
    // is a known upstream gotcha, not something satrec.error always flags.
    // Skip anything the propagator itself has already flagged.
    if (sat.satrec.error !== 0) continue;

    const posVelNow = satellite.propagate(sat.satrec, now);
    const posVelFuture = satellite.propagate(sat.satrec, future);

    if (!posVelNow.position || !posVelNow.velocity) continue;

    const geoNow = satellite.eciToGeodetic(posVelNow.position, gmstNow);

    // This is the actual fix for the negative-altitude reports: a garbage
    // propagation can produce a "valid-looking" but nonsensical (including
    // negative) height even though position/velocity weren't false. Any
    // object in the "stations" group genuinely sitting below ~100km isn't a
    // real reading, so drop the sample rather than broadcast it.
    if (!Number.isFinite(geoNow.height) || geoNow.height < MIN_PLAUSIBLE_ALT_KM) continue;

    const lat = satellite.degreesLat(geoNow.latitude).toFixed(4);
    const lon = satellite.degreesLong(geoNow.longitude).toFixed(4);
    const altFeet = Math.round(geoNow.height * 3280.84);

    const { x, y, z } = posVelNow.velocity;
    const speedKnots = Math.round(Math.sqrt(x * x + y * y + z * z) * 1943.84);

    // Velocity/track/vertical-rate depend on the future sample too - guard
    // it separately so one bad lookahead point doesn't poison this cycle or
    // throw (posVelFuture.position can legitimately be false here even when
    // posVelNow succeeded).
    let track = '';
    let vRate = '';
    if (posVelFuture.position && posVelFuture.velocity) {
      const geoFuture = satellite.eciToGeodetic(posVelFuture.position, gmstFuture);
      if (Number.isFinite(geoFuture.height) && geoFuture.height >= MIN_PLAUSIBLE_ALT_KM) {
        const altFeetFuture = Math.round(geoFuture.height * 3280.84);
        track = calculateBearing(lat, lon, satellite.degreesLat(geoFuture.latitude), satellite.degreesLong(geoFuture.longitude));
        
        let rawVRate = Math.round((altFeetFuture - altFeet) * 60);
        // Clamp vRate to ADS-B limits to prevent UI extrapolation into the ground
        vRate = Math.max(-32640, Math.min(32640, rawVRate));
      }
    }


    const hexId = sat.hexId;

    // Construct SBS-1 Messages
    // MSG 1: Identification (Callsign)
    const msg1 = `MSG,1,1,1,${hexId},1,${dStr},${tStr},${dStr},${tStr},${sat.name},,,,,,,,,,,0\r\n`;
    // MSG 3: Position & Altitude
    const msg3 = `MSG,3,1,1,${hexId},1,${dStr},${tStr},${dStr},${tStr},,${altFeet},,,${lat},${lon},,,,,,,0\r\n`;
    // MSG 4: Velocity (Speed, Track, Vert Rate)
    const msg4 = `MSG,4,1,1,${hexId},1,${dStr},${tStr},${dStr},${tStr},,,${speedKnots},${track},,,${vRate},,,,,0\r\n`;

    const payload = msg1 + msg3 + msg4;

    for (const client of clients) {
      try {
        client.write(payload);
      } catch (err) {
        clients.delete(client);
      }
    }
  }
}

updateTLEs();
setInterval(updateTLEs, 6 * 60 * 60 * 1000);
setInterval(broadcastTCP, REFRESH_INTERVAL_MS);
