/**
 * 国土地理院 標高タイル（PNG）→ MapLibre `terrarium` エンコード変換プロトコル
 *
 * 地理院PNG:  x = R*65536 + G*256 + B
 *   x <  2^23 → h = x * 0.01 [m]
 *   x == 2^23 → 無効値（0 m 扱い）
 *   x >  2^23 → h = (x - 2^24) * 0.01 [m]
 * terrarium:  v = h + 32768,  R = floor(v/256), G = floor(v) mod 256, B = round(frac(v)*256)
 *   MapLibre 側の復号（dem_data.ts）:  h = R*256 + G + B/256 - 32768
 *   → B は 1/256 m 刻み。0.01 m 刻みの地理院値は最大 ±1/512 m (≈2 mm) の量子化誤差で保持される
 *
 * 利用:  maplibregl.addProtocol('gsidem', gsidemProtocol)
 *        tiles: ['gsidem://https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png']
 *
 * 純粋関数（decodeGsiPixel / encodeTerrariumPixel / convertGsiToTerrarium / LruCache）は
 * DOM 非依存で、vitest（node 環境）から直接テストできる。
 */
import type { AddProtocolAction, GetResourceResponse, RequestParameters } from 'maplibre-gl';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------
export const TILE_SIZE = 256;
/** 地理院PNGの無効値 (2^23) */
export const GSI_INVALID = 0x800000; // 8388608
const GSI_WRAP = 0x1000000; // 2^24
/** terrarium の表現範囲 [m]。R が 0..255 に収まる範囲 */
export const TERRARIUM_MIN = -32768;
export const TERRARIUM_MAX = 32767 + 255 / 256;
const TERRARIUM_BASE = 32768;
/** メモリキャッシュ上限（タイル数） */
export const CACHE_LIMIT = 200;

// ---------------------------------------------------------------------------
// 純粋関数
// ---------------------------------------------------------------------------

/**
 * 地理院 dem_png の1ピクセル(R,G,B)を標高[m]へ復号する。
 * 無効値 (x == 2^23) は 0 m を返す。
 */
export function decodeGsiPixel(r: number, g: number, b: number): number {
  const x = r * 65536 + g * 256 + b;
  if (x === GSI_INVALID) return 0;
  if (x < GSI_INVALID) return x * 0.01;
  return (x - GSI_WRAP) * 0.01;
}

/**
 * 標高[m]を terrarium の (R,G,B) へ符号化する。
 * v = h + 32768 を 1/256 単位へ四捨五入し、上位から R / G / B に分配する（桁上がりを正しく処理）。
 * 表現範囲外は [TERRARIUM_MIN, TERRARIUM_MAX] にクランプする。非数は 0 m 扱い。
 */
export function encodeTerrariumPixel(h: number): [number, number, number] {
  if (!Number.isFinite(h)) h = 0;
  if (h < TERRARIUM_MIN) h = TERRARIUM_MIN;
  else if (h > TERRARIUM_MAX) h = TERRARIUM_MAX;
  // (h + 32768) * 256 を整数化。最大 (65535.996)*256 ≈ 16777215 < 2^24 なので 32bit 整数演算で安全
  let q = Math.round((h + TERRARIUM_BASE) * 256);
  if (q < 0) q = 0;
  else if (q > 0xffffff) q = 0xffffff;
  return [(q >>> 16) & 0xff, (q >>> 8) & 0xff, q & 0xff];
}

/** terrarium の (R,G,B) から標高[m]を復号する（MapLibre dem_data.ts と同一式。テスト・検証用） */
export function decodeTerrariumPixel(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - TERRARIUM_BASE;
}

/**
 * 地理院PNGのRGBA配列を terrarium へ in-place 変換する。
 * アルファは常に 255（完全不透明）にする。
 */
