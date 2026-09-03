/**
 * 建物レイヤー（3段構え）と浸水色分け
 *
 *   tier   | データ                                             | zoom  | 高さ属性                                   | feature id
 *   -------+----------------------------------------------------+-------+--------------------------------------------+---------------------------
 *   lod1   | PLATEAU 2022 LOD1 PMTiles (source-layer PLATEAU)   | z16   | measuredHeight → storeysAboveGround×3 → 10 | promoteId `id`（bldg_<uuid>、タイル内一意）
 *   lod0   | PLATEAU 2023 LOD0 PMTiles (PLATEAU_2023_LOD0)      | z16   | measured_height → cal_height_m → storeys×3 | promoteId `gml_id`（bldg_<uuid>、タイル内一意）
 *   bvmap  | 地理院ベクトルタイル experimental_bvmap `building`   | z14–16| ftCode 固定値 3101=6 / 3102=12 / 3103=30 / 3111,3112=3 | id なし（下記）
 *
 * 各値は scripts/inspect-pmtiles.mjs `--at lon,lat` で実タイルを復号して確認した（2026-09-02）。
 *
 * ## 段の選択
 * moveend（300 ms デバウンス）と PMTiles ソースの sourcedata 完了時に `selectTier()` を評価する。
 * 判定は「LOD1 のタイルが読み込み済みで表示範囲に建物がある → lod1、なければ LOD0 → 同様に lod0、
 * どちらも 0 件 → bvmap」。まだ読み込みが終わっていない段があるあいだは直前の段を維持し、ちらつきを抑える。
 * 非表示レイヤーのソースはタイルを取得しない（Style.update の `isHidden` 判定）ため、
 * LOD1/LOD0 には `fill-opacity: 0` の透明「プローブ」レイヤーを常設してタイルを読み込ませ、
 * `querySourceFeatures` で件数を数える。PMTiles は対象都市外ではディレクトリ照会だけで済み、通信量は小さい。
 *
 * ## 浸水色分け（feature-state.ground）
 * 名古屋版と同じく、表示中の建物の重心で `map.queryTerrainElevation` を引き（誇張率で割り戻す）、
 * `feature-state.ground` に地盤標高を保存する。`ground <= 津波高` の建物を青にする。
 * 1 パス最大 2,000 件、段ごとに feature id でキャッシュする。
 *
 * ## bvmap の扱い（id が無い）
 * 地理院ベクトルタイルの building には feature id も一意な属性も無く（属性は ftCode / orgGILvl / lvOrder のみ）、
 * MapLibre の `generateId` は GeoJSON ソース専用でベクトルタイルには効かないため feature-state を直接は使えない。
 * そこで bvmap 段では、
 *   1. ベクトルタイルの `buildings-bvmap`（灰色）を常時描画し、
 *   2. moveend 後に表示中の建物ポリゴンを `queryRenderedFeatures` で取り出し、重心で地盤を採取して
 *      `ground` プロパティ付き GeoJSON（`generateId: true`）へ書き出し、
 *   3. `buildings-bvmap-submerged` レイヤーを `ground <= 津波高` のフィルタで青く重ねる。
 * 重ね描き時の Z ファイティングを避けるため、派生ポリゴンは重心基準で 3% 拡大し高さも +0.3 m している。
 * 地盤サンプルのキャッシュは重心座標（1e-6 度丸め）をキーにした「タイルセッション内」のもので、
 * タイル境界で分割された建物は分割片ごとに別建物として扱われる。
 *
 * `selectTier` / 高さ式 / ftCode→高さ は純粋関数で、vitest（node）から検証する。
 */
import type {
  ExpressionSpecification,
  FilterSpecification,
  GeoJSONSource,
  LayerSpecification,
  LngLatLike,
  Map as MapLibreMap,
  MapGeoJSONFeature,
  MapSourceDataEvent,
  SourceSpecification,
} from 'maplibre-gl';
import { addProtocol, config } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
// tsconfig の `types: ["vite/client"]` により @types/geojson のグローバル名前空間は読み込まれないため明示 import する
import type {
  Feature as GeoJSONFeatureT,
  FeatureCollection as GeoJSONFeatureCollection,
  MultiPolygon as GeoJSONMultiPolygon,
  Polygon as GeoJSONPolygon,
  Position,
} from 'geojson';

// ---------------------------------------------------------------------------
// 型（shared/DATA_CONTRACT.md §5 `building_coverage.json`）
// `./data` は M1 が所有する。コンパイル時に存在しない可能性があるため同等型をここで宣言・公開する。
// ---------------------------------------------------------------------------
export interface BuildingCoverageCity {
  code: string;
  name: string;
}

export interface PmtilesTierCoverage {
  url: string;
  source_layer: string;
  height_attr: string;
  cities: BuildingCoverageCity[];
}

