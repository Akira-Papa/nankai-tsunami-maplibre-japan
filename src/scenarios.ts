/**
 * セミナー向け「シナリオ選択」の定義（地図描画には触れない純データ）
 *
 * - 津波ケース①〜⑪: 内閣府 南海トラフ巨大地震モデル検討会が設定した「大すべり域・超大すべり域の位置」の
 *   パターン。`tsunami_h.json` の `cases_2025["1".."11"]` と同じ番号で、市区町村ごとの最大津波高が公表値として存在する。
 *   ここで言う「震源地を選ぶ」は、この公式ケース（＝大すべり域の位置）の選択であり、任意の震源点を推測するものではない。
 * - 震度: 気象庁「震度階級関連解説表」の説明文。震度は揺れの強さの指標で、津波高・浸水深とは直接の換算関係がない。
 *   本アプリの浸水表示（公式浸水想定／津波高の試算）は震度の選択で変化しない。
 *
 * 文言・出典は研究結果（内閣府第二次報告 2012-08-29、2025-03-31 見直し、気象庁解説表）で確定させる。
 */

export interface TsunamiCase {
  /** "1".."11"（tsunami_h.json の cases_2025 のキー） */
  id: string;
  /** 表示名（例: ケース①） */
  label: string;
  /** 大すべり域・超大すべり域の位置（公式表現） */
  regions: string;
  /** 大すべり域の数（1 or 2） */
  slipCount: 1 | 2;
  /** 分岐断層の考慮 */
  branchFault: boolean;
  /** 補足（公式表現の補足のみ） */
  note?: string;
  /** 地図に概略表示する震源域（src/slipRegions.ts の SLIP_REGIONS キー。公式の区域名に対応） */
  regionKeys: string[];
}

export const TSUNAMI_CASE_SOURCE = {
  title: '内閣府 南海トラフの巨大地震モデル検討会 第二次報告（2012-08-29）津波断層モデル編',
  url: 'https://www.bousai.go.jp/jishin/nankai/model/pdf/20120829_2nd_report01.pdf',
  /** 2025-03-31 見直し報告書本文。「大すべり域、超大すべり域等の設定は、前回報告と同様」「合計 11 ケース」 */
  url2025: 'https://www.bousai.go.jp/jishin/nankai/kento_wg/pdf/honbun.pdf',
} as const;

/**
 * 公式ケース定義（第二次報告 第2章「大すべり域、超大すべり域等の位置と検討ケース」の文言）。
 * ①〜⑤が「基本的な検討ケース」、⑥〜⑪が「その他派生的な検討ケース」。
 * 破壊開始点（津波の震源に相当）は「大すべり域の中心付近の深さ20km付近」（②のみ潮岬沖）と本文にあるが、
 * 経緯度の数値は公表されていないため、本アプリでは地図上に震源ピンを置かない。
 */
export const TSUNAMI_CASES: TsunamiCase[] = [
  { id: '1', label: 'ケース①', regions: '駿河湾〜紀伊半島沖', slipCount: 1, branchFault: false, note: '基本ケース', regionKeys: ['suruga_kii'] },
  { id: '2', label: 'ケース②', regions: '紀伊半島沖', slipCount: 1, branchFault: false, note: '基本ケース', regionKeys: ['kii'] },
  { id: '3', label: 'ケース③', regions: '紀伊半島沖〜四国沖', slipCount: 1, branchFault: false, note: '基本ケース', regionKeys: ['kii_shikoku'] },
  { id: '4', label: 'ケース④', regions: '四国沖', slipCount: 1, branchFault: false, note: '基本ケース', regionKeys: ['shikoku'] },
  { id: '5', label: 'ケース⑤', regions: '四国沖〜九州沖', slipCount: 1, branchFault: false, note: '基本ケース', regionKeys: ['shikoku_kyushu'] },
  { id: '6', label: 'ケース⑥', regions: '駿河湾〜紀伊半島沖', slipCount: 1, branchFault: true, note: '派生ケース（熊野灘の分岐断層を考慮）', regionKeys: ['suruga_kii'] },
  { id: '7', label: 'ケース⑦', regions: '紀伊半島沖', slipCount: 1, branchFault: true, note: '派生ケース（熊野灘の分岐断層を考慮）', regionKeys: ['kii'] },
  { id: '8', label: 'ケース⑧', regions: '駿河湾〜愛知県東部沖 ＋ 三重県南部沖〜徳島県沖', slipCount: 2, branchFault: false, note: '派生ケース（大すべり域を2箇所設定）', regionKeys: ['suruga_aichi', 'mie_tokushima'] },
  { id: '9', label: 'ケース⑨', regions: '愛知県沖〜三重県沖 ＋ 室戸岬沖', slipCount: 2, branchFault: false, note: '派生ケース（大すべり域を2箇所設定）', regionKeys: ['aichi_mie', 'muroto'] },
  { id: '10', label: 'ケース⑩', regions: '三重県南部沖〜徳島県沖 ＋ 足摺岬沖', slipCount: 2, branchFault: false, note: '派生ケース（大すべり域を2箇所設定）', regionKeys: ['mie_tokushima', 'ashizuri'] },
  { id: '11', label: 'ケース⑪', regions: '室戸岬沖 ＋ 日向灘', slipCount: 2, branchFault: false, note: '派生ケース（大すべり域を2箇所設定）', regionKeys: ['muroto', 'hyuganada'] },
];

