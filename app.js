const { exec } = require('child_process');
const satellite = require('satellite.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// Cache & Refresh Configuration
const CACHE_DIR = process.env.CACHE_DIR || __dirname;
const CACHE_FILE = path.join(CACHE_DIR, 'sat_cache.json');
// Bump this whenever the SHAPE of what's cached changes meaningfully (a new
// field added to what each record carries, a renamed field, etc) - not for
// every code change. loadFromCache() rejects any cache file whose version
// doesn't match, regardless of age, so a stale-but-recent cache from before
// a feature existed can never silently mask that feature after a deploy.
// This is exactly what happened once already: the SATCAT enrichment fields
// (owner, launch date, object type, ...) were added, but a cache file
// written by the OLD code - sitting on a persistent volume that survives
// redeploys - was still under REFRESH_HOURS old, so it kept getting reused
// with no enrichment data at all until it happened to age out naturally.
const CACHE_SCHEMA_VERSION = 2;
const DISABLED_FLAG_FILE = path.join(CACHE_DIR, 'NETWORKING_DISABLED.flag');
const REFRESH_HOURS = parseFloat(process.env.TLE_REFRESH_HOURS) || 12;
const CACHE_MAX_AGE_MS = REFRESH_HOURS * 60 * 60 * 1000;

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION - continuing, not crashing]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION - continuing, not crashing]', err);
});

// CelesTrak compliance hold. Any non-200 HTTP response from CelesTrak stops
// ALL outbound requests for NETWORK_HOLD_HOURS (default 24), then exactly one
// fresh attempt is made: success clears the hold, another HTTP error starts a
// new hold. So a CelesTrak outage (e.g. a 500) costs at most one request per
// day, and the feeder recovers on its own instead of serving ever-older
// elements until someone notices. The flag file persists the hold across
// restarts, so restarting the container can never shortcut it.
// Deleting the flag file by hand still lifts the hold at the next restart.
const NETWORK_HOLD_MS = (parseFloat(process.env.NETWORK_HOLD_HOURS) || 24) * 60 * 60 * 1000;
let holdStartedAt = 0;          // ms; 0 = no hold on record
let holdResumeTimer = null;

function readHoldStart() {
  if (!fs.existsSync(DISABLED_FLAG_FILE)) return 0;
  try {
    const first = fs.readFileSync(DISABLED_FLAG_FILE, 'utf8').split('\n')[0].trim();
    const t = Date.parse(first);
    if (Number.isFinite(t)) return t;
    return fs.statSync(DISABLED_FLAG_FILE).mtimeMs;   // older/odd flag file: fall back to its age
  } catch (e) {
    return Date.now();                                  // unreadable: be conservative, start a full hold now
  }
}

function holdUntil() { return holdStartedAt ? holdStartedAt + NETWORK_HOLD_MS : 0; }
function networkHoldActive() { return holdStartedAt > 0 && Date.now() < holdUntil(); }

// Run an update as soon as the hold ends, rather than waiting for the next
// regular refresh interval.
function scheduleHoldResume() {
  if (holdResumeTimer) clearTimeout(holdResumeTimer);
  const wait = holdUntil() - Date.now();
  if (wait <= 0) return;
  holdResumeTimer = setTimeout(() => {
    holdResumeTimer = null;
    console.log('CelesTrak hold period over - making one fresh attempt.');
    updateTLEs();
  }, wait + 5000);
}

function startNetworkHold(reason) {
  holdStartedAt = Date.now();
  try {
    fs.writeFileSync(DISABLED_FLAG_FILE,
      `${new Date(holdStartedAt).toISOString()}\n${reason}\nHold until ${new Date(holdUntil()).toISOString()}, then one retry.\n`, 'utf8');
  } catch (err) {
    console.error('Failed to write the hold flag file (the hold still applies in memory for this run):', err.message);
  }
  console.error(`[CELESTRAK COMPLIANCE HOLD] ${reason} All CelesTrak requests paused until ${new Date(holdUntil()).toISOString()}; serving cached data meanwhile.`);
  scheduleHoldResume();
}

function clearNetworkHold() {
  if (!holdStartedAt && !fs.existsSync(DISABLED_FLAG_FILE)) return;
  holdStartedAt = 0;
  try { fs.unlinkSync(DISABLED_FLAG_FILE); } catch (e) { /* already gone */ }
  console.log('CelesTrak fetch succeeded after a hold - hold cleared, normal refresh schedule resumed.');
}

