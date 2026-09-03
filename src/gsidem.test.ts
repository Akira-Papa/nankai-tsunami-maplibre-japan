import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_LIMIT,
  GSI_INVALID,
  HttpError,
  LruCache,
  TERRARIUM_MAX,
  TERRARIUM_MIN,
  clearGsidemCache,
  convertGsiToTerrarium,
  decodeGsiPixel,
  decodeTerrariumPixel,
  encodeTerrariumPixel,
  getGsidemCacheStats,
  gsidemProtocol,
  isMissingTileStatus,
  makeFlatRgba,
  stripGsidemScheme,
} from './gsidem';

/** 地理院 24bit 値 x → (R,G,B) */
function gsiRgb(x: number): [number, number, number] {
  return [(x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff];
}

/** terrarium 量子化の理論最大誤差（四捨五入なので 1/512）＋浮動小数点余裕 */
const MAX_ERR = 1 / 512 + 1e-9;

describe('decodeGsiPixel', () => {
  it('x < 2^23 は x*0.01', () => {
    expect(decodeGsiPixel(0, 0, 0)).toBe(0);
    expect(decodeGsiPixel(0, 0, 1)).toBeCloseTo(0.01, 12);
    expect(decodeGsiPixel(0, 0, 173)).toBeCloseTo(1.73, 12);
    expect(decodeGsiPixel(...gsiRgb(377600))).toBeCloseTo(3776.0, 9); // 富士山
    expect(decodeGsiPixel(...gsiRgb(GSI_INVALID - 1))).toBeCloseTo((2 ** 23 - 1) * 0.01, 6);
  });

  it('x == 2^23 は無効値 → 0 m', () => {
    expect(GSI_INVALID).toBe(8388608);
    expect(decodeGsiPixel(128, 0, 0)).toBe(0);
  });

  it('x > 2^23 は (x - 2^24)*0.01 の負値', () => {
    // 名古屋の最低標高 -1.73 m → x = 2^24 - 173
    const x = 2 ** 24 - 173;
    expect(gsiRgb(x)).toEqual([255, 255, 83]);
    expect(decodeGsiPixel(255, 255, 83)).toBeCloseTo(-1.73, 12);
    expect(decodeGsiPixel(255, 255, 255)).toBeCloseTo(-0.01, 12);
    expect(decodeGsiPixel(...gsiRgb(GSI_INVALID + 1))).toBeCloseTo((2 ** 23 + 1 - 2 ** 24) * 0.01, 6);
  });
});

describe('encodeTerrariumPixel', () => {
  it('基本値', () => {
    expect(encodeTerrariumPixel(0)).toEqual([128, 0, 0]);
    expect(encodeTerrariumPixel(1)).toEqual([128, 1, 0]);
    expect(encodeTerrariumPixel(256)).toEqual([129, 0, 0]);
    expect(encodeTerrariumPixel(0.5)).toEqual([128, 0, 128]);
    expect(encodeTerrariumPixel(-1)).toEqual([127, 255, 0]);
    expect(encodeTerrariumPixel(-0.5)).toEqual([127, 255, 128]);
  });

  it('B は round(frac*256) で、桁上がりが G/R へ正しく伝播する', () => {
    // 0.999 → frac*256 = 255.744 → round 256 → 桁上がりで G+1, B=0
    expect(encodeTerrariumPixel(0.999)).toEqual([128, 1, 0]);
    // 255.999 → G=255 からの桁上がりで R+1
    expect(encodeTerrariumPixel(255.999)).toEqual([129, 0, 0]);
    // 0.01 → 2.56 → round 3 (floor だと 2)
    expect(encodeTerrariumPixel(0.01)).toEqual([128, 0, 3]);
  });

  it('MapLibre 復号式 (R*256 + G + B/256 - 32768) と往復一致', () => {
    for (const h of [0, 0.01, 1.73, -1.73, 3776, -100, 4000, 0.004, -0.004]) {
      const [r, g, b] = encodeTerrariumPixel(h);
      expect(Math.abs(decodeTerrariumPixel(r, g, b) - h)).toBeLessThanOrEqual(MAX_ERR);
    }
  });

  it('範囲外はクランプ、非数は 0 m', () => {
    expect(encodeTerrariumPixel(TERRARIUM_MIN)).toEqual([0, 0, 0]);
    expect(encodeTerrariumPixel(TERRARIUM_MIN - 1000)).toEqual([0, 0, 0]);
    expect(encodeTerrariumPixel(TERRARIUM_MAX)).toEqual([255, 255, 255]);
    expect(encodeTerrariumPixel(1e9)).toEqual([255, 255, 255]);
    expect(encodeTerrariumPixel(Number.NaN)).toEqual([128, 0, 0]);
    expect(encodeTerrariumPixel(Number.POSITIVE_INFINITY)).toEqual([128, 0, 0]);
    // 全出力は 0..255 の整数
    for (const h of [-40000, -32768.9, 32767.9999, 99999, 0.0001]) {
      for (const c of encodeTerrariumPixel(h)) {
        expect(Number.isInteger(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(255);
      }
    }
  });
});

describe('往復精度 (-100 m .. 4000 m, 0.01 m 刻み)', () => {
  it('地理院値 → terrarium → MapLibre 復号 の誤差が 1/512 m 以下', () => {
    let maxErr = 0;
    // 0.01 刻み全件 (410,001 値)
    for (let cm = -10000; cm <= 400000; cm++) {
      const h = cm / 100;
      const [r, g, b] = encodeTerrariumPixel(h);
      const err = Math.abs(decodeTerrariumPixel(r, g, b) - h);
      if (err > maxErr) maxErr = err;
    }
    expect(maxErr).toBeLessThanOrEqual(MAX_ERR);
  });

  it('地理院24bit画素 → decode → encode → MapLibre 復号 の誤差が 1/512 m 以下（負値含む）', () => {
    let maxErr = 0;
    const check = (x: number) => {
      const [r, g, b] = gsiRgb(x);
      const h = decodeGsiPixel(r, g, b);
      const [tr, tg, tb] = encodeTerrariumPixel(h);
      const err = Math.abs(decodeTerrariumPixel(tr, tg, tb) - h);
      if (err > maxErr) maxErr = err;
    };
    for (let x = 0; x <= 400000; x++) check(x); // 0 .. 4000 m
    for (let x = 2 ** 24 - 10000; x < 2 ** 24; x++) check(x); // -100 .. -0.01 m
    expect(maxErr).toBeLessThanOrEqual(MAX_ERR);
  });

  it('0.01 m の差が terrarium 上で単調に保たれる（B チャネルで sub-meter が生き残る）', () => {
    let prev = -Infinity;
    for (let cm = -200; cm <= 200; cm++) {
      const [r, g, b] = encodeTerrariumPixel(cm / 100);
      const v = r * 65536 + g * 256 + b;
      expect(v).toBeGreaterThanOrEqual(prev); // 単調非減少
      // 隣接値と少なくとも 2 段階(2/256 m)以上離れる: 0.01 m = 2.56/256
      if (prev !== -Infinity) expect(v - prev).toBeGreaterThanOrEqual(2);
      prev = v;
    }
  });
});

describe('convertGsiToTerrarium', () => {
  it('RGBA 配列を in-place 変換し、アルファを常に 255 にする', () => {
    const px = [
      [0, 0, 0, 0], // 0 m, alpha 0
      [0, 0, 173, 10], // 1.73 m
      [255, 255, 83, 255], // -1.73 m
      [128, 0, 0, 0], // invalid → 0 m
      [5, 195, 0, 255], // 377600 = 0x05C300 → 3776 m
    ];
    const data = new Uint8ClampedArray(px.flat());
    convertGsiToTerrarium(data);
    const expected = [
      encodeTerrariumPixel(0),
      encodeTerrariumPixel(1.73),
      encodeTerrariumPixel(-1.73),
      encodeTerrariumPixel(0),
      encodeTerrariumPixel(3776),
    ];
    for (let i = 0; i < px.length; i++) {
      expect([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]).toEqual(expected[i]);
      expect(data[i * 4 + 3]).toBe(255);
    }
    // 無効値と 0 m は同じ出力 (128,0,0)
    expect([data[12], data[13], data[14]]).toEqual([128, 0, 0]);
  });

  it('256x256 タイル全画素が処理される', () => {
    const data = new Uint8ClampedArray(256 * 256 * 4); // 全画素 0 m, alpha 0
    convertGsiToTerrarium(data);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 128 || data[i + 1] !== 0 || data[i + 2] !== 0 || data[i + 3] !== 255) {
        throw new Error(`pixel ${i / 4} mismatch`);
      }
    }
  });

  it('makeFlatRgba(0) は (128,0,0,255) で埋まる', () => {
    const d = makeFlatRgba(0, 4);
    expect(d.length).toBe(4 * 4 * 4);
    expect(Array.from(d.slice(0, 4))).toEqual([128, 0, 0, 255]);
    expect(Array.from(d.slice(-4))).toEqual([128, 0, 0, 255]);
  });
});

describe('LruCache', () => {
  it('上限を超えると最も古いものから追い出す', () => {
    const c = new LruCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.set('d', 4);
    expect(c.size).toBe(3);
    expect(c.has('a')).toBe(false);
    expect(c.get('b')).toBe(2);
  });

  it('get で最近使用に昇格する', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');
    c.set('c', 3);
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
  });

  it('既定の上限は 200', () => {
    expect(CACHE_LIMIT).toBe(200);
    expect(() => new LruCache(0)).toThrow(RangeError);
  });
});

