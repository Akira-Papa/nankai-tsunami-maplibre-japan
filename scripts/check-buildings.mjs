/**
 * 沿岸都市ごとに建物データ 3 段（PLATEAU LOD1 2022 / LOD0 2023 / 地理院 bvmap）の有無を確認する。
 *   node scripts/check-buildings.mjs [--radius 1] [--city 高知市]
 *   --radius N  市中心タイルの周囲 N タイル（(2N+1)^2 枚）まで探す（既定 1）
 * PMTiles は `pmtiles` パッケージの FetchSource（Range 要求）でディレクトリを引き、z16 タイルの有無とバイト数を出す。
 * bvmap は z15 / z16 の .pbf を GET し、ステータス・バイト数・building ポリゴン数を出す。
 */
import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { gunzipSync } from 'node:zlib';

const LOD1_URL = 'https://shiworks.xsrv.jp/pmtiles-data/plateau/PLATEAU_2022_LOD1.pmtiles';
const LOD0_URL = 'https://shiworks.xsrv.jp/pmtiles-data/plateau/PLATEAU_2023_LOD0.pmtiles';
const BVMAP_URL = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/${z}/${x}/${y}.pbf`;

// 市役所・町役場付近の代表点（WGS84）
const CITIES = [
  { code: '39201', name: '高知市', lon: 133.5311, lat: 33.5597 },
  { code: '39428', name: '黒潮町', lon: 133.0133, lat: 33.0222 },
  { code: '45201', name: '宮崎市', lon: 131.4202, lat: 31.9077 },
  { code: '22100', name: '静岡市', lon: 138.3828, lat: 34.9756 },
  { code: '47201', name: '那覇市', lon: 127.6809, lat: 26.2124 },
  { code: '23100', name: '名古屋市', lon: 136.9066, lat: 35.1815 },
  { code: '24209', name: '尾鷲市', lon: 136.1909, lat: 34.0708 },
  { code: '46201', name: '鹿児島市', lon: 130.5581, lat: 31.5966 },
];

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const RADIUS = Number(opt('--radius', '1'));
const ONLY = opt('--city', null);

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { z, x, y };
}

function decodeBuildings(data) {
  let buf = new Uint8Array(data);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  const vt = new VectorTile(new PbfReader(buf));
  const layer = vt.layers.building;
  if (!layer) return { polygons: 0, lines: 0, layers: Object.keys(vt.layers) };
  let polygons = 0;
  let lines = 0;
  for (let i = 0; i < layer.length; i++) {
    const t = layer.feature(i).type;
    if (t === 3) polygons++;
    else if (t === 2) lines++;
  }
  return { polygons, lines };
}

/** 中心タイルと周囲のタイルを探し、最初に見つかったタイルのバイト数と探索枚数を返す */
async function probePmtiles(p, center, radius) {
  let checked = 0;
  let hit = null;
  let firstError = null;
  // 中心 → 周囲の順（距離順）
  const offsets = [];
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) offsets.push([dx, dy]);
  offsets.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
  for (const [dx, dy] of offsets) {
    checked++;
    try {
      const res = await p.getZxy(center.z, center.x + dx, center.y + dy);
      if (res && res.data && res.data.byteLength > 0) {
        hit = { bytes: res.data.byteLength, dx, dy };
        break;
      }
    } catch (e) {
      firstError ??= e?.message ?? String(e);
    }
  }
  return { hit, checked, error: firstError };
}

async function probeBvmap(lon, lat, z) {
  const t = lonLatToTile(lon, lat, z);
  const url = BVMAP_URL(t.z, t.x, t.y);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { Origin: 'https://example.github.io' } });
    const buf = await res.arrayBuffer();
    const out = { status: res.status, bytes: buf.byteLength, acao: res.headers.get('access-control-allow-origin') };
    if (res.ok) Object.assign(out, decodeBuildings(buf));
    return out;
  } catch (e) {
    return { status: 'ERR', error: e?.message ?? String(e) };
  }
}

function pad(s, n, right = false) {
  s = String(s);
  // 全角文字は幅 2 として揃える
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0) > 0xff ? 2 : 1;
  const fill = ' '.repeat(Math.max(0, n - w));
  return right ? fill + s : s + fill;
}

const started = Date.now();
console.log(`# check-buildings  ${new Date().toISOString()}  radius=${RADIUS}`);
const lod1 = new PMTiles(LOD1_URL);
const lod0 = new PMTiles(LOD0_URL);
const [h1, h0] = await Promise.all([lod1.getHeader(), lod0.getHeader()]);
console.log(`LOD1: z${h1.minZoom}-${h1.maxZoom} bounds=[${[h1.minLon, h1.minLat, h1.maxLon, h1.maxLat].map((v) => v.toFixed(3)).join(', ')}]`);
console.log(`LOD0: z${h0.minZoom}-${h0.maxZoom} bounds=[${[h0.minLon, h0.minLat, h0.maxLon, h0.maxLat].map((v) => v.toFixed(3)).join(', ')}]`);
console.log('');

const rows = [];
for (const c of CITIES) {
  if (ONLY && c.name !== ONLY) continue;
  const t16 = lonLatToTile(c.lon, c.lat, 16);
  const [r1, r0, b16, b15] = await Promise.all([
    probePmtiles(lod1, t16, RADIUS),
    probePmtiles(lod0, t16, RADIUS),
    probeBvmap(c.lon, c.lat, 16),
    probeBvmap(c.lon, c.lat, 15),
  ]);
  const fmtP = (r) => {
    if (r.error && !r.hit) return `ERR ${r.error.slice(0, 20)}`;
    if (!r.hit) return `-- (0/${r.checked})`;
    const where = r.hit.dx === 0 && r.hit.dy === 0 ? 'center' : `d=(${r.hit.dx},${r.hit.dy})`;
    return `OK ${(r.hit.bytes / 1024).toFixed(0)}KB ${where}`;
  };
  const fmtB = (b) =>
    b.status === 200 ? `200 ${(b.bytes / 1024).toFixed(0)}KB poly=${b.polygons}` : `${b.status}${b.error ? ' ' + b.error.slice(0, 16) : ''}`;
  const expected =
    r1.hit ? 'lod1' : r0.hit ? 'lod0' : b16.status === 200 && b16.polygons > 0 ? 'bvmap' : 'none';
  rows.push({
    city: `${c.name} (${c.code})`,
    tile: `${t16.z}/${t16.x}/${t16.y}`,
    lod1: fmtP(r1),
    lod0: fmtP(r0),
    bv16: fmtB(b16),
    bv15: fmtB(b15),
    tier: expected,
  });
}

const cols = [
  ['city', '都市', 20],
  ['tile', 'z16タイル', 18],
  ['lod1', 'LOD1 2022', 22],
  ['lod0', 'LOD0 2023', 22],
  ['bv16', 'bvmap z16', 22],
  ['bv15', 'bvmap z15', 22],
  ['tier', '想定段', 7],
];
console.log(cols.map(([, label, w]) => pad(label, w)).join(' | '));
console.log(cols.map(([, , w]) => '-'.repeat(w)).join('-+-'));
for (const r of rows) console.log(cols.map(([k, , w]) => pad(r[k], w)).join(' | '));
console.log(`\n${rows.length} cities in ${((Date.now() - started) / 1000).toFixed(1)} s`);
