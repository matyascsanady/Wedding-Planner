'use strict';
/*
 * Wedding Seating Planner — tiny self-hosted server.
 * No npm packages needed: runs on plain Node.js (18+).
 *
 * Serves wedding-planner.html and stores the plan on disk so every device sees the same plan:
 *   DATA_DIR/current.json        the live plan (versioned, so two devices can't silently overwrite each other)
 *   DATA_DIR/saves/*.json        named configurations ("Save / Load")
 *   DATA_DIR/backups/*.json      hourly snapshots of the live plan (newest BACKUP_KEEP kept)
 *
 * Environment:
 *   PORT        port to listen on                       (default 8080)
 *   DATA_DIR    where plans are stored                   (default ./data)
 *   AUTH_USER   optional — set both to require a login   (HTTP basic auth)
 *   AUTH_PASS
 *   BACKUP_KEEP number of hourly backups to keep         (default 200)
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const APP_FILE = path.join(__dirname, 'wedding-planner.html');
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
const BACKUP_KEEP = parseInt(process.env.BACKUP_KEEP, 10) || 200;
const BACKUP_EVERY_MS = 60 * 60 * 1000;
const MAX_BODY = 20 * 1024 * 1024;
const MAX_NAME = 120;

const CURRENT_FILE = path.join(DATA_DIR, 'current.json');
const SAVES_DIR = path.join(DATA_DIR, 'saves');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

/* ---------- small helpers ---------- */
class HttpError extends Error { constructor(status, msg){ super(msg); this.status = status; } }

// all writes go through one queue so concurrent requests can't interleave
let queue = Promise.resolve();
function serial(fn){ const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; }

async function readJson(file, fallback){
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (e){ if (e.code === 'ENOENT') return fallback; throw e; }
}
async function writeJsonAtomic(file, obj){
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(obj));
  await fsp.rename(tmp, file);
}
const nameToFile = name => path.join(SAVES_DIR, Buffer.from(name, 'utf8').toString('base64url') + '.json');

