/**
 * 外部データ配信元の疎通・CORS 確認（依存なし / Node 18+ の fetch を使用）
 *   node scripts/check-endpoints.mjs [--origin https://example.github.io] [--quick]
 *
 * 全国版: 6 サンプル都市（名古屋・高知・静岡・黒潮町・宮崎・那覇）の代表点から z14 / z15 タイル座標を
 * 計算し、次を確認する。
 *   - 重ねるハザードマップ 津波浸水想定 統合タイル（04_tsunami_newlegend_data）× 6 都市（z14）
 *   - 地理院 標高タイル dem5a_png / dem5b_png（z15）と dem_png（z14）× 6 都市
 *       dem5a / dem5b は範囲限定のため 404 は「範囲外（想定内）」として SKIP 扱い
 *   - 地理院 淡色地図 / 全国最新写真（名古屋のみ）
 *   - 地理院ベクトルタイル experimental_bvmap（名古屋 z14）
 *   - PLATEAU PMTiles（2022 LOD1 / 2023 LOD0）のヘッダー Range 要求（206 + CORS + magic）
 *   - MapLibre demo glyphs（参考）
 * 各行に HTTP ステータス・Content-Type・Access-Control-Allow-Origin・Content-Range・Cache-Control を表示する。
 */
const argv = process.argv.slice(2);
const originIdx = argv.indexOf('--origin');
const ORIGIN = originIdx >= 0 ? argv[originIdx + 1] : 'https://example.github.io';
const QUICK = argv.includes('--quick'); // 都市ごとの DEM を dem_png だけにする

/** 経緯度 → XYZ タイル座標 */
function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { z, x, y };
}

// DATA_CONTRACT の 6 サンプル都市（沿岸側の代表点。市役所ではなく海岸近くを選ぶ）
const CITIES = [
  { code: '23100', name: '名古屋市（港区）', lon: 136.88, lat: 35.09 },
  { code: '39201', name: '高知市', lon: 133.56, lat: 33.53 },
  { code: '22100', name: '静岡市（駿河区）', lon: 138.40, lat: 34.95 },
  { code: '39428', name: '黒潮町', lon: 133.02, lat: 33.02 },
  { code: '45201', name: '宮崎市', lon: 131.45, lat: 31.90 },
  { code: '47201', name: '那覇市', lon: 127.68, lat: 26.21 },
];

const GSI = 'https://cyberjapandata.gsi.go.jp/xyz';
const HAZARD = 'https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data';

const TARGETS = [];
for (const c of CITIES) {
  const t14 = lonLatToTile(c.lon, c.lat, 14);
  const t15 = lonLatToTile(c.lon, c.lat, 15);
  TARGETS.push({
    group: 'hazard',
    name: `Hazard tsunami 統合 ${c.name} (${c.code}) z${t14.z}/${t14.x}/${t14.y}`,
    url: `${HAZARD}/${t14.z}/${t14.x}/${t14.y}.png`,
    optional404: true, // 想定範囲外（海上のみ等）の 404 は想定内
  });
  TARGETS.push({
    group: 'dem',
    name: `GSI dem_png (DEM10B) ${c.name} z${t14.z}/${t14.x}/${t14.y}`,
    url: `${GSI}/dem_png/${t14.z}/${t14.x}/${t14.y}.png`,
  });
  if (!QUICK) {
    TARGETS.push({
      group: 'dem',
      name: `GSI dem5a_png ${c.name} z${t15.z}/${t15.x}/${t15.y}`,
      url: `${GSI}/dem5a_png/${t15.z}/${t15.x}/${t15.y}.png`,
      optional404: true,
    });
    TARGETS.push({
      group: 'dem',
      name: `GSI dem5b_png ${c.name} z${t15.z}/${t15.x}/${t15.y}`,
      url: `${GSI}/dem5b_png/${t15.z}/${t15.x}/${t15.y}.png`,
      optional404: true,
    });
  }
}