holdStartedAt = readHoldStart();
if (holdStartedAt) {
  if (networkHoldActive()) {
    console.warn(`[CELESTRAK COMPLIANCE HOLD] Hold from a previous run (started ${new Date(holdStartedAt).toISOString()}) - `
      + `no CelesTrak requests until ${new Date(holdUntil()).toISOString()}; serving cached data meanwhile.`);
    scheduleHoldResume();
  } else {
    console.log(`Previous CelesTrak hold (started ${new Date(holdStartedAt).toISOString()}) has expired - one fresh attempt will be made.`);
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
let latestPayload = JSON.stringify({ generated_at: 0, details_version: null, satellites: [] });
// The positions themselves (not yet serialised), kept only so the legacy
// "?full=1" form of the positions endpoint can merge the details back in.
let latestSatellites = [];

// Catalogue details (owner, launch, object type, RCS, orbital elements, ...)
// are served separately from positions: they only change when satRecords is
// reloaded (TLE refresh / cache load), so sending them in every 2-second
// positions payload just multiplied the download size. detailsVersion is a
// short content hash of the details payload - it goes out with every
// positions payload, so the browser re-fetches details only when it changes,
// and an identical reload (e.g. a container restart) keeps the same version,
// so browsers / Cloudflare keep using their cached copy.
let detailsVersion = null;
let lastComputedAt = 0;   // see ensureFreshPositions()
let latestDetailsPayload = JSON.stringify({ version: null, satellites: {} });

function rebuildDetailsPayload() {
  const byId = {};
  for (const s of satRecords) byId[s.noradId] = s.enrichment;
  const body = JSON.stringify(byId);
  detailsVersion = crypto.createHash('sha1').update(body).digest('hex').slice(0, 12);
  latestDetailsPayload = '{"version":' + JSON.stringify(detailsVersion) + ',"satellites":' + body + '}';
  console.log(`Satellite details payload rebuilt: ${satRecords.length} satellites, version ${detailsVersion}, ${latestDetailsPayload.length} bytes`);
}

// Single place satRecords is replaced, so the details payload always matches it.
function setSatRecords(records) {
  satRecords = records;
  rebuildDetailsPayload();
  lastComputedAt = 0;   // new elements: the next request recomputes positions straight away
}

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
          message: `CelesTrak returned HTTP ${httpCode} for ${url.replace(/^https:\/\/celestrak\.org/, '')}.`
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
// Earth gravitational parameter and equatorial radius (WGS-72, as SGP4 uses).
const MU_KM3_S2 = 398600.8;
const EARTH_RADIUS_KM = 6378.135;

// Apogee / perigee / period / inclination from an OMM element set. Mean
// elements, so good to a few km - plenty for a summary line.
function orbitShapeFromOmm(omm) {
  if (!omm) return null;
  const mm = omm.MEAN_MOTION, e = omm.ECCENTRICITY, inc = omm.INCLINATION;
  if (typeof mm !== 'number' || !(mm > 0) || typeof e !== 'number' || e < 0 || e >= 1) return null;
  const n = mm * 2 * Math.PI / 86400;                 // rad/s
  const a = Math.cbrt(MU_KM3_S2 / (n * n));           // semi-major axis, km
  return {
    period_min: Math.round(14400 / mm) / 10,          // 1440 / mm, to 0.1 min
    inclination_deg: (typeof inc === 'number') ? Math.round(inc * 100) / 100 : null,
    apogee_km: Math.round(a * (1 + e) - EARTH_RADIUS_KM),
    perigee_km: Math.round(a * (1 - e) - EARTH_RADIUS_KM),
    eccentricity: e,
  };
}

// Orbit class from the whole orbit, not the current altitude, so an
// elliptical orbit (Molniya, GTO) keeps one label all the way round.
//   LEO  apogee < 2,000 km
//   GEO  ~1 sidereal day period, near-circular, inclination < 3 deg (geostationary)
//   GSO  ~1 sidereal day period, near-circular, inclined (geosynchronous)
//   HEO  highly elliptical (e >= 0.25)
//   MEO  between LEO and GEO
//   HIGH near-circular above GEO
function classifyOrbit(apogeeKm, perigeeKm, periodMin, inclinationDeg, eccentricity) {
  if (typeof apogeeKm !== 'number' || typeof perigeeKm !== 'number') return null;
  const e = (typeof eccentricity === 'number') ? eccentricity
    : (apogeeKm - perigeeKm) / (apogeeKm + perigeeKm + 2 * EARTH_RADIUS_KM);
  if (apogeeKm < 2000) return 'LEO';
  if (e >= 0.25) return 'HEO';
  if (typeof periodMin === 'number' && periodMin > 1400 && periodMin < 1480 && e < 0.05) {
    return (typeof inclinationDeg === 'number' && inclinationDeg < 3) ? 'GEO' : 'GSO';
  }
  if (perigeeKm > 36500) return 'HIGH';
  return 'MEO';
}

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
  // Orbit shape from the CURRENT element set where there is one: SATCAT's
  // APOGEE/PERIGEE/PERIOD/INCLINATION are only updated occasionally and can
  // be months out of date, while the OMM elements are what the map is
  // actually propagating. SATCAT values stay as the fallback.
  const shape = orbitShapeFromOmm(ommData);
  if (shape) {
    out.period_min = shape.period_min;
    out.inclination_deg = shape.inclination_deg;
    out.apogee_km = shape.apogee_km;
    out.perigee_km = shape.perigee_km;
  }
  out.orbit_class = classifyOrbit(out.apogee_km, out.perigee_km, out.period_min, out.inclination_deg,
    shape ? shape.eccentricity : null);
  // SATCAT ORBIT_TYPE "DOC" = docked to another catalogued object (e.g. a
  // crew or cargo vehicle at the ISS) - explains co-located icons on the map.
  out.docked = out.orbit_type === 'DOC';
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
      // Keyed as a STRING deliberately - satellite.js's json2satrec() stores
      // satrec.satnum in whatever form it uses internally for SGP4 (a TLE-
      // format heritage that doesn't guarantee a plain JS number), while
      // CelesTrak's SATCAT JSON gives NORAD_CAT_ID as a genuine number. A Map
      // keyed by the raw, un-normalised value from either side would silently
      // never match the other - not a partial mismatch, a total one, since
      // "25544" !== 25544 as Map keys even though they mean the same satellite.
      if (rec && rec.NORAD_CAT_ID != null) {
        const key = String(rec.NORAD_CAT_ID);
        if (!satcatByNoradId.has(key)) satcatByNoradId.set(key, rec);
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
          const satcat = satcatByNoradId.get(String(satrec.satnum)) || null;
          newSatRecords.push({
            // Full name, untruncated - the 8-char alphanumeric-only strip
            // this used to have (name.replace(...).substring(0,8)) existed
            // only to fit inside an SBS MSG,1 callsign field. There's no
            // such constraint on a JSON field: "ISS (ZARYA)" now really
            // does read "ISS (ZARYA)", not "ISSZARYA".
            name: name,
            // Number(), not satrec.satnum directly - satellite.js's internal
            // representation isn't guaranteed to be a plain JS number (see
            // the comment on satcatByNoradId above), but the JSON this app
            // serves documents noradId as a number, and the frontend keys
            // off it as one (e.g. 'SAT' + noradId) - keep that contract
            // exact regardless of what the parsing library does internally.
            noradId: Number(satrec.satnum),
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
    setSatRecords(newSatRecords);
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
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));

    // Reject anything that isn't exactly the current schema, BEFORE looking
    // at age at all - this includes the old bare-array format (no
    // schemaVersion field), which is what every cache file written before
    // this versioning existed looks like. A wrong/missing version is
    // treated as "no usable cache", not "stale cache" - same effect
    // (loadFromCache returns false, forcing a real fetch), but for a
    // different reason worth its own log line.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schemaVersion !== CACHE_SCHEMA_VERSION) {
      console.log(`Cache file is missing or an outdated schema version (expected v${CACHE_SCHEMA_VERSION}) - ignoring it and fetching fresh data.`);
      return false;
    }

    const cacheData = parsed.satellites;

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
            noradId: Number(item.noradId),
            satrec: satrec,
            category: item.category,
            ommData: item.ommData,
            satcat: item.satcat || null,
            enrichment: buildEnrichment(item.satcat || null, item.ommData),
          });
        }
      }

      if (newSatRecords.length > 0) {
        setSatRecords(newSatRecords);
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
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, satellites: cachePayload }), 'utf8');
    console.log(`Saved ${satRecords.length} satellite records to local cache (${CACHE_FILE}, schema v${CACHE_SCHEMA_VERSION})`);
  } catch (err) {
    console.error('Failed to write local cache file:', err.message);
  }
}