function send(res, status, body, headers = {}){
  res.writeHead(status, {'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', ...headers});
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'});

function readBody(req){
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY){ reject(new HttpError(413, 'Plan too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); }
      catch (e){ reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function checkPlan(state){
  if (!state || typeof state !== 'object' || !Array.isArray(state.guests) || !Array.isArray(state.tables))
    throw new HttpError(400, 'Not a seating plan');
}
function checkName(name){
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME) throw new HttpError(400, 'Invalid configuration name');
  return name;
}

/* ---------- optional login ---------- */
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
function authorized(req){
  if (!AUTH_USER && !AUTH_PASS) return true;
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  const okUser = crypto.timingSafeEqual(sha(decoded.slice(0, i)), sha(AUTH_USER));
  const okPass = crypto.timingSafeEqual(sha(decoded.slice(i + 1)), sha(AUTH_PASS));
  return okUser && okPass;
}

/* ---------- backups ---------- */
let lastBackupAt = 0;
async function maybeBackup(doc){
  if (Date.now() - lastBackupAt < BACKUP_EVERY_MS) return;
  lastBackupAt = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeJsonAtomic(path.join(BACKUP_DIR, `plan-${stamp}.json`), doc);
  const files = (await fsp.readdir(BACKUP_DIR)).filter(f => f.startsWith('plan-') && f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) await fsp.unlink(path.join(BACKUP_DIR, f)).catch(() => {});
}

/* ---------- routes ---------- */
async function handle(req, res){
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/{2,}/g, '/');
  const method = req.method;

  // health check stays open so Docker/Portainer can probe it; it reveals nothing about the plan
  if (p === '/api/health') return json(res, 200, {ok:true, app:'wedding-planner-server', version:1});

  if (!authorized(req)){
    return send(res, 401, 'Login required', {'WWW-Authenticate':'Basic realm="Wedding Planner", charset="UTF-8"', 'Content-Type':'text/plain; charset=utf-8'});
  }

  if (method === 'GET' && (p === '/' || p === '/index.html' || p === '/wedding-planner.html')){
    const html = await fsp.readFile(APP_FILE); // read every time, so replacing the file needs no restart
    return send(res, 200, html, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-cache'});
  }

  if (p === '/api/version' && method === 'GET'){
    const cur = await readJson(CURRENT_FILE, null);
    return json(res, 200, {version:cur ? cur.version : 0, updatedAt:cur ? cur.updatedAt : null});
  }

  if (p === '/api/current'){
    if (method === 'GET'){
      const cur = await readJson(CURRENT_FILE, null);
      return json(res, 200, cur || {version:0, state:null});
    }
    if (method === 'PUT'){
      const body = await readBody(req);
      if (!body || typeof body !== 'object') throw new HttpError(400, 'Missing body');
      checkPlan(body.state);
      const force = url.searchParams.get('force') === '1';
      const result = await serial(async () => {
        const cur = await readJson(CURRENT_FILE, null);
        const curVersion = cur ? cur.version : 0;
        // optimistic locking: refuse to overwrite a version this client hasn't seen
        if (!force && body.baseVersion !== curVersion) return {conflict:cur || {version:0, state:null}};
        const next = {version:curVersion + 1, updatedAt:new Date().toISOString(),
          saveName:typeof body.saveName === 'string' ? body.saveName : null, dirty:!!body.dirty, state:body.state};
        await writeJsonAtomic(CURRENT_FILE, next);
        await maybeBackup(next).catch(e => console.error('backup failed:', e.message));
        return {next};
      });
      if (result.conflict) return json(res, 409, result.conflict);
      return json(res, 200, {version:result.next.version, updatedAt:result.next.updatedAt});
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (p === '/api/saves' && method === 'GET'){
    const files = (await fsp.readdir(SAVES_DIR)).filter(f => f.endsWith('.json'));
    const list = [];
    for (const f of files){
      try {
        const s = JSON.parse(await fsp.readFile(path.join(SAVES_DIR, f), 'utf8'));
        list.push({name:s.name, savedAt:s.savedAt, guests:(s.data?.guests || []).length, tables:(s.data?.tables || []).length});
      } catch (e){ /* skip unreadable files */ }
    }
    list.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    return json(res, 200, list);
  }

  const m = /^\/api\/saves\/([^/]+)$/.exec(p);
  if (m){
    let name;
    try { name = decodeURIComponent(m[1]); } catch (e){ throw new HttpError(400, 'Invalid configuration name'); }
    checkName(name);
    const file = nameToFile(name);
    if (method === 'GET'){
      const s = await readJson(file, null);
      if (!s) throw new HttpError(404, 'No such configuration');
      return json(res, 200, s);
    }
    if (method === 'PUT'){
      const body = await readBody(req);
      checkPlan(body && body.data);
      const doc = {name, savedAt:Date.now(), data:body.data};
      await serial(() => writeJsonAtomic(file, doc));
      return json(res, 200, {ok:true, savedAt:doc.savedAt});
    }
    if (method === 'DELETE'){
      await serial(() => fsp.unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; }));
      return json(res, 200, {ok:true});
    }
    throw new HttpError(405, 'Method not allowed');
  }

  throw new HttpError(404, 'Not found');
}

/* ---------- start ---------- */
async function main(){
  await fsp.mkdir(SAVES_DIR, {recursive:true});
  await fsp.mkdir(BACKUP_DIR, {recursive:true});
  await fsp.access(APP_FILE).catch(() => { throw new Error(`wedding-planner.html not found next to server.js (${APP_FILE})`); });

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      const status = err.status || 500;
      if (status >= 500) console.error(new Date().toISOString(), req.method, req.url, err);
      if (!res.headersSent) json(res, status, {error:status >= 500 ? 'Server error' : err.message});
      else res.end();
    });
  });
  server.listen(PORT, () => {
    console.log(`Wedding planner running on port ${PORT} — data in ${DATA_DIR}` + (AUTH_USER || AUTH_PASS ? ' — login required' : ''));
  });
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
main().catch(err => { console.error(err.message || err); process.exit(1); });