export function convertGsiToTerrarium(data: Uint8ClampedArray | Uint8Array): void {
  const n = data.length - (data.length % 4);
  for (let i = 0; i < n; i += 4) {
    const h = decodeGsiPixel(data[i], data[i + 1], data[i + 2]);
    const [r, g, b] = encodeTerrariumPixel(h);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
}

/** 全画素 h[m] の RGBA 配列を生成する（平坦タイル用） */
export function makeFlatRgba(h: number, size: number = TILE_SIZE): Uint8ClampedArray {
  const [r, g, b] = encodeTerrariumPixel(h);
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return data;
}

/** 単純な LRU キャッシュ（Map の挿入順を利用） */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(public readonly limit: number) {
    if (!(limit > 0)) throw new RangeError('LruCache limit must be > 0');
  }
  get size(): number {
    return this.map.size;
  }
  has(key: K): boolean {
    return this.map.has(key);
  }
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // 最近使用として末尾へ移動
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }
  delete(key: K): boolean {
    return this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

// ---------------------------------------------------------------------------
// ブラウザ依存部
// ---------------------------------------------------------------------------

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
interface CanvasPair {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: Canvas2D;
}

/**
 * 2D キャンバスを生成する。
 * OffscreenCanvas は iOS/Safari 16.4 以降で 2D 対応。存在しても getContext('2d') が null を返す
 * 古い Safari を考慮し、失敗時は <canvas> へフォールバックする（Worker 内など document が無い場合は例外）。
 */
function makeCanvas(w: number, h: number, willReadFrequently: boolean): CanvasPair {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d', { willReadFrequently });
      if (ctx) return { canvas, ctx };
    } catch {
      /* fall through */
    }
  }
  if (typeof document === 'undefined') {
    throw new Error('gsidem: no 2D canvas available (OffscreenCanvas unsupported and no document)');
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently });
  if (!ctx) throw new Error('gsidem: 2D canvas context unavailable');
  return { canvas, ctx };
}

/** キャンバスを PNG の ArrayBuffer へ。convertToBlob → toBlob の順にフォールバック */
async function canvasToPng(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<ArrayBuffer> {
  if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return blob.arrayBuffer();
  }
  const el = canvas as HTMLCanvasElement;
  if (typeof el.toBlob === 'function') {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      el.toBlob((blob) => {
        if (!blob) return reject(new Error('gsidem: canvas.toBlob returned null'));
        blob.arrayBuffer().then(resolve, reject);
      }, 'image/png');
    });
  }
  // 最終手段: dataURL → ArrayBuffer
  const dataUrl = el.toDataURL('image/png');
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function abortError(reason?: unknown): Error {
  // MapLibre は error.name === 'AbortError' で中断を判定する（isAbortError）ので、名前を必ず揃える
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  if (typeof DOMException !== 'undefined') return new DOMException('gsidem: aborted', 'AbortError');
  const e = new Error('gsidem: aborted');
  e.name = 'AbortError';
  return e;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal.reason);
}

/** RGBA 配列を PNG（ArrayBuffer）へエンコード */
async function rgbaToPng(rgba: Uint8ClampedArray, w: number, h: number): Promise<ArrayBuffer> {
  const { canvas, ctx } = makeCanvas(w, h, false);
  const img = ctx.createImageData(w, h);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
  return canvasToPng(canvas);
}

// 平坦 0 m の terrarium タイル（DEM未整備域・404用）。一度だけ生成してキャッシュ。失敗時は再試行できるよう破棄。
let flatTilePromise: Promise<ArrayBuffer> | null = null;
function flatTile(): Promise<ArrayBuffer> {
  if (!flatTilePromise) {
    flatTilePromise = rgbaToPng(makeFlatRgba(0), TILE_SIZE, TILE_SIZE).catch((e) => {
      flatTilePromise = null;
      throw e;
    });
  }
  return flatTilePromise;
}

