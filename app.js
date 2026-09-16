const { exec } = require('child_process');
const satellite = require('satellite.js');
const net = require('net');

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

const REFRESH_INTERVAL_MS = 2000;
const TCP_PORT = 30003;

// Absolute altitude floor in kilometers
const MIN_PLAUSIBLE_ALT_KM = 100;

// SBS-1 protocol altitude field: just a plain integer, in feet, with no
// protocol-level ceiling - real aircraft never approached one so nobody
// bothered enforcing one. See the removed MAX_SBS_ALT_FT cap further down
// for why satellites now report their true altitude instead.
const KM_TO_FEET = 3280.84;

// --- Category -> synthetic hex band ------------------------------------
//
// The SBS/BaseStation protocol has no field to carry an arbitrary tag like
// "which CelesTrak group did this come from", so the category is instead
// encoded directly into the hex address. The F00000-FFFFFE block is already
// reserved for satellites (see isSatelliteHex() client-side); this splits
// that block into sub-bands of 65536 addresses each, one per category:
//
//   F0xxxx = stations     F4xxxx = navigation
//   F1xxxx = visual       F5xxxx = comms
//   F2xxxx = military     F6xxxx = science
//   F3xxxx = weather      F7xxxx = other
//   F8xxxx = recent (last-30-days)   (F9xxxx-FFxxxx reserved)
//
// CATEGORY_BANDS below MUST be kept in sync with the identical table in the
// client's markers.js (getSatelliteCategory / SAT_CATEGORIES) - the band
// index is the only thing carrying this information across the wire.
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
// Anything not listed here (a typo, or a future CelesTrak group) falls back
// to 'other' rather than failing.
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

// Each category gets 65536 addresses (satnum wrapped into 16 bits); with
// world catalog sizes in the tens of thousands this is enormously more
// headroom than the old flat 0x0FFFFE-wide, cross-category modulus, so
// collisions between unrelated satellites are effectively eliminated too.
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

async function updateTLEs() {
  try {
    const fetchPromises = CELESTRAK_GROUPS.map(group => {
      const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;
      return fetchWithCurl(url).catch(err => {
        console.error(`Error fetching group ${group}:`, err.message);
        return '';
      });
    });

    const results = await Promise.all(fetchPromises);
    const newSatRecords = [];
    const seenNoradIds = new Set();
    const categoryCounts = {};

    for (let g = 0; g < results.length; g++) {
      const rawData = results[g];
      const group = CELESTRAK_GROUPS[g];
      const category = categoryForGroup(group);

      if (!rawData || rawData.includes('GP data has not updated')) continue;

      const lines = rawData.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('1 ') && lines[i + 1]?.startsWith('2 ')) {
          const name = (i > 0 && !lines[i - 1].startsWith('1 ')) ? lines[i - 1] : 'SAT';
          try {
            const satrec = satellite.twoline2satrec(lines[i], lines[i + 1]);
            // If the same NORAD ID appears in more than one requested group
            // (e.g. it's in both "stations" and "visual"), the group listed
            // earliest in CELESTRAK_GROUPS wins the category assignment.
            if (satrec && satrec.satnum && !seenNoradIds.has(satrec.satnum)) {
              seenNoradIds.add(satrec.satnum);
              categoryCounts[category] = (categoryCounts[category] || 0) + 1;
              newSatRecords.push({
                name: name.replace(/[^a-zA-Z0-9]/g, "").substring(0, 8),
                noradId: satrec.satnum,
                satrec: satrec,
                category: category,
                hexId: buildHexId(category, satrec.satnum),
              });
            }
          } catch (e) {}
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
    if (!posVelNow.position || !posVelNow.velocity) continue;

    const geoNow = satellite.eciToGeodetic(posVelNow.position, gmstNow);

    // Altitude floor check: Drop anything invalid or below 100km
    if (!Number.isFinite(geoNow.height) || geoNow.height < MIN_PLAUSIBLE_ALT_KM) {
      continue;
    }

    // Altitude, transmitted as a SCALED-DOWN multiple of the true value, not
    // the true value itself. Disabling binCraft (see early.js) should have
    // been sufficient on its own - binCraft's alt_baro is a documented
    // s16*25 field with a hard ceiling around 819,175ft - but if some other
    // component in a pipeline we don't have source access to (readsb's own
    // internal storage, some other narrow field, anything) still assumes
    // aircraft-scale altitude, no amount of finding-and-disabling individual
    // binary formats fixes a constraint we haven't found yet. Dividing by a
    // large, fixed factor before transmission - and multiplying back on
    // display, see formatSatelliteAltitude() in script.js - means every
    // number this satellite ever puts on the wire looks, to every consumer
    // in the pipeline, exactly like an unremarkable aircraft altitude (tens
    // of thousands, the same magnitude the OLD 100,000ft-capped version
    // always used safely) instead of a multi-million-foot outlier. That's
    // safe against any fixed-width assumption, not just the one we found.
    //
    // SAT_ALT_SCALE MUST match the identical constant in script.js's
    // formatSatelliteAltitude() exactly - this is the only thing making the
    // transmitted number meaningful again on the other end.
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

    if (posVelFuture.position && posVelFuture.velocity) {
      const geoFuture = satellite.eciToGeodetic(posVelFuture.position, gmstFuture);
      
      if (Number.isFinite(geoFuture.height) && geoFuture.height >= MIN_PLAUSIBLE_ALT_KM) {
        const rawAltFtFuture = Math.round(geoFuture.height * KM_TO_FEET);
        const futLat = satellite.degreesLat(geoFuture.latitude);
        const futLon = satellite.degreesLong(geoFuture.longitude);

        if (Number.isFinite(futLat) && Number.isFinite(futLon)) {
          track = calculateBearing(lat, lon, futLat, futLon);
          // Vertical rate in ft/min
          let rawVRate = Math.round((rawAltFtFuture - rawAltFt) * 60);

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

    // Construct SBS-1 Messages (altFt inserted into altitude field)
    const msg1 = `MSG,1,1,1,${hexId},1,${dStr},${tStr},${dStr},${tStr},${sat.name},,,,,,,,,,,0\r\n`;
    const msg3 = `MSG,3,1,1,${hexId},1,${dStr},${tStr},${dStr},${tStr},,${altFt},,,${latStr},${lonStr},,,,,,,0\r\n`;
    
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