describe('ヘルパー', () => {
  it('stripGsidemScheme', () => {
    expect(stripGsidemScheme('gsidem://https://a/b/1/2/3.png')).toBe('https://a/b/1/2/3.png');
    expect(stripGsidemScheme('https://a/b.png')).toBe('https://a/b.png');
  });
  it('isMissingTileStatus', () => {
    expect(isMissingTileStatus(404)).toBe(true);
    expect(isMissingTileStatus(204)).toBe(true);
    expect(isMissingTileStatus(410)).toBe(true);
    expect(isMissingTileStatus(200)).toBe(false);
    expect(isMissingTileStatus(500)).toBe(false);
    expect(isMissingTileStatus(403)).toBe(false);
  });
});

/** ブラウザ Canvas に到達しない経路だけを node で検証する */
describe('gsidemProtocol（Canvas 非依存の経路）', () => {
  const URL = 'gsidem://https://example.test/dem/1/2/3.png';
  beforeEach(() => {
    clearGsidemCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ネットワークエラーは reject する（平坦タイルで握りつぶさない）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await expect(gsidemProtocol({ url: URL }, new AbortController())).rejects.toThrow('Failed to fetch');
    expect(getGsidemCacheStats().size).toBe(0);
    expect(getGsidemCacheStats().inflight).toBe(0);
  });

  it('5xx は HttpError で reject する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    await expect(gsidemProtocol({ url: URL }, new AbortController())).rejects.toBeInstanceOf(HttpError);
  });

  it('事前に abort 済みなら fetch せず AbortError で reject する', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const ac = new AbortController();
    ac.abort();
    await expect(gsidemProtocol({ url: URL }, ac)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetch 中の abort は AbortError で reject し、fetch へ signal が伝わる', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const ac = new AbortController();
    const p = gsidemProtocol({ url: URL }, ac);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getGsidemCacheStats().inflight).toBe(0);
  });

  it('同一 URL の並行要求は 1 回の fetch にまとめ、片方の abort で他方を巻き込まない', async () => {
    let resolveFetch!: (r: Response) => void;
    let aborted = false;
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
          init.signal!.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const p1 = gsidemProtocol({ url: URL }, ac1);
    const p2 = gsidemProtocol({ url: URL }, ac2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    ac1.abort();
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(false); // まだ p2 が待っているので fetch は継続
    resolveFetch(new Response(null, { status: 500 }));
    await expect(p2).rejects.toBeInstanceOf(HttpError);
  });
});

