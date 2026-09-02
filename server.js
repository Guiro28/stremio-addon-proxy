const path = require('path');
const express = require('express');

const config = require('./src/config');
const auth = require('./src/auth');
const stats = require('./src/stats');
const { request } = require('./src/http');
const { decodeToken, fetchManifest, fetchResource } = require('./src/addon');

const app = express();
const PORT = process.env.PORT || 7000;

app.use(express.json());
// Protege uniquement l'UI (/) et l'API (/api/*). Les routes addon et /play restent publiques.
app.use(auth.middleware);

// ---- Utilitaires -----------------------------------------------------------

function baseUrl(req) {
  const s = config.getState().settings;
  if (s.publicUrl) return s.publicUrl;
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return '?'; }
}

async function checkWarp(upstream) {
  try {
    const { res: r } = await request('https://cloudflare.com/cdn-cgi/trace', {
      upstream,
      timeout: 5000,
      headers: { accept: 'text/plain' }
    });
    const chunks = [];
    for await (const c of r) chunks.push(c);
    const match = Buffer.concat(chunks).toString('utf8').match(/^warp=(.+)$/m);
    return match ? match[1].trim() : 'off';
  } catch {
    return 'unreachable';
  }
}

// ---- Authentification (page de login) --------------------------------------

app.get('/login', (req, res) => {
  if (!auth.ENABLED || auth.isAuthed(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { user, pass } = req.body || {};
  if (auth.verify(user, pass)) {
    auth.setCookie(req, res);
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'Identifiants invalides' });
});

app.post('/api/logout', (req, res) => {
  auth.clearCookie(res);
  res.json({ ok: true });
});

// ---- API interface ---------------------------------------------------------

app.get('/api/stats', (req, res) => {
  const st = config.getState();
  res.json({
    ...stats.snapshot(),
    addonsConfigured: st.addons.length,
    upstreamMode: st.settings.upstream.mode
  });
});

app.get('/api/state', (req, res) => {
  const s = config.getState();
  res.json({
    authEnabled: auth.ENABLED,
    settings: s.settings,
    addons: s.addons.map((a) => ({
      ...a,
      installUrl: `${baseUrl(req)}/${a.id}/manifest.json`
    }))
  });
});

app.post('/api/addons', async (req, res) => {
  let manifestUrl = (req.body && req.body.manifestUrl || '').trim();
  if (!manifestUrl) return res.status(400).json({ error: 'manifestUrl requis' });

  // Tolerance: stremio:// et URLs sans /manifest.json
  manifestUrl = manifestUrl.replace(/^stremio:\/\//i, 'https://');
  if (!/\/manifest\.json/i.test(manifestUrl)) {
    manifestUrl = manifestUrl.replace(/\/+$/, '') + '/manifest.json';
  }

  try {
    const upstream = config.getState().settings.upstream;
    const { res: r } = await request(manifestUrl, { upstream, headers: { accept: 'application/json' } });
    const chunks = [];
    for await (const c of r) chunks.push(c);
    const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!manifest || !manifest.id) throw new Error('Manifest sans id');

    const addon = config.addAddon({ name: manifest.name || manifest.id, manifestUrl });
    res.json({ ...addon, installUrl: `${baseUrl(req)}/${addon.id}/manifest.json` });
  } catch (e) {
    res.status(400).json({ error: 'Manifest injoignable ou invalide : ' + e.message });
  }
});

app.delete('/api/addons/:id', (req, res) => {
  const ok = config.removeAddon(req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
});

app.post('/api/settings', (req, res) => {
  const settings = config.setSettings(req.body || {});
  res.json(settings);
});

// Teste la sortie reseau courante : renvoie l'IP publique vue par l'exterieur.
app.post('/api/test-upstream', async (req, res) => {
  const upstream = (req.body && req.body.upstream) || config.getState().settings.upstream;
  try {
    const { res: r } = await request('https://api.ipify.org?format=json', {
      upstream,
      timeout: 15000,
      headers: { accept: 'application/json' }
    });
    const chunks = [];
    for await (const c of r) chunks.push(c);
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.json({ ok: true, ip: data.ip, mode: upstream.mode });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Detecte automatiquement WARP via la sortie courante et les adresses usuelles du projet.
app.get('/api/warp-status', async (req, res) => {
  const current = config.getState().settings.upstream;
  const candidates = [
    current,
    { mode: 'socks', url: 'socks5://warp:1080' },
    { mode: 'socks', url: 'socks5://127.0.0.1:40000' }
  ].filter((candidate, index, all) =>
    all.findIndex((item) => item.mode === candidate.mode && item.url === candidate.url) === index
  );

  const results = await Promise.all(candidates.map(async (upstream) => ({
    ...upstream,
    status: await checkWarp(upstream)
  })));
  const detected = results.find((result) => result.status === 'on' || result.status === 'plus');

  res.json(detected
    ? { detected: true, status: detected.status, mode: detected.mode, url: detected.url }
    : { detected: false, status: 'off', mode: null, url: '' });
});

// ---- Relais video ----------------------------------------------------------

app.get('/play', async (req, res) => {
  cors(res);
  let target, extraHeaders, addonId;
  try {
    const decoded = decodeToken(req.query.t);
    target = decoded.url;
    extraHeaders = decoded.headers;
    addonId = decoded.addonId;
  } catch (e) {
    return e.expired
      ? res.status(410).send('Lien expiré')
      : res.status(400).send('Token invalide');
  }

  const headers = { ...extraHeaders };
  if (req.headers.range) headers.range = req.headers.range;
  if (!headers['user-agent']) headers['user-agent'] = req.headers['user-agent'] || 'Mozilla/5.0';
  if (!headers.accept) headers.accept = '*/*';

  stats.playStart(addonId, target, req.method);
  let okFlag = false;
  let finished = false;
  const finish = () => { if (finished) return; finished = true; stats.playEnd(addonId, target, okFlag); };

  try {
    const upstream = config.getState().settings.upstream;
    log(`[play] ${req.method} host=${hostOf(target)} via=${upstream.mode}${upstream.url ? '(' + upstream.url + ')' : ''} range=${req.headers.range ? 'oui' : 'non'}`);
    const { res: origin } = await request(target, {
      upstream,
      headers,
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      timeout: 30000
    });
    okFlag = (origin.statusCode || 0) < 400;
    log(`[play] -> ${origin.statusCode} host=${hostOf(target)} (${origin.headers['content-type'] || '?'})`);

    res.status(origin.statusCode || 502);
    const pass = [
      'content-type', 'content-length', 'content-range', 'accept-ranges',
      'content-disposition', 'cache-control', 'expires', 'last-modified', 'etag'
    ];
    for (const h of pass) if (origin.headers[h]) res.setHeader(h, origin.headers[h]);
    if (!origin.headers['accept-ranges']) res.setHeader('Accept-Ranges', 'bytes');

    origin.on('data', (c) => { stats.addBytes(c.length); });
    origin.on('end', finish);
    origin.on('error', () => { finish(); res.destroy(); });
    req.on('close', () => origin.destroy());
    res.on('close', finish);
    origin.pipe(res);
  } catch (e) {
    okFlag = false;
    finish();
    if (!res.headersSent) res.status(502).send('Erreur de relais : ' + e.message);
  }
});

// ---- Routes addon proxifie -------------------------------------------------

app.options(/.*/, (req, res) => {
  cors(res);
  res.sendStatus(204);
});

app.get('/:addonId/manifest.json', async (req, res) => {
  cors(res);
  const addon = config.getAddon(req.params.addonId);
  if (!addon) return res.status(404).json({ error: 'Addon inconnu' });
  try {
    const upstream = config.getState().settings.upstream;
    const manifest = await fetchManifest(addon, upstream);
    res.json(manifest);
  } catch (e) {
    res.status(502).json({ error: 'Manifest amont injoignable : ' + e.message });
  }
});

app.get('/:addonId/*rest', async (req, res) => {
  cors(res);
  const addon = config.getAddon(req.params.addonId);
  if (!addon) return res.status(404).json({ error: 'Addon inconnu' });

  const restPath = Array.isArray(req.params.rest) ? req.params.rest.join('/') : req.params.rest;
  const qIndex = req.originalUrl.indexOf('?');
  const query = qIndex >= 0 ? req.originalUrl.slice(qIndex) : '';

  try {
    const upstream = config.getState().settings.upstream;
    const out = await fetchResource(addon, restPath, query, baseUrl(req), upstream);
    if (restPath.startsWith('stream/')) {
      stats.recordStream(addon, out.proxied, out.total);
      log(`[stream] addon=${addon.name} ${restPath} -> ${out.proxied}/${out.total} flux proxifies`);
    }
    res.status(out.status);
    res.setHeader('Content-Type', out.contentType);
    res.send(out.body);
  } catch (e) {
    res.status(502).json({ error: 'Ressource amont injoignable : ' + e.message });
  }
});

// ---- Interface web ---------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Stremio Addon Proxy demarre sur le port ${PORT}`);
  console.log(`Interface : http://localhost:${PORT}`);
});