export interface BuildingCoverage {
  generated?: string;
  pmtiles: {
    lod1_2022: PmtilesTierCoverage;
    lod0_2023: PmtilesTierCoverage;
  };
  plateau_3dtiles_cities?: BuildingCoverageCity[];
}

/** 呼び出し側の型がわずかに違っても受け付けられるよう、必要項目だけを任意にした緩い型 */
export type BuildingCoverageLike = {
  pmtiles?: {
    lod1_2022?: Partial<PmtilesTierCoverage> | null;
    lod0_2023?: Partial<PmtilesTierCoverage> | null;
  } | null;
} | null | undefined;

export type BuildingTier = 'lod1' | 'lod0' | 'bvmap' | 'none';

export interface BuildingLayersHandle {
  setVisible(on: boolean): void;
  /** 津波高（T.P. m）。feature-state.ground <= この値の建物を浸水色にする */
  setWaterLevel(tpHeight: number): void;
  /** 表示中の建物の地盤標高を採取（150 ms スロットル・1 パス最大 2,000 件・id でキャッシュ） */
  refreshGround(): void;
  currentSource(): BuildingTier;
  /** イベント購読を解除する（レイヤー・ソースは残す） */
  destroy(): void;
}

export interface AddBuildingLayersOptions {
  /** この layer id の直前に挿入する（存在しなければ最上位） */
  beforeId?: string;
  /** 段が切り替わったときに呼ばれる */
  onTierChange?: (tier: BuildingTier, previous: BuildingTier) => void;
  /** 初期の津波高（既定 0） */
  initialWaterLevel?: number;
  /** 初期表示（既定 true） */
  initialVisible?: boolean;
}

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------
export const LOD1_DEFAULT_URL = 'https://shiworks.xsrv.jp/pmtiles-data/plateau/PLATEAU_2022_LOD1.pmtiles';
export const LOD1_DEFAULT_SOURCE_LAYER = 'PLATEAU';
export const LOD1_DEFAULT_HEIGHT_ATTR = 'measuredHeight';
/** タイル内で一意（inspect-pmtiles.mjs で 140/140 unique を確認） */
export const LOD1_ID_ATTR = 'id';
export const LOD1_STOREYS_ATTR = 'storeysAboveGround';

export const LOD0_DEFAULT_URL = 'https://shiworks.xsrv.jp/pmtiles-data/plateau/PLATEAU_2023_LOD0.pmtiles';
export const LOD0_DEFAULT_SOURCE_LAYER = 'PLATEAU_2023_LOD0';
export const LOD0_DEFAULT_HEIGHT_ATTR = 'measured_height';
/** cal_zmax_m − cal_zmin_m 由来の計算高さ。全件に入っている（measured_height は約 85%） */
export const LOD0_FALLBACK_HEIGHT_ATTR = 'cal_height_m';
/** タイル内で一意（139/139 unique）。building_id も一意だが gml_id を採用 */
export const LOD0_ID_ATTR = 'gml_id';
export const LOD0_STOREYS_ATTR = 'storeys_above_ground';

export const BVMAP_TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/{z}/{x}/{y}.pbf';
export const BVMAP_SOURCE_LAYER = 'building';
/** bvmap 建物は z14 では輪郭線のみ、z15 以上でポリゴンを持つ（実タイルで確認） */
export const BVMAP_MIN_ZOOM = 15;
export const BVMAP_MAX_ZOOM = 16;
/** PMTiles（LOD1/LOD0）は z16 単一ズーム */
export const PLATEAU_TILE_ZOOM = 16;

/** 地理院地図Vector 建物 ftCode → 想定高さ [m] */
export const BVMAP_HEIGHT_BY_FTCODE: Readonly<Record<number, number>> = {
  3101: 6, // 普通建物
  3102: 12, // 堅ろう建物
  3103: 30, // 高層建物
  3111: 3, // 普通無壁舎
  3112: 3, // 堅ろう無壁舎
};
export const BVMAP_DEFAULT_HEIGHT = 6;
export const PLATEAU_DEFAULT_HEIGHT = 10;
/** 階数からの推定に使う階高 [m] */
export const STOREY_HEIGHT = 3;

export const BUILDING_SUBMERGED = '#1f8aa8';
export const BUILDING_DRY = '#9aa4ad';
const BUILDING_OPACITY = 0.85;
/** 未サンプリング（feature-state 無し）の建物は浸水判定しない番兵値 */
const GROUND_UNKNOWN = 99999;

export const GROUND_SAMPLE_MAX_FEATURES = 2000;
const GROUND_SAMPLE_THROTTLE_MS = 150;
const GROUND_SAMPLE_CHAIN_MAX = 4;
const GROUND_CACHE_LIMIT = 60000;
const TIER_DEBOUNCE_MS = 300;
/** bvmap 派生 GeoJSON の上限件数（地盤の低い順に残す） */
const BVMAP_DERIVED_MAX = 6000;
/** bvmap 派生ポリゴンの拡大率・高さ加算（灰色との Z ファイティング回避） */
const BVMAP_OVERLAY_SCALE = 1.03;
const BVMAP_OVERLAY_EXTRA_HEIGHT = 0.3;