const nagoya = lonLatToTile(CITIES[0].lon, CITIES[0].lat, 14);
TARGETS.push(
  { group: 'base', name: 'GSI pale（名古屋 z14）', url: `${GSI}/pale/${nagoya.z}/${nagoya.x}/${nagoya.y}.png` },
  { group: 'base', name: 'GSI seamlessphoto（名古屋 z14）', url: `${GSI}/seamlessphoto/${nagoya.z}/${nagoya.x}/${nagoya.y}.jpg` },
  {
    group: 'base',
    name: 'GSI experimental_bvmap（ベクトル・名古屋 z14）',
    url: `${GSI}/experimental_bvmap/${nagoya.z}/${nagoya.x}/${nagoya.y}.pbf`,
  },
  {
    group: 'pmtiles',
    name: 'PLATEAU PMTiles 2022 LOD1 header (Range 0-16383)',
    url: 'https://shiworks.xsrv.jp/pmtiles-data/plateau/PLATEAU_2022_LOD1.pmtiles',
    headers: { Range: 'bytes=0-16383' },
    expect: 206,
    pmtiles: true,
  },
  {
    group: 'pmtiles',
    name: 'PLATEAU PMTiles 2023 LOD0 header (Range 0-16383)',
    url: 'https://shiworks.xsrv.jp/pmtiles-data/plateau/PLATEAU_2023_LOD0.pmtiles',
    headers: { Range: 'bytes=0-16383' },
    expect: 206,
    pmtiles: true,
  },
  {
    group: 'misc',
    name: 'MapLibre demo glyphs（参考・未使用）',
    url: 'https://demotiles.maplibre.org/font/Open%20Sans%20Regular/0-255.pbf',
    optional404: true,
  },
);

const pick = (h, k) => h.get(k) ?? '-';

async function check(t) {
  const started = Date.now();
  try {
    const res = await fetch(t.url, {
      method: 'GET',
      headers: { Origin: ORIGIN, ...(t.headers ?? {}) },
      signal: AbortSignal.timeout(20000),
    });
    const buf = await res.arrayBuffer();
    const ms = Date.now() - started;
    const h = res.headers;
    let verdict;
    if (t.expect ? res.status === t.expect : res.ok) verdict = 'OK  ';
    else if (t.optional404 && res.status === 404) verdict = 'SKIP';
    else verdict = 'NG  ';
    let extra = '';
    if (t.pmtiles) {
      const magic = Buffer.from(buf.slice(0, 7)).toString('ascii');
      extra = ` magic=${JSON.stringify(magic)}${magic === 'PMTiles' ? ' (ok)' : ' (unexpected)'}`;
      if (magic !== 'PMTiles' && verdict === 'OK  ') verdict = 'NG  ';
    }
    const lines = [
      `${verdict.padEnd(5)}${t.name}`,
      `    url            : ${t.url}`,
      `    status         : ${res.status} ${res.statusText} (${ms} ms, ${buf.byteLength} bytes)${extra}${verdict === 'SKIP' ? '  ← 範囲外（想定内）' : ''}`,
      `    content-type   : ${pick(h, 'content-type')}`,
      `    acao           : ${pick(h, 'access-control-allow-origin')}`,
    ];
    if (t.pmtiles) {
      lines.push(
        `    acah / expose  : ${pick(h, 'access-control-allow-headers')} / ${pick(h, 'access-control-expose-headers')}`,
        `    accept-ranges  : ${pick(h, 'accept-ranges')}`,
        `    content-range  : ${pick(h, 'content-range')}`,
      );
    }
    lines.push(`    cache-control  : ${pick(h, 'cache-control')}`);
    return { verdict: verdict.trim(), text: lines.join('\n') };
  } catch (e) {
    return { verdict: 'NG', text: `NG  ${t.name}\n    url            : ${t.url}\n    error          : ${e?.message ?? e}` };
  }
}

console.log(`# check-endpoints  ${new Date().toISOString()}  Origin: ${ORIGIN}  targets: ${TARGETS.length}`);
const results = [];
// 同一ホストへの同時要求を抑えるため 4 並列で回す
const queue = TARGETS.slice();
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const t = queue.shift();
      results[TARGETS.indexOf(t)] = await check(t);
    }
  }),
);
console.log(results.map((r) => r.text).join('\n\n'));
const ng = results.filter((r) => r.verdict === 'NG').length;
const skip = results.filter((r) => r.verdict === 'SKIP').length;
console.log(`\n${TARGETS.length - ng - skip}/${TARGETS.length} OK, ${skip} SKIP (404 範囲外), ${ng} NG`);
process.exitCode = ng ? 1 : 0;
