import { describe, expect, it } from 'vitest';
// maplibre-gl の依存として同梱される style-spec を使い、式の構文と評価結果を検証する
import { createExpression, featureFilter, validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { ExpressionSpecification, FilterSpecification } from '@maplibre/maplibre-gl-style-spec';
import {
  BUILDING_DRY,
  BUILDING_IDS,
  BUILDING_SUBMERGED,
  BVMAP_DEFAULT_HEIGHT,
  BVMAP_HEIGHT_BY_FTCODE,
  BVMAP_MIN_ZOOM,
  PLATEAU_DEFAULT_HEIGHT,
  PLATEAU_TILE_ZOOM,
  STOREY_HEIGHT,
  bvmapHeightExpression,
  bvmapSubmergedFilter,
  buildingLayerSpecs,
  buildingSourceSpecs,
  centroidKey,
  featureCentroid,
  ftCodeToHeight,
  normalizeWaterLevel,
  plateauHeightExpression,
  resolvePlateauTiers,
  scaleRing,
  selectTier,
  submergedColorExpression,
  type BuildingTier,
  type TierObservation,
} from './buildings';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------
function compile(expr: ExpressionSpecification) {
  const r = createExpression(expr, 'layers[0].paint.fill-extrusion-height');
  if (r.result === 'error') {
    throw new Error(r.value.map((e) => e.message).join('; '));
  }
  return r.value;
}

function evalWith(expr: ExpressionSpecification, properties: Record<string, unknown>, state?: Record<string, unknown>) {
  const e = compile(expr);
  const feature = { type: 3 as const, properties, geometry: [] as never[], id: 1 };
  return e.evaluate({ zoom: 16 }, feature as never, state as never);
}

function runFilter(filter: FilterSpecification, properties: Record<string, unknown>): boolean {
  const f = featureFilter(filter, 'layers[0].filter');
  const feature = { type: 3 as const, properties, geometry: [] as never[] };
  return f.filter({ zoom: 16 }, feature as never, undefined as never);
}

const loaded = (count: number) => ({ loaded: true, count });
const loading = () => ({ loaded: false, count: 0 });
const obs = (zoom: number, lod1: TierObservation['lod1'], lod0: TierObservation['lod0']): TierObservation => ({
  zoom,
  lod1,
  lod0,
});

// ---------------------------------------------------------------------------
// ftCode → 高さ
// ---------------------------------------------------------------------------
describe('ftCodeToHeight', () => {
  it('maps the four building classes', () => {
    expect(ftCodeToHeight(3101)).toBe(6);
    expect(ftCodeToHeight(3102)).toBe(12);
    expect(ftCodeToHeight(3103)).toBe(30);
    expect(ftCodeToHeight(3111)).toBe(3);
    expect(ftCodeToHeight(3112)).toBe(3);
  });

  it('accepts numeric strings and falls back for unknown or missing codes', () => {
    expect(ftCodeToHeight('3103')).toBe(30);
    expect(ftCodeToHeight(9999)).toBe(BVMAP_DEFAULT_HEIGHT);
    expect(ftCodeToHeight(undefined)).toBe(BVMAP_DEFAULT_HEIGHT);
    expect(ftCodeToHeight(null)).toBe(BVMAP_DEFAULT_HEIGHT);
    expect(ftCodeToHeight('abc')).toBe(BVMAP_DEFAULT_HEIGHT);
  });

  it('agrees with the style expression for every known code', () => {
    const expr = bvmapHeightExpression();
    for (const [code, h] of Object.entries(BVMAP_HEIGHT_BY_FTCODE)) {
      expect(evalWith(expr, { ftCode: Number(code) })).toBe(h);
      expect(ftCodeToHeight(Number(code))).toBe(h);
    }
    expect(evalWith(expr, { ftCode: 3199 })).toBe(BVMAP_DEFAULT_HEIGHT);
    expect(evalWith(expr, {})).toBe(BVMAP_DEFAULT_HEIGHT);
  });

  it('adds the overlay offset uniformly', () => {
    const expr = bvmapHeightExpression(0.3);
    expect(evalWith(expr, { ftCode: 3103 })).toBeCloseTo(30.3);
    expect(evalWith(expr, { ftCode: 0 })).toBeCloseTo(BVMAP_DEFAULT_HEIGHT + 0.3);
  });
});

// ---------------------------------------------------------------------------
// PLATEAU 高さ式
// ---------------------------------------------------------------------------
describe('plateauHeightExpression', () => {
  const lod1 = plateauHeightExpression(['measuredHeight'], 'storeysAboveGround');
  const lod0 = plateauHeightExpression(['measured_height', 'cal_height_m'], 'storeys_above_ground');

  it('compiles', () => {
    expect(() => compile(lod1)).not.toThrow();
    expect(() => compile(lod0)).not.toThrow();
  });

  it('uses measuredHeight when present (LOD1)', () => {
    expect(evalWith(lod1, { measuredHeight: 32.9, storeysAboveGround: '2' })).toBe(32.9);
  });

  it('falls back to storeys × STOREY_HEIGHT, then the default (LOD1: storeys is a string)', () => {
    expect(evalWith(lod1, { storeysAboveGround: '4' })).toBe(4 * STOREY_HEIGHT);
    expect(evalWith(lod1, { measuredHeight: null, storeysAboveGround: '0' })).toBe(PLATEAU_DEFAULT_HEIGHT);
    expect(evalWith(lod1, {})).toBe(PLATEAU_DEFAULT_HEIGHT);
  });

  it('prefers measured_height, then cal_height_m, then storeys (LOD0)', () => {
    expect(evalWith(lod0, { measured_height: 32.9, cal_height_m: 17.9 })).toBe(32.9);
    expect(evalWith(lod0, { cal_height_m: 17.9, storeys_above_ground: 2 })).toBe(17.9);
    expect(evalWith(lod0, { storeys_above_ground: 5 })).toBe(5 * STOREY_HEIGHT);
    expect(evalWith(lod0, { measured_height: 0, cal_height_m: 0 })).toBe(PLATEAU_DEFAULT_HEIGHT);
  });

  it('treats non-numeric values as missing instead of throwing', () => {
    expect(evalWith(lod1, { measuredHeight: 'n/a' })).toBe(PLATEAU_DEFAULT_HEIGHT);
  });
});

// ---------------------------------------------------------------------------
// 浸水色・フィルタ
// ---------------------------------------------------------------------------
describe('submergedColorExpression / bvmapSubmergedFilter', () => {
  it('colours by feature-state.ground against the water level', () => {
    const expr = submergedColorExpression(3.5);
    const asHex = (v: unknown) => String(v);
    expect(asHex(evalWith(expr, {}, { ground: 1.2 }))).not.toBe(asHex(evalWith(expr, {}, { ground: 5 })));
    expect(compile(expr).evaluate({ zoom: 16 }, { type: 3, properties: {}, geometry: [] } as never, { ground: 3.5 } as never)).not.toEqual(
      compile(expr).evaluate({ zoom: 16 }, { type: 3, properties: {}, geometry: [] } as never, { ground: 3.51 } as never),
    );
    // 未サンプリングは乾燥色
    const dry = compile(['literal', BUILDING_DRY] as ExpressionSpecification).evaluate({ zoom: 16 });
    const submerged = compile(['literal', BUILDING_SUBMERGED] as ExpressionSpecification).evaluate({ zoom: 16 });
    expect(String(evalWith(expr, {}, {}))).toBe(String(dry));
    expect(String(evalWith(expr, {}, { ground: -1 }))).toBe(String(submerged));
  });

  it('bvmap filter keeps only features whose ground <= level', () => {
    const f = bvmapSubmergedFilter(2);
    expect(runFilter(f, { ground: 1.99 })).toBe(true);
    expect(runFilter(f, { ground: 2 })).toBe(true);
    expect(runFilter(f, { ground: 2.01 })).toBe(false);
    expect(runFilter(f, {})).toBe(false);
  });

  it('normalizes non-finite water levels so nothing is submerged', () => {
    expect(normalizeWaterLevel(NaN)).toBeLessThan(-1e8);
    expect(normalizeWaterLevel(3.456)).toBe(3.46);
    expect(runFilter(bvmapSubmergedFilter(NaN), { ground: -100 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 段の選択
// ---------------------------------------------------------------------------
describe('selectTier', () => {
  const prevs: BuildingTier[] = ['none', 'lod1', 'lod0', 'bvmap'];

  it('returns none below the bvmap minimum zoom', () => {
    for (const p of prevs) {
      expect(selectTier(obs(BVMAP_MIN_ZOOM - 0.01, loaded(100), loaded(100)), p)).toBe('none');
      expect(selectTier(obs(NaN, loaded(100), loaded(100)), p)).toBe('none');
    }
  });

  it('uses bvmap between z15 and z16 because PMTiles only exist at z16', () => {
    for (const p of prevs) {
      expect(selectTier(obs(BVMAP_MIN_ZOOM, loaded(100), loaded(100)), p)).toBe('bvmap');
      expect(selectTier(obs(PLATEAU_TILE_ZOOM - 0.01, loading(), loading()), p)).toBe('bvmap');
    }
  });

  it('prefers lod1, then lod0, then bvmap at z16+', () => {
    expect(selectTier(obs(16, loaded(12), loaded(30)), 'none')).toBe('lod1');
    expect(selectTier(obs(16, loaded(0), loaded(30)), 'none')).toBe('lod0');
    expect(selectTier(obs(16, loaded(0), loaded(0)), 'none')).toBe('bvmap');
    expect(selectTier(obs(17.5, loaded(0), loaded(0)), 'lod1')).toBe('bvmap');
  });

  it('keeps the previous tier while a higher tier is still loading (hysteresis)', () => {
    expect(selectTier(obs(16, loading(), loaded(0)), 'bvmap')).toBe('bvmap');
    expect(selectTier(obs(16, loading(), loaded(30)), 'lod0')).toBe('lod0');
    expect(selectTier(obs(16, loaded(0), loading()), 'lod1')).toBe('lod1');
    expect(selectTier(obs(16, loaded(0), loading()), 'bvmap')).toBe('bvmap');
    // 何も決まっていない起動直後は none のまま待つ
    expect(selectTier(obs(16, loading(), loading()), 'none')).toBe('none');
  });

  it('does not let a loading lod0 block a loaded lod1', () => {
    expect(selectTier(obs(16, loaded(5), loading()), 'bvmap')).toBe('lod1');
  });

  it('honours minCount', () => {
    expect(selectTier(obs(16, loaded(1), loaded(0)), 'none', 3)).toBe('bvmap');
    expect(selectTier(obs(16, loaded(3), loaded(0)), 'none', 3)).toBe('lod1');
  });
});

// ---------------------------------------------------------------------------
// 幾何ヘルパー
// ---------------------------------------------------------------------------
describe('geometry helpers', () => {
  it('computes the centroid of the outer ring and ignores the closing point', () => {
    const c = featureCentroid({
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [2, 0],
            [2, 2],
            [0, 2],
            [0, 0],
          ],
        ],
      },
    });
    expect(c).toEqual([1, 1]);
    expect(featureCentroid({ geometry: { type: 'Point', coordinates: [1, 1] } })).toBeNull();
  });

  it('keys centroids at 1e-6 degrees', () => {
    expect(centroidKey([136.8812345678, 35.0987654321])).toBe('136.881235,35.098765');
  });

  it('scales rings about the centre', () => {
    const ring = scaleRing(
      [
        [0, 0],
        [2, 0],
        [2, 2],
      ],
      [1, 1],
      2,
    );
    expect(ring).toEqual([
      [-1, -1],
      [3, -1],
      [3, 3],
    ]);
  });
});

// ---------------------------------------------------------------------------
// ソース・レイヤー仕様（style-spec の validator で丸ごと検証）
// ---------------------------------------------------------------------------
describe('buildingSourceSpecs / buildingLayerSpecs', () => {
  const { lod1, lod0 } = resolvePlateauTiers(null);

  it('resolves defaults from an empty or placeholder coverage', () => {
    expect(lod1.sourceLayer).toBe('PLATEAU');
    expect(lod1.heightAttrs).toEqual(['measuredHeight']);
    expect(lod0.sourceLayer).toBe('PLATEAU_2023_LOD0');
    expect(lod0.heightAttrs).toEqual(['measured_height', 'cal_height_m']);
    const r = resolvePlateauTiers({
      pmtiles: {
        lod1_2022: { url: 'https://example.test/a.pmtiles', source_layer: 'PLATEAU', height_attr: 'measuredHeight', cities: [] },
        lod0_2023: { url: 'https://example.test/b.pmtiles', source_layer: '...', height_attr: 'height_m', cities: [] },
      },
    });
    expect(r.lod1.url).toBe('https://example.test/a.pmtiles');
    expect(r.lod0.sourceLayer).toBe('PLATEAU_2023_LOD0'); // "..." は未確定として既定値
    expect(r.lod0.heightAttrs).toEqual(['height_m', 'measured_height', 'cal_height_m']);
  });

  it('produces a style that passes validateStyleMin', () => {
    const sources: Record<string, unknown> = {};
    for (const [id, spec] of buildingSourceSpecs(lod1, lod0)) sources[id] = spec;
    const layers = buildingLayerSpecs(lod1, lod0, 3.4);
    const style = { version: 8, sources, layers };
    const errors = validateStyleMin(style as never);
    expect(errors.map((e) => e.message)).toEqual([]);
    expect(layers.map((l: { id: string }) => l.id)).toEqual([
      BUILDING_IDS.layers.lod1Probe,
      BUILDING_IDS.layers.lod0Probe,
      BUILDING_IDS.layers.lod1,
      BUILDING_IDS.layers.lod0,
      BUILDING_IDS.layers.bvmap,
      BUILDING_IDS.layers.bvmapSubmerged,
    ]);
  });

  it('uses the verified promoteId attributes and only the bvmap GeoJSON uses generateId', () => {
    const specs = Object.fromEntries(buildingSourceSpecs(lod1, lod0)) as Record<string, Record<string, unknown>>;
    expect(specs[BUILDING_IDS.sources.lod1].promoteId).toBe('id');
    expect(specs[BUILDING_IDS.sources.lod0].promoteId).toBe('gml_id');
    expect(specs[BUILDING_IDS.sources.bvmap].promoteId).toBeUndefined();
    expect(specs[BUILDING_IDS.sources.bvmapSubmerged].generateId).toBe(true);
  });

  it('keeps the probes visible (tiles keep loading) and every tier layer hidden initially', () => {
    const layers = buildingLayerSpecs(lod1, lod0, 0);
    for (const l of layers) {
      const vis = (l as { layout?: { visibility?: string } }).layout?.visibility;
      if (l.id.endsWith('-probe')) expect(vis).toBeUndefined();
      else expect(vis).toBe('none');
    }
  });
});
