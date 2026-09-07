// Compteurs en memoire (remis a zero au redemarrage du process).
//
// Nuance importante : une seule lecture Stremio genere plusieurs requetes /play
// (1 HEAD + plusieurs GET Range pour bufferiser, + des reprises apres buffer). On
// distingue donc :
//   - sessions  : lectures distinctes = requete GET au DEBUT du fichier (offset 0).
//                 Les reprises apres buffering visent un offset > 0 -> non comptees.
//   - requests  : total brut des requetes /play
//   - active    : nombre de VIDEOS en cours (pas de connexions)

const startedAt = Date.now();
const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // fenêtre de grâce "lectures en cours"
const START_DEDUP_MS = (Number(process.env.START_DEDUP_SEC) > 0 ? Number(process.env.START_DEDUP_SEC) : 15) * 1000; // fusionne les sondes de démarrage
// Au-delà de ce temps SANS activité sur un flux, une reprise = nouvelle lecture
// (distingue une pause de buffering d'une reprise "plus tard"). Réglable via env.
const RESUME_GAP_MS = (Number(process.env.SESSION_GAP_MIN) > 0 ? Number(process.env.SESSION_GAP_MIN) : 30) * 60 * 1000;

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
  seen: new Map(),       // clé -> dernier accès (fenêtre de grâce "en cours")
  started: new Map()     // clé -> dernier démarrage (offset 0) déjà compté
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

function prune(map, maxAge) {
  if (map.size <= 500) return;
  const now = Date.now();
  for (const [k, t] of map) if (now - t > maxAge) map.delete(k);
}

function playStart(addonId, url, method, rangeStart) {
  s.requests++;
  const key = (addonId || '') + '|' + url;
  const now = Date.now();

  // Connexions ouvertes (flux actifs bruts).
  s.activeUrls.set(key, (s.activeUrls.get(key) || 0) + 1);

  // Dernière activité de ce flux (avant mise à jour) -> sert au gap de reprise.
  const last = s.seen.get(key);
  s.seen.set(key, now);
  prune(s.seen, RESUME_GAP_MS);

  // Une "lecture" est comptée si : requête GET au DÉBUT du fichier (offset 0), OU
  // reprise après une longue inactivité (> RESUME_GAP_MS). Les reprises de buffering
  // (offset > 0, gap court) ne comptent pas -> plus de sur-comptage.
  if (method !== 'HEAD') {
    const freshStart = rangeStart === 0;
    const longGap = !last || (now - last > RESUME_GAP_MS);
    if (freshStart || longGap) {
      const lastCounted = s.started.get(key);
      if (!lastCounted || now - lastCounted > START_DEDUP_MS) {
        s.sessions++;
        if (addonId) ensure(addonId).plays++;
      }
      s.started.set(key, now);
      prune(s.started, START_DEDUP_MS);
    }
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
