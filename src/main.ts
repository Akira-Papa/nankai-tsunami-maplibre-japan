/**
 * 全国版 南海トラフ津波 3D ビジュアライザ（MapLibre GL JS v6 + color-relief）エントリ
 *
 * 構成（下 → 上）:
 *   bg → pale / photo（地理院）→ hillshade → tsunami-relief（what-if・color-relief）
 *   → whatif-mask（選択市区町村の外側を暗く覆う反転マスク）→ hazard-official（重ねるハザードマップ 全国統合）
 *   → buildings（PLATEAU PMTiles・M2 所有）
 *
 * - 公式想定（hazard-official）が全国の主レイヤー（既定 ON）
 * - what-if（tsunami-relief）は選択市区町村の内側だけに表示するローカル試算（既定 OFF）。
 *   H = 選択市区町村の内閣府津波高（プリセット）または手動値
 * - DEM: 既定は地理院（`gsidem://` プロトコルで dem_png / dem5a / dem5b を terrarium へ変換）。
 *   `?dem=mapterhorn` で Mapterhorn（terrarium・512px・© Mapterhorn）へ切替
 * - URL: `?m=39201`（初期選択市区町村）`?h=5.0`（初期津波高・手動）
 */
import { Map as MapLibreMap, NavigationControl, ScaleControl, addProtocol, setWorkerUrl } from 'maplibre-gl';
// MapLibre v6 は import.meta.url 相対で worker を探すため、Vite では明示的に worker URL を渡す
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type {
  ExpressionSpecification,
  StyleSpecification,
  ErrorEvent,
  LngLatBoundsLike,
  RasterDEMSourceSpecification,
} from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { GSI_XYZ_BASE, gsidemProtocol } from './gsidem';
import {
  loadAll,
  ensureCoastalPref,
  findMunicipality,
  findTsunamiRow,
  geometryFor,
  geometryBbox,
  type AppData,
  type Municipality,
  type MunicipalityGeometry,
} from './data';
import { initUi, type UiHandle, type UiState } from './ui';
import { findCase, findIntensity } from './scenarios';
import { createSlipOverlay } from './slipRegions';
import { addBuildingLayers } from './buildings';
import { createMask, MASK_LAYER_ID } from './mask';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------
/** 初期表示（市区町村未指定時）: 南海トラフ沿岸（沖縄〜関東）を俯瞰 */
const JAPAN_BOUNDS: LngLatBoundsLike = [
  [126.5, 25.5],
  [141.5, 37.5],
];
const H_MIN = 0;
const H_MAX = 35;
const TERRAIN_EXAGGERATION = 1.5;
const DEM_PROBE_URL = `${GSI_XYZ_BASE}/dem_png/14/14269/6569.png`; // 高知市中心部の z14 タイル
const MAPTERHORN_TILES = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';

const LAYER = {
  bg: 'bg',
  pale: 'pale',
  photo: 'photo',
  hillshade: 'hillshade',
  relief: 'tsunami-relief',
  mask: MASK_LAYER_ID,
  hazard: 'hazard-official',
} as const;

// 浸水深による濃淡（深いほど濃い青）
const WATER_DEEP = 'rgba(12,74,110,0.78)'; // 3 m 以上
const WATER_MID = 'rgba(21,110,150,0.68)'; // 1 m
const WATER_SHALLOW = 'rgba(56,168,200,0.55)'; // 0 m（水際）
const TRANSPARENT = 'rgba(0,0,0,0)';

const PRESET_LABEL: Record<UiState['preset'], string> = {
  max_2025: '2025 最大',
  mean_2025: '2025 平均',
  max_2012: '2012 最大',
  case: 'ケース別',
  manual: '手動',
};

/**
 * ズーム上限。地理院DEMは z15、公式浸水想定ラスタは z17、淡色地図は z18 が原寸で、
 * それ以上は MapLibre が親タイルを拡大表示する（overzoom）。
 * z19 でも描画は破綻しないが、公式想定が 4 倍に引き伸ばされ粗さが目立つため、
 * 地図が原寸で読める z18 を上限とする（データの精度は上がらない旨を操作案内に明記）。
 */
const MAX_ZOOM = 18;

