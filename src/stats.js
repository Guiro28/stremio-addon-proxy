// Compteurs en memoire (remis a zero au redemarrage du process).
//
// Nuance importante : une seule lecture Stremio genere plusieurs requetes /play
// (1 HEAD + plusieurs GET Range pour bufferiser). On distingue donc :
//   - sessions  : lectures distinctes (dedupliquees par URL sur une fenetre)
//   - requests  : total brut des requetes /play
//   - active    : nombre de VIDEOS en cours (pas de connexions)

const startedAt = Date.now();
const SESSION_GAP_MS = 5 * 60 * 1000; // 2 requetes du meme flux a +5min = nouvelle lecture

const s = {
  sessions: 0,
  requests: 0,
  playErrors: 0,
  bytesRelayed: 0,
  streamRequests: 0,
  streamsProxied: 0,
  streamsTotal: 0,
  lastActivity: null,
  perAddon: {},          // id -> { name, plays, streamHits }
  activeUrls: new Map(), // clé -> nb de connexions ouvertes (taille = flux actifs)
  seen: new Map()        // clé -> dernier accès (pour la déduplication en sessions)
};

// Historique des octets relayés (1 point/s) pour le débit + échantillonnage CPU.
const bwHistory = [];
let cpuPercent = 0;
let lastCpu = process.cpuUsage(); // micros cumulés (user+system)
let lastCpuAt = Date.now();
const bwTimer = setInterval(() => {
  const now = Date.now();
  bwHistory.push({ t: now, bytes: s.bytesRelayed });
  while (bwHistory.length > 12) bwHistory.shift();

  // CPU% du process : temps CPU consommé / temps réel écoulé (100% = un cœur plein).
  const cu = process.cpuUsage();
  const deltaCpu = (cu.user - lastCpu.user) + (cu.system - lastCpu.system); // micros
  const deltaWall = (now - lastCpuAt) * 1000; // micros
  if (deltaWall > 0) cpuPercent = (deltaCpu / deltaWall) * 100;
  lastCpu = cu;
  lastCpuAt = now;
}, 1000);
if (bwTimer.unref) bwTimer.unref();

// "Lectures en cours" avec fenêtre de grâce : un flux reste compté tant qu'il a eu
// une requête dans les dernières minutes (couvre les pauses de buffer du lecteur).
// = connexions ouvertes maintenant  ∪  flux vus récemment.
const ACTIVE_WINDOW_MS = SESSION_GAP_MS; // 5 min
function activeCount() {
  const now = Date.now();
  const keys = new Set(s.activeUrls.keys());
  for (const [k, t] of s.seen) if (now - t <= ACTIVE_WINDOW_MS) keys.add(k);
  return keys.size;
}

// Débit courant en octets/s, moyenné sur ~5 s (0 quand rien ne circule).
function currentBps() {
  if (bwHistory.length < 2) return 0;
  const newest = bwHistory[bwHistory.length - 1];
  let oldest = bwHistory[0];
  for (const h of bwHistory) {
    if (newest.t - h.t <= 5000) { oldest = h; break; }
  }
  const dt = (newest.t - oldest.t) / 1000;
  if (dt <= 0) return 0;
  return Math.max(0, (newest.bytes - oldest.bytes) / dt);
}

function touch() {
  s.lastActivity = Date.now();
}

function ensure(id, name) {
  if (!s.perAddon[id]) s.perAddon[id] = { name: name || id, plays: 0, streamHits: 0 };
  else if (name) s.perAddon[id].name = name;
  return s.perAddon[id];
}

function isNewSession(key) {
  const now = Date.now();
  const last = s.seen.get(key);
  s.seen.set(key, now);
  if (s.seen.size > 500) {
    for (const [k, t] of s.seen) if (now - t > SESSION_GAP_MS) s.seen.delete(k);
  }
  return !last || now - last > SESSION_GAP_MS;
}

function playStart(addonId, url, method) {
  s.requests++;
  const key = (addonId || '') + '|' + url;
  s.activeUrls.set(key, (s.activeUrls.get(key) || 0) + 1);
  // Une nouvelle "lecture" = premiere requete GET vers une URL pas vue recemment.
  if (method !== 'HEAD' && isNewSession(key)) {
    s.sessions++;
    if (addonId) ensure(addonId).plays++;
  }
  touch();
}

// Comptabilise les octets au fil de l'eau (appelé à chaque chunk relayé),
// pour que la mesure de bande passante reflète le transfert en temps réel.
function addBytes(n) {
  s.bytesRelayed += n || 0;
}

function playEnd(addonId, url, ok) {
  const key = (addonId || '') + '|' + url;
  const c = s.activeUrls.get(key);
  if (c > 1) s.activeUrls.set(key, c - 1);
  else s.activeUrls.delete(key);
  if (!ok) s.playErrors++;
  touch();
}

function recordStream(addon, proxied, total) {
  s.streamRequests++;
  s.streamsProxied += proxied || 0;
  s.streamsTotal += total || 0;
  if (addon) ensure(addon.id, addon.name).streamHits++;
  touch();
}

function snapshot() {
  const topAddons = Object.entries(s.perAddon)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.plays - a.plays || b.streamHits - a.streamHits)
    .slice(0, 5);

  return {
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    plays: s.sessions,            // lectures distinctes
    playRequests: s.requests,     // requetes /play brutes
    playActive: activeCount(),    // videos en cours (avec fenetre de grace)
    playErrors: s.playErrors,
    bytesRelayed: s.bytesRelayed,
    bandwidthBps: Math.round(currentBps()), // debit courant en octets/s
    cpuPercent: Math.round(cpuPercent * 10) / 10, // % CPU du process (1 decimale)
    rssBytes: process.memoryUsage().rss,          // RAM residente du process
    streamRequests: s.streamRequests,
    streamsProxied: s.streamsProxied,
    streamsTotal: s.streamsTotal,
    lastActivity: s.lastActivity,
    topAddons
  };
}

module.exports = { playStart, playEnd, addBytes, recordStream, snapshot };