export const BUILDING_IDS = {
  sources: {
    lod1: 'plateau-lod1',
    lod0: 'plateau-lod0',
    bvmap: 'gsi-bvmap',
    bvmapSubmerged: 'gsi-bvmap-submerged',
  },
  layers: {
    lod1Probe: 'buildings-lod1-probe',
    lod0Probe: 'buildings-lod0-probe',
    lod1: 'buildings-lod1',
    lod0: 'buildings-lod0',
    bvmap: 'buildings-bvmap',
    bvmapSubmerged: 'buildings-bvmap-submerged',
  },
} as const;

export const BUILDING_ATTRIBUTION: Readonly<Record<Exclude<BuildingTier, 'none'>, string>> = {
  lod1:
    '<a href="https://www.mlit.go.jp/plateau/" target="_blank">国土交通省 PLATEAU</a> 建築物モデル LOD1（2022・CC BY 4.0）／' +
    '<a href="https://github.com/amx-project/apb" target="_blank">amx-project</a> PMTiles',
  lod0:
    '<a href="https://www.mlit.go.jp/plateau/" target="_blank">国土交通省 PLATEAU</a> 建築物モデル LOD0（2023・CC BY 4.0）／' +
    '<a href="https://beta.source.coop/repositories/pacificspatial/flateau/" target="_blank">Pacific Spatial Solutions flateau</a>',
  bvmap:
    '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル（地理院地図Vector 建物・試験公開）</a>',
};

// ---------------------------------------------------------------------------
// 純粋関数（テスト対象）
// ---------------------------------------------------------------------------

/** ftCode → 高さ [m]。未知・欠損は BVMAP_DEFAULT_HEIGHT */
export function ftCodeToHeight(ftCode: unknown): number {
  const code = typeof ftCode === 'string' ? Number(ftCode) : ftCode;
  if (typeof code !== 'number' || !Number.isFinite(code)) return BVMAP_DEFAULT_HEIGHT;
  return BVMAP_HEIGHT_BY_FTCODE[code] ?? BVMAP_DEFAULT_HEIGHT;
}

/** bvmap 用 fill-extrusion-height 式（ftCode の match） */
export function bvmapHeightExpression(extra = 0): ExpressionSpecification {
  const byHeight = new Map<number, number[]>();
  for (const [code, h] of Object.entries(BVMAP_HEIGHT_BY_FTCODE)) {
    const list = byHeight.get(h) ?? [];
    list.push(Number(code));
    byHeight.set(h, list);
  }
  const branches: unknown[] = [];
  for (const [h, codes] of [...byHeight.entries()].sort((a, b) => a[0] - b[0])) {
    branches.push(codes.length === 1 ? codes[0] : codes, h + extra);
  }
  return ['match', ['get', 'ftCode'], ...branches, BVMAP_DEFAULT_HEIGHT + extra] as unknown as ExpressionSpecification;
}

/**
 * PLATEAU 用 fill-extrusion-height 式。
 * 高さ属性を順に試し（> 0 のものを採用）、無ければ階数 × STOREY_HEIGHT、最後に既定値。
 * `to-number` は null → 0 になるため「> 0」で欠損と 0 m をまとめて次候補へ送る（非数文字列も 0 扱い）。
 */
export function plateauHeightExpression(
  heightAttrs: readonly string[],
  storeysAttr: string | null,
  defaultHeight = PLATEAU_DEFAULT_HEIGHT,
): ExpressionSpecification {
  // `to-number` は変換できない文字列で評価エラーになり高さが 0 に化けるため、第 2 引数のフォールバック 0 を付ける
  const num = (attr: string): unknown[] => ['to-number', ['get', attr], 0];
  const expr: unknown[] = ['case'];
  for (const attr of heightAttrs) {
    expr.push(['>', num(attr), 0], num(attr));
  }
  if (storeysAttr) {
    expr.push(['>', num(storeysAttr), 0], ['*', num(storeysAttr), STOREY_HEIGHT]);
  }
  expr.push(defaultHeight);
  return expr as ExpressionSpecification;
}

/** 津波高を式に使える有限数へ。非数は「誰も浸水しない」極小値にする */
export function normalizeWaterLevel(h: number): number {
  if (!Number.isFinite(h)) return -1e9;
  return Math.round(h * 100) / 100;
}

/** feature-state.ground <= 津波高 なら浸水色、未サンプリングは乾燥色 */
export function submergedColorExpression(tpHeight: number): ExpressionSpecification {
  return [
    'case',
    ['<=', ['coalesce', ['feature-state', 'ground'], GROUND_UNKNOWN], normalizeWaterLevel(tpHeight)],
    BUILDING_SUBMERGED,
    BUILDING_DRY,
  ];
}