// ---------------------------------------------------------------------------
// 全国対応（z15 dem5a/dem5b → 親 z14 拡大）の純粋関数
// ---------------------------------------------------------------------------
import {
  GSI_XYZ_BASE,
  countInvalid,
  decodeGsiPixelOrNaN,
  fillInvalid,
  gsiTileUrl,
  heightsToTerrariumRgba,
  parseTileUrl,
  rgbaToHeights,
  upscaleFromAncestor,
} from './gsidem';

describe('parseTileUrl', () => {
  it('gsidem://gsi/{z}/{x}/{y} を解釈する', () => {
    expect(parseTileUrl('gsidem://gsi/15/28538/13138')).toEqual({ base: GSI_XYZ_BASE, coord: { z: 15, x: 28538, y: 13138 } });
    expect(parseTileUrl('gsidem://gsi/14/1/2.png')).toEqual({ base: GSI_XYZ_BASE, coord: { z: 14, x: 1, y: 2 } });
  });
  it('旧形式 URL からベースと座標を抽出する', () => {
    expect(parseTileUrl('gsidem://https://cyberjapandata.gsi.go.jp/xyz/dem_png/14/14269/6569.png')).toEqual({
      base: 'https://cyberjapandata.gsi.go.jp/xyz',
      coord: { z: 14, x: 14269, y: 6569 },
    });
    expect(parseTileUrl('https://h/xyz/dem5a_png/15/1/2.png')?.coord).toEqual({ z: 15, x: 1, y: 2 });
  });
  it('解釈できない URL は null（旧来の単一取得へ）', () => {
    expect(parseTileUrl('gsidem://https://example.test/dem/1/2/3.png')).toBeNull();
  });
  it('gsiTileUrl', () => {
    expect(gsiTileUrl(GSI_XYZ_BASE, 'dem5b_png', { z: 15, x: 3, y: 4 })).toBe(
      'https://cyberjapandata.gsi.go.jp/xyz/dem5b_png/15/3/4.png',
    );
  });
});

