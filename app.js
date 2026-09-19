const { exec } = require('child_process');
const satellite = require('satellite.js');
const net = require('net');
const fs = require('fs');
const path = require('path');

// Cache & Refresh Configuration
const CACHE_DIR = process.env.CACHE_DIR || __dirname;
const CACHE_FILE = path.join(CACHE_DIR, 'sat_cache.json');
const DISABLED_FLAG_FILE = path.join(CACHE_DIR, 'NETWORKING_DISABLED.flag');
const REFRESH_HOURS = parseFloat(process.env.TLE_REFRESH_HOURS) || 12;
const CACHE_MAX_AGE_MS = REFRESH_HOURS * 60 * 60 * 1000;

// This is the actual root cause of the original incident, not the null-pointer
// crash itself: an uncaught exception inside a setInterval callback is fatal
// to the whole Node process (this is standard Node behavior, not a bug in
// this file specifically), Docker's `restart: unless-stopped` immediately
// restarted the container, and every restart re-ran updateTLEs() from
// scratch. The null-pointer bug that triggered THIS particular crash is now
// fixed below (posVelNow/posVelFuture are checked before use), but the same
// crash-restart-refetch mechanism would flood CelesTrak again just as
// effectively from ANY other uncaught exception - a satellite-js edge case
// we haven't hit yet, a malformed OMM record, anything. This handler is the
// actual fix for the failure mode, not just the one bug that happened to
// trigger it: it guarantees no future exception can crash the process at
// all, logging it instead and letting the existing setInterval loops
// continue on their normal schedule.
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION - continuing, not crashing]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION - continuing, not crashing]', err);
});

// Flag to permanently disable network fetching if CelesTrak returns non-200 HTTP codes.
// Persisted to disk (not just an in-memory flag) specifically because CelesTrak's
// own usage policy says to "cease all outward network queries immediately...
// investigate human-side" - an in-memory-only flag forgets that instruction on
// every container restart and would silently resume querying a service that
// told this software to stop. It stays disabled until a human deletes the flag
// file after actually investigating, exactly as requested.
let networkingDisabled = fs.existsSync(DISABLED_FLAG_FILE);
if (networkingDisabled) {
  console.error(`[CRITICAL CELESTRAK COMPLIANCE ALERT] ${DISABLED_FLAG_FILE} is present from a previous run - `
    + 'networking stays disabled until a human investigates and deletes this file. '
    + 'Content of that file: ' + (() => { try { return fs.readFileSync(DISABLED_FLAG_FILE, 'utf8'); } catch (e) { return '(unreadable)'; } })());
}

function disableNetworkingPermanently(reason) {
  networkingDisabled = true;
  try {
    fs.writeFileSync(DISABLED_FLAG_FILE, `${new Date().toISOString()}\n${reason}\n`, 'utf8');
  } catch (err) {
    console.error('Failed to write networking-disabled flag file (networking is still disabled in-memory for this run):', err.message);
  }
}

// json2satrec() check
if (typeof satellite.json2satrec !== 'function') {
  console.error(
    'FATAL: satellite.json2satrec is not available in the installed satellite.js package. '
    + 'This feeder requires a version that supports OMM/JSON input; the legacy TLE-only '
    + 'versions do not have this function. Upgrade satellite.js in this image.'
  );
}

const CELESTRAK_GROUPS = (process.env.CELESTRAK_GROUPS || 'weather,gps-ops,stations,visual')
  .split(',')
  .map(g => g.trim());