/** bvmap 派生 GeoJSON（`ground` プロパティ付き）用フィルタ */
export function bvmapSubmergedFilter(tpHeight: number): FilterSpecification {
  return ['<=', ['coalesce', ['get', 'ground'], GROUND_UNKNOWN], normalizeWaterLevel(tpHeight)];
}

export interface TierObservation {
  zoom: number;
  /** loaded=false はタイル取得中（判定保留）。count は表示範囲内の建物数 */
  lod1: { loaded: boolean; count: number };
  lod0: { loaded: boolean; count: number };
}

/**
 * 表示する段を決める。
 * - z < 15: 何も出せない（bvmap は z14 で輪郭線のみ）→ none
 * - 15 <= z < 16: PMTiles は z16 単一ズームでタイルが無い → bvmap
 * - z >= 16: LOD1 に建物があれば lod1、無ければ LOD0、どちらも無ければ bvmap。
 *   読み込み未完了の段がある間は直前の段を維持する（ヒステリシス）。
 */
export function selectTier(obs: TierObservation, previous: BuildingTier, minCount = 1): BuildingTier {
  if (!Number.isFinite(obs.zoom) || obs.zoom < BVMAP_MIN_ZOOM) return 'none';
  if (obs.zoom < PLATEAU_TILE_ZOOM) return 'bvmap';
  if (obs.lod1.loaded && obs.lod1.count >= minCount) return 'lod1';
  if (!obs.lod1.loaded) return previous;
  if (obs.lod0.loaded && obs.lod0.count >= minCount) return 'lod0';
  if (!obs.lod0.loaded) return previous;
  return 'bvmap';
}

type Ring = Position[];

/** 外環（最初のポリゴンの最初の環）の頂点平均。閉環の終点は除外 */
export function featureCentroid(f: { geometry: MapGeoJSONFeature['geometry'] }): [number, number] | null {
  const g = f.geometry;
  let ring: Ring | undefined;
  if (g.type === 'Polygon') ring = g.coordinates[0];
  else if (g.type === 'MultiPolygon') ring = g.coordinates[0]?.[0];
  if (!ring || ring.length === 0) return null;
  const n = ring.length > 1 ? ring.length - 1 : ring.length;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
  }
  return [sx / n, sy / n];
}

/** bvmap 用キャッシュキー（重心を 1e-6 度 ≒ 0.1 m で丸める） */
export function centroidKey(c: [number, number]): string {
  return `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
}

/** 重心を中心に環を拡大する（灰色建物との Z ファイティング回避用） */
export function scaleRing(ring: Ring, center: [number, number], factor: number): Ring {
  return ring.map(([x, y]) => [center[0] + (x - center[0]) * factor, center[1] + (y - center[1]) * factor]);
}

function scaleGeometry(
  g: MapGeoJSONFeature['geometry'],
  center: [number, number],
  factor: number,
): GeoJSONPolygon | GeoJSONMultiPolygon | null {
  if (g.type === 'Polygon') {
    return { type: 'Polygon', coordinates: g.coordinates.map((r) => scaleRing(r, center, factor)) };
  }
  if (g.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: g.coordinates.map((poly) => poly.map((r) => scaleRing(r, center, factor))),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// ソース・レイヤー仕様（純粋関数）
// ---------------------------------------------------------------------------
export interface PlateauTierConfig {
  url: string;
  sourceLayer: string;
  /** 高さ属性の優先順（> 0 のものを採用） */
  heightAttrs: string[];
}

/** coverage（DATA_CONTRACT §5）と実測既定値から LOD1/LOD0 の設定を決める */
export function resolvePlateauTiers(coverage: BuildingCoverageLike): { lod1: PlateauTierConfig; lod0: PlateauTierConfig } {
  const lod1Cov = coverage?.pmtiles?.lod1_2022 ?? null;
  const lod0Cov = coverage?.pmtiles?.lod0_2023 ?? null;
  const known = (v: string | undefined | null): v is string => typeof v === 'string' && v.length > 0 && v !== '...';
  return {
    lod1: {
      url: known(lod1Cov?.url) ? lod1Cov.url : LOD1_DEFAULT_URL,
      sourceLayer: known(lod1Cov?.source_layer) ? lod1Cov.source_layer : LOD1_DEFAULT_SOURCE_LAYER,
      heightAttrs: dedupe([known(lod1Cov?.height_attr) ? lod1Cov.height_attr : '', LOD1_DEFAULT_HEIGHT_ATTR]),
    },
    lod0: {
      url: known(lod0Cov?.url) ? lod0Cov.url : LOD0_DEFAULT_URL,
      // DATA_CONTRACT §5 のサンプルは "..." のため、未確定値は実測した layer 名へ倒す
      sourceLayer: known(lod0Cov?.source_layer) ? lod0Cov.source_layer : LOD0_DEFAULT_SOURCE_LAYER,
      heightAttrs: dedupe([
        known(lod0Cov?.height_attr) ? lod0Cov.height_attr : '',
        LOD0_DEFAULT_HEIGHT_ATTR,
        LOD0_FALLBACK_HEIGHT_ATTR,
      ]),
    },
  };
}

export function buildingSourceSpecs(lod1: PlateauTierConfig, lod0: PlateauTierConfig): [string, SourceSpecification][] {
  const S = BUILDING_IDS.sources;
  return [
    [
      S.lod1,
      {
        type: 'vector',
        url: `pmtiles://${lod1.url}`,
        promoteId: LOD1_ID_ATTR,
        attribution: BUILDING_ATTRIBUTION.lod1,
      },
    ],
    [
      S.lod0,
      {
        type: 'vector',
        url: `pmtiles://${lod0.url}`,
        promoteId: LOD0_ID_ATTR,
        attribution: BUILDING_ATTRIBUTION.lod0,
      },
    ],
    [
      S.bvmap,
      {
        type: 'vector',
        tiles: [BVMAP_TILE_URL],
        minzoom: 14,
        maxzoom: BVMAP_MAX_ZOOM,
        attribution: BUILDING_ATTRIBUTION.bvmap,
      },
    ],
    [
      S.bvmapSubmerged,
      {
        type: 'geojson',
        data: emptyFeatureCollection(),
        generateId: true,
        tolerance: 0.1,
      },
    ],
  ];
}

