/**
 * PMTiles のヘッダー・メタデータ・（任意）タイル内容を確認する。
 *   node scripts/inspect-pmtiles.mjs [url] [--at lon,lat] [--zoom 16] [--layer name] [--full]
 *   --at   指定地点を含むタイルを Range 要求で取得し、属性の充足率・ID 一意性を表示する
 *   --full メタデータを省略せず表示
 * 依存: pmtiles（Range 要求）、@mapbox/vector-tile + pbf（maplibre-gl の依存として同梱）
 */
import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { gunzipSync } from 'node:zlib';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--')));
const url = positional[0] ?? 'https://shiworks.xsrv.jp/pmtiles-data/plateau/PLATEAU_2022_LOD1.pmtiles';
const at = opt('--at', null);
const zoom = Number(opt('--zoom', '16'));
const full = argv.includes('--full');

export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { z, x, y };
}

const p = new PMTiles(url);
const h = await p.getHeader();
console.log('header', {
  minZoom: h.minZoom,
  maxZoom: h.maxZoom,
  bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat],
  tileType: h.tileType,
  tileCompression: h.tileCompression,
});
const m = await p.getMetadata();
if (full) console.log(JSON.stringify(m, null, 2));
else {
  console.log('vector_layers', JSON.stringify(m.vector_layers, null, 2));
  console.log('generator_options', m.generator_options);
}

if (at) {
  const [lon, lat] = at.split(',').map(Number);
  const t = lonLatToTile(lon, lat, zoom);
  console.log(`\n# tile ${t.z}/${t.x}/${t.y} @ ${lon},${lat}`);
  const res = await p.getZxy(t.z, t.x, t.y);
  if (!res) {
    console.log('no tile');
    process.exit(0);
  }
  let buf = new Uint8Array(res.data);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  const vt = new VectorTile(new PbfReader(buf));
  for (const [name, layer] of Object.entries(vt.layers)) {
    const layerFilter = opt('--layer', null);
    if (layerFilter && layerFilter !== name) continue;
    const n = layer.length;
    const present = new Map();
    const uniq = new Map();
    let withFeatureId = 0;
    const featIds = new Set();
    for (let i = 0; i < n; i++) {
      const f = layer.feature(i);
      if (f.id !== undefined) {
        withFeatureId++;
        featIds.add(f.id);
      }
      for (const [k, v] of Object.entries(f.properties)) {
        if (v === null || v === undefined || v === '') continue;
        present.set(k, (present.get(k) ?? 0) + 1);
        if (!uniq.has(k)) uniq.set(k, new Set());
        if (uniq.get(k).size < 100000) uniq.get(k).add(String(v));
      }
    }
    console.log(`layer "${name}": ${n} features, extent ${layer.extent}, feature.id set on ${withFeatureId} (${featIds.size} unique)`);
    const rows = [...present.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, c]) => `  ${k.padEnd(28)} present ${String(c).padStart(6)}/${n}  unique ${uniq.get(k).size}`);
    console.log(rows.join('\n'));
    const sample = layer.feature(0).properties;
    console.log('  sample:', JSON.stringify(sample).slice(0, 600));
  }
}
