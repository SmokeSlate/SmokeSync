var CONFIG = {
  PLAYLIST_ID: '986760',            /* <- your playlist numeric ID */
  BMSESSIONID: '',                  /* <- your BMSESSIONID value */
  PAGES: 5,                         /* how many pages to scan (0-based pages) */
  QUERY: '',                        /* search query; empty = everything (same as your Shortcut) */
  LEADERBOARD: 'All',
  SORT_ORDER: 'Rating',
  SLEEP_MS_BETWEEN_POSTS: 20,       /* gentle rate-limit */
  SLEEP_MS_BETWEEN_PAGES: 100
};

var BMSESSIONID = '';
var PLAYLIST_INPUT = CONFIG.PLAYLIST_ID;  /* or just '658586' */
var BATCH_SIZE = 1;                       /* pause after this many requests */
var BATCH_SLEEP_MS = 5;                   /* 5s pause like your Shortcut */
var RETRIES = 3;                          /* retry count for transient errors */
var RETRY_BASE_SLEEP_MS = 1500;           /* backoff base */
var ARGS = '';

/** Run is the function you run to update your playlists */
function run() {
  /* EXAMPLES
     Top Vivify - https://beatsaver.com/playlists/986760
     runwithArgs('986760', 5, "&vivify=true")

     SmokeSync
     200 maps - https://beatsaver.com/playlists/979914
     runwithArgs('979914', 10)

     400 maps - https://beatsaver.com/playlists/658586
     runwithArgs('658586', 20)
  */
  // REPLACE
}

function init() {
  PropertiesService.getScriptProperties().setProperty("username", SETNAME);
  PropertiesService.getScriptProperties().setProperty("password", SETPASS);
  saveSessionCookieFromSetCookie(loginAndGetCookie());
  try {
    ScriptApp.newTrigger("run").timeBased().everyDays(7).create();
  } catch (e) {
    console.log("Trigger create error: " + e);
  }
}

/**
 * Run with arguments
 * NOTE: pages are groups of 20
 */
function runwithArgs(playlistId, pages, args = '') {
  CONFIG.BMSESSIONID = getValidSessionCookie()["BMSESSIONID"];
  BMSESSIONID = CONFIG.BMSESSIONID;
  CONFIG.PAGES = pages;
  CONFIG.PLAYLIST_ID = playlistId;
  PLAYLIST_INPUT = CONFIG.PLAYLIST_ID;
  ARGS = args;
  massRemoveFromPlaylist();
  runSmokeSync();
}

/* ---------------- Remove from playlists ---------------- */

function massRemoveFromPlaylist() {
  const playlistId = parsePlaylistId(PLAYLIST_INPUT);
  if (!playlistId) throw new Error('Could not parse a playlist ID from PLAYLIST_INPUT.');

  const playlistMetaUrl = `https://api.beatsaver.com/playlists/id/${playlistId}`;
  const meta = fetchJson(playlistMetaUrl);
  const downloadUrl = getNested(meta, ['playlist', 'downloadURL']);
  if (!downloadUrl) throw new Error('Could not find playlist.downloadURL from BeatSaver API.');

  // Download the playlist JSON that includes songs
  const playlistJson = fetchJson(downloadUrl);
  const songs = playlistJson?.songs || [];
  if (!Array.isArray(songs) || songs.length === 0) {
    Logger.log('No songs found in playlist JSON.');
    return;
  }

  Logger.log(`Removing ${songs.length} songs from playlist ${playlistId}...`);

  let ok = 0, fail = 0;
  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    const key = song?.key; // your Shortcut posts the "key" as mapId
    if (!key) {
      fail++;
      Logger.log(`Skip index ${i}: no song.key`);
      continue;
    }

    const success = postPlaylistToggle(playlistId, key, false);
    if (success) ok++; else fail++;

    // Every BATCH_SIZE, wait a bit (mirrors your "ends with 0" + wait 5s + re-run)
    if ((i + 1) % BATCH_SIZE === 0 && (i + 1) < songs.length) {
      Utilities.sleep(BATCH_SLEEP_MS);
    }
  }

  Logger.log(`Done. Success: ${ok}, Failed: ${fail}`);
}

