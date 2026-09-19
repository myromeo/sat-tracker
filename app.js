const { exec } = require('child_process');
const satellite = require('satellite.js');
const net = require('net');
const fs = require('fs');
const path = require('path');

// Cache configuration
const CACHE_FILE = path.join(__dirname, 'sat_cache.json');
const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

// json2satrec() check
if (typeof satellite.json2satrec !== 'function') {
  console.error(
    'FATAL: satellite.json2satrec is not available in the installed satellite.js package. '
    + 'This feeder requires a version that supports OMM/JSON input (added ~2025); the '
    + 'legacy TLE-only versions do not have this function. Upgrade the satellite.js '
    + 'dependency in this image and rebuild. Every satellite will silently fail to load '
    + 'until this is fixed.'
  );
}

const CELESTRAK_GROUPS = (process.env.CELESTRAK_GROUPS || 'weather,gps-ops,stations,visual')
  .split(',')
  .map(g => g.trim());

const REFRESH_INTERVAL_MS = 2000;
const TCP_PORT = 30003;
const MIN_PLAUSIBLE_ALT_KM = 100;
const KM_TO_FEET = 3280.84;

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

const GROUP_CATEGORY = {
  stations: 'stations',
  visual: 'visual',
  active: 'other',
  analyst: 'other',
  '1999-025': 'other',
  'last-30-days': 'recent',
  weather: 'weather',
  noaa: 'weather',
  goes: 'weather',
  resource: 'weather',
  sarsat: 'weather',
  disaster: 'weather',
  earthobs: 'weather',
  amateur: 'comms',
  intelsat: 'comms',
  ses: 'comms',
  iridium: 'comms',
  'iridium-NEXT': 'comms',
  orbcomm: 'comms',
  globalstar: 'comms',
  'one-web': 'comms',
  starlink: 'comms',
  'gps-ops': 'navigation',
  'glo-ops': 'navigation',
  galileo: 'navigation',
  beidou: 'navigation',
  sbas: 'navigation',
  navic: 'navigation',
  'space-weather': 'science',
  geodetic: 'science',
  engineering: 'science',
  education: 'science',
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

const CATEGORY_SPAN = 0x10000;

function buildHexId(category, noradId) {
  const band = (0xF0 + (CATEGORY_BANDS[category] ?? CATEGORY_BANDS.other));
  const low = noradId % CATEGORY_SPAN;
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

// Process raw group JSON results into active satRecords
function processOMMData(groupResults) {
  const newSatRecords = [];
  const seenNoradIds = new Set();
  const categoryCounts = {};

  for (let g = 0; g < groupResults.length; g++) {
    const rawData = groupResults[g];
    const group = CELESTRAK_GROUPS[g];
    const category = categoryForGroup(group);

    if (!rawData) continue;

    let ommRecords;
    try {
      ommRecords = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
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
            ommData: omm // Preserved for disk cache writes
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
    return true;
  }
  return false;
}

// Loads local cache file if available
function loadFromCache() {
  if (!fs.existsSync(CACHE_FILE)) return false;

  try {
    const stats = fs.statSync(CACHE_FILE);
    const ageMs = Date.now() - stats.mtimeMs;
    const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));

    if (Array.isArray(cacheData) && cacheData.length > 0) {
      const newSatRecords = [];
      const seenNoradIds = new Set();
      const categoryCounts = {};

      for (const item of cacheData) {
        if (!item.ommData) continue;
        const satrec = satellite.json2satrec(item.ommData);
        if (satrec && satrec.satnum && !seenNoradIds.has(satrec.satnum)) {
          seenNoradIds.add(satrec.satnum);
          categoryCounts[item.category] = (categoryCounts[item.category] || 0) + 1;
          newSatRecords.push({
            name: item.name,
            noradId: item.noradId,
            satrec: satrec,
            category: item.category,
            hexId: item.hexId,
            ommData: item.ommData
          });
        }
      }

      if (newSatRecords.length > 0) {
        satRecords = newSatRecords;
        const summary = Object.entries(categoryCounts).map(([c, n]) => `${c}=${n}`).join(', ');
        const ageHours = (ageMs / (1000 * 60 * 60)).toFixed(1);
        console.log(`Loaded ${satRecords.length} satellites from local disk cache (${ageHours}h old): ${summary}`);
        return ageMs < CACHE_MAX_AGE_MS;
      }
    }
  } catch (err) {
    console.error('Failed to read or parse local cache file:', err.message);
  }
  return false;
}

// Writes current satellite pool to disk
function saveToCache() {
  try {
    const cachePayload = satRecords.map(s => ({
      name: s.name,
      noradId: s.noradId,
      category: s.category,
      hexId: s.hexId,
      ommData: s.ommData
    }));
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cachePayload), 'utf8');
    console.log(`Saved ${satRecords.length} satellite records to local cache (${CACHE_FILE})`);
  } catch (err) {
    console.error('Failed to write local cache file:', err.message);
  }
}

async function updateTLEs(force = false) {
  // Try disk cache first unless explicitly forcing a network update
  if (!force) {
    const isFresh = loadFromCache();
    if (isFresh) {
      console.log('Cache is under 12 hours old. Skipping network request to CelesTrak.');
      return;
    }
  }

  console.log('Fetching fresh satellite data from CelesTrak via curl...');
  try {
    const fetchPromises = CELESTRAK_GROUPS.map(group => {
      const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`;
      return fetchWithCurl(url).catch(err => {
        console.error(`Error fetching group ${group}:`, err.message);
        return '';
      });
    });

    const results = await Promise.all(fetchPromises);
    const success = processOMMData(results);

    if (success) {
      saveToCache();
    } else {
      console.warn('Network fetch returned no valid data. Falling back to local disk cache...');
      loadFromCache();
    }
  } catch (err) {
    console.error('TLE fetch error:', err.message);
    loadFromCache();
  }
}

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

// Initial boot check (checks cache first)
updateTLEs();

// Re-check CelesTrak every 12 hours (forces network update)
setInterval(() => updateTLEs(true), 12 * 60 * 60 * 1000);
setInterval(broadcastTCP, REFRESH_INTERVAL_MS);
