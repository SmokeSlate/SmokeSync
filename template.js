var CONFIG = {
  PLAYLIST_ID: "986760", BMSESSIONID: "", PAGES: 5, QUERY: "",
  LEADERBOARD: "All", SORT_ORDER: "Rating",
  SLEEP_MS_BETWEEN_POSTS: 20, SLEEP_MS_BETWEEN_PAGES: 100
};
var ARGS = "", RETRIES = 3, RETRY_BASE_SLEEP_MS = 1500;

function run() {
  const properties = PropertiesService.getScriptProperties();
  if (!properties.getProperty('username') || !properties.getProperty('password')) init();
  else getValidSessionCookie();
  ensureWeeklyTrigger();
  SETRUN
}

function ensureWeeklyTrigger() {
  if (!ScriptApp.getProjectTriggers().some(trigger => trigger.getHandlerFunction() === 'run')) {
    ScriptApp.newTrigger('run').timeBased().everyDays(7).create();
  }
}

function init() {
  const username = SETNAME, password = SETPASS;
  const cookie = parseSetCookie(loginAndGetCookie(username, password));
  if (!cookie.BMSESSIONID) throw new Error('Login did not return a session cookie.');
  // Failed login must not leave a password marker that skips initialization.
  PropertiesService.getScriptProperties().setProperties({ username, password, cookie: JSON.stringify(cookie) });
  ensureWeeklyTrigger();
}

function runwithArgs(input, pages, query = "") {
  const playlistID = parsePlaylistId(input);
  if (!playlistID) throw new Error('Could not parse playlist ID.');
  if (!Number.isInteger(Number(pages)) || Number(pages) < 1) throw new Error('Pages must be a positive integer.');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    CONFIG.BMSESSIONID = getValidSessionCookie().BMSESSIONID;
    CONFIG.PLAYLIST_ID = playlistID;
    CONFIG.PAGES = Number(pages);
    ARGS = String(query || '');
    return runSmokeSync();
  } finally {
    lock.releaseLock();
  }
}

