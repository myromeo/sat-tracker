const satellite = require('satellite.js');
const net = require('net');

// json2satrec() only exists in satellite.js releases from roughly late 2025
// onward (it was added specifically to support OMM/JSON input alongside
// legacy TLE). If the installed package predates that, this is undefined.
// Exit immediately rather than letting the script run in a broken state.
if (typeof satellite.json2satrec !== 'function') {
  console.error(
    'FATAL: satellite.json2satrec is not available in the installed satellite.js package. '
    + 'This feeder requires a version that supports OMM/JSON input (added ~2025); the '
    + 'legacy TLE-only versions do not have this function. Upgrade the satellite.js '
    + 'dependency in this image and rebuild. Every satellite will silently fail to load '
    + 'until this is fixed.'
  );
  process.exit(1);
}

/*
 * Valid CelesTrak Group Names for CELESTRAK_GROUPS (comma-separated):
 * 
 * SPECIAL INTEREST:  stations, visual, active, analyst, 1999-025, last-30-days
 * WEATHER & EARTH:   weather, noaa, goes, resource, sarsat, disaster, earthobs
 * COMMUNICATIONS:    amateur, intelsat, ses, iridium, iridium-NEXT, orbcomm, globalstar, one-web, starlink
 * NAVIGATION:        gps-ops, glo-ops, galileo, beidou, sbas, navic
 * SCIENTIFIC:        space-weather, geodetic, engineering, education
 * MISCELLANEOUS:     military, radar, cubesat, molniya, x-comm, other-comm
 */
const CELESTRAK_GROUPS = (process.env.CELESTRAK_GROUPS || 'weather,gps-ops,stations,visual')
  .split(',')
  .map(g => g.trim());

// Configurable broadcast interval in seconds via env var (defaults to 2s)
const BROADCAST_INTERVAL_SEC = parseFloat(process.env.BROADCAST_INTERVAL_SEC || '2');
const BROADCAST_INTERVAL_MS = Math.max(100, BROADCAST_INTERVAL_SEC * 1000);

const TCP_PORT = 30003;

// Absolute altitude floor in kilometers
const MIN_PLAUSIBLE_ALT_KM = 100;

// SBS-1 protocol altitude field conversion
const KM_TO_FEET = 3280.84;

// --- Category -> synthetic hex band ------------------------------------
const CATEGORY_BANDS = {
  stations:   0,
  visual:     1,
  military:   2,
  weather:    3,
  navigation: 4,
  comms:      5,
  science:    6,
  other:      7,
  recent:     8,
};

// Maps every documented CelesTrak group name to one of the categories above.
const GROUP_CATEGORY = {
  // SPECIAL INTEREST
  stations: 'stations',
  visual: 'visual',
  active: 'other',
  analyst: 'other',
  '1999-025': 'other',
  'last-30-days': 'recent',
  // WEATHER & EARTH
  weather: 'weather',
  noaa: 'weather',
  goes: 'weather',
  resource: 'weather',
  sarsat: 'weather',
  disaster: 'weather',
  earthobs: 'weather',
  // COMMUNICATIONS
  amateur: 'comms',
  intelsat: 'comms',
  ses: 'comms',
  iridium: 'comms',
  'iridium-NEXT': 'comms',
  orbcomm: 'comms',
  globalstar: 'comms',
  'one-web': 'comms',
  starlink: 'comms',
  // NAVIGATION
  'gps-ops': 'navigation',
  'glo-ops': 'navigation',
  galileo: 'navigation',
  beidou: 'navigation',
  sbas: 'navigation',
  navic: 'navigation',
  // SCIENTIFIC
  'space-weather': 'science',
  geodetic: 'science',
  engineering: 'science',
  education: 'science',
  // MISCELLANEOUS
  military: 'military',
  radar: 'other',
  cubesat: 'other',
  molniya: 'other',
  'x-comm': 'other',
  'other-comm': 'other',
};

function categoryForGroup(group) {
  return GROUP_CATEGORY[group] || 'other';
}

for (const group of CELESTRAK_GROUPS) {
  if (!(group in GROUP_CATEGORY)) {
    console.warn(`CELESTRAK_GROUPS: "${group}" is not a recognized CelesTrak group name - check for a typo. `
      + `Known groups: ${Object.keys(GROUP_CATEGORY).join(', ')}`);
  }
}

// 6-digit NORAD IDs support: uses low 16 bits for suffix and mixes high bits
// into band mapping to avoid hex collisions for IDs > 65535.
function buildHexId(category, noradId) {
  const baseBand = 0xF0 + (CATEGORY_BANDS[category] ?? CATEGORY_BANDS.other);
  const overflow = Math.floor(noradId / 0x10000);
  const band = (baseBand + overflow) & 0xFF;
  const low = noradId % 0x10000;
  return (((band << 16) | low) >>> 0).toString(16).toUpperCase().padStart(6, '0');
}

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
  console.log(`SBS/Basestation TCP Server listening on port ${TCP_PORT} (broadcasting every ${BROADCAST_INTERVAL_SEC}s)`);
});