/**
 * POST to BeatSaver:
 *   https://beatsaver.com/api/playlists/id/{id}/add
 * Body: { mapId: <key>, inPlaylist: false }
 * Requires BMSESSIONID cookie.
 */
function postPlaylistToggle(playlistId, mapKey, inPlaylistFlag) {
  const url = `https://beatsaver.com/api/playlists/id/${playlistId}/add`;

  const payload = {
    mapId: mapKey,          /* from doc.id */
    inPlaylist: !!inPlaylistFlag
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: { 'Cookie': `BMSESSIONID=${BMSESSIONID}` },
    followRedirects: true,
    muteHttpExceptions: true
  };

  // Simple retry with backoff for 429/5xx
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const resp = UrlFetchApp.fetch(url, options);
    const code = resp.getResponseCode();
    let body = null;
    try { body = JSON.parse(resp.getContentText() || '{}'); } catch (e) {}
    const success = body && body.success === true;
    if (success) return true;

    const retryable = (code >= 500) || code === 429;
    if (!retryable || attempt === RETRIES) {
      Logger.log(`Remove FAIL mapId=${mapKey} code=${code} body=${resp.getContentText()}`);
      return false;
    }
    Utilities.sleep(RETRY_BASE_SLEEP_MS * Math.pow(2, attempt)); // backoff
  }
  return false;
}

/* ---------------- Helpers ---------------- */

function parsePlaylistId(input) {
  if (!input) return null;
  const s = String(input).trim();
  // If it's just digits, treat as ID
  if (/^\d+$/.test(s)) return s;

  // Try to extract from common URL forms:
  // https://beatsaver.com/playlists/658586
  // https://www.beatsaver.com/playlists/658586
  const m = s.match(/beatsaver\.com\/playlists\/(\d+)/i);
  if (m) return m[1];
  return null;
}

function fetchJson(url) {
  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    followRedirects: true,
    muteHttpExceptions: true
  });
  const code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(`GET ${url} failed with ${code}: ${resp.getContentText()}`);
  }
  try {
    return JSON.parse(resp.getContentText());
  } catch (e) {
    throw new Error(`Invalid JSON from ${url}: ${e}`);
  }
}

function getNested(obj, pathArr) {
  return pathArr.reduce((o, k) => (o && k in o ? o[k] : undefined), obj);
}

/* ---------------- SmokeSync ---------------- */

function runSmokeSync() {
  const added = [];
  const skipped = [];
  const failed = [];

  for (let page = 0; page < CONFIG.PAGES; page++) {
    const url = buildSearchUrl(page);
    const docs = fetchDocs(url);

    for (const doc of docs) {
      // BeatSaver v3 search docs have `id` (this is the map key you used as "mapId")
      const mapId = String(doc?.id || '').trim();
      if (!mapId) continue;

      const res = addToPlaylist(mapId);
      if (res.ok) {
        added.push(mapId);
      } else if (res.status === 409 || res.status === 400) {
        // 409/400 commonly happens if it's already in the playlist or invalid; treat as skip
        skipped.push({ mapId, reason: `status ${res.status}` });
      } else {
        failed.push({ mapId, status: res.status, body: res.body });
      }

      Utilities.sleep(CONFIG.SLEEP_MS_BETWEEN_POSTS);
    }

    Utilities.sleep(CONFIG.SLEEP_MS_BETWEEN_PAGES);
  }

  Logger.log(JSON.stringify({ addedCount: added.length, skippedCount: skipped.length, failedCount: failed.length }, null, 2));
  if (failed.length) Logger.log('Failures:\n' + JSON.stringify(failed.slice(0, 20), null, 2));
}

/* helpers for search */
function buildSearchUrl(page) {
  const q = encodeURIComponent(CONFIG.QUERY || '');
  const lb = encodeURIComponent(CONFIG.LEADERBOARD);
  const so = encodeURIComponent(CONFIG.SORT_ORDER);
  return `https://api.beatsaver.com/search/text/${page}?q=${q}&leaderboard=${lb}&sortOrder=${so}${ARGS}`;
}

function fetchDocs(url) {
  const res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error(`Search fetch failed ${res.getResponseCode()} for ${url}: ${res.getContentText()}`);
  }
  const json = JSON.parse(res.getContentText() || '{}');
  // matches your Shortcut: Get Value for "docs" in Dictionary
  return Array.isArray(json.docs) ? json.docs : [];
}