let updateInProgress = false;

async function updateTLEs() {
  // single-flight: the hold-resume timer, the regular interval and the
  // startup retry can otherwise overlap
  if (updateInProgress) return;
  updateInProgress = true;
  try {
    await updateTLEsInner();
  } finally {
    updateInProgress = false;
  }
}

async function updateTLEsInner() {
  if (networkHoldActive()) {
    console.warn(`CelesTrak requests on hold until ${new Date(holdUntil()).toISOString()} after an HTTP error. Serving cached data.`);
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
      if (networkHoldActive()) break;
      const gpUrl = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`;
      gpResults.push(await fetchWithCurl(gpUrl));

      if (networkHoldActive()) break;   // the GP fetch above may have started a hold
      // Bulk SATCAT query for the SAME group - one extra request per group,
      // not one per satellite (celestrak.org/satcat/records.php supports
      // GROUP= exactly like the GP endpoint does). This is what supplies
      // owner, launch date/site, object type, RCS, etc. - see buildEnrichment().
      const satcatUrl = `https://celestrak.org/satcat/records.php?GROUP=${group}&FORMAT=JSON`;
      satcatResults.push(await fetchWithCurl(satcatUrl));
    }

    if (!networkHoldActive()) {
      const success = processOMMData(gpResults, satcatResults);
      if (success) {
        saveToCache();
        clearNetworkHold();
      } else {
        console.warn('Network response contained no valid satellite records. Reverting to cache fallback.');
        loadFromCache();
      }
    }
  } catch (err) {
    if (err.isHttpError) {
      startNetworkHold(err.message);
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
// Positions are computed on demand: at most once per REFRESH_INTERVAL_MS, and
// only when someone actually requests them. With nobody viewing the map the
// feeder does no SGP4 work at all; with many viewers they all share one
// computation per interval, exactly as before.
function ensureFreshPositions() {
  if (Date.now() - lastComputedAt >= REFRESH_INTERVAL_MS) computeSatellitePositions();
}

function computeSatellitePositions() {
  if (!satRecords.length) return;
  lastComputedAt = Date.now();

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
        // Catalogue details (owner, launch, object type, RCS, orbital
        // elements) are NOT repeated here any more - they're served once from
        // /satellite-details, versioned by details_version below.
      });
    } catch (satError) {
      console.error(`Error processing satellite ${sat.name || sat.noradId}, skipping it for this cycle:`, satError.message);
    }
  }

  latestSatellites = satellites;
  latestPayload = JSON.stringify({ generated_at: now.getTime() / 1000, details_version: detailsVersion, satellites: satellites });
}