/** <img> 経由でデコード（createImageBitmap 非対応／失敗時のフォールバック。document 必須） */
async function blobToImageElement(blob: Blob, signal: AbortSignal): Promise<HTMLImageElement> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    throw new Error('gsidem: no image decoder available');
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(abortError(signal.reason));
      signal.addEventListener('abort', onAbort, { once: true });
      img.onload = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      img.onerror = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('gsidem: image decode failed'));
      };
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * PNG blob → RGBA 配列。
 * - createImageBitmap には premultiplyAlpha:'none' / colorSpaceConversion:'none' を指定し、
 *   Safari 等での色補正・アルファ乗算による画素値破壊を防ぐ
 * - 拡大縮小補間は禁止（imageSmoothingEnabled=false、原寸描画）
 */
async function decodeBlobToRgba(
  blob: Blob,
  signal: AbortSignal,
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  let source: ImageBitmap | HTMLImageElement | null = null;
  let width = 0;
  let height = 0;

  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob, {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
      source = bmp;
      width = bmp.width;
      height = bmp.height;
    } catch {
      source = null; // フォールバックへ
    }
  }
  if (!source) {
    const img = await blobToImageElement(blob, signal);
    source = img;
    width = img.naturalWidth || img.width;
    height = img.naturalHeight || img.height;
  }
  throwIfAborted(signal);

  if (!(width > 0 && height > 0)) {
    if ('close' in source) source.close();
    throw new Error('gsidem: decoded image has zero size');
  }

  try {
    const { ctx } = makeCanvas(width, height, true);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, 0, 0);
    const img = ctx.getImageData(0, 0, width, height);
    return { data: img.data, width, height };
  } finally {
    if ('close' in source) source.close();
  }
}

// ---------------------------------------------------------------------------
// プロトコルハンドラ
// ---------------------------------------------------------------------------

/** URL キー → 変換済み terrarium PNG。MapLibre は ArrayBuffer を Worker へ転送(detach)し得るため、返却時は必ず複製する */
const tileCache = new LruCache<string, ArrayBuffer>(CACHE_LIMIT);

interface InflightEntry {
  promise: Promise<{ png: ArrayBuffer | null; cacheControl?: string; expires?: string }>;
  controller: AbortController;
  waiters: number;
}
/** 同一 URL の並行リクエストをまとめる（in-flight dedupe）。全 waiter が abort した時だけ fetch を中断する */
const inflight = new Map<string, InflightEntry>();

/** テスト・デバッグ用: キャッシュ統計 */
export function getGsidemCacheStats(): { size: number; limit: number; inflight: number } {
  return { size: tileCache.size, limit: tileCache.limit, inflight: inflight.size };
}
export function clearGsidemCache(): void {
  tileCache.clear();
}