const REFRESH_INTERVAL_MS = 2000; // SBS broadcast output interval
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
    console.warn(`CELESTRAK_GROUPS: "${group}" is not a recognized CelesTrak group name. `
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
    // Removed -L to ensure 301 Redirects are actively caught per M2M compliance rules.
    // A clean, non-browser-spoofed user agent that identifies this software plainly -
    // claiming to be Mozilla while also being an automated M2M client is a combination
    // abuse-detection systems commonly flag, the opposite of what we want here.
    const command = `curl -s -w "\\n%{http_code}" -A "mlat.uk-SatelliteEngine/1.0 (+https://mlat.uk)" "${url}"`;
    exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
      if (error) return reject(error);

      const lines = stdout.trim().split('\n');
      const httpCode = parseInt(lines.pop(), 10);
      const responseBody = lines.join('\n');

      // curl's %{http_code} reports "000" (parses to 0) when no HTTP response was
      // received at all - DNS failure, connection refused, timeout. That's a local/
      // network problem, not CelesTrak telling us anything, and must NOT trigger the
      // permanent compliance shutdown below - only a genuine HTTP response in their
      // documented problem range (301/403/404/50x, or any other non-200) means that.
      const gotRealHttpResponse = Number.isInteger(httpCode) && httpCode >= 100 && httpCode <= 599;

      if (!gotRealHttpResponse) {
        return reject(new Error(`No HTTP response received (curl reported code "${httpCode}") - treating as a transient network error, not a CelesTrak compliance signal.`));
      }

      if (httpCode !== 200) {
        return reject({
          isHttpError: true,
          status: httpCode,
          message: `CelesTrak returned non-200 HTTP response code: [${httpCode}]. Querying stopped per compliance rules.`
        });
      }

      resolve(responseBody);
    });
  });
}

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
            ommData: omm
          });
        }
      } catch (e) {
        if (!loggedParseErrorForGroup) {
          loggedParseErrorForGroup = true;
          console.error(`Error parsing GP record for group ${group}:`, e.message);
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
        const ageHours = (ageMs / (1000 * 60 * 60)).toFixed(2);
        
        if (ageMs < CACHE_MAX_AGE_MS) {
          console.log(`Cache valid (${ageHours}h old <= ${REFRESH_HOURS}h max). Loaded ${satRecords.length} satellites from disk: ${summary}`);
          return true;
        } else {
          console.log(`Cache expired (${ageHours}h old > ${REFRESH_HOURS}h max). Data restored as fallback, network update needed.`);
          return false;
        }
      }
    }
  } catch (err) {
    console.error('Failed to read or parse local cache file:', err.message);
  }
  return false;
}

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

async function updateTLEs() {
  if (networkingDisabled) {
    console.warn('Network requests disabled due to previous CelesTrak HTTP error. Operating purely from cache.');
    loadFromCache();
    return;
  }

  const isCacheFresh = loadFromCache();
  if (isCacheFresh) {
    console.log(`Skipping CelesTrak fetch: cache is valid and under ${REFRESH_HOURS} hours old.`);
    return;
  }

  console.log(`Cache missing or older than ${REFRESH_HOURS} hours. Requesting updates from CelesTrak...`);
  try {
    const results = [];
    
    // Sequential loop instead of Promise.all ensures we instantly halt on the very first HTTP error
    // and don't simultaneously bombard the server with concurrent requests if it is already failing.
    for (const group of CELESTRAK_GROUPS) {
      if (networkingDisabled) break;
      const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`;
      const data = await fetchWithCurl(url);
      results.push(data);
    }

    if (!networkingDisabled) {
      const success = processOMMData(results);
      if (success) {
        saveToCache();
      } else {
        console.warn('Network response contained no valid satellite records. Reverting to cache fallback.');
        loadFromCache();
      }
    }
  } catch (err) {
    if (err.isHttpError) {
      console.error(`[CRITICAL CELESTRAK COMPLIANCE ALERT] ${err.message}`);
      console.error('Ceasing all outward network queries immediately to avoid IP ban. Please investigate human-side.');
      disableNetworkingPermanently(err.message);
    } else {
      console.error('TLE fetch network error:', err.message);
    }
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
    // Defense in depth alongside the global uncaughtException handler above:
    // this catches a bad satellite record HERE, immediately, and moves on to
    // the next one in the same broadcast cycle - the other ~444 satellites
    // keep updating on schedule instead of the whole cycle being skipped
    // (which the global handler alone would still allow: it stops the
    // process from dying, but a throw partway through this loop would still
    // abandon every satellite after the one that failed, for this cycle).
    try {
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
    } catch (satError) {
      console.error(`Error processing satellite ${sat.name || sat.hexId}, skipping it for this cycle:`, satError.message);
    }
  }
}

// Initial boot check
updateTLEs();

// Dynamic re-check interval based on TLE_REFRESH_HOURS
setInterval(updateTLEs, CACHE_MAX_AGE_MS);

// Broadcast positions every 2 seconds
setInterval(broadcastTCP, REFRESH_INTERVAL_MS);