async function updateTLEs() {
  try {
    const fetchPromises = CELESTRAK_GROUPS.map(async (group) => {
      const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`;
      try {
        const response = await fetch(url, {
          headers: {
            // CelesTrak blocks generic User-Agents. Use a distinct app-identifying header:
            'User-Agent': 'SatelliteSfeeder/1.0 (Node.js/tar1090-integration)',
            'Accept': 'application/json, text/plain, */*'
          }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
      } catch (err) {
        console.error(`Error fetching group ${group}:`, err.message);
        return '';
      }
    });


    const results = await Promise.all(fetchPromises);
    const newSatRecords = [];
    const seenNoradIds = new Set();
    const categoryCounts = {};

    for (let g = 0; g < results.length; g++) {
      const rawData = results[g];
      const group = CELESTRAK_GROUPS[g];
      const category = categoryForGroup(group);

      if (!rawData) continue;

      let ommRecords;
      try {
        ommRecords = JSON.parse(rawData);
      } catch (e) {
        console.error(`Error parsing GP JSON for group ${group}:`, e.message);
        continue;
      }
      if (!Array.isArray(ommRecords)) continue;

      let loggedParseErrorForGroup = false;

      for (const omm of ommRecords) {
        try {
          const satrec = satellite.json2satrec(omm);
          if (satrec && satrec.satnum && !seenNoradIds.has(satrec.satnum)) {
            seenNoradIds.add(satrec.satnum);
            categoryCounts[category] = (categoryCounts[category] || 0) + 1;
            const name = omm.OBJECT_NAME || 'SAT';
            newSatRecords.push({
              name: name.replace(/[^a-zA-Z0-9]/g, "").substring(0, 8),
              noradId: satrec.satnum,
              satrec: satrec,
              category: category,
              hexId: buildHexId(category, satrec.satnum),
            });
          }
        } catch (e) {
          if (!loggedParseErrorForGroup) {
            loggedParseErrorForGroup = true;
            console.error(`Error parsing GP record for group ${group} (object "${omm.OBJECT_NAME}", `
              + `NORAD ${omm.NORAD_CAT_ID}):`, e.message);
          }
        }
      }
    }

    if (newSatRecords.length > 0) {
      satRecords = newSatRecords;
      const summary = Object.entries(categoryCounts).map(([c, n]) => `${c}=${n}`).join(', ');
      console.log(`Loaded ${satRecords.length} unique satellites across groups: ${CELESTRAK_GROUPS.join(', ')} (${summary})`);
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
    if (!posVelNow || !posVelNow.position || !posVelNow.velocity) continue;

    const geoNow = satellite.eciToGeodetic(posVelNow.position, gmstNow);

    // Altitude floor check: Drop anything invalid or below 100km
    if (!Number.isFinite(geoNow.height) || geoNow.height < MIN_PLAUSIBLE_ALT_KM) {
      continue;
    }

    const SAT_ALT_SCALE = 5000;
    const rawAltFt = Math.round(geoNow.height * KM_TO_FEET);
    const altFt = Math.round(rawAltFt / SAT_ALT_SCALE);

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

    if (posVelFuture && posVelFuture.position && posVelFuture.velocity) {
      const geoFuture = satellite.eciToGeodetic(posVelFuture.position, gmstFuture);
      
      if (Number.isFinite(geoFuture.height) && geoFuture.height >= MIN_PLAUSIBLE_ALT_KM) {
        const rawAltFtFuture = Math.round(geoFuture.height * KM_TO_FEET);
        const futLat = satellite.degreesLat(geoFuture.latitude);
        const futLon = satellite.degreesLong(geoFuture.longitude);

        if (Number.isFinite(futLat) && Number.isFinite(futLon)) {
          track = calculateBearing(lat, lon, futLat, futLon);
          let rawVRate = Math.round((rawAltFtFuture - rawAltFt) * 60);

          if (geoNow.height < MIN_PLAUSIBLE_ALT_KM + 50) {
            vRate = 0;
          } else {
            vRate = Math.max(-32640, Math.min(32640, rawVRate));
          }
        }
      }
    }

    const hexId = sat.hexId;

    // Construct SBS-1 Messages
    const msg1 = `MSG,1,1,1,${hexId},1,${dStr},${tStr},${dStr},${tStr},${sat.name},,,,,,,,,,,0\r\n`;
    const msg3 = `MSG,3,1,1,${hexId},1,${dStr},${tStr},${dStr},${tStr},,${altFt},,,${latStr},${lonStr},,,,,,0\r\n`;
    
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
setInterval(broadcastTCP, BROADCAST_INTERVAL_MS);
