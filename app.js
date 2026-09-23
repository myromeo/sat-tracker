const { exec } = require('child_process');
const satellite = require('satellite.js');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Cache & Refresh Configuration
const CACHE_DIR = process.env.CACHE_DIR || __dirname;
const CACHE_FILE = path.join(CACHE_DIR, 'sat_cache.json');
const DISABLED_FLAG_FILE = path.join(CACHE_DIR, 'NETWORKING_DISABLED.flag');
const REFRESH_HOURS = parseFloat(process.env.TLE_REFRESH_HOURS) || 12;
const CACHE_MAX_AGE_MS = REFRESH_HOURS * 60 * 60 * 1000;

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION - continuing, not crashing]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION - continuing, not crashing]', err);
});

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

const REFRESH_INTERVAL_MS = 2000; // how often satellite positions are recomputed
const MIN_PLAUSIBLE_ALT_KM = 100;
const KM_TO_FEET = 3280.84;

// The port this container's JSON endpoint listens on. Set SATELLITE_HTTP_PORT
// in docker-compose (or the environment) to whatever host port you map it to;
// the frontend's "satellite URL" setting then just points at that port.
const HTTP_PORT_ENV = parseInt(process.env.SATELLITE_HTTP_PORT, 10);
const HTTP_PORT = Number.isFinite(HTTP_PORT_ENV) && HTTP_PORT_ENV >= 0 ? HTTP_PORT_ENV : 8978;

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

let satRecords = [];
// The current JSON response body, pre-serialized once per computeSatellitePositions()
// cycle rather than per HTTP request - many simultaneous browser clients (every
// visitor's own browser, same as the CelesTrak calls elsewhere in this project)
// share one already-done piece of work instead of each triggering fresh SGP4
// propagation for every satellite.
let latestPayload = JSON.stringify({ generated_at: 0, satellites: [] });