type DemMode = 'gsi' | 'mapterhorn';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// ---------------------------------------------------------------------------
// 津波高 → color-relief 式
// MapLibre v6 の color-relief は `interpolate` 式のみを色ランプに変換する（step は非対応）。
// H と H+0.01 の間で急峻に切り替える interpolate 式で「H以下=青／超=透明」を表現する。
// 標高ストップは terrarium の 1/256 m 精度でパックされるため 0.01 m 差（約2.6単位）は判別できる。
// ---------------------------------------------------------------------------
function clampHeight(h: number): number {
  if (!Number.isFinite(h)) return H_MIN;
  return Math.round(Math.max(H_MIN, Math.min(H_MAX, h)) * 100) / 100;
}

function reliefExpression(h: number): ExpressionSpecification {
  const hh = clampHeight(h);
  const stops: [number, string][] = [
    [-100, WATER_DEEP],
    [hh - 3, WATER_DEEP],
    [hh - 1, WATER_MID],
    [hh, WATER_SHALLOW],
    [hh + 0.01, TRANSPARENT],
    [4000, TRANSPARENT],
  ];
  // interpolate のストップは厳密に昇順。同値になった場合は 1/256 m だけ押し出す
  for (let i = 1; i < stops.length; i++) {
    if (stops[i][0] <= stops[i - 1][0]) stops[i][0] = stops[i - 1][0] + 1 / 256;
  }
  return ['interpolate', ['linear'], ['elevation'], ...stops.flat()] as ExpressionSpecification;
}

// ---------------------------------------------------------------------------
// スタイル
// ---------------------------------------------------------------------------
function demSource(mode: DemMode): RasterDEMSourceSpecification {
  if (mode === 'mapterhorn') {
    return {
      type: 'raster-dem',
      tiles: [MAPTERHORN_TILES],
      tileSize: 512,
      encoding: 'terrarium',
      minzoom: 1,
      maxzoom: 16,
      attribution: '<a href="https://mapterhorn.com/" target="_blank">© Mapterhorn</a>',
    };
  }
  return {
    type: 'raster-dem',
    // z≤14: dem_png（10 m）／z15: dem5a_png → dem5b_png → 親 z14 タイル 2× 拡大（src/gsidem.ts）
    tiles: ['gsidem://gsi/{z}/{x}/{y}'],
    tileSize: 256,
    encoding: 'terrarium',
    minzoom: 1,
    maxzoom: 15,
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル（標高タイル）</a>',
  };
}

