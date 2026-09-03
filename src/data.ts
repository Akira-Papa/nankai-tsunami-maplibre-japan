/**
 * 共有データ契約（../shared/DATA_CONTRACT.md）の型とローダー
 *
 * - §1 municipalities.json            … 市区町村一覧（代表点・bbox・沿岸／南海トラフ対象フラグ）
 * - §2 municipalities_coastal.geojson … 沿岸市区町村ポリゴン（簡略化済み）
 * - §3 tsunami_h.json                 … 内閣府 市町村別 最大津波高（2025 / 2012）
 * - §5 building_coverage.json         … PLATEAU PMTiles の URL と収録都市
 *
 * 開発時は `public/data/` のフィクスチャ（6市町・`"fixture": true`）を読み、統合時に
 * `shared/data/` の実データへ差し替える。キー名・型は契約どおりで変更しない。
 */

// ---------------------------------------------------------------------------
// §1 municipalities.json
// ---------------------------------------------------------------------------
export interface Prefecture {
  code: string; // 2桁
  name: string;
}

export interface Municipality {
  code: string; // 5桁（政令市は市コード。区は wards に列挙）
  name: string;
  pref_code: string;
  pref: string;
  lon: number;
  lat: number;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
  coastal: boolean;
  nankai_target: boolean;
  wards?: string[];
}

export interface MunicipalitiesFile {
  generated: string;
  source: { n03: string; license: string };
  prefectures: Prefecture[];
  municipalities: Municipality[];
  fixture?: boolean;
}

// ---------------------------------------------------------------------------
// §2 municipalities_coastal.geojson
// ---------------------------------------------------------------------------
export type Position = [number, number];
export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: Position[][];
}
export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: Position[][][];
}
export type MunicipalityGeometry = PolygonGeometry | MultiPolygonGeometry;

export interface MunicipalityFeature {
  type: 'Feature';
  properties: { code: string; name: string; pref_code: string; pref: string };
  geometry: MunicipalityGeometry;
}

export interface CoastalGeoJSON {
  type: 'FeatureCollection';
  features: MunicipalityFeature[];
  fixture?: boolean;
}

// ---------------------------------------------------------------------------
// §3 tsunami_h.json
// ---------------------------------------------------------------------------
export interface TsunamiRow {
  code: string | null;
  pref: string;
  name: string;
  max_2025: number | null;
  mean_2025: number | null;
  cases_2025: Record<string, number | null>;
  max_2012: number | null;
  area_ha_2025: number | null;
  raw_name: string;
  note: string;
}

export interface TsunamiFile {
  generated: string;
  source: { '2025': string; '2012': string; license: string };
  unit: string;
  cases: string[];
  rows: TsunamiRow[];
  fixture?: boolean;
}

export type HeightPreset = 'max_2025' | 'mean_2025' | 'max_2012';

// ---------------------------------------------------------------------------
// §5 building_coverage.json
// ---------------------------------------------------------------------------
export interface PmtilesEntry {
  url: string;
  source_layer: string;
  height_attr: string;
  cities: { code: string; name: string }[];
}

export interface BuildingCoverage {
  generated: string;
  pmtiles: Record<string, PmtilesEntry> & {
    lod1_2022?: PmtilesEntry;
    lod0_2023?: PmtilesEntry;
  };
  plateau_3dtiles_cities: { code: string; name: string }[];
  fixture?: boolean;
}

// ---------------------------------------------------------------------------
// ローダー
// ---------------------------------------------------------------------------
export interface AppData {
  municipalities: MunicipalitiesFile;
  coastal: CoastalGeoJSON;
  tsunami: TsunamiFile;
  coverage: BuildingCoverage;
  /** 任意ファイル（coastal / coverage）の取得失敗など、地図の継続は可能な警告 */
  warnings: string[];
  /** いずれかのファイルが `"fixture": true` */
  isFixture: boolean;
}

export const DATA_FILES = {
  municipalities: 'municipalities.json',
  coastal: 'municipalities_coastal.geojson',
  tsunami: 'tsunami_h.json',
  coverage: 'building_coverage.json',
} as const;

