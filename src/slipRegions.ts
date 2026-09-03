/**
 * 震源域（大すべり域・超大すべり域）の概略オーバーレイ
 *
 * 内閣府 南海トラフ巨大地震モデル検討会の津波ケース①〜⑪は「大すべり域・超大すべり域をどの海域に置くか」で
 * 区別される（例: ケース④「四国沖」）。公式報告書はその範囲を図で示すだけで、ポリゴンや経緯度は公表されていない。
 * 本モジュールは、南海トラフ沿いに設定した「帯」（陸側の縁と海溝側の縁を結ぶ 12 の断面）から、
 * 公式の区域名（駿河湾〜日向灘）に対応する区間を切り出して**概略の範囲**として描く。
 *
 * - 正確な断層線・破壊開始点・公式図の範囲そのものではない（UI と凡例に明記）
 * - 震源の一点ではなく「範囲」であることを示すため、塗り＋輪郭＋地名ラベルで表示する
 * - 地図描画（MapLibre）にだけ触れ、浸水レイヤー・津波高・震度の意味は変えない
 */
import { Marker, type Map as MapLibreMap, type LngLatBounds, LngLatBounds as LngLatBoundsCtor } from 'maplibre-gl';

/** 南海トラフ沿いの断面（北東→南西）。coast=陸側の縁（海岸から数〜十数 km 沖）、trough=海溝軸側の縁。いずれも概略値 */
interface Station {
  coast: [number, number];
  trough: [number, number];
}
const STATIONS: Station[] = [
  { coast: [138.85, 34.95], trough: [138.45, 34.45] }, // 0 駿河湾
  { coast: [138.25, 34.55], trough: [138.05, 33.95] }, // 1 御前崎・遠州灘東
  { coast: [137.45, 34.55], trough: [137.35, 33.65] }, // 2 遠州灘西・愛知県東部沖
  { coast: [136.85, 34.25], trough: [136.75, 33.25] }, // 3 伊勢湾口・三重県沖
  { coast: [136.25, 33.85], trough: [136.15, 32.85] }, // 4 熊野灘・三重県南部沖
  { coast: [135.75, 33.35], trough: [135.55, 32.55] }, // 5 潮岬・紀伊半島沖
  { coast: [134.95, 33.55], trough: [134.85, 32.45] }, // 6 徳島県沖
  { coast: [134.25, 33.15], trough: [134.15, 32.25] }, // 7 室戸岬沖
  { coast: [133.45, 33.25], trough: [133.45, 32.05] }, // 8 土佐湾・四国沖
  { coast: [132.85, 32.65], trough: [132.85, 31.75] }, // 9 足摺岬沖
  { coast: [132.05, 32.45], trough: [132.15, 31.55] }, // 10 日向灘北
  { coast: [131.55, 31.65], trough: [131.75, 31.05] }, // 11 日向灘南
];

/** 公式の区域名 → 帯の区間（断面番号。小数は隣接断面との補間） */
export interface SlipRegionDef {
  key: string;
  name: string;
  from: number;
  to: number;
}
export const SLIP_REGIONS: Record<string, SlipRegionDef> = {
  suruga_kii: { key: 'suruga_kii', name: '駿河湾〜紀伊半島沖', from: 0, to: 5.5 },
  kii: { key: 'kii', name: '紀伊半島沖', from: 4, to: 6 },
  kii_shikoku: { key: 'kii_shikoku', name: '紀伊半島沖〜四国沖', from: 4, to: 8.5 },
  shikoku: { key: 'shikoku', name: '四国沖', from: 6, to: 9 },
  shikoku_kyushu: { key: 'shikoku_kyushu', name: '四国沖〜九州沖', from: 6, to: 11 },
  suruga_aichi: { key: 'suruga_aichi', name: '駿河湾〜愛知県東部沖', from: 0, to: 2.5 },
  mie_tokushima: { key: 'mie_tokushima', name: '三重県南部沖〜徳島県沖', from: 3.5, to: 6.5 },
  aichi_mie: { key: 'aichi_mie', name: '愛知県沖〜三重県沖', from: 2, to: 4 },
  muroto: { key: 'muroto', name: '室戸岬沖', from: 6.5, to: 7.5 },
  ashizuri: { key: 'ashizuri', name: '足摺岬沖', from: 8.5, to: 9.5 },
  hyuganada: { key: 'hyuganada', name: '日向灘', from: 9.5, to: 11 },
};