/** 追加順（下から上）。段レイヤーは visibility none で作り、applyVisibility で 1 段だけ出す */
export function buildingLayerSpecs(
  lod1: PlateauTierConfig,
  lod0: PlateauTierConfig,
  waterLevel: number,
): LayerSpecification[] {
  const S = BUILDING_IDS.sources;
  const L = BUILDING_IDS.layers;
  const hidden = { visibility: 'none' } as const;
  return [
    // タイル読込用の透明プローブ（isHidden にならないよう visibility は visible のまま）
    {
      id: L.lod1Probe,
      type: 'fill',
      source: S.lod1,
      'source-layer': lod1.sourceLayer,
      minzoom: PLATEAU_TILE_ZOOM,
      paint: { 'fill-opacity': 0, 'fill-antialias': false },
    },
    {
      id: L.lod0Probe,
      type: 'fill',
      source: S.lod0,
      'source-layer': lod0.sourceLayer,
      minzoom: PLATEAU_TILE_ZOOM,
      paint: { 'fill-opacity': 0, 'fill-antialias': false },
    },
    {
      id: L.lod1,
      type: 'fill-extrusion',
      source: S.lod1,
      'source-layer': lod1.sourceLayer,
      minzoom: PLATEAU_TILE_ZOOM,
      layout: hidden,
      paint: {
        'fill-extrusion-color': submergedColorExpression(waterLevel),
        'fill-extrusion-height': plateauHeightExpression(lod1.heightAttrs, LOD1_STOREYS_ATTR),
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': BUILDING_OPACITY,
      },
    },
    {
      id: L.lod0,
      type: 'fill-extrusion',
      source: S.lod0,
      'source-layer': lod0.sourceLayer,
      minzoom: PLATEAU_TILE_ZOOM,
      layout: hidden,
      paint: {
        'fill-extrusion-color': submergedColorExpression(waterLevel),
        'fill-extrusion-height': plateauHeightExpression(lod0.heightAttrs, LOD0_STOREYS_ATTR),
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': BUILDING_OPACITY,
      },
    },
    {
      id: L.bvmap,
      type: 'fill-extrusion',
      source: S.bvmap,
      'source-layer': BVMAP_SOURCE_LAYER,
      minzoom: BVMAP_MIN_ZOOM,
      // building レイヤーには輪郭線（LineString）も混在するためポリゴンだけを使う
      filter: ['==', ['geometry-type'], 'Polygon'],
      layout: hidden,
      paint: {
        'fill-extrusion-color': BUILDING_DRY,
        'fill-extrusion-height': bvmapHeightExpression(),
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': BUILDING_OPACITY,
      },
    },
    {
      id: L.bvmapSubmerged,
      type: 'fill-extrusion',
      source: S.bvmapSubmerged,
      minzoom: BVMAP_MIN_ZOOM,
      filter: bvmapSubmergedFilter(waterLevel),
      layout: hidden,
      paint: {
        'fill-extrusion-color': BUILDING_SUBMERGED,
        'fill-extrusion-height': bvmapHeightExpression(BVMAP_OVERLAY_EXTRA_HEIGHT),
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.92,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// pmtiles:// プロトコル（main.ts 側で登録済みならそのまま使う）
// ---------------------------------------------------------------------------
export function ensurePmtilesProtocol(): void {
  if (config.REGISTERED_PROTOCOLS['pmtiles']) return;
  const protocol = new Protocol();
  addProtocol('pmtiles', protocol.tile);
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------
export function addBuildingLayers(
  map: MapLibreMap,
  coverage: BuildingCoverageLike,
  opts: AddBuildingLayersOptions = {},
): BuildingLayersHandle {
  const S = BUILDING_IDS.sources;
  const L = BUILDING_IDS.layers;
  const { lod1, lod0 } = resolvePlateauTiers(coverage);

  let visible = opts.initialVisible ?? true;
  let waterLevel = normalizeWaterLevel(opts.initialWaterLevel ?? 0);
  let tier: BuildingTier = 'none';
  let initialized = false;
  let destroyed = false;
  const failed = { lod1: false, lod0: false };

  // 段ごとの地盤キャッシュ。LOD 段は feature id、bvmap 段は重心キー
  const groundCache: Record<Exclude<BuildingTier, 'none'>, Map<string | number, number>> = {
    lod1: new Map(),
    lod0: new Map(),
    bvmap: new Map(),
  };
  let bvmapDerivedTruncated = false;

  // -------------------------------------------------------------------------
  // ソース・レイヤー追加（仕様は純粋関数 buildingSourceSpecs / buildingLayerSpecs で組み立て、テストで検証する）
  // -------------------------------------------------------------------------
  function beforeIdOrUndefined(): string | undefined {
    return opts.beforeId && map.getLayer(opts.beforeId) ? opts.beforeId : undefined;
  }

  function addSources(): void {
    ensurePmtilesProtocol();
    for (const [id, spec] of buildingSourceSpecs(lod1, lod0)) {
      if (!map.getSource(id)) map.addSource(id, spec);
    }
  }

  function addLayers(): void {
    const before = beforeIdOrUndefined();
    for (const layer of buildingLayerSpecs(lod1, lod0, waterLevel)) {
      if (!map.getLayer(layer.id)) map.addLayer(layer, before);
    }
  }

  // -------------------------------------------------------------------------
  // 表示制御
  // -------------------------------------------------------------------------
  function setLayerVisible(id: string, on: boolean): void {
    if (!map.getLayer(id)) return;
    const want = on ? 'visible' : 'none';
    if (map.getLayoutProperty(id, 'visibility') !== want) map.setLayoutProperty(id, 'visibility', want);
  }

  function applyVisibility(): void {
    setLayerVisible(L.lod1, visible && tier === 'lod1');
    setLayerVisible(L.lod0, visible && tier === 'lod0');
    setLayerVisible(L.bvmap, visible && tier === 'bvmap');
    setLayerVisible(L.bvmapSubmerged, visible && tier === 'bvmap');
  }

  function setTier(next: BuildingTier): void {
    if (next === tier) return;
    const prev = tier;
    tier = next;
    applyVisibility();
    console.debug(`[buildings] tier ${prev} → ${next} (z=${map.getZoom().toFixed(2)})`);
    opts.onTierChange?.(next, prev);
    scheduleGroundSampling();
  }

  // -------------------------------------------------------------------------
  // 段の判定
  // -------------------------------------------------------------------------
  function sourceLoaded(id: string, failFlag: boolean): boolean {
    if (failFlag) return true;
    if (!map.getSource(id)) return false;
    try {
      return map.isSourceLoaded(id);
    } catch {
      return false;
    }
  }

  function observe(): TierObservation {
    const zoom = map.getZoom();
    const obs: TierObservation = {
      zoom,
      lod1: { loaded: false, count: 0 },
      lod0: { loaded: false, count: 0 },
    };
    if (zoom < PLATEAU_TILE_ZOOM) return obs;
    obs.lod1.loaded = sourceLoaded(S.lod1, failed.lod1);
    if (obs.lod1.loaded && !failed.lod1) {
      obs.lod1.count = map.querySourceFeatures(S.lod1, { sourceLayer: lod1.sourceLayer }).length;
    }
    // LOD1 に建物があれば LOD0 の集計は不要（querySourceFeatures のコストを抑える）
    if (obs.lod1.loaded && obs.lod1.count > 0) {
      obs.lod0.loaded = true;
      return obs;
    }
    obs.lod0.loaded = sourceLoaded(S.lod0, failed.lod0);
    if (obs.lod0.loaded && !failed.lod0) {
      obs.lod0.count = map.querySourceFeatures(S.lod0, { sourceLayer: lod0.sourceLayer }).length;
    }
    return obs;
  }

  let tierTimer: number | undefined;
  function evaluateTier(): void {
    if (!initialized || destroyed) return;
    const next = selectTier(observe(), tier);
    setTier(next);
  }

  function scheduleTierEvaluation(delay = TIER_DEBOUNCE_MS): void {
    if (destroyed) return;
    window.clearTimeout(tierTimer);
    tierTimer = window.setTimeout(evaluateTier, delay);
  }

  // -------------------------------------------------------------------------
  // 地盤サンプリング
  // -------------------------------------------------------------------------
  let groundScheduled = false;
  let groundTimer: number | undefined;
  let groundChain = 0;
  let budgetWarned = false;

  function terrainExaggeration(): number | null {
    const t = map.getTerrain();
    if (!t) return null;
    const ex = typeof t.exaggeration === 'number' ? t.exaggeration : 1;
    return ex > 0 ? ex : 1;
  }

  function sampleAt(c: [number, number], exaggeration: number): number | null {
    const raw = map.queryTerrainElevation(c as LngLatLike);
    if (raw === null || raw === undefined || !Number.isFinite(raw)) return null;
    return Math.round((raw / exaggeration) * 100) / 100;
  }

  function trimCache(cache: Map<string | number, number>): void {
    if (cache.size > GROUND_CACHE_LIMIT) cache.clear();
  }

  /** LOD1 / LOD0: feature-state.ground を id 単位で設定 */
  function samplePlateau(which: 'lod1' | 'lod0'): number {
    const layerId = which === 'lod1' ? L.lod1 : L.lod0;
    const sourceId = which === 'lod1' ? S.lod1 : S.lod0;
    const sourceLayer = which === 'lod1' ? lod1.sourceLayer : lod0.sourceLayer;
    const exaggeration = terrainExaggeration();
    if (exaggeration === null) return 0;
    const cache = groundCache[which];
    trimCache(cache);

    const feats = map.queryRenderedFeatures({ layers: [layerId] });
    const seen = new Set<string | number>();
    let updated = 0;
    let remaining = 0;
    for (const f of feats) {
      if (f.id === undefined || f.id === null) continue;
      if (seen.has(f.id)) continue;
      if (cache.has(f.id)) continue;
      if (seen.size >= GROUND_SAMPLE_MAX_FEATURES) {
        remaining++;
        continue;
      }
      seen.add(f.id);
      const c = featureCentroid(f);
      if (!c) continue;
      const ground = sampleAt(c, exaggeration);
      if (ground === null) continue;
      cache.set(f.id, ground);
      map.setFeatureState({ source: sourceId, sourceLayer, id: f.id }, { ground });
      updated++;
    }
    if (remaining > 0 && !budgetWarned) {
      budgetWarned = true;
      console.info(`[buildings] ground sampling capped at ${GROUND_SAMPLE_MAX_FEATURES} features per pass`);
    }
    if (updated > 0) console.debug(`[buildings:${which}] ground sampled +${updated} (cache ${cache.size})`);
    return remaining;
  }

  /** bvmap: 派生 GeoJSON（ground プロパティ付き）を作り直す */
  function sampleBvmap(): number {
    const exaggeration = terrainExaggeration();
    if (exaggeration === null) return 0;
    const cache = groundCache.bvmap;
    trimCache(cache);

    const feats = map.queryRenderedFeatures({ layers: [L.bvmap] });
    const derived: GeoJSONFeatureT<GeoJSONPolygon | GeoJSONMultiPolygon, { ground: number; ftCode: number }>[] = [];
    const seenKeys = new Set<string>();
    let sampled = 0;
    let remaining = 0;
    for (const f of feats) {
      const g = f.geometry;
      if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue;
      const c = featureCentroid(f);
      if (!c) continue;
      const key = centroidKey(c);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      let ground = cache.get(key);
      if (ground === undefined) {
        if (sampled >= GROUND_SAMPLE_MAX_FEATURES) {
          remaining++;
          continue;
        }
        const s = sampleAt(c, exaggeration);
        if (s === null) continue;
        cache.set(key, s);
        ground = s;
        sampled++;
      }
      const geometry = scaleGeometry(g, c, BVMAP_OVERLAY_SCALE);
      if (!geometry) continue;
      const ftCode = Number((f.properties as Record<string, unknown> | null)?.ftCode ?? NaN);
      derived.push({
        type: 'Feature',
        properties: { ground, ftCode: Number.isFinite(ftCode) ? ftCode : 0 },
        geometry,
      });
    }
    // 件数上限: 地盤の低い（＝浸水しやすい）順に残す
    derived.sort((a, b) => a.properties.ground - b.properties.ground);
    bvmapDerivedTruncated = derived.length > BVMAP_DERIVED_MAX;
    const fc: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      features: bvmapDerivedTruncated ? derived.slice(0, BVMAP_DERIVED_MAX) : derived,
    };
    const src = map.getSource(S.bvmapSubmerged) as GeoJSONSource | undefined;
    src?.setData(fc);
    if (remaining > 0 && !budgetWarned) {
      budgetWarned = true;
      console.info(`[buildings] ground sampling capped at ${GROUND_SAMPLE_MAX_FEATURES} features per pass`);
    }
    if (sampled > 0 || derived.length > 0) {
      console.debug(`[buildings:bvmap] ground sampled +${sampled}, derived ${fc.features.length} (cache ${cache.size})`);
    }
    return remaining;
  }

  function runGroundSampling(): void {
    groundScheduled = false;
    if (destroyed || !initialized || !visible || tier === 'none') return;
    if (map.getZoom() < BVMAP_MIN_ZOOM) return;
    let remaining = 0;
    if (tier === 'bvmap') remaining = sampleBvmap();
    else remaining = samplePlateau(tier);
    // 上限で打ち切った分は続けて処理する（1 回の moveend につき最大 GROUND_SAMPLE_CHAIN_MAX 回）
    if (remaining > 0 && groundChain < GROUND_SAMPLE_CHAIN_MAX) {
      groundChain++;
      scheduleGroundSampling(true);
    } else {
      groundChain = 0;
    }
  }

  function scheduleGroundSampling(chained = false): void {
    if (destroyed || groundScheduled) return;
    if (!chained) groundChain = 0;
    groundScheduled = true;
    window.clearTimeout(groundTimer);
    groundTimer = window.setTimeout(() => {
      if (map.loaded() && map.areTilesLoaded()) runGroundSampling();
      else map.once('idle', runGroundSampling);
    }, GROUND_SAMPLE_THROTTLE_MS);
  }

  // -------------------------------------------------------------------------
  // 津波高
  // -------------------------------------------------------------------------
  let waterRaf = 0;
  function pushWaterLevel(): void {
    if (waterRaf) return;
    waterRaf = requestAnimationFrame(() => {
      waterRaf = 0;
      if (destroyed || !initialized) return;
      const color = submergedColorExpression(waterLevel);
      if (map.getLayer(L.lod1)) map.setPaintProperty(L.lod1, 'fill-extrusion-color', color);
      if (map.getLayer(L.lod0)) map.setPaintProperty(L.lod0, 'fill-extrusion-color', color);
      if (map.getLayer(L.bvmapSubmerged)) map.setFilter(L.bvmapSubmerged, bvmapSubmergedFilter(waterLevel));
      // 派生 GeoJSON を件数上限で切っていた場合は、水位変更で対象が変わるので作り直す
      if (tier === 'bvmap' && bvmapDerivedTruncated) scheduleGroundSampling();
    });
  }

  // -------------------------------------------------------------------------
  // イベント
  // -------------------------------------------------------------------------
  const onMoveEnd = (): void => {
    scheduleTierEvaluation();
    scheduleGroundSampling();
  };
  const onSourceData = (e: MapSourceDataEvent): void => {
    if (e.dataType !== 'source' || !e.isSourceLoaded) return;
    if (e.sourceId === S.lod1 || e.sourceId === S.lod0) scheduleTierEvaluation();
  };
  const onError = (e: { sourceId?: string; error?: { url?: string; status?: number } }): void => {
    const url = e.error?.url ?? '';
    // タイル単位の 404/空応答は正常（範囲外）。ソース自体（ヘッダー・メタデータ）の失敗だけ段判定から外す
    if (e.error?.status === 404) return;
    if (e.sourceId === S.lod1 || (url && url.includes(lod1.url) && !e.sourceId)) failed.lod1 = true;
    if (e.sourceId === S.lod0 || (url && url.includes(lod0.url) && !e.sourceId)) failed.lod0 = true;
    if (failed.lod1 || failed.lod0) scheduleTierEvaluation(0);
  };

  function init(): void {
    if (initialized || destroyed) return;
    addSources();
    addLayers();
    initialized = true;
    map.on('moveend', onMoveEnd);
    map.on('sourcedata', onSourceData);
    map.on('error', onError as (e: unknown) => void);
    applyVisibility();
    scheduleTierEvaluation(0);
  }

  if (map.isStyleLoaded()) init();
  else map.once('load', init);

  // -------------------------------------------------------------------------
  // 公開 API
  // -------------------------------------------------------------------------
  return {
    setVisible(on: boolean): void {
      visible = !!on;
      if (!initialized) return;
      applyVisibility();
      if (visible) {
        scheduleTierEvaluation(0);
        scheduleGroundSampling();
      }
    },
    setWaterLevel(tpHeight: number): void {
      const next = normalizeWaterLevel(tpHeight);
      if (next === waterLevel) return;
      waterLevel = next;
      if (initialized) pushWaterLevel();
    },
    refreshGround(): void {
      if (!initialized) return;
      scheduleGroundSampling();
    },
    currentSource(): BuildingTier {
      return tier;
    },
    destroy(): void {
      destroyed = true;
      window.clearTimeout(tierTimer);
      window.clearTimeout(groundTimer);
      if (waterRaf) cancelAnimationFrame(waterRaf);
      map.off('moveend', onMoveEnd);
      map.off('sourcedata', onSourceData);
      map.off('error', onError as (e: unknown) => void);
      map.off('load', init);
    },
  };
}

// ---------------------------------------------------------------------------
// 小物
// ---------------------------------------------------------------------------
function dedupe(list: string[]): string[] {
  return [...new Set(list.filter((s) => typeof s === 'string' && s.length > 0))];
}

function emptyFeatureCollection(): GeoJSONFeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}
