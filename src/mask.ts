/**
 * What-if（color-relief）表示を選択中の市区町村内に限定する「反転マスク」
 *
 * 世界全体を覆う矩形ポリゴンに、選択した市区町村ポリゴン（外環）を穴として開けた fill レイヤーを
 * color-relief の上に描く。穴の外側は半透明の暗色で覆われるため、what-if の着色は穴の内側＝
 * 選択市区町村の中だけが見える。市区町村ポリゴン自身が内環（湖など）を持つ場合は、その内環を
 * 独立した塗りポリゴンとして追加し、正しく「覆う」側に戻す。
 *
 * GeoJSON の環の向きには依存しない（MapLibre / geojson-vt は最初の環を外環、以降を穴として扱う）。
 */
import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import type { MunicipalityGeometry, MultiPolygonGeometry, Position } from './data';

interface MaskFeature {
  type: 'Feature';
  properties: Record<string, never>;
  geometry: MultiPolygonGeometry;
}

export const MASK_SOURCE_ID = 'whatif-mask';
export const MASK_LAYER_ID = 'whatif-mask';

/** Web メルカトルの表示範囲いっぱいの外環（反時計回り） */
const WORLD_RING: Position[] = [
  [-180, -85.051129],
  [180, -85.051129],
  [180, 85.051129],
  [-180, 85.051129],
  [-180, -85.051129],
];

export interface MaskOptions {
  /** この layer id の直前（下）に挿入する。省略時は最上位 */
  beforeId?: string;
  /** 覆いの色（半透明の暗色） */
  fillColor?: string;
  /** 初期表示 */
  visible?: boolean;
}

export interface MaskController {
  /** 穴にする市区町村ポリゴン。null で穴なし（全面を覆う） */
  setPolygon(geometry: MunicipalityGeometry | null): void;
  setVisible(on: boolean): void;
  isVisible(): boolean;
  remove(): void;
}

/**
 * 市区町村ジオメトリから「世界矩形 − 市区町村」の MultiPolygon を組み立てる（純粋関数）
 */
export function buildInvertedMask(geometry: MunicipalityGeometry | null): MultiPolygonGeometry {
  const world: Position[][] = [WORLD_RING];
  const extra: Position[][][] = [];
  if (geometry) {
    const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    for (const rings of polys) {
      if (!rings.length || rings[0].length < 4) continue;
      world.push(rings[0]); // 外環 → 世界矩形の穴
      for (let i = 1; i < rings.length; i++) {
        if (rings[i].length >= 4) extra.push([rings[i]]); // 内環（島の中の湖など）→ 覆いに戻す
      }
    }
  }
  return { type: 'MultiPolygon', coordinates: [world, ...extra] };
}

export function createMask(map: MapLibreMap, opts: MaskOptions = {}): MaskController {
  const fillColor = opts.fillColor ?? 'rgba(15, 23, 42, 0.45)';
  let visible = opts.visible ?? false;
  let current: MunicipalityGeometry | null = null;

  const feature = (): MaskFeature => ({
    type: 'Feature',
    properties: {},
    geometry: buildInvertedMask(current),
  });

  const ensure = (): void => {
    if (!map.getSource(MASK_SOURCE_ID)) {
      map.addSource(MASK_SOURCE_ID, {
        type: 'geojson',
        data: feature(),
        // 世界矩形は巨大なので tolerance を下げて市区町村境界の精度を保つ
        tolerance: 0.1,
        buffer: 8,
      });
    }
    if (!map.getLayer(MASK_LAYER_ID)) {
      map.addLayer(
        {
          id: MASK_LAYER_ID,
          type: 'fill',
          source: MASK_SOURCE_ID,
          layout: { visibility: visible ? 'visible' : 'none' },
          paint: {
            'fill-color': fillColor,
            'fill-antialias': false,
          },
        },
        opts.beforeId && map.getLayer(opts.beforeId) ? opts.beforeId : undefined,
      );
    }
  };

  ensure();
  // スタイル差し替え（setStyle）後に復元できるよう styledata でも再確認
  map.on('styledata', () => {
    if (map.isStyleLoaded()) ensure();
  });

  return {
    setPolygon(geometry) {
      current = geometry;
      ensure();
      (map.getSource(MASK_SOURCE_ID) as GeoJSONSource | undefined)?.setData(feature());
    },
    setVisible(on) {
      visible = on;
      ensure();
      map.setLayoutProperty(MASK_LAYER_ID, 'visibility', on ? 'visible' : 'none');
    },
    isVisible() {
      return visible;
    },
    remove() {
      if (map.getLayer(MASK_LAYER_ID)) map.removeLayer(MASK_LAYER_ID);
      if (map.getSource(MASK_SOURCE_ID)) map.removeSource(MASK_SOURCE_ID);
    },
  };
}