export class DataLoadError extends Error {
  constructor(
    public readonly file: string,
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'DataLoadError';
  }
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal, cache: 'default' });
  } catch (err) {
    throw new DataLoadError(url, null, `${url}: ${(err as Error).message ?? String(err)}`);
  }
  if (!res.ok) throw new DataLoadError(url, res.status, `${url}: HTTP ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new DataLoadError(url, res.status, `${url}: JSON parse failed (${(err as Error).message})`);
  }
}

function joinUrl(base: string, file: string): string {
  return base.endsWith('/') ? base + file : `${base}/${file}`;
}

const EMPTY_COASTAL: CoastalGeoJSON = { type: 'FeatureCollection', features: [] };
const EMPTY_COVERAGE: BuildingCoverage = { generated: '', pmtiles: {}, plateau_3dtiles_cities: [] };

/**
 * 4ファイルを並列取得する。
 * - municipalities / tsunami は必須（失敗時は DataLoadError を throw）
 * - coastal / coverage は任意（失敗時は空データ＋ warnings で継続。マスクは bbox 矩形へフォールバック）
 */
export async function loadAll(base: string, signal?: AbortSignal): Promise<AppData> {
  // 沿岸ポリゴンは一枚ファイル（14.7 MB）を読まず、都道府県別 `coastal/{pref_code}.geojson` を
  // 市区町村選択時に `ensureCoastalPref()` で遅延取得する（スマホの初回転送量対策）
  const [muni, tsunami, coverage] = await Promise.allSettled([
    fetchJson<MunicipalitiesFile>(joinUrl(base, DATA_FILES.municipalities), signal),
    fetchJson<TsunamiFile>(joinUrl(base, DATA_FILES.tsunami), signal),
    fetchJson<BuildingCoverage>(joinUrl(base, DATA_FILES.coverage), signal),
  ]);

  if (muni.status === 'rejected') throw muni.reason;
  if (tsunami.status === 'rejected') throw tsunami.reason;
  validateMunicipalities(muni.value);
  validateTsunami(tsunami.value);

  const warnings: string[] = [];
  const coastalValue: CoastalGeoJSON = { type: 'FeatureCollection', features: [] };
  let coverageValue = EMPTY_COVERAGE;
  if (coverage.status === 'fulfilled' && coverage.value?.pmtiles) {
    coverageValue = coverage.value;
  } else {
    warnings.push(`建物カバレッジ（${DATA_FILES.coverage}）を取得できませんでした。建物なしで表示します。`);
  }

  return {
    municipalities: muni.value,
    coastal: coastalValue,
    tsunami: tsunami.value,
    coverage: coverageValue,
    warnings,
    isFixture: Boolean(muni.value.fixture || tsunami.value.fixture || coastalValue.fixture || coverageValue.fixture),
  };
}

const loadedCoastalPrefs = new Map<string, Promise<boolean>>();

/**
 * 都道府県別の沿岸ポリゴン `coastal/{pref_code}.geojson` を取得し `data.coastal.features` へ追記する。
 * 同じ県は1回だけ取得（進行中は同じ Promise を返す）。失敗時は false（bbox 矩形へフォールバック）。
 */
export function ensureCoastalPref(data: AppData, base: string, prefCode: string | null | undefined): Promise<boolean> {
  if (!prefCode) return Promise.resolve(false);
  const cached = loadedCoastalPrefs.get(prefCode);
  if (cached) return cached;
  const p = fetchJson<CoastalGeoJSON>(joinUrl(base, `coastal/${prefCode}.geojson`))
    .then((fc) => {
      if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) return false;
      const known = new Set(data.coastal.features.map((f) => f.properties?.code));
      for (const f of fc.features) if (!known.has(f.properties?.code)) data.coastal.features.push(f);
      return true;
    })
    .catch(() => {
      loadedCoastalPrefs.delete(prefCode); // 次回再試行できるようにする
      return false;
    });
  loadedCoastalPrefs.set(prefCode, p);
  return p;
}

function validateMunicipalities(m: MunicipalitiesFile): void {
  if (!m || !Array.isArray(m.municipalities)) {
    throw new DataLoadError(DATA_FILES.municipalities, null, 'municipalities.json: `municipalities` 配列がありません');
  }
  for (const x of m.municipalities) {
    if (typeof x.code !== 'string' || x.code.length !== 5 || !Array.isArray(x.bbox) || x.bbox.length !== 4) {
      throw new DataLoadError(DATA_FILES.municipalities, null, `municipalities.json: 不正なエントリ ${JSON.stringify(x).slice(0, 80)}`);
    }
  }
}

function validateTsunami(t: TsunamiFile): void {
  if (!t || !Array.isArray(t.rows)) {
    throw new DataLoadError(DATA_FILES.tsunami, null, 'tsunami_h.json: `rows` 配列がありません');
  }
}

// ---------------------------------------------------------------------------
// 検索ヘルパー
// ---------------------------------------------------------------------------

/** 市区町村コード → エントリ。区コード（政令市）は親市へ解決する */
export function findMunicipality(data: MunicipalitiesFile, code: string | null | undefined): Municipality | null {
  if (!code) return null;
  const direct = data.municipalities.find((m) => m.code === code);
  if (direct) return direct;
  return data.municipalities.find((m) => m.wards?.includes(code)) ?? null;
}

/** 津波高の行。コード一致を優先し、政令市は区コードでも親市の行を返す */
export function findTsunamiRow(data: TsunamiFile, muni: Municipality | null): TsunamiRow | null {
  if (!muni) return null;
  const byCode = data.rows.find((r) => r.code === muni.code);
  if (byCode) return byCode;
  if (muni.wards?.length) {
    // 区単位の行しか無い場合は区の最大値を合成する
    const wardRows = data.rows.filter((r) => r.code && muni.wards!.includes(r.code));
    if (wardRows.length) return mergeRows(muni, wardRows);
  }
  return data.rows.find((r) => r.name === muni.name && r.pref === muni.pref) ?? null;
}

function maxOf(vals: (number | null | undefined)[]): number | null {
  const nums = vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? Math.max(...nums) : null;
}

function mergeRows(muni: Municipality, rows: TsunamiRow[]): TsunamiRow {
  const cases: Record<string, number | null> = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.cases_2025 ?? {})) cases[k] = maxOf([cases[k], v]);
  }
  return {
    code: muni.code,
    pref: muni.pref,
    name: muni.name,
    max_2025: maxOf(rows.map((r) => r.max_2025)),
    mean_2025: maxOf(rows.map((r) => r.mean_2025)),
    cases_2025: cases,
    max_2012: maxOf(rows.map((r) => r.max_2012)),
    area_ha_2025: rows.reduce<number | null>((a, r) => (r.area_ha_2025 == null ? a : (a ?? 0) + r.area_ha_2025), null),
    raw_name: rows.map((r) => r.raw_name).join('/'),
    note: '区別の値から合成（最大値）',
  };
}

/** プリセットに対応する津波高（m）。値が無ければ null */
export function heightForPreset(row: TsunamiRow | null, preset: HeightPreset): number | null {
  if (!row) return null;
  const v = row[preset];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** bbox → 閉じた矩形ポリゴン */
export function bboxPolygon(bbox: [number, number, number, number]): PolygonGeometry {
  const [w, s, e, n] = bbox;
  return {
    type: 'Polygon',
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}

/** 市区町村ポリゴン。GeoJSON に無ければ municipalities.json の bbox 矩形で代用する */
export function geometryFor(
  coastal: CoastalGeoJSON,
  muni: Municipality | null,
): { geometry: MunicipalityGeometry; fromBbox: boolean } | null {
  if (!muni) return null;
  const f = coastal.features.find((x) => x.properties?.code === muni.code);
  if (f?.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')) {
    return { geometry: f.geometry, fromBbox: false };
  }
  return { geometry: bboxPolygon(muni.bbox), fromBbox: true };
}

/** ジオメトリの bbox（フォールバックや fitBounds 用） */
export function geometryBbox(g: MunicipalityGeometry): [number, number, number, number] {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const rings = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  }
  return [w, s, e, n];
}