function lerp(a: [number, number], b: [number, number], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function stationAt(idx: number, side: 'coast' | 'trough'): [number, number] {
  const i0 = Math.max(0, Math.min(STATIONS.length - 1, Math.floor(idx)));
  const i1 = Math.max(0, Math.min(STATIONS.length - 1, Math.ceil(idx)));
  const t = idx - Math.floor(idx);
  return lerp(STATIONS[i0][side], STATIONS[i1][side], i1 === i0 ? 0 : t);
}

/** 区間 [from, to] の帯ポリゴン（陸側の縁を北東→南西、海溝側の縁を南西→北東で閉じる） */
export function regionPolygon(def: SlipRegionDef): [number, number][] {
  const coast: [number, number][] = [];
  const trough: [number, number][] = [];
  const first = Math.ceil(def.from);
  const last = Math.floor(def.to);
  coast.push(stationAt(def.from, 'coast'));
  trough.push(stationAt(def.from, 'trough'));
  for (let i = first; i <= last; i++) {
    if (i === def.from || i === def.to) continue;
    coast.push(STATIONS[i].coast);
    trough.push(STATIONS[i].trough);
  }
  coast.push(stationAt(def.to, 'coast'));
  trough.push(stationAt(def.to, 'trough'));
  const ring = [...coast, ...trough.reverse()];
  ring.push(ring[0]);
  return ring;
}

export function regionCentroid(def: SlipRegionDef): [number, number] {
  const mid = (def.from + def.to) / 2;
  return lerp(stationAt(mid, 'coast'), stationAt(mid, 'trough'), 0.5);
}

export interface SlipRegionFeatureProps {
  key: string;
  name: string;
  index: number; // 1..n（複数区域ケースの番号）
  label: string; // 表示ラベル（例「1 駿河湾〜愛知県東部沖」または「四国沖」）
}

const SOURCE_ID = 'slip-regions';
const FILL_ID = 'slip-regions-fill';
const LINE_ID = 'slip-regions-line';

export interface SlipOverlay {
  /** 表示する区域キー（空配列で非表示） */
  setRegions(keys: string[]): void;
  /** 表示中の区域の範囲。非表示なら null */
  bounds(): LngLatBounds | null;
  dispose(): void;
}

/**
 * 地図へ赤い震源域オーバーレイを追加する。ラベルは MapLibre の symbol（glyph 配信が必要）ではなく
 * DOM マーカーで描き、日本語フォント・スマホの可読性を確保する。
 */
export function createSlipOverlay(map: MapLibreMap): SlipOverlay {
  let markers: Marker[] = [];
  let current: string[] = [];

  function ensureLayers(): void {
    if (map.getSource(SOURCE_ID)) return;
    map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: FILL_ID,
      type: 'fill',
      source: SOURCE_ID,
      paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.28 },
    });
    map.addLayer({
      id: LINE_ID,
      type: 'line',
      source: SOURCE_ID,
      paint: { 'line-color': '#991b1b', 'line-width': 2.5, 'line-opacity': 0.95 },
    });
  }

  function clearMarkers(): void {
    for (const m of markers) m.remove();
    markers = [];
  }

  function featureCollection(keys: string[]): GeoJSON.FeatureCollection<GeoJSON.Polygon, SlipRegionFeatureProps> {
    const defs = keys.map((k) => SLIP_REGIONS[k]).filter((d): d is SlipRegionDef => !!d);
    return {
      type: 'FeatureCollection',
      features: defs.map((d, i) => ({
        type: 'Feature',
        properties: { key: d.key, name: d.name, index: i + 1, label: defs.length > 1 ? `${i + 1} ${d.name}` : d.name },
        geometry: { type: 'Polygon', coordinates: [regionPolygon(d)] },
      })),
    };
  }

  function setRegions(keys: string[]): void {
    current = keys.filter((k) => SLIP_REGIONS[k]);
    const apply = (): void => {
      ensureLayers();
      const fc = featureCollection(current);
      (map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(fc);
      clearMarkers();
      for (const f of fc.features) {
        const def = SLIP_REGIONS[f.properties.key];
        const el = document.createElement('div');
        el.className = 'slip-label';
        el.setAttribute('role', 'img');
        el.setAttribute('aria-label', `震源域の概略: ${f.properties.label}`);
        const num = document.createElement('span');
        num.className = 'slip-label-num';
        num.textContent = fc.features.length > 1 ? String(f.properties.index) : '';
        const txt = document.createElement('span');
        txt.textContent = f.properties.name;
        if (num.textContent) el.appendChild(num);
        el.appendChild(txt);
        markers.push(new Marker({ element: el, anchor: 'center' }).setLngLat(regionCentroid(def)).addTo(map));
      }
    };
    if (map.getStyle()) apply();
    else map.once('style.load', apply);
  }

  function bounds(): LngLatBounds | null {
    if (!current.length) return null;
    const b = new LngLatBoundsCtor();
    for (const k of current) for (const p of regionPolygon(SLIP_REGIONS[k])) b.extend(p);
    return b;
  }

  function dispose(): void {
    clearMarkers();
    if (map.getLayer(LINE_ID)) map.removeLayer(LINE_ID);
    if (map.getLayer(FILL_ID)) map.removeLayer(FILL_ID);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  }

  return { setRegions, bounds, dispose };
}

// maplibre-gl の名前空間型（GeoJSONSource）を参照するための宣言
declare namespace maplibregl {
  type GeoJSONSource = import('maplibre-gl').GeoJSONSource;
}
