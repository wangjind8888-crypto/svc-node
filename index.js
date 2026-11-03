// render-node bootstrap: downloads official Xray, writes config, runs VLESS+WS on $PORT.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');

const UUID = process.env.NODE_UUID;
const WS_PATH = process.env.WS_PATH || '/ws';
const PORT = parseInt(process.env.PORT || '10000', 10);
const VER = 'v26.10.31';
const ZIP_URL = `https://github.com/XTLS/Xray-core/releases/download/${VER}/Xray-linux-64.zip`;
const DGST_URL = ZIP_URL + '.dgst';
const ZIP_FILE = path.join(__dirname, 'xray.zip');
const BIN = path.join(__dirname, 'xray');

function log(...a) { console.log('[bootstrap]', ...a); }

function download(url, dest, redirects = 6) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'node-bootstrap' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        if (!redirects) return reject(new Error('too many redirects'));
        res.resume();
        return resolve(download(res.headers.location, dest, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      if (!dest) { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); return; }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
    }).on('error', reject);
  });
}

function unzip(zipPath, destDir) {
  const data = fs.readFileSync(zipPath);
  // find End Of Central Directory
  let eocd = -1;
  for (let i = data.length - 22; i >= 0; i--) { if (data.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('bad zip');
  const count = data.readUInt16LE(eocd + 10);
  let off = data.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (data.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central dir');
    const method = data.readUInt16LE(off + 10);
    const compSize = data.readUInt32LE(off + 20);
    const nameLen = data.readUInt16LE(off + 28);
    const extraLen = data.readUInt16LE(off + 30);
    const commentLen = data.readUInt16LE(off + 32);
    const localOff = data.readUInt32LE(off + 42);
    const name = data.toString('utf8', off + 46, off + 46 + nameLen);
    const lNameLen = data.readUInt16LE(localOff + 26);
    const lExtraLen = data.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const comp = data.slice(dataOff, dataOff + compSize);
    let content;
    if (method === 0) content = comp;
    else if (method === 8) content = zlib.inflateRawSync(comp);
    else throw new Error('unsupported zip method ' + method);
    if (!name.endsWith('/')) {
      const target = path.join(destDir, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
}

async function ensureXray() {
  if (fs.existsSync(BIN)) { log('xray binary present'); return; }
  log('downloading xray', VER);
  await download(ZIP_URL, ZIP_FILE);
  const dgst = await download(DGST_URL, null);
  const m = dgst.match(/SHA256= ([0-9a-f]{64})/) || dgst.match(/([0-9a-f]{64})/);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(ZIP_FILE)).digest('hex');
  if (!m || m[1] !== actual) throw new Error('sha256 mismatch: got ' + actual);
  log('sha256 verified');
  unzip(ZIP_FILE, __dirname);
  fs.chmodSync(BIN, 0o755);
  log('xray extracted');
}

function writeConfig() {
  const cfg = {
    log: { loglevel: 'warning' },
    inbounds: [{
      listen: '0.0.0.0', port: PORT, protocol: 'vless',
      settings: { clients: [{ id: UUID }], decryption: 'none' },
      streamSettings: { network: 'ws', security: 'none', wsSettings: { path: WS_PATH } },
    }],
    outbounds: [{ protocol: 'freedom' }],
  };
  fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(cfg, null, 2));
  log('config written, port', PORT);
}

let child = null;
function runXray() {
  writeConfig();
  child = spawn(BIN, ['run', '-c', path.join(__dirname, 'config.json')], { stdio: 'inherit' });
  child.on('exit', (code) => { log('xray exited', code, '- restarting in 3s'); setTimeout(runXray, 3000); });
}

if (!UUID) { console.error('[bootstrap] NODE_UUID env is required'); process.exit(1); }
(async () => {
  try { await ensureXray(); runXray(); }
  catch (e) { console.error('[bootstrap] fatal:', e.message); setInterval(() => {}, 10000); }
})();
setInterval(() => {}, 30000);