describe('無効値の扱いと親タイル拡大', () => {
  it('decodeGsiPixelOrNaN は無効値で NaN', () => {
    expect(decodeGsiPixelOrNaN(128, 0, 0)).toBeNaN();
    expect(decodeGsiPixelOrNaN(0, 0, 173)).toBeCloseTo(1.73, 12);
    expect(decodeGsiPixelOrNaN(255, 255, 83)).toBeCloseTo(-1.73, 12);
  });

  it('rgbaToHeights / heightsToTerrariumRgba（NaN → 0 m）', () => {
    const rgba = new Uint8ClampedArray([0, 0, 173, 255, 128, 0, 0, 255]);
    const h = rgbaToHeights(rgba, 2);
    expect(h[0]).toBeCloseTo(1.73, 5);
    expect(h[1]).toBeNaN();
    expect(countInvalid(h)).toBe(1);
    const out = heightsToTerrariumRgba(h);
    expect([out[4], out[5], out[6], out[7]]).toEqual([128, 0, 0, 255]);
    expect(Math.abs(decodeTerrariumPixel(out[0], out[1], out[2]) - 1.73)).toBeLessThanOrEqual(MAX_ERR);
  });

  it('upscaleFromAncestor は該当象限を 2× 最近傍拡大する', () => {
    const size = 4;
    const parent = new Float32Array(size * size);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) parent[j * size + i] = j * 10 + i;
    // 子 (z=1, x=1, y=0) → 親の右上象限 (i=2..3, j=0..1)
    const child = upscaleFromAncestor(parent, { z: 1, x: 1, y: 0 }, 0, size);
    expect(Array.from(child.slice(0, 4))).toEqual([2, 2, 3, 3]);
    expect(Array.from(child.slice(4, 8))).toEqual([2, 2, 3, 3]);
    expect(Array.from(child.slice(8, 12))).toEqual([12, 12, 13, 13]);
    // 左下象限 (z=1, x=0, y=1)
    const ll = upscaleFromAncestor(parent, { z: 1, x: 0, y: 1 }, 0, size);
    expect(Array.from(ll.slice(0, 4))).toEqual([20, 20, 21, 21]);
    // z 差 2 の孫（x=3,y=3 → 親の右下 1 画素を 4× 拡大）
    const gc = upscaleFromAncestor(parent, { z: 2, x: 3, y: 3 }, 0, size);
    expect(Array.from(new Set(gc))).toEqual([33]);
  });

  it('fillInvalid は NaN だけを埋める', () => {
    const t = new Float32Array([1, NaN, 3, NaN]);
    const f = new Float32Array([9, 8, 7, NaN]);
    expect(fillInvalid(t, f)).toBe(2);
    expect(Array.from(t)).toEqual([1, 8, 3, 0]);
  });
});