function parsePlaylistId(input) {
  const text = String(input || '').trim();
  if (/^\d+$/.test(text)) return text;
  return text.match(/^https?:\/\/(?:www\.)?beatsaver\.com\/playlists\/(\d+)(?:[/?#].*)?$/i)?.[1]
    || text.match(/^https?:\/\/api\.beatsaver\.com\/playlists\/id\/(\d+)(?:[/?#].*)?$/i)?.[1]
    || null;
}

function fetchJson(url) {
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) throw new Error(`GET request failed (${status}).`);
  return JSON.parse(response.getContentText());
}

function getNested(value, fields) {
  return fields.reduce((value, field) => value && field in value ? value[field] : undefined, value);
}

function readPlaylistSongs() {
  const metadata = fetchJson(`https://api.beatsaver.com/playlists/id/${CONFIG.PLAYLIST_ID}`);
  const download = getNested(metadata, ['playlist','downloadURL']);
  if (!download) throw new Error('No playlist.downloadURL.');
  const songs = fetchJson(download).songs;
  if (!Array.isArray(songs) || songs.some(song => typeof song?.key !== 'string' || !song.key.trim())) {
    throw new Error('Existing playlist returned malformed songs; no changes made.');
  }
  return [...new Set(songs.map(song => song.key.trim()))];
}

function runSmokeSync() {
  // Discover and validate every page before any playlist mutation.
  const desired = new Set();
  for (let page = 0; page < CONFIG.PAGES; page++) {
    for (const doc of fetchDocs(buildSearchUrl(page))) {
      if (typeof doc?.id !== 'string' || !doc.id.trim()) throw new Error('Search returned an invalid map ID; no changes made.');
      desired.add(doc.id.trim());
    }
    Utilities.sleep(CONFIG.SLEEP_MS_BETWEEN_PAGES);
  }
  if (!desired.size) throw new Error('No replacement maps found; existing playlist left unchanged.');
  const existing = readPlaylistSongs();
  const existingSet = new Set(existing);
  const properties = PropertiesService.getScriptProperties();
  const recoveryKey = `smokeSyncPending:${CONFIG.PLAYLIST_ID}`;
  const prior = properties.getProperty(recoveryKey);
  let before = existing;
  if (prior) {
    const recovery = JSON.parse(prior);
    if (!Array.isArray(recovery.before)) throw new Error('Recovery state is invalid; no changes made.');
    before = recovery.before;
  }
  // Saving recovery can fail on PropertiesService quotas. Do it before writes.
  properties.setProperty(recoveryKey, JSON.stringify({ playlistID: CONFIG.PLAYLIST_ID, before, desired: [...desired] }));
  let added = 0, removed = 0;
  for (const mapId of desired) {
    if (existingSet.has(mapId)) continue;
    const result = addToPlaylist(mapId);
    if (!result.ok) throw new Error(`Could not add ${mapId} (${result.status}); original songs retained. Recovery: ${recoveryKey}`);
    added++;
    Utilities.sleep(CONFIG.SLEEP_MS_BETWEEN_POSTS);
  }
  // Only remove obsolete songs after all replacement additions have succeeded.
  for (const mapId of existing) {
    if (desired.has(mapId)) continue;
    if (!postPlaylistToggle(CONFIG.PLAYLIST_ID, mapId, false)) {
      throw new Error(`Could not remove ${mapId}; replacement songs are present. Recovery: ${recoveryKey}`);
    }
    removed++;
    Utilities.sleep(CONFIG.SLEEP_MS_BETWEEN_POSTS);
  }
  properties.deleteProperty(recoveryKey);
  const summary = { added, removed, retained: existing.filter(id => desired.has(id)).length, failed: 0 };
  Logger.log(JSON.stringify(summary));
  return summary;
}

function buildSearchUrl(page) {
  return `https://api.beatsaver.com/search/text/${page}?q=${encodeURIComponent(CONFIG.QUERY)}&leaderboard=${encodeURIComponent(CONFIG.LEADERBOARD)}&sortOrder=${encodeURIComponent(CONFIG.SORT_ORDER)}${ARGS}`;
}

function fetchDocs(url) {
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) throw new Error(`Search fail ${response.getResponseCode()}`);
  const data = JSON.parse(response.getContentText() || '{}');
  if (!Array.isArray(data.docs)) throw new Error('Search response has no docs array; no changes made.');
  return data.docs;
}

function playlistMutation(playlistID, mapId, inPlaylist) {
  const request = {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ mapId, inPlaylist: Boolean(inPlaylist) }),
    headers: { Cookie: `BMSESSIONID=${CONFIG.BMSESSIONID}` }, muteHttpExceptions: true
  };
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    let response;
    try {
      response = UrlFetchApp.fetch(`https://beatsaver.com/api/playlists/id/${encodeURIComponent(playlistID)}/add`, request);
    } catch (error) {
      return { ok: false, status: -1, body: String(error.message) };
    }
    const status = response.getResponseCode();
    const body = String(response.getContentText() || '');
    let success = false;
    try { success = JSON.parse(body).success === true; } catch {}
    if (status >= 200 && status < 300 && success) return { ok: true, status, body: body.slice(0,2000) };
    if (!(status >= 500 || status === 429) || attempt === RETRIES) return { ok: false, status, body: body.slice(0,2000) };
    Utilities.sleep(RETRY_BASE_SLEEP_MS * Math.pow(2, attempt));
  }
}

function postPlaylistToggle(playlistID, mapId, inPlaylist) {
  return playlistMutation(playlistID, mapId, inPlaylist).ok;
}

function addToPlaylist(mapId) {
  return playlistMutation(CONFIG.PLAYLIST_ID, mapId, true);
}

function loginAndGetCookie(username, password) {
  const properties = PropertiesService.getScriptProperties();
  const response = UrlFetchApp.fetch('https://beatsaver.com/login', {
    method: 'post', payload: {
      username: username === undefined ? properties.getProperty('username') : username,
      password: password === undefined ? properties.getProperty('password') : password
    }, followRedirects: false, muteHttpExceptions: true
  });
  const header = response.getAllHeaders()['Set-Cookie'];
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  const cookie = cookies.find(value => typeof value === 'string' && value.includes('BMSESSIONID='));
  if (!cookie) throw new Error('Login did not return BMSESSIONID.');
  return cookie;
}

function parseSetCookie(header) {
  const result = {};
  String(header).split(';').forEach(part => {
    const value = part.trim();
    if (!value) return;
    const separator = value.indexOf('=');
    if (separator > -1) result[value.slice(0,separator).trim()] = value.slice(separator + 1).trim();
    else result[value] = true;
  });
  return result;
}

function saveSessionCookieFromSetCookie(header) {
  const cookie = parseSetCookie(header);
  if (!cookie.BMSESSIONID) throw new Error('Missing session cookie.');
  PropertiesService.getScriptProperties().setProperty('cookie', JSON.stringify(cookie));
}

function loadSessionCookie() {
  const raw = PropertiesService.getScriptProperties().getProperty('cookie');
  const cookie = raw ? JSON.parse(raw) : null;
  if (!cookie || typeof cookie.BMSESSIONID !== 'string' || !cookie.BMSESSIONID) throw new Error('No valid cookie.');
  return cookie;
}

function getValidSessionCookie() {
  let cookie;
  try {
    cookie = loadSessionCookie();
    const expiry = cookie.Expires || cookie.expires;
    if (expiry && (Number.isNaN(Date.parse(expiry)) || Date.now() >= Date.parse(expiry))) cookie = null;
  } catch { cookie = null; }
  if (!cookie) {
    saveSessionCookieFromSetCookie(loginAndGetCookie());
    cookie = loadSessionCookie();
  }
  return cookie;
}