function addToPlaylist(mapId) {
  const url = `https://beatsaver.com/api/playlists/id/${encodeURIComponent(CONFIG.PLAYLIST_ID)}/add`;

  const payload = {
    mapId: mapId,     /* from doc.id */
    inPlaylist: true
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: {
      /* matches your Shortcut headers */
      'Cookie': `BMSESSIONID=${CONFIG.BMSESSIONID}`
    },
    followRedirects: true,
    muteHttpExceptions: true
  };

  try {
    const res = UrlFetchApp.fetch(url, options);
    const status = res.getResponseCode();
    const body = res.getContentText();
    return { ok: status >= 200 && status < 300, status, body };
  } catch (e) {
    return { ok: false, status: -1, body: String(e) };
  }
}

/* ---------------- Cookie Getters ---------------- */

/* Log in, capture Set-Cookie headers, return the *raw* Set-Cookie string for BMSESSIONID */
function loginAndGetCookie() {
  var url = "https://beatsaver.com/login";
  var payload = {
    username: PropertiesService.getScriptProperties().getProperty("username"),
    password: PropertiesService.getScriptProperties().getProperty("password")
  };

  var options = {
    method: "post",
    payload: payload,
    followRedirects: false, /* capture Set-Cookie on 302 */
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var headers = response.getAllHeaders();
  var setCookie = headers["Set-Cookie"];

  /* Normalize to array */
  var list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  if (!list.length) {
    throw new Error("No Set-Cookie header returned from login; check credentials or login flow.");
  }

  /* Pick the BMSESSIONID cookie specifically */
  var bm = list.find(function (c) { return typeof c === "string" && c.indexOf("BMSESSIONID=") >= 0; });
  if (!bm) {
    throw new Error("Set-Cookie did not include BMSESSIONID.");
  }
  return bm; /* e.g. "BMSESSIONID=abc; Max-Age=...; Expires=Mon, 25 Aug 2025 18:46:59 GMT; ..." */
}

/* Parse a single Set-Cookie string into a plain object (safe for JSON.stringify) */
function parseSetCookie(setCookieStr) {
  var out = {};
  var parts = String(setCookieStr).split(";");

  parts.forEach(function (raw) {
    var part = raw.trim();
    if (!part) return;

    var eq = part.indexOf("=");
    if (eq > -1) {
      var key = part.slice(0, eq).trim();
      var val = part.slice(eq + 1).trim();
      out[key] = val; /* keep exact value; Expires will contain a comma and spaces and that's fine */
    } else {
      /* flag attributes (HttpOnly, Secure) */
      out[part] = true;
    }
  });

  return out;
}

/* Persist cookie object as a JSON string */
function saveSessionCookieFromSetCookie(setCookieStr) {
  var cookieObj = parseSetCookie(setCookieStr);
  PropertiesService.getScriptProperties().setProperty("cookie", JSON.stringify(cookieObj));
}

/* Read JSON string back and parse */
function loadSessionCookie() {
  var s = PropertiesService.getScriptProperties().getProperty("cookie");
  if (!s) {
    throw new Error('No saved cookie found in Script Properties. Run initCookie() first.');
  }
  return JSON.parse(s);
}

/* Ensure we have a valid (non-expired) cookie; refresh if needed */
function getValidSessionCookie() {
  var cookie = loadSessionCookie();

  /* If Expires exists, check it */
  var exp = cookie["Expires"] || cookie["expires"]; /* be tolerant */
  if (exp) {
    var expiry = new Date(exp); /* e.g. "Mon, 25 Aug 2025 18:46:59 GMT" */
    var now = new Date();
    if (isNaN(expiry.getTime())) {
      /* If parsing failed, just keep cookie but log */
      Logger.log("Warning: could not parse cookie Expires value: " + exp);
    } else if (now > expiry) {
      Logger.log("Cookie expired, regenerating...");
      saveSessionCookieFromSetCookie(loginAndGetCookie());
      cookie = loadSessionCookie();
    }
  } else {
    /* If no Expires, we might still want to refresh occasionally; for now, keep it. */
  }

  return cookie;
}