// A small, read-only JSON endpoint - the frontend's "satellite URL" setting
// points straight at this (e.g. http://your-host:SATELLITE_HTTP_PORT/), the
// same way droneJson/aiscatcher_server are just a URL the browser polls
// directly. Access-Control-Allow-Origin is required (not optional) here:
// this is served on its own port, so from the browser's point of view it is
// always a cross-origin request even when it's the same physical host - see
// the earlier CORS investigation into adsb.lol/adsb.im in this project for
// exactly what happens without it.
// A satellite's track is fully determined by its own orbital elements - no
// polling or storage needed at all, unlike vessels/aircraft, whose past
// positions are inherently unpredictable and have to be recorded as they
// happen. This just re-runs the same SGP4 propagation computeSatellitePositions()
// already does for "now", stepping backward in time instead. Computed fresh
// per request (cheap - a few hundred propagate() calls at most), not on a
// timer: track requests only happen when someone actually selects a
// satellite, nowhere near often enough to justify precomputing this for
// the whole catalog continuously.
const TRACK_ABSOLUTE_MAX_MINUTES = 200;   // hard ceiling regardless of the satellite's own orbital period
const TRACK_STEP_SECONDS = 60;            // one point per minute of track

function computeSatelliteTrack(noradId) {
  const sat = satRecords.find(s => s.noradId === noradId);
  if (!sat || !sat.satrec || sat.satrec.error !== 0) {
    return { noradId: noradId, period_min: null, track_min: null, points: [] };
  }

  // Orbital period from the TLE's own mean motion (revs/day) - 1440 minutes
  // in a day / revs per day = minutes per rev. A missing or non-positive
  // mean motion (shouldn't happen for a satellite that's already propagating
  // successfully, but never trust a single field blindly) falls back to a
  // reasonable LEO-typical value rather than producing an absurd or
  // negative track length.
  const meanMotion = (sat.ommData && typeof sat.ommData.MEAN_MOTION === 'number' && sat.ommData.MEAN_MOTION > 0)
    ? sat.ommData.MEAN_MOTION : null;
  const periodMinutes = meanMotion ? (1440 / meanMotion) : 100;
  const trackMinutes = Math.min(periodMinutes, TRACK_ABSOLUTE_MAX_MINUTES);

  const now = Date.now();
  const points = [];   // newest (now) first, oldest last - same convention as the vessel track API, which the frontend already reverses before drawing

  for (let t = 0; t <= trackMinutes * 60; t += TRACK_STEP_SECONDS) {
    const when = new Date(now - t * 1000);
    try {
      const posVel = satellite.propagate(sat.satrec, when);
      if (!posVel || !posVel.position) continue;
      const gmst = satellite.gstime(when);
      const geo = satellite.eciToGeodetic(posVel.position, gmst);
      if (!Number.isFinite(geo.height) || geo.height < MIN_PLAUSIBLE_ALT_KM) continue;
      const lat = satellite.degreesLat(geo.latitude);
      const lon = satellite.degreesLong(geo.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      points.push([Number(lat.toFixed(4)), Number(lon.toFixed(4)), Math.round(when.getTime() / 1000)]);
    } catch (e) {
      continue;   // one bad point along the track shouldn't drop the rest of it
    }
  }

  return {
    noradId: noradId,
    period_min: Number(periodMinutes.toFixed(2)),
    track_min: Number(trackMinutes.toFixed(2)),
    points: points,
  };
}

// gzip responses when the client accepts it. Each payload is compressed at
// most once per change (cached against the exact body string), not per request.
const gzipCache = new Map();   // name -> { body, gz }
function sendJson(req, res, body, cacheControl, cacheName, extraHeaders) {
  const headers = Object.assign({
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': cacheControl,
    'Vary': 'Accept-Encoding',
  }, extraHeaders || {});
  const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (acceptsGzip && body.length > 1024) {
    let entry = cacheName ? gzipCache.get(cacheName) : null;
    if (!entry || entry.body !== body) {
      entry = { body: body, gz: zlib.gzipSync(body) };
      if (cacheName) gzipCache.set(cacheName, entry);
    }
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    res.end(entry.gz);
    return;
  }
  res.writeHead(200, headers);
  res.end(body);
}

const httpServer = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, 'http://localhost');
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  if (parsedUrl.pathname === '/satellite-track' || parsedUrl.pathname === '/satellite-track/') {
    const noradIdParam = parsedUrl.searchParams.get('noradId');
    const noradId = Number(noradIdParam);
    if (!noradIdParam || !Number.isFinite(noradId)) {
      res.writeHead(400, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ error: 'noradId query parameter is required and must be numeric' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(computeSatelliteTrack(noradId)));
    return;
  }

  // Catalogue details for every loaded satellite, keyed by NORAD ID.
  // Requested as /satellite-details?v=<details_version>: when v matches the
  // current version the response never changes, so it may be cached for a
  // day (a new version is a new URL). Anything else is served uncached.
  if (parsedUrl.pathname === '/satellite-details' || parsedUrl.pathname === '/satellite-details/') {
    const etag = '"' + detailsVersion + '"';
    if (detailsVersion && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'ETag': etag, 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }
    const versionMatches = detailsVersion && parsedUrl.searchParams.get('v') === detailsVersion;
    sendJson(req, res, latestDetailsPayload,
      versionMatches ? 'public, max-age=86400, immutable' : 'no-cache',
      'details', detailsVersion ? { 'ETag': etag } : null);
    return;
  }

  if (parsedUrl.pathname !== '/' && parsedUrl.pathname !== '/satellites.json') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  // Legacy form for anything still expecting details inline in every record:
  // /satellites.json?full=1. Built on demand - the map itself never asks for it.
  ensureFreshPositions();
  if (parsedUrl.searchParams.get('full') === '1') {
    const byId = new Map(satRecords.map(s => [s.noradId, s.enrichment]));
    const full = latestSatellites.map(p => Object.assign({}, p, byId.get(p.noradId) || {}));
    const generatedAt = (() => { try { return JSON.parse(latestPayload).generated_at; } catch (e) { return null; } })();
    sendJson(req, res, JSON.stringify({ generated_at: generatedAt, satellites: full }), 'no-store', null);
    return;
  }

  sendJson(req, res, latestPayload, 'no-store', 'positions');
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
  console.log(`Satellite JSON endpoint listening on 0.0.0.0:${HTTP_PORT} (GET / or /satellites.json for positions, /satellite-details for catalogue details, /satellite-track?noradId= for orbit tracks)`);
});

// Initial boot check
const STARTUP_RETRY_MS = 5 * 60 * 1000; // 5 minutes - short enough to recover quickly from a boot-time race, nowhere near frequent enough to trouble CelesTrak even if it took several attempts

async function checkStartupSuccess() {
  if (networkHoldActive()) {
    return; // the hold-resume timer makes the next attempt
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

// (No fixed 2-second timer any more: see ensureFreshPositions().)