export function findCase(id: string | null | undefined): TsunamiCase | null {
  if (!id) return null;
  return TSUNAMI_CASES.find((c) => c.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// 震度（気象庁 震度階級関連解説表）
// ---------------------------------------------------------------------------
export interface IntensityLevel {
  /** '5-' | '5+' | '6-' | '6+' | '7' */
  key: string;
  label: string;
  /** 人の体感・行動 */
  people: string;
  /** 屋内の状況 */
  indoor: string;
  /** 屋外の状況 */
  outdoor: string;
}

export const JMA_INTENSITY_SOURCE = {
  title: '気象庁 震度階級関連解説表',
  url: 'https://www.jma.go.jp/jma/kishou/know/shindo/kaisetsu.html',
} as const;

/** 震度と津波の関係についての公式の説明（出典 URL を UI に併記） */
export const INTENSITY_TSUNAMI_NOTE_SOURCE = {
  title: '気象庁 津波警報・注意報、津波情報、津波予報について',
  url: 'https://www.jma.go.jp/jma/kishou/know/jishin/joho/tsunamiinfo.html',
} as const;

/**
 * 気象庁「震度階級関連解説表」（平成21年3月31日改定）の要約。
 * 原表は「人の体感・行動／屋内の状況／屋外の状況」の3列で、震度7の「人の体感・行動」は6強と同一セル。
 * 同表の留意事項: 震度は震度計の観測値であり、地盤・地形で同じ震度でも揺れは異なる。記述は比較的多い事例で、
 * すべての現象が必ず起きるわけではない。
 * 震度は「揺れの強さ」、津波の高さは地震の規模・位置（断層モデル）から別途計算される（気象庁「津波を予測するしくみ」）。
 */
export const JMA_INTENSITY: IntensityLevel[] = [
  {
    key: '5-',
    label: '震度5弱',
    people: '大半の人が恐怖を覚え、物につかまりたいと感じる',
    indoor: 'つり下げ物が激しく揺れ、食器や本が落ちることがある',
    outdoor: 'まれに窓ガラスが割れて落ちる。電柱の揺れがわかる',
  },
  {
    key: '5+',
    label: '震度5強',
    people: '物につかまらないと歩くことが難しいなど、行動に支障を感じる',
    indoor: '食器や本で落ちるものが多くなる。固定していない家具が倒れることがある',
    outdoor: '窓ガラスが割れて落ちることがある。補強されていないブロック塀が崩れることがある',
  },
  {
    key: '6-',
    label: '震度6弱',
    people: '立っていることが困難になる',
    indoor: '固定していない家具の大半が移動し、倒れるものもある。ドアが開かなくなることがある',
    outdoor: '壁のタイルや窓ガラスが破損、落下することがある',
  },
  {
    key: '6+',
    label: '震度6強',
    people: '立っていることができず、はわないと動くことができない。揺れにほんろうされ、飛ばされることもある',
    indoor: '固定していない家具のほとんどが移動し、倒れるものが多くなる',
    outdoor: '壁のタイルや窓ガラスが破損、落下する建物が多くなる。補強されていないブロック塀のほとんどが崩れる',
  },
  {
    key: '7',
    label: '震度7',
    people: '（6強と同じ）立っていることができず、はわないと動くことができない。揺れにほんろうされ、飛ばされることもある',
    indoor: '固定していない家具のほとんどが移動したり倒れたりし、飛ぶこともある',
    outdoor: '壁のタイルや窓ガラスが破損、落下する建物がさらに多くなる。補強されているブロック塀も破損するものがある',
  },
];

export function findIntensity(key: string | null | undefined): IntensityLevel | null {
  if (!key) return null;
  return JMA_INTENSITY.find((c) => c.key === key) ?? null;
}