/** `gsidem://https://...` → `https://...` */
export function stripGsidemScheme(url: string): string {
  return url.replace(/^gsidem:\/\//i, '');
}

/** 「タイル未整備」と見なす HTTP ステータス（平坦 0 m タイルを返す） */
export function isMissingTileStatus(status: number): boolean {
  return status === 404 || status === 204 || status === 410;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    url: string,
  ) {
    super(`gsidem: HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

interface TileResult {
  png: ArrayBuffer | null;
  cacheControl?: string;
  expires?: string;
}

/**
 * 実際の取得・変換（単一 URL）。png: null は「未整備（平坦タイル）」を意味する。
 * ネットワーク障害・5xx などは例外で reject する（MapLibre 側で error イベントになり、次回表示時に再要求される）。
 */
async function fetchAndConvert(url: string, signal: AbortSignal): Promise<TileResult> {
  const res = await fetch(url, { signal });
  if (isMissingTileStatus(res.status)) {
    return { png: null };
  }
  if (!res.ok) {
    throw new HttpError(res.status, url);
  }
  const blob = await res.blob();
  throwIfAborted(signal);

  const { data, width, height } = await decodeBlobToRgba(blob, signal);
  convertGsiToTerrarium(data);
  const png = await rgbaToPng(data, width, height);
  throwIfAborted(signal);

  return {
    png,
    cacheControl: res.headers.get('cache-control') ?? undefined,
    expires: res.headers.get('expires') ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// 全国対応: z15 は dem5a_png → dem5b_png → 親 z14 dem_png を 2× 拡大、z≤14 は dem_png
// ---------------------------------------------------------------------------

/** 地理院タイルのベース URL */
export const GSI_XYZ_BASE = 'https://cyberjapandata.gsi.go.jp/xyz';
/** dem_png（10 m メッシュ）の最大ズーム。これより上は dem5a/dem5b、無ければ親タイル拡大 */
export const DEM10_MAX_ZOOM = 14;
/** z15 で試すデータセットの順（5 m メッシュ：航空レーザ → 写真測量） */
export const DEM5_DATASETS = ['dem5a_png', 'dem5b_png'] as const;
/** 親タイル（復号済み標高）キャッシュ上限。1 枚 256 KB（Float32 × 65536） */
export const PARENT_CACHE_LIMIT = 32;

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/**
 * プロトコル URL を解釈する。対応形式:
 *   - `gsidem://gsi/{z}/{x}/{y}`                                   … 推奨（ベースは GSI_XYZ_BASE）
 *   - `gsidem://https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png` … 旧形式（ベースを URL から抽出）
 * それ以外（テスト用の任意 URL など）は null を返し、URL をそのまま 1 回取得する旧来動作になる。
 */
export function parseTileUrl(url: string): { base: string; coord: TileCoord } | null {
  const u = stripGsidemScheme(url);
  let m = /^gsi\/(\d+)\/(\d+)\/(\d+)(?:\.png)?$/i.exec(u);
  if (m) return { base: GSI_XYZ_BASE, coord: { z: +m[1], x: +m[2], y: +m[3] } };
  m = /^(.*)\/dem(?:5a|5b)?_png\/(\d+)\/(\d+)\/(\d+)\.png$/i.exec(u);
  if (m) return { base: m[1], coord: { z: +m[2], x: +m[3], y: +m[4] } };
  return null;
}

export function gsiTileUrl(base: string, dataset: string, c: TileCoord): string {
  return `${base}/${dataset}/${c.z}/${c.x}/${c.y}.png`;
}

/**
 * 地理院 dem_png の1ピクセルを標高へ。無効値 (2^23) は NaN を返す（decodeGsiPixel は 0 を返す）。
 */
export function decodeGsiPixelOrNaN(r: number, g: number, b: number): number {
  const x = r * 65536 + g * 256 + b;
  if (x === GSI_INVALID) return NaN;
  if (x < GSI_INVALID) return x * 0.01;
  return (x - GSI_WRAP) * 0.01;
}

/** RGBA（地理院PNG）→ 標高 Float32Array（無効値は NaN） */
export function rgbaToHeights(data: Uint8ClampedArray | Uint8Array, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = decodeGsiPixelOrNaN(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  }
  return out;
}

/** 標高配列 → terrarium RGBA。NaN は 0 m として符号化する */
export function heightsToTerrariumRgba(heights: Float32Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(heights.length * 4);
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    const [r, g, b] = encodeTerrariumPixel(Number.isNaN(h) ? 0 : h);
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * 祖先タイル（zoom 差 d）の該当象限を 2^d 倍に最近傍拡大して子タイルを作る（純粋関数）。
 * `parent` は size×size、戻り値も size×size。
 */
export function upscaleFromAncestor(
  parent: Float32Array,
  child: TileCoord,
  ancestorZ: number,
  size: number = TILE_SIZE,
): Float32Array {
  const d = child.z - ancestorZ;
  if (d < 0) throw new RangeError('upscaleFromAncestor: ancestorZ must be <= child.z');
  const f = 1 << d;
  const qx = child.x & (f - 1);
  const qy = child.y & (f - 1);
  const out = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    const pj = Math.floor((qy * size + j) / f);
    for (let i = 0; i < size; i++) {
      const pi = Math.floor((qx * size + i) / f);
      out[j * size + i] = parent[pj * size + pi];
    }
  }
  return out;
}

/** NaN（無効値）の画素を fallback の同位置の値で埋める。埋めた画素数を返す */
export function fillInvalid(target: Float32Array, fallback: Float32Array): number {
  let n = 0;
  for (let i = 0; i < target.length; i++) {
    if (Number.isNaN(target[i])) {
      const v = fallback[i];
      target[i] = Number.isNaN(v) ? 0 : v;
      n++;
    }
  }
  return n;
}

export function countInvalid(heights: Float32Array): number {
  let n = 0;
  for (let i = 0; i < heights.length; i++) if (Number.isNaN(heights[i])) n++;
  return n;
}

interface DecodedTile {
  heights: Float32Array;
  width: number;
  height: number;
  cacheControl?: string;
  expires?: string;
}

/** URL を取得して標高配列へ復号する。未整備（404 等）は null */
async function fetchHeights(url: string, signal: AbortSignal): Promise<DecodedTile | null> {
  const res = await fetch(url, { signal });
  if (isMissingTileStatus(res.status)) return null;
  if (!res.ok) throw new HttpError(res.status, url);
  const blob = await res.blob();
  throwIfAborted(signal);
  const { data, width, height } = await decodeBlobToRgba(blob, signal);
  return {
    heights: rgbaToHeights(data, width * height),
    width,
    height,
    cacheControl: res.headers.get('cache-control') ?? undefined,
    expires: res.headers.get('expires') ?? undefined,
  };
}

/** 親（z14 dem_png）タイルの復号済み標高キャッシュ。null = 未整備 */
const parentCache = new LruCache<string, Float32Array | null>(PARENT_CACHE_LIMIT);
const parentInflight = new Map<string, Promise<Float32Array | null>>();

/**
 * z14 祖先タイルの標高を取得する（共有・キャッシュ）。呼び出し元の abort では中断せず、
 * 兄弟タイル（同じ親を持つ 4 枚）が再利用できるように完走させる。
 */
function ancestorHeights(base: string, child: TileCoord): Promise<Float32Array | null> {
  const d = child.z - DEM10_MAX_ZOOM;
  const a: TileCoord = { z: DEM10_MAX_ZOOM, x: child.x >> d, y: child.y >> d };
  const url = gsiTileUrl(base, 'dem_png', a);
  const cached = parentCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);
  let p = parentInflight.get(url);
  if (!p) {
    p = fetchHeights(url, new AbortController().signal)
      .then((t) => {
        const heights = t && t.width === TILE_SIZE && t.height === TILE_SIZE ? t.heights : null;
        parentCache.set(url, heights);
        return heights;
      })
      .finally(() => parentInflight.delete(url));
    p.catch(() => {});
    parentInflight.set(url, p);
  }
  return p;
}

/** テスト・デバッグ用: 直近の解決経路（URL → 使用データセット） */
export type ResolvedSource = 'dem_png' | 'dem5a_png' | 'dem5b_png' | 'dem5a_png+parent' | 'dem5b_png+parent' | 'parent-upscaled' | 'flat' | 'raw';
const resolvedLog = new LruCache<string, ResolvedSource>(64);
export function getGsidemResolvedSource(url: string): ResolvedSource | undefined {
  return resolvedLog.get(stripGsidemScheme(url));
}

/**
 * タイル 1 枚を解決する。
 *   z ≤ 14      : dem_png をそのまま変換（未整備は平坦 0 m）
 *   z ≥ 15      : dem5a_png → dem5b_png の順に試し、無効画素があれば z14 親タイルの拡大値で穴埋め。
 *                 両方 404 なら z14 親タイルの該当象限を 2^(z-14) 倍に拡大。それも無ければ平坦 0 m
 *   解釈不能 URL: そのまま 1 回取得（旧来動作・テスト用）
 */
async function resolveTile(url: string, signal: AbortSignal): Promise<TileResult> {
  const parsed = parseTileUrl(url);
  if (!parsed) {
    resolvedLog.set(url, 'raw');
    return fetchAndConvert(url, signal);
  }
  const { base, coord } = parsed;

  if (coord.z <= DEM10_MAX_ZOOM) {
    resolvedLog.set(url, 'dem_png');
    return fetchAndConvert(gsiTileUrl(base, 'dem_png', coord), signal);
  }

  const n = TILE_SIZE * TILE_SIZE;
  for (const ds of DEM5_DATASETS) {
    const t = await fetchHeights(gsiTileUrl(base, ds, coord), signal);
    throwIfAborted(signal);
    if (!t) continue;
    if (t.width !== TILE_SIZE || t.height !== TILE_SIZE) continue;
    let source: ResolvedSource = ds;
    if (countInvalid(t.heights) > 0) {
      // 5 m メッシュの整備範囲境界: 無効画素を 10 m メッシュの親タイルで補完する
      const parent = await ancestorHeights(base, coord);
      throwIfAborted(signal);
      if (parent) {
        fillInvalid(t.heights, upscaleFromAncestor(parent, coord, DEM10_MAX_ZOOM));
        source = `${ds}+parent`;
      }
    }
    const png = await rgbaToPng(heightsToTerrariumRgba(t.heights), TILE_SIZE, TILE_SIZE);
    throwIfAborted(signal);
    resolvedLog.set(url, source);
    return { png, cacheControl: t.cacheControl, expires: t.expires };
  }

  const parent = await ancestorHeights(base, coord);
  throwIfAborted(signal);
  if (!parent) {
    resolvedLog.set(url, 'flat');
    return { png: null };
  }
  const up = upscaleFromAncestor(parent, coord, DEM10_MAX_ZOOM);
  const png = await rgbaToPng(heightsToTerrariumRgba(up), TILE_SIZE, TILE_SIZE);
  throwIfAborted(signal);
  resolvedLog.set(url, 'parent-upscaled');
  return { png };
}

export const gsidemProtocol: AddProtocolAction = async (
  params: RequestParameters,
  abortController: AbortController,
): Promise<GetResourceResponse<ArrayBuffer>> => {
  const signal = abortController.signal;
  throwIfAborted(signal);
  const url = stripGsidemScheme(params.url);

  // 1) メモリキャッシュ
  const cached = tileCache.get(url);
  if (cached) {
    return { data: cached.slice(0) };
  }

  // 2) in-flight 共有
  let entry = inflight.get(url);
  if (!entry) {
    const controller = new AbortController();
    const e: InflightEntry = { controller, waiters: 0, promise: null as never };
    e.promise = resolveTile(url, controller.signal)
      .then((r) => {
        if (r.png) tileCache.set(url, r.png);
        return r;
      })
      .finally(() => {
        if (inflight.get(url) === e) inflight.delete(url);
      });
    // 全 waiter が abort した後に reject しても unhandled rejection にならないよう握っておく（各 waiter は自分で await する）
    e.promise.catch(() => {});
    inflight.set(url, e);
    entry = e;
  }
  entry.waiters++;
  // 自分の abort で即座に reject し、最後の waiter が抜けた時だけ共有 fetch を中断する
  let onAbort!: () => void;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => {
      entry!.waiters--;
      if (entry!.waiters <= 0) entry!.controller.abort(signal.reason);
      reject(abortError(signal.reason));
    };
  });
  signal.addEventListener('abort', onAbort, { once: true });

  let result: { png: ArrayBuffer | null; cacheControl?: string; expires?: string };
  try {
    result = await Promise.race([entry.promise, abortPromise]);
  } catch (err) {
    // 自分が abort されていれば AbortError を投げる（MapLibre は AbortError を無視する）。
    // 他 waiter 由来の abort で fetch が止まった場合も、自分は未 abort なので通常エラーとして reject → 再要求可能
    throw signal.aborted ? abortError(signal.reason) : err;
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!signal.aborted) entry.waiters--;
  }
  throwIfAborted(signal);

  if (result.png === null) {
    // 404 など = DEM未整備域（海上など）。透明ではなく平坦 0 m タイルを返す
    const flat = await flatTile();
    return { data: flat.slice(0) };
  }
  return { data: result.png.slice(0), cacheControl: result.cacheControl, expires: result.expires };
};