function fetchWithCurl(url) {
  return new Promise((resolve, reject) => {
    
    const command = `curl -s -w "\\n%{http_code}" -A "mlat.uk-SatelliteEngine/1.0 (+https://mlat.uk)" "${url}"`;
    exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
      if (error) return reject(error);

      const lines = stdout.trim().split('\n');
      const httpCode = parseInt(lines.pop(), 10);
      const responseBody = lines.join('\n');

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

// CelesTrak's SATCAT uses "" for an empty field (not absent, not null) -
// normalise that to a real null so the JSON this serves is clean to consume.
function emptyToNull(v) {
  return (v === '' || v === undefined) ? null : v;
}

// Merges a SATCAT record (owner, launch, physical/orbital facts - static,
// barely ever changes) with the information-bearing fields of an OMM record
// (epoch, mean motion, eccentricity, drag term - these describe the CURRENT
// element set, not the satellite itself, but are genuinely useful alongside
// it). Deliberately excludes OMM boilerplate fields that are the same for
// every record (REF_FRAME, TIME_SYSTEM, MEAN_ELEMENT_THEORY, CENTER_NAME) -
// those carry no information here. Computed once per satellite when its
// records are loaded (fresh fetch or from cache), not on every position tick.
function buildEnrichment(satcat, ommData) {
  const out = {
    object_id: null, object_type: null, ops_status_code: null, owner: null,
    launch_date: null, launch_site: null, decay_date: null,
    period_min: null, inclination_deg: null, apogee_km: null, perigee_km: null,
    rcs_m2: null, data_status_code: null, orbit_center: null, orbit_type: null,
  };
  if (satcat) {
    out.object_id = emptyToNull(satcat.OBJECT_ID);
    out.object_type = emptyToNull(satcat.OBJECT_TYPE);
    out.ops_status_code = emptyToNull(satcat.OPS_STATUS_CODE);
    out.owner = emptyToNull(satcat.OWNER);
    out.launch_date = emptyToNull(satcat.LAUNCH_DATE);
    out.launch_site = emptyToNull(satcat.LAUNCH_SITE);
    out.decay_date = emptyToNull(satcat.DECAY_DATE);
    out.period_min = (typeof satcat.PERIOD === 'number') ? satcat.PERIOD : null;
    out.inclination_deg = (typeof satcat.INCLINATION === 'number') ? satcat.INCLINATION : null;
    out.apogee_km = (typeof satcat.APOGEE === 'number') ? satcat.APOGEE : null;
    out.perigee_km = (typeof satcat.PERIGEE === 'number') ? satcat.PERIGEE : null;
    out.rcs_m2 = (typeof satcat.RCS === 'number') ? satcat.RCS : null;
    out.data_status_code = emptyToNull(satcat.DATA_STATUS_CODE);
    out.orbit_center = emptyToNull(satcat.ORBIT_CENTER);
    out.orbit_type = emptyToNull(satcat.ORBIT_TYPE);
  }
  out.epoch = (ommData && ommData.EPOCH) || null;
  out.mean_motion_rev_per_day = (ommData && typeof ommData.MEAN_MOTION === 'number') ? ommData.MEAN_MOTION : null;
  out.eccentricity = (ommData && typeof ommData.ECCENTRICITY === 'number') ? ommData.ECCENTRICITY : null;
  out.bstar = (ommData && typeof ommData.BSTAR === 'number') ? ommData.BSTAR : null;
  out.element_set_no = (ommData && typeof ommData.ELEMENT_SET_NO === 'number') ? ommData.ELEMENT_SET_NO : null;
  out.rev_at_epoch = (ommData && typeof ommData.REV_AT_EPOCH === 'number') ? ommData.REV_AT_EPOCH : null;
  return out;
}

function processOMMData(groupResults, satcatGroupResults) {
  // One NORAD ID -> SATCAT record lookup built across every fetched group,
  // so it doesn't matter which specific group a satellite's OMM data came
  // from - a satellite appearing in two groups' SATCAT results just keeps
  // whichever copy was seen first (they should be identical anyway).
  const satcatByNoradId = new Map();
  let satcatParsed = 0;
  for (let g = 0; g < (satcatGroupResults || []).length; g++) {
    const rawData = satcatGroupResults[g];
    if (!rawData) continue;
    let records;
    try {
      records = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    } catch (e) {
      console.error(`Error parsing SATCAT JSON for group ${CELESTRAK_GROUPS[g]}:`, e.message);
      continue;
    }
    if (!Array.isArray(records)) continue;
    satcatParsed += records.length;
    for (const rec of records) {
      if (rec && rec.NORAD_CAT_ID != null && !satcatByNoradId.has(rec.NORAD_CAT_ID)) {
        satcatByNoradId.set(rec.NORAD_CAT_ID, rec);
      }
    }
  }

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
          const satcat = satcatByNoradId.get(satrec.satnum) || null;
          newSatRecords.push({
            // Full name, untruncated - the 8-char alphanumeric-only strip
            // this used to have (name.replace(...).substring(0,8)) existed
            // only to fit inside an SBS MSG,1 callsign field. There's no
            // such constraint on a JSON field: "ISS (ZARYA)" now really
            // does read "ISS (ZARYA)", not "ISSZARYA".
            name: name,
            noradId: satrec.satnum,
            satrec: satrec,
            category: category,
            ommData: omm,
            satcat: satcat,
            enrichment: buildEnrichment(satcat, omm),
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
    const matched = newSatRecords.filter(s => s.satcat).length;
    console.log(`Loaded ${satRecords.length} unique satellites across groups: ${CELESTRAK_GROUPS.join(', ')} (${summary})`);
    console.log(`SATCAT enrichment: ${matched}/${satRecords.length} satellites matched (${satcatParsed} SATCAT records fetched across ${(satcatGroupResults || []).length} groups)`);
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
            ommData: item.ommData,
            satcat: item.satcat || null,
            enrichment: buildEnrichment(item.satcat || null, item.ommData),
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
      ommData: s.ommData,
      satcat: s.satcat
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
    const gpResults = [];
    const satcatResults = [];

    for (const group of CELESTRAK_GROUPS) {
      if (networkingDisabled) break;
      const gpUrl = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`;
      gpResults.push(await fetchWithCurl(gpUrl));

      if (networkingDisabled) break;   // the GP fetch above may have tripped the compliance flag
      // Bulk SATCAT query for the SAME group - one extra request per group,
      // not one per satellite (celestrak.org/satcat/records.php supports
      // GROUP= exactly like the GP endpoint does). This is what supplies
      // owner, launch date/site, object type, RCS, etc. - see buildEnrichment().
      const satcatUrl = `https://celestrak.org/satcat/records.php?GROUP=${group}&FORMAT=JSON`;
      satcatResults.push(await fetchWithCurl(satcatUrl));
    }

    if (!networkingDisabled) {
      const success = processOMMData(gpResults, satcatResults);
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

// Recomputes every satellite's current position/velocity and re-serializes
// latestPayload. Real units throughout - no scaling, no clamping to keep a
// value "plausible" for an ADS-B field that no longer exists. Unit
// conversions that ARE genuinely needed (km -> ft) are done here rather than
// left to the browser, the same as processDrone() in script.js converts m/s
// to knots before handing data to PlaneObject - the JSON this serves is
// meant to be consumed directly, not further translated.
function computeSatellitePositions() {
  if (!satRecords.length) return;

  const now = new Date();
  const future = new Date(now.getTime() + 1000);
  const gmstNow = satellite.gstime(now);
  const gmstFuture = satellite.gstime(future);
  const satellites = [];

  for (const sat of satRecords) {
    try {
      if (sat.satrec.error !== 0) continue;

      const posVelNow = satellite.propagate(sat.satrec, now);
      if (!posVelNow || !posVelNow.position || !posVelNow.velocity) continue;

      const geoNow = satellite.eciToGeodetic(posVelNow.position, gmstNow);
      if (!Number.isFinite(geoNow.height) || geoNow.height < MIN_PLAUSIBLE_ALT_KM) continue;

      const lat = satellite.degreesLat(geoNow.latitude);
      const lon = satellite.degreesLong(geoNow.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const altFt = Math.round(geoNow.height * KM_TO_FEET);

      const { x, y, z } = posVelNow.velocity;
      const speedKnots = Math.round(Math.sqrt(x * x + y * y + z * z) * 1943.84);

      let track = null;
      let vrateFpm = null;

      const posVelFuture = satellite.propagate(sat.satrec, future);
      if (posVelFuture && posVelFuture.position && posVelFuture.velocity) {
        const geoFuture = satellite.eciToGeodetic(posVelFuture.position, gmstFuture);
        if (Number.isFinite(geoFuture.height) && geoFuture.height >= MIN_PLAUSIBLE_ALT_KM) {
          const futLat = satellite.degreesLat(geoFuture.latitude);
          const futLon = satellite.degreesLong(geoFuture.longitude);
          if (Number.isFinite(futLat) && Number.isFinite(futLon)) {
            track = calculateBearing(lat, lon, futLat, futLon);
            const altFtFuture = Math.round(geoFuture.height * KM_TO_FEET);
            // No clamp to +/-32640 and no "force to 0 near the ground" rule
            // any more - those existed only to keep the SBS vertical-rate
            // field within a range readsb would accept for an aircraft.
            // There's no such field now; this is just the true value.
            vrateFpm = (altFtFuture - altFt) * 60;
          }
        }
      }

      satellites.push({
        noradId: sat.noradId,
        name: sat.name,
        category: sat.category,
        lat: Number(lat.toFixed(4)),
        lon: Number(lon.toFixed(4)),
        alt_ft: altFt,
        speed_kn: speedKnots,
        track: track,
        vrate_fpm: vrateFpm,
        // owner, launch date/site, object type, RCS, orbital elements, etc -
        // precomputed once per satellite in buildEnrichment() when its
        // records were loaded (fresh fetch or cache), not recomputed on
        // every 2-second tick since none of it changes that often.
        ...sat.enrichment,
      });
    } catch (satError) {
      console.error(`Error processing satellite ${sat.name || sat.noradId}, skipping it for this cycle:`, satError.message);
    }
  }

  latestPayload = JSON.stringify({ generated_at: now.getTime() / 1000, satellites: satellites });
}

// A small, read-only JSON endpoint - the frontend's "satellite URL" setting
// points straight at this (e.g. http://your-host:SATELLITE_HTTP_PORT/), the
// same way droneJson/aiscatcher_server are just a URL the browser polls
// directly. Access-Control-Allow-Origin is required (not optional) here:
// this is served on its own port, so from the browser's point of view it is
// always a cross-origin request even when it's the same physical host - see
// the earlier CORS investigation into adsb.lol/adsb.im in this project for
// exactly what happens without it.
const httpServer = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }
  const url = req.url.split('?')[0];
  if (url !== '/' && url !== '/satellites.json') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(latestPayload);
});

// Explicit 0.0.0.0 bind - deliberately NOT relying on Node's "no host given"
// default. That default should mean "all interfaces", but in some minimal
// container images/network configs it resolves to the IPv6 wildcard (::)
// only, which can silently fail to accept IPv4 connections depending on the
// container's network stack - exactly the symptom of "docker-compose port
// mapping looks right, container isn't crashing, nothing ever answers".
// A dedicated 'error' listener matters here too: without one, a failed
// listen() throws as an EventEmitter 'error' with no handler, which becomes
// an uncaught exception - and this file's global uncaughtException handler
// (see the top of the file) would swallow that into one generic logged
// line, making a completely dead HTTP server look identical to a healthy,
// quiet one in the logs. This handler makes that failure loud and specific
// instead.
httpServer.on('error', (err) => {
  console.error(`[SATELLITE HTTP SERVER FAILED TO START] Could not listen on 0.0.0.0:${HTTP_PORT}: ${err.code || err.message}. `
    + `The satellite JSON endpoint is NOT available - nothing else in this process depends on it, so TLE fetching/caching continues normally, `
    + `but no browser will ever get satellite data from this container until this is fixed. `
    + (err.code === 'EADDRINUSE' ? 'Something else is already using this port inside the container.' : 'Check SATELLITE_HTTP_PORT and the container network configuration.'));
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`Satellite JSON endpoint listening on 0.0.0.0:${HTTP_PORT} (GET / or /satellites.json)`);
});

// Initial boot check
const STARTUP_RETRY_MS = 5 * 60 * 1000; // 5 minutes - short enough to recover quickly from a boot-time race, nowhere near frequent enough to trouble CelesTrak even if it took several attempts

async function checkStartupSuccess() {
  if (networkingDisabled) {
    return; // hard stop, by design - no retry, human intervention required
  }
  if (satRecords.length > 0) {
    console.log('Initial satellite load succeeded - startup retry loop no longer needed.');
    return; // success - the 12-hour setInterval takes over from here, this never fires again
  }
  console.warn(`Initial satellite load has not yet succeeded - retrying in ${STARTUP_RETRY_MS / 60000} minutes.`);
  setTimeout(async () => {
    await updateTLEs();
    checkStartupSuccess();
  }, STARTUP_RETRY_MS);
}
(async () => {
  await updateTLEs();
  computeSatellitePositions();   // don't leave the endpoint serving an empty list until the first tick
  checkStartupSuccess();
})();

// Dynamic re-check interval based on TLE_REFRESH_HOURS
setInterval(updateTLEs, CACHE_MAX_AGE_MS);

// Recompute positions every 2 seconds
setInterval(computeSatellitePositions, REFRESH_INTERVAL_MS);