function buildStyle(initialHeight: number, dem: DemMode, s: UiState): StyleSpecification {
  const vis = (on: boolean): 'visible' | 'none' => (on ? 'visible' : 'none');
  return {
    version: 8,
    sources: {
      pale: {
        type: 'raster',
        tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 18,
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>',
      },
      photo: {
        type: 'raster',
        tiles: ['https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg'],
        tileSize: 256,
        maxzoom: 18,
        attribution: '地理院タイル（全国最新写真）',
      },
      dem: demSource(dem),
      hazard: {
        type: 'raster',
        // 重ねるハザードマップ 津波浸水想定（全国統合タイル）
        tiles: ['https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/{z}/{x}/{y}.png'],
        tileSize: 256,
        minzoom: 2,
        maxzoom: 17,
        attribution: '<a href="https://disaportal.gsi.go.jp/" target="_blank">ハザードマップポータルサイト</a>',
      },
    },
    layers: [
      { id: LAYER.bg, type: 'background', paint: { 'background-color': '#dfe7ee' } },
      { id: LAYER.pale, type: 'raster', source: 'pale', layout: { visibility: vis(s.imagery === 'pale') } },
      { id: LAYER.photo, type: 'raster', source: 'photo', layout: { visibility: vis(s.imagery === 'photo') } },
      {
        id: LAYER.hillshade,
        type: 'hillshade',
        source: 'dem',
        layout: { visibility: vis(s.hillshade) },
        paint: {
          'hillshade-exaggeration': 0.35,
          'hillshade-shadow-color': '#4a4a4a',
          'hillshade-highlight-color': '#ffffff',
        },
      },
      {
        id: LAYER.relief,
        type: 'color-relief',
        source: 'dem',
        layout: { visibility: 'none' }, // applyState で市区町村選択と showWhatIf に応じて表示
        paint: {
          'color-relief-color': reliefExpression(initialHeight),
          'color-relief-opacity': 1,
        },
      },
      // whatif-mask は createMask() でここ（hazard-official の直前）に挿入する
      {
        id: LAYER.hazard,
        type: 'raster',
        source: 'hazard',
        layout: { visibility: vis(s.showOfficial) },
        paint: { 'raster-opacity': 0.7 },
      },
    ],
    terrain: { source: 'dem', exaggeration: TERRAIN_EXAGGERATION },
  };
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
function dataBase(): string {
  // vite base './' → index.html と同じディレクトリの data/
  return new URL('data/', document.baseURI).toString();
}

function emptyData(): AppData {
  return {
    municipalities: { generated: '', source: { n03: '', license: '' }, prefectures: [], municipalities: [] },
    coastal: { type: 'FeatureCollection', features: [] },
    tsunami: { generated: '', source: { '2025': '', '2012': '', license: '' }, unit: '', cases: [], rows: [] },
    coverage: { generated: '', pmtiles: {}, plateau_3dtiles_cities: [] },
    warnings: [],
    isFixture: false,
  };
}

function bboxToBounds(b: [number, number, number, number]): LngLatBoundsLike {
  return [
    [b[0], b[1]],
    [b[2], b[3]],
  ];
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const demMode: DemMode = params.get('dem') === 'mapterhorn' ? 'mapterhorn' : 'gsi';

  // ---- データ ----
  let data: AppData;
  const fatal: string[] = [];
  try {
    data = await loadAll(dataBase());
  } catch (err) {
    console.error('[data]', err);
    data = emptyData();
    fatal.push(`市区町村・津波高データを読み込めませんでした（${(err as Error).message}）。地図のみ表示します。`);
  }

  // ---- UI（M3）----
  const banners = new Map<string, string>();
  let ui: UiHandle;
  const pushBanner = (key: string, msg: string | null, level: 'warn' | 'error' = 'warn'): void => {
    if (msg === null) banners.delete(key);
    else banners.set(key, msg);
    const all = [...banners.values()];
    ui?.setBanner(all.length ? all.join(' ／ ') : null, all.length && fatal.length ? 'error' : level);
  };

  let applying = false;
  let currentMuni: Municipality | null = null;
  let currentGeom: { geometry: MunicipalityGeometry; fromBbox: boolean } | null = null;
  let styleReady = false;
  // map / buildings / mask は初期化後に代入（onChange から参照する）
  let map: MapLibreMap;
  let buildings: ReturnType<typeof addBuildingLayers> | null = null;
  let mask: ReturnType<typeof createMask> | null = null;
  let slip: ReturnType<typeof createSlipOverlay> | null = null;
  let lastCaseId: string | null | undefined; // undefined = 未適用

  ui = initUi(
    { municipalities: data.municipalities, tsunami: data.tsunami },
    {
      onChange: (s) => applyState(s),
      onFlyTo: (code) => flyToMunicipality(code),
      onResetView: () => resetView(),
      onFitCase: () => fitCaseAndMunicipality(),
    },
    { heightM: 5.0, preset: 'max_2025', caseId: null, intensity: null, showOfficial: true, showWhatIf: true, showBuildings: true, imagery: 'pale', hillshade: true },
  );
  for (const m of fatal) pushBanner('fatal', m, 'error');
  for (const [i, w] of data.warnings.entries()) pushBanner(`warn-${i}`, w);

  const initial = ui.getState();
  if (params.get('m') && !findMunicipality(data.municipalities, params.get('m'))) {
    pushBanner('m', `URL の市区町村コード ${params.get('m')} はデータにありません。`);
  }

  // ---- 地図 ----
  setWorkerUrl(maplibreWorkerUrl);
  addProtocol('gsidem', gsidemProtocol);
  const pmtilesProtocol = new Protocol();
  addProtocol('pmtiles', pmtilesProtocol.tile);

  const initialMuni = findMunicipality(data.municipalities, initial.muniCode);
  map = new MapLibreMap({
    container: 'map',
    style: buildStyle(initial.heightM, demMode, initial),
    bounds: initialMuni ? bboxToBounds(initialMuni.bbox) : JAPAN_BOUNDS,
    fitBoundsOptions: initialMuni ? { padding: 24, pitch: 50, bearing: -15 } : { padding: 16 },
    maxPitch: 65,
    maxZoom: MAX_ZOOM,
    minZoom: 4,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    maxTileCacheZoomLevels: 3,
    touchPitch: true,
    cooperativeGestures: false,
    attributionControl: { compact: true },
    fadeDuration: reducedMotion.matches ? 0 : 300,
    hash: false,
  });
  // セミナー実演向けに ＋− ボタンも表示（PC ではホイール、スマホではピンチと併用）
  map.addControl(new NavigationControl({ visualizePitch: true, showZoom: true }), 'top-right');
  map.addControl(new ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

  // 現在のズームをヘッダーに表示（データ解像度の目安: z15 DEM / z17 公式想定 / z18 地図）
  const zoomBadge = document.getElementById('zoom-badge');
  let zoomRaf = 0;
  const renderZoom = (): void => {
    if (!zoomBadge || zoomRaf) return;
    zoomRaf = requestAnimationFrame(() => {
      zoomRaf = 0;
      const z = map.getZoom();
      zoomBadge.textContent = `z ${z.toFixed(1)}`;
      zoomBadge.classList.toggle('overzoom', z > 17);
      zoomBadge.title = z > 17 ? '拡大表示中（z17 超は公式想定を引き伸ばして表示。精度は上がりません）' : '現在のズームレベル（最大 18）';
    });
  };
  map.on('zoom', renderZoom);
  map.on('load', renderZoom);
  renderZoom();

  if (demMode === 'mapterhorn') {
    const el = document.getElementById('attribution-mapterhorn');
    if (el) el.hidden = false;
  }

  // ---- 状態適用 ----
  function setVisibility(layerId: string, visible: boolean): void {
    if (!map.getLayer(layerId)) return;
    map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
  }

  function updateMunicipality(code: string | null): void {
    const muni = findMunicipality(data.municipalities, code);
    if (muni?.code === currentMuni?.code && currentGeom) return;
    currentMuni = muni;
    currentGeom = geometryFor(data.coastal, muni);
    mask?.setPolygon(currentGeom?.geometry ?? null);
    // 都道府県別ポリゴンが未取得なら遅延取得し、到着後に bbox 矩形から実ポリゴンへ差し替える
    if (muni && currentGeom?.fromBbox) {
      void ensureCoastalPref(data, dataBase(), muni.pref_code).then((ok) => {
        if (!ok || currentMuni?.code !== muni.code) return;
        const g = geometryFor(data.coastal, muni);
        if (g && !g.fromBbox) {
          currentGeom = g;
          mask?.setPolygon(g.geometry);
          applyState(ui.getState());
        }
      });
    }
  }

  let rafPending = false;
  let lastAppliedHeight: number | null = null;
  function applyState(s: UiState): void {
    if (applying) return;
    applying = true;
    try {
      const h = clampHeight(s.heightM);
      // 津波高を動かしたら地図へ必ず反映する: 試算表示がOFFでも自動でONにする
      if (lastAppliedHeight !== null && Math.abs(h - lastAppliedHeight) > 1e-6 && !s.showWhatIf) {
        s = { ...s, showWhatIf: true };
        ui.setState({ showWhatIf: true });
      }
      lastAppliedHeight = h;
      updateMunicipality(s.muniCode);
      // 市区町村が未選択でも全国一律の簡易試算として青塗りを表示（マスクは選択時のみ）
      const whatIfActive = s.showWhatIf;
      const maskActive = whatIfActive && currentMuni !== null;

      if (styleReady && !rafPending) {
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          if (map.getLayer(LAYER.relief)) {
            map.setPaintProperty(LAYER.relief, 'color-relief-color', reliefExpression(h));
          }
          buildings?.setWaterLevel(h);
        });
      }
      if (styleReady) {
        setVisibility(LAYER.relief, whatIfActive);
        mask?.setVisible(maskActive);
        setVisibility(LAYER.hazard, s.showOfficial);
        setVisibility(LAYER.pale, s.imagery === 'pale');
        setVisibility(LAYER.photo, s.imagery === 'photo');
        setVisibility(LAYER.hillshade, s.hillshade);
        buildings?.setVisible(s.showBuildings);
        // 震源域（大すべり域）の概略オーバーレイ: ケース選択中のみ。地図凡例も連動
        const c = findCase(s.caseId);
        slip?.setRegions(c ? c.regionKeys : []);
        const slipLegend = document.getElementById('slip-legend');
        const slipLegendText = document.getElementById('slip-legend-text');
        if (slipLegend) slipLegend.hidden = !c;
        if (slipLegendText && c) slipLegendText.textContent = `${c.label} ${c.regions}: 震源域（大すべり域・超大すべり域）の概略`;
        // ユーザーがケースを変えたときは震源域と市区町村が両方入る画角へ
        if (c && lastCaseId !== undefined && lastCaseId !== c.id) fitCaseAndMunicipality();
        lastCaseId = c ? c.id : null;
      }

      // ステータス
      const parts: string[] = [];
      const tsunamiCase = findCase(s.caseId);
      const presetText =
        s.preset === 'case' && tsunamiCase ? `${tsunamiCase.label} ${tsunamiCase.regions}` : PRESET_LABEL[s.preset];
      if (currentMuni) {
        parts.push(`${currentMuni.pref} ${currentMuni.name}: 津波高 ${h.toFixed(1)} m（${presetText}）`);
        if (currentGeom?.fromBbox) parts.push('範囲は bbox 矩形で代用');
      } else if (s.showWhatIf) {
        parts.push(`全国一律 津波高 ${h.toFixed(1)} m の簡易試算（市区町村を選ぶと範囲を絞れます）`);
      }
      const lv = findIntensity(s.intensity);
      if (lv) parts.push(`参考: ${lv.label}（浸水表示には影響しません）`);
      if (data.isFixture) parts.push('フィクスチャ（6市町）');
      if (demMode === 'mapterhorn') parts.push('DEM: Mapterhorn');
      ui.setStatus(parts.join(' ／ '));
    } finally {
      applying = false;
    }
  }

  function flyToMunicipality(code: string): void {
    const muni = findMunicipality(data.municipalities, code);
    if (!muni) return;
    updateMunicipality(muni.code);
    const bbox = currentGeom && !currentGeom.fromBbox ? geometryBbox(currentGeom.geometry) : muni.bbox;
    map.stop();
    map.fitBounds(bboxToBounds(bbox), {
      padding: 24,
      pitch: 50,
      bearing: -15,
      maxZoom: 14,
      duration: reducedMotion.matches ? 0 : 1200,
      essential: true,
    });
  }

  function fitCaseAndMunicipality(): void {
    const b = slip?.bounds();
    if (!b) return;
    if (currentMuni) {
      const bb = currentGeom && !currentGeom.fromBbox ? geometryBbox(currentGeom.geometry) : currentMuni.bbox;
      b.extend([bb[0], bb[1]]);
      b.extend([bb[2], bb[3]]);
    }
    // PC は右側パネル（400px）、スマホは下部シートの可視高さぶんを避ける
    const desktop = window.matchMedia('(min-width: 720px)').matches;
    const sheetVisible = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sheet-visible')) || 0;
    const padding = desktop
      ? { top: 80, left: 40, right: 440, bottom: 60 }
      : { top: 110, left: 24, right: 24, bottom: Math.min(sheetVisible, Math.round(window.innerHeight * 0.5)) + 24 };
    map.stop();
    map.fitBounds(b, { padding, pitch: 0, bearing: 0, maxZoom: 9, duration: reducedMotion.matches ? 0 : 1000, essential: true });
  }

  function resetView(): void {
    map.stop();
    if (currentMuni) {
      flyToMunicipality(currentMuni.code);
      return;
    }
    map.fitBounds(JAPAN_BOUNDS, { padding: 16, pitch: 0, bearing: 0, duration: reducedMotion.matches ? 0 : 800 });
  }

  // ---- タップ読み取り: T.P. 標高と津波高との差 ----
  map.on('click', (e) => {
    const s = ui.getState();
    const h = clampHeight(s.heightM);
    const raw = map.queryTerrainElevation(e.lngLat);
    if (raw === null || !Number.isFinite(raw)) {
      ui.setReadout('この地点の標高データはまだ読み込まれていません');
      return;
    }
    // queryTerrainElevation は exaggeration を掛けた値を返すため割り戻す
    const exaggeration = map.getTerrain()?.exaggeration ?? TERRAIN_EXAGGERATION;
    const elev = raw / exaggeration;
    const depth = h - elev;
    const where = `${e.lngLat.lat.toFixed(4)}, ${e.lngLat.lng.toFixed(4)}`;
    const verdict =
      depth > 0
        ? `津波高 ${h.toFixed(1)} m より ${depth.toFixed(1)} m 低い（水面下）`
        : `津波高 ${h.toFixed(1)} m より ${(-depth).toFixed(1)} m 高い`;
    ui.setReadout(`標高 T.P. ${elev.toFixed(1)} m ／ ${verdict} ／ ${where}`);
  });

  // ---- シート高さ → 地図 padding（M3 の ui:sheet イベント）----
  window.addEventListener('ui:sheet', (ev) => {
    const d = (ev as CustomEvent<{ visible: number; collapsed: boolean }>).detail;
    if (!d) return;
    const bottom = Math.min(d.visible, Math.round(window.innerHeight * 0.5));
    if (map.getPadding().bottom !== bottom) map.setPadding({ top: 0, left: 0, right: 0, bottom });
  });

  // ---- リサイズ ----
  let resizeRaf = 0;
  const requestMapResize = (): void => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      map.resize();
    });
  };
  window.visualViewport?.addEventListener('resize', requestMapResize);
  window.addEventListener('orientationchange', requestMapResize);

  // ---- ライフサイクル ----
  // `load` は「全ソース読込済み」の描画フレームでしか発火せず、512px DEM（Mapterhorn）＋terrain では
  // 発火しないケースを確認したため、style.load（スタイル・ソース定義完了）で初期化し、load / idle は保険にする
  let initialized = false;
  const initLayers = (): void => {
    if (initialized || !map.getStyle()) return;
    initialized = true;
    // 反転マスク（color-relief の上・hazard-official の下）
    mask = createMask(map, { beforeId: LAYER.hazard, visible: false });
    // 建物（M2）: 最上位
    try {
      // 段（lod1 / lod0 / bvmap）の選択は M2 側が非同期に行うため、ここでは 'none' を異常扱いしない
      buildings = addBuildingLayers(map, data.coverage, {});
    } catch (err) {
      console.warn('[buildings]', err);
      pushBanner('bld', '建物レイヤーの初期化に失敗しました。建物なしで表示を続けます。');
    }
    slip = createSlipOverlay(map);
    styleReady = true;
    applyState(ui.getState());
    // コンパクト帰属表示は開いた状態で始まるため、狭い画面では畳んでおく
    if (!window.matchMedia('(min-width: 720px)').matches) {
      map
        .getContainer()
        .querySelector<HTMLButtonElement>('.maplibregl-ctrl-attrib.maplibregl-compact-show .maplibregl-ctrl-attrib-button')
        ?.click();
    }
  };
  map.once('style.load', initLayers);
  map.once('load', initLayers);
  map.once('idle', initLayers);

  map.on('sourcedata', (e) => {
    if (e.sourceId === 'plateau' && e.dataType === 'source' && e.isSourceLoaded) pushBanner('plateau', null);
  });

  map.on('error', (e: ErrorEvent) => {
    const err = e.error as (Error & { status?: number; url?: string }) | undefined;
    const sourceId = (e as ErrorEvent & { sourceId?: string }).sourceId;
    const msg = err?.message ?? String(e);
    const status = err?.status;
    const url = err?.url ?? '';
    // タイル 404 は範囲外（海上など）で正常
    if (status === 404 || /\b404\b/.test(msg)) {
      console.debug('[map 404]', url || msg);
      return;
    }
    if (err?.name === 'AbortError') return;
    console.warn('[map error]', sourceId ?? '', msg);
    if (sourceId === 'plateau' || url.includes('.pmtiles')) {
      pushBanner('plateau', '建物データ（PLATEAU PMTiles）を取得できませんでした。建物なしで表示を続けます。');
    } else if (sourceId === 'dem' || url.includes('dem_png') || url.includes('mapterhorn')) {
      pushBanner('dem', '標高タイルを取得できませんでした。地形は平坦（0 m）として表示されます。');
    } else if (sourceId === 'hazard') {
      pushBanner('hazard', '公式想定タイル（重ねるハザードマップ）を取得できませんでした。');
    }
  });

  // DEM 到達性プローブ（地理院モードのみ）: gsidem プロトコルは 404 を平坦タイルへ置き換えるため、
  // 起動時に 1 枚だけ確認し、届かなければバナーで知らせる（地図自体は継続）
  if (demMode === 'gsi') {
    fetch(DEM_PROBE_URL, { method: 'GET', cache: 'force-cache', mode: 'cors' })
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
      })
      .catch((err: unknown) => {
        console.warn('[dem probe]', err);
        pushBanner('dem', '標高タイル（地理院DEM）に接続できません。地形は平坦（0 m）として表示され、試算は正しくありません。');
      });
  }

  // デバッグ用
  Object.assign(window as unknown as Record<string, unknown>, {
    __map: map,
    __ui: ui,
    __data: data,
    __demMode: demMode,
    __currentMuni: () => currentMuni,
  });
}

boot().catch((err: unknown) => {
  console.error('[boot]', err);
  const el = document.getElementById('unsupported');
  const reason = document.getElementById('unsupported-reason');
  if (reason) reason.textContent = String((err as Error)?.message ?? err);
  if (el) el.hidden = false;
});
