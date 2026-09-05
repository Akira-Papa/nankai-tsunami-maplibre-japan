# 南海トラフ 津波浸水3Dビジュアライザ 全国版（パターン1: MapLibre GL JS + color-relief）

スマートフォン優先の簡易プロトタイプです。内閣府「南海トラフ巨大地震モデル検討会」の**市町村別津波高（2025／2012）**を、
国土地理院の実標高（DEM10B）から生成した3D地形に重ね、公式の**重ねるハザードマップ 津波浸水想定**と見比べます。
外部APIキー・有料サービス・サーバーサイド処理は一切使いません（静的ファイルのみ）。

- 🌐 **Web公開サイト**: [https://nankai-tsunami-maplibre-japan.akirafunakoshi.com/?h=2.7&m=13108](https://nankai-tsunami-maplibre-japan.akirafunakoshi.com/?h=2.7&m=13108)

📖 **使い方（初心者向け・操作ガイド）**: [docs/manual/使い方マニュアル.md](docs/manual/使い方マニュアル.md) ／ 共有データ契約: [../shared/DATA_CONTRACT.md](../shared/DATA_CONTRACT.md)

> **免責**: 簡易可視化であり公式想定ではありません。内閣府の津波高は海岸線での最大値で、内陸へ一律に適用すると過大・過小になります。
> 避難判断は各自治体のハザードマップ（[ハザードマップポータルサイト](https://disaportal.gsi.go.jp/)）を参照してください。

---

## 目次

1. [概要](#1-概要)
2. [起動](#2-起動)
3. [構成](#3-構成)
4. [データ契約（shared/DATA_CONTRACT.md）](#4-データ契約shareddata_contractmd)
5. [UI 要素一覧と `src/ui.ts` の API](#5-ui-要素一覧と-srcuits-の-api)
6. [出典・ライセンス](#6-出典ライセンス)
7. [既知の制約](#7-既知の制約)
8. [検証](#8-検証)
9. [トラブルシュート](#9-トラブルシュート)

---

## 1. 概要

| 項目 | 内容 |
|---|---|
| 目的 | 南海トラフ沿岸の任意の市区町村で「内閣府想定の津波高（T.P.）に対して、どの土地が低いか」と「公式の浸水想定」を同じ3D地形の上で見比べる |
| 対象市区町村 | `municipalities.json` で `nankai_target || coastal` の市区町村（内閣府 2025 一覧表掲載 or 海岸線あり）。都道府県→市区町村セレクト＋部分一致検索で選択 |
| 津波高 | 選択市区町村の `max_2025`（既定）／`mean_2025`／`max_2012`／手動スライダー 0〜35 m（0.1 刻み） |
| 主表示 | **公式浸水想定ラスター**（重ねるハザードマップ 津波浸水想定 統合タイル、既定 ON、凡例付き） |
| 副表示（試算） | 「津波高で試算」ON で **標高 ≦ 津波高** を `color-relief` で青く塗る（既定 ON・スライダーに即時連動）。市区町村を選ぶとそのポリゴン内だけに絞り、未選択時は全国一律の簡易試算として表示。試算OFFでもスライダーを動かすと自動でONになる |
| 地形 | 地理院 DEM10B → `terrarium` 再エンコード（`gsidem://`）→ `terrain` + `hillshade` |
| 建物 | PLATEAU PMTiles（`fill-extrusion`、`building_coverage.json` の対応都市のみ） |
| URL | `?m=39201`（市区町村コード）／`?h=5.0`（津波高）を初期状態に反映し、操作に追従して `history.replaceState` |
| 対応環境 | WebGL2 必須（iOS 15+ Safari / Chrome 94+ / Firefox 90+ 相当）。非対応時は画面に案内 |
| 依存 | `maplibre-gl@6.6.0`（BSD-3）/ `pmtiles@4.5.0` / Vite 6 / TypeScript 5 |

## 2. 起動

```bash
npm install
npm run dev              # http://localhost:5291/（host:true → 同一Wi-FiのスマホからLAN IPで確認可）
npm run build            # dist/ に静的ファイルを出力（base './' → サブパス配置可）
npm run preview          # dist/ を http://localhost:5295/ で配信
npm run typecheck        # tsc --noEmit
npm test                 # vitest run（src/**/*.test.ts）
npm run check:endpoints  # 外部配信元の HTTP / CORS / Range 疎通確認（依存なし・6 都市）
npm run inspect:pmtiles  # PLATEAU PMTiles のヘッダー・vector_layers を表示
npm run make:icons       # public/icons/*.png を再生成（依存なし）
```

ポートは DATA_CONTRACT §6 に従い **dev 5291 / preview 5295**（`strictPort`、衝突時は失敗）。QA 用ヘッドレス検証は 5292〜5294 を使い、共有 Browser ペインは使いません。
Node 20 以上（`engines.node >= 20`）。

**サブパス配置**: `dist/` をそのまま `https://host/sub/` に置けば動きます（`base: './'`、`manifest.webmanifest` の `start_url: "./"`、Worker の `new URL(..., import.meta.url)` がすべて相対解決）。

## 3. 構成

```
1-maplibre-color-relief-japan/
├── index.html                 # UI 骨格（ボトムシート・#status/#banner/#readout・免責・出典）・PWA メタ・WebGL2 判定
├── vite.config.ts             # base './', target es2022, worker es, ports 5291/5295, manualChunks
├── public/
│   ├── manifest.webmanifest   # PWA マニフェスト（Service Worker なし）
│   ├── icons/                 # icon-192 / icon-512 / icon-512-maskable（scripts/make-icons.mjs）
│   └── data/                  # 開発用フィクスチャ（6 市町村）。統合時に ../shared/data/ の実データで置換
│       ├── municipalities.json            # §1
│       ├── municipalities_coastal.geojson # §2
│       ├── tsunami_h.json                 # §3
│       └── building_coverage.json         # §5
├── scripts/
│   ├── check-endpoints.mjs    # 配信元チェック（6 都市 × hazard/dem_png/dem5a/dem5b、bvmap、PMTiles ×2）
│   ├── inspect-pmtiles.mjs    # PMTiles メタデータ調査
│   └── make-icons.mjs         # PNG アイコン生成
├── docs/manual/使い方マニュアル.md
└── src/
    ├── main.ts                # 地図初期化・スタイル・レイヤー制御・ui.ts との配線
    ├── ui.ts                  # ボトムシート UI（DOM ↔ UiState、URL 同期、status/banner/readout）
    ├── data.ts                # データ契約の型・読込・検索ヘルパー（findMunicipality / findTsunamiRow / heightForPreset）
    ├── mask.ts                # 選択市区町村ポリゴンによる試算レイヤーのマスク
    ├── buildings.ts           # PLATEAU PMTiles の対応都市判定・建物レイヤー
    ├── gsidem.ts              # 地理院標高PNG → terrarium 変換プロトコル（gsidem://）
    └── style.css              # スマホ優先ボトムシート UI
```

データフロー:

```
 public/data/*.json（→ 統合時 shared/data/）
        │  data.ts: loadAll() で並列取得・契約検証
        ▼
 ui.ts: 都道府県／市区町村セレクト・津波高テーブル・プリセット・トグル・URL ?m=&h=
        │  onChange(UiState) / onFlyTo(code) / onResetView()
        ▼
 main.ts ──┬─ hazard（raster）: disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data  ← 公式（既定 ON）
           ├─ gsidem（raster-dem）: cyberjapandata.gsi.go.jp/xyz/dem_png → terrain / hillshade
           ├─ tsunami-relief（color-relief）: 標高 ≦ H を青。選択市区町村ポリゴンでマスク（試算・既定 ON・スライダー連動）
           ├─ pale / photo（raster）: 地理院 淡色地図 / 全国最新写真
           └─ buildings（fill-extrusion）: PLATEAU PMTiles（pmtiles://、対応都市のみ）
```

## 4. データ契約（shared/DATA_CONTRACT.md）

アプリは [../shared/DATA_CONTRACT.md](../shared/DATA_CONTRACT.md) のスキーマだけを前提にします。開発中は `public/data/` の
6 市町村フィクスチャ（`fixture: true`）で動かし、統合時に `shared/data/` の実データをそのまま置き換えます。**キー名・型は変えません。**

| ファイル | 契約 | UI での使い方 |
|---|---|---|
| `municipalities.json` | §1 | `prefectures` → 都道府県セレクト。`municipalities` のうち `nankai_target \|\| coastal` → 市区町村セレクト・検索。政令市は市コード（`23100`）1 件で、区コード（`23111` 等）は `wards` 経由で市へ解決 |
| `municipalities_coastal.geojson` | §2 | 試算レイヤーのマスク（`mask.ts`）・フライト先の bbox |
| `tsunami_h.json` | §3 | 津波高テーブル（2025 最大／2025 平均／2012 最大／浸水面積）。`null` は「データなし」表示、プリセットは `aria-disabled` |
| `building_coverage.json` | §5 | 建物レイヤーの対応都市判定（`buildings.ts`） |
| §6 共通仕様 | — | 既定プリセット `max_2025`、スライダー 0〜35 m、免責文、公式レイヤー URL と凡例色、出典表記、`?m=&h=`、ポート |

## 5. UI 要素一覧と `src/ui.ts` の API

### 要素 ID（index.html）

| ID | 役割 |
|---|---|
| `#topbar` / `#btn-reset` | タイトル・「視点リセット」（→ `onResetView`） |
| `#status` | 読込状況などの短文（`setStatus`。空文字で非表示） |
| `#banner` / `#banner-text` / `#banner-close` | 警告・エラー（`setBanner(msg, 'warn'\|'error')`。`error` は `role="alert"`） |
| `#readout` | 地図タップ時の標高などの読み取り表示（`setReadout`。シートの直上に追従） |
| `#sheet` / `#sheet-handle` / `#sheet-head` | ボトムシート・開閉ハンドル・折りたたみ時にも見える要約行（`#summary-muni` / `#summary-height`） |
| `#sel-pref` / `#sel-muni` / `#muni-search` / `#btn-flyto` | 都道府県・市区町村セレクト、部分一致検索、「この市町村へ移動」（→ `onFlyTo`） |
| `#muni-info` / `#muni-name` / `#th-max2025` / `#th-mean2025` / `#th-max2012` / `#th-area2025` / `#muni-note` / `#muni-empty` | 津波高テーブル（未選択時は `#muni-empty` の案内） |
| `#zoom-badge` / `#btn-help` / `#help` / `#help-close` | 現在ズーム表示（z17 超は拡大表示の警告色）、操作案内ダイアログ（PC／スマホ／キーボード、URL 共有） |
| `#sel-case` / `#case-desc` / `#case-note` / `#case-source` | 内閣府 津波ケース①〜⑪（大すべり域の位置）の選択、説明、出典（`src/scenarios.ts`） |
| `#sel-intensity` / `#intensity-desc` / `#intensity-note` / `#intensity-source` | 参考: 気象庁 震度階級の選択と解説表示。**地図には影響しない**（`src/scenarios.ts`） |
| `#height` / `#height-out` / `#presets` / `#height-note` | スライダー（0〜35、0.1 刻み、44px つまみ）、読み取り `output`、プリセット 5 ボタン（`data-preset`: max_2025 / mean_2025 / max_2012 / case / manual） |
| `#chk-official` / `#legend` | 公式浸水想定トグル（既定 ON）と浸水深凡例（§6 の 8 色＋出典） |
| `#chk-whatif` / `#whatif-note` | 「津波高で試算」トグル（既定 ON。OFFでもスライダー操作で自動ON）と簡易試算の注意書き |
| `#chk-buildings` / `#chk-photo` / `#chk-hillshade` | 建物・写真地図・陰影 |
| `#disclaimer` / `#attribution` / `#attribution-mapterhorn` | 免責（契約 §6 の文言）・出典フッター（Mapterhorn 表記は `hidden` を外して使う） |

### API（main.ts が使う）

```ts
import { initUi, type UiState } from './ui';

const ui = initUi(
  { municipalities, tsunami },                 // data.ts の型（契約 §1 / §3）
  { onChange(s: UiState) {…}, onFlyTo(code) {…}, onResetView() {…} },
  { heightM: 5 },                              // 初期値（省略可）
);
ui.setState({ muniCode: '39201' });           // DOM と URL を更新。onChange は呼ばない
ui.setStatus('標高タイル読込中…');
ui.setBanner('標高タイルに接続できません', 'warn');  // null で消す
ui.setReadout('標高 2.3 m ／ 津波高 5.0 m');        // null で消す
ui.getState();
```

- `UiState = { muniCode, heightM, preset: 'max_2025'|'mean_2025'|'max_2012'|'manual', showOfficial, showWhatIf, showBuildings, imagery: 'pale'|'photo', hillshade }`
- 初期化の優先順位: 既定値 < `initial` < URL（`?m=` は 5 桁コード、`?h=` は 0〜35 にクランプし preset を `manual` に）
- 市区町村をユーザーが選ぶと `onChange` → `onFlyTo(code)` の順に呼びます。preset が `manual` 以外なら津波高はデータ値へ更新され、値が無ければ 2025最大→2025平均→2012最大 の順で代替、すべて無ければ `manual` へ落ちて現在値を維持します
- スライダーは `input` ごとに `onChange`（preset は `manual`）。URL の `replaceState` は 250 ms で間引き（Safari の呼び出し回数制限対策）
- シートの可視高さは CSS 変数 `--sheet-visible` に反映し、`window` に `CustomEvent('ui:sheet', { detail: { visible, collapsed } })` を送ります（地図 padding 調整に任意で利用）

## 6. 出典・ライセンス

| データ | URL | 出典表記 / 利用条件 |
|---|---|---|
| 淡色地図 | `https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png` | **地理院タイル**。[地理院タイル利用規約](https://maps.gsi.go.jp/development/ichiran.html) |
| 全国最新写真 | `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg` | 地理院タイル（全国最新写真（シームレス）） |
| 標高タイル DEM10B | `https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png`（z1〜14） | 地理院タイル（標高タイル・PNG）。無効値 2^23 は 0 m 扱い |
| 標高タイル DEM5A/5B（参考） | `.../dem5a_png/`, `.../dem5b_png/`（z15、範囲限定） | 地理院タイル。`check-endpoints` で疎通のみ確認（本アプリでは未使用） |
| 建物 | `https://shiworks.xsrv.jp/pmtiles-data/plateau/PLATEAU_2022_LOD1.pmtiles`、`PLATEAU_2023_LOD0.pmtiles` | **国土交通省 PLATEAU（CC BY 4.0）**。変換・公開: shiwaku 氏 |
| 津波浸水想定（統合） | `https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/{z}/{x}/{y}.png`（z2〜17） | **ハザードマップポータルサイト**（重ねるハザードマップ）。[利用規約](https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html) |
| 市町村別津波高 | 内閣府 [2025 一覧表](https://www.bousai.go.jp/jishin/nankai/kento_wg/pdf/ichiran.pdf) / [2012 一覧表](https://www.bousai.go.jp/jishin/nankai/pdf/shichouson_ichiran.pdf) | **内閣府 南海トラフ巨大地震モデル検討会**。公共データ利用規約（第1.0版）・出典明記 |
| 行政区域 | 国土数値情報 N03 | CC BY 4.0（国土数値情報 利用規約） |
| （任意）地形タイル | Mapterhorn | 使う場合は `#attribution-mapterhorn` の `hidden` を外して **© Mapterhorn** を表示 |

出典はアプリ内の `#attribution`（シート下部）と MapLibre の帰属コントロール（ⓘ）に表示します。

## 7. 既知の制約

1. **`color-relief` は地域ごとに違う H を 1 レイヤーで塗れない**（色ランプは 1 本＝全国同じ H）。そのため
   **公式ラスター（重ねるハザードマップ）を主表示**とし、試算レイヤーは「選択市区町村のポリゴン内だけ、その市区町村の H で塗る」構成にしています。
   隣接市区町村を同時に別々の H で塗ることはできません
2. 内閣府の津波高は**海岸線での最大値**です。試算はそれを内陸へ一律に当てはめるため、堤防・遡上・減衰・河川流入を無視して過大・過小になります（公式想定ではありません）
3. DEM10B は 10 m メッシュ。市街地の細かな盛土・堤防は表現されません。`dem5a_png` は z15 限定・範囲限定のため未使用（疎通のみ確認）
4. 公式ラスターは統合タイル（都道府県公表の津波浸水想定を国が統合）で、**未公表・未収録の地域は何も表示されません**。表示が無い＝安全ではありません
5. PLATEAU PMTiles は **z16 単一ズーム**のため、建物はズーム 16 以上でのみ表示されます。収録は `building_coverage.json` の都市に限られます
6. `color-relief` の `step` 式は v6.6.0 では無視されるため `interpolate` の急峻な切替で「H 以下＝青」を表現しています
7. `terrain`・`hillshade`・`color-relief` が同一 `gsidem` ソースを共有するため、MapLibre が描画品質の `warnOnce` を出します（動作には影響なし）
8. `municipalities.json` に無い区コード（例 `?m=23111`）は市コードへ解決し、未知のコードは無視します。`tsunami_h.json` で `code: null` の行（島嶼部など）は選べません
9. Service Worker なし → オフライン不可（防災情報の陳腐化を避けるため意図的）
10. **「震源地」はピンではなく内閣府の津波ケース①〜⑪（大すべり域の位置）の選択**です。各ケースの破壊開始点は報告書本文に「大すべり域の中心付近の深さ20km付近」等の記述はあるものの経緯度は公表されていないため、地図上に震源点を描きません（推測値を置かない）
11. **震度セレクタは参考表示のみ**です。気象庁 震度階級関連解説表の要約を示すだけで、浸水表示・津波高には一切影響しません（本アプリは震度から浸水深を計算していません）。内閣府 2025 一覧表 p166–195 の市区町村別「最大震度」表はパース可能と確認済みですが未取込（次の一手）
13. **震源域の赤い範囲は概略です。** 内閣府は大すべり域・超大すべり域の範囲を報告書の図で示すのみで座標・ポリゴンを公表していないため、`src/slipRegions.ts` の帯状モデル（陸側の縁・海溝側の縁ともに概略値）から区域名に対応する区間を描いています。公式図と形・広がりは一致しません。破壊開始点や断層線は描きません
12. ズーム上限は z18。地理院 DEM は z15、公式浸水想定は z17、淡色地図は z18 が原寸で、それ以上は親タイルの拡大表示（精度は上がらない）。z19 も描画は破綻しないが公式想定が粗く見えるため 18 で止めている

## 7b. セミナー向け拡張（2026-09-03）

| 機能 | 実装 | 根拠 |
|---|---|---|
| ズーム拡張 | `maxZoom` 17→18、＋−ボタン表示、ヘッダーに現在ズーム（z17 超は琥珀色）、操作案内ダイアログ | z18 は淡色地図の原寸。z19 は描画可だが公式想定が 4 倍拡大で粗い |
| 津波の発生パターン（震源域） | `#sel-case` で内閣府 津波ケース①〜⑪ を選ぶと、選択市区町村の `cases_2025[k]`（公表値）が津波高プリセット「ケース別」として反映。URL `?c=` | 第二次報告（2012-08-29）津波断層モデル編 第2章の文言。2025 見直し本文「設定は前回報告と同様、合計 11 ケース」 |
| 震度（参考） | `#sel-intensity` で気象庁 震度階級 5弱〜7 の解説を表示。URL `?si=`。地図・津波高は不変 | 気象庁 震度階級関連解説表（平成21年改定）／「津波を予測するしくみ」（津波高は地震の位置・規模から計算） |
| 震源域の概略オーバーレイ | ケース選択中、`src/slipRegions.ts` が南海トラフ沿いの帯（12 断面）から公式の区域名に対応する区間を切り出し、赤の半透明塗り＋濃い赤の輪郭＋地名ラベル（複数区域は番号付き）で表示。地図凡例 `#slip-legend` とパネル内凡例 `#case-map-legend`、「震源域と市区町村を一画面に」ボタン | 公式は範囲を図示のみで座標・ポリゴン未公表。**概略表示**であり断層線・破壊開始点・公式図の正確な範囲ではない旨を UI・凡例に明記 |

ラベル・文言は `src/scenarios.ts` に集約し、出典 URL を同ファイルと UI（`#case-source` / `#intensity-source`）に併記しています。

## 8. 検証

### `npm run check:endpoints`（2026-09-02 実行、Origin: https://example.github.io）

6 都市（名古屋・高知・静岡・黒潮町・宮崎・那覇）の代表点から z14/z15 のタイル座標を算出して確認。
`SKIP` は範囲限定タイルの 404（想定内）。

```
# check-endpoints  2026-09-02T04:48:21.636Z  Origin: https://example.github.io  targets: 30
OK   Hazard tsunami 統合 名古屋市（港区） (23100) z14/14421/6484   200 image/png  acao *
OK   GSI dem_png (DEM10B) 名古屋市（港区） z14/14421/6484            200 image/png  acao *
OK   GSI dem5a_png 名古屋市（港区） z15/28843/12969                  200 image/png  acao *
SKIP GSI dem5b_png 名古屋市（港区） z15/28843/12969                  404 ← 範囲外（想定内）
OK   Hazard tsunami 統合 高知市 (39201) z14/14270/6570               200 image/png  acao *
OK   GSI dem_png (DEM10B) 高知市 z14/14270/6570                      200
OK   GSI dem5a_png 高知市 z15/28540/13141                            200
SKIP GSI dem5b_png 高知市 z15/28540/13141                            404 ← 範囲外（想定内）
OK   Hazard tsunami 統合 静岡市（駿河区） (22100) z14/14490/6492     200
OK   GSI dem_png (DEM10B) 静岡市（駿河区） z14/14490/6492            200
OK   GSI dem5a_png 静岡市（駿河区） z15/28981/12984                  200
SKIP GSI dem5b_png 静岡市（駿河区） z15/28981/12984                  404 ← 範囲外（想定内）
OK   Hazard tsunami 統合 黒潮町 (39428) z14/14245/6598               200
OK   GSI dem_png (DEM10B) 黒潮町 z14/14245/6598                      200
OK   GSI dem5a_png 黒潮町 z15/28491/13196                            200
SKIP GSI dem5b_png 黒潮町 z15/28491/13196                            404 ← 範囲外（想定内）
OK   Hazard tsunami 統合 宮崎市 (45201) z14/14174/6658               200
OK   GSI dem_png (DEM10B) 宮崎市 z14/14174/6658                      200
OK   GSI dem5a_png 宮崎市 z15/28348/13317                            200
SKIP GSI dem5b_png 宮崎市 z15/28348/13317                            404 ← 範囲外（想定内）
OK   Hazard tsunami 統合 那覇市 (47201) z14/14002/6955               200 (9483 bytes)
OK   GSI dem_png (DEM10B) 那覇市 z14/14002/6955                      200
OK   GSI dem5a_png 那覇市 z15/28005/13910                            200
OK   GSI dem5b_png 那覇市 z15/28005/13910                            200
OK   GSI pale（名古屋 z14）                                          200 image/png  acao *
OK   GSI seamlessphoto（名古屋 z14）                                 200 image/jpeg acao *
OK   GSI experimental_bvmap（ベクトル・名古屋 z14）                  200 application/vnd.mapbox-vector-tile  acao *
OK   PLATEAU PMTiles 2022 LOD1 header (Range 0-16383)               206  magic="PMTiles" (ok)  acao *  content-range: bytes 0-16383/1159134423
OK   PLATEAU PMTiles 2023 LOD0 header (Range 0-16383)               206  magic="PMTiles" (ok)  acao *  content-range: bytes 0-16383/3134912302
SKIP MapLibre demo glyphs（参考・未使用）                            404 ← 想定内（symbol レイヤー未使用）

24/30 OK, 6 SKIP (404 範囲外), 0 NG
```

すべての地理院・ハザードマップ配信元は `Access-Control-Allow-Origin: *`、`Cache-Control` 無し（ブラウザのヒューリスティックキャッシュ依存）。
PMTiles は 2 ファイルとも Range 要求が 206 で返り、先頭 7 バイトが `PMTiles`。

### 型検査

```
npx tsc --noEmit -p tsconfig.json
  src/ui.ts / index.html 由来のエラー: 0
  （src/mask.ts の `GeoJSON` 名前空間未解決は別担当のファイル。@types/geojson の追加で解消見込み）
```

### レイアウト（headless Chrome / CDP、390×844、DPR 2、port 5292）

`src/ui.ts` を単体で配線した一時ハーネス（`_uiharness/`、検証後に削除）で確認。

| 項目 | 結果 |
|---|---|
| 横スクロール | `document.scrollWidth = 390`、`#sheet.scrollWidth = clientWidth = 390`（390 / 320 / 1024 px すべて） |
| タッチ目標 | `#btn-reset` 44px、`#sel-pref` / `#sel-muni` / `#muni-search` / `#btn-flyto` 44px、スライダー 48px（つまみ 44px）、プリセット 48px、トグル行 44px |
| 市区町村選択 | 高知県 → 高知市: テーブル `15.0 m / 12.4 m / 16.0 m / 約 1,360 ha`、preset `max_2025`、`heightM 15`、`onChange` → `onFlyTo('39201')` の順に発火、URL `?h=15.0&m=39201` |
| スライダー | 7.3 へ移動: `preset 'manual'`、`#height-out 7.3 m`、`aria-valuetext "7.3 メートル（東京湾平均海面基準）"` |
| 検索 | 都道府県「すべて」＋部分一致で候補が絞られる（選択中の市区町村は先頭に保持） |
| `setState` | `{ muniCode: '23111', preset: 'max_2012', showOfficial: false, showWhatIf: true }` → 区コードが市 `23100` に解決、凡例 hidden、`onChange` 0 回 |
| `setStatus` / `setBanner('…','error')` / `setReadout` | 上部バー直下に status、その下に赤バナー（`role="alert"`）、シート直上に readout を表示 |
| 折りたたみ | ハンドル押下で `--sheet-visible: 82px`（ハンドル＋要約行のみ） |
| URL 初期化 | `?m=39428&h=12.5` → 黒潮町・`12.5 m`・`manual`。`?m=45201` → 宮崎市・`15.0 m`（`max_2025`） |
| 720px 以上 | シートは右下 400px カード、`--sheet-visible: 0px` |

## 9. トラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| 地図が真っ白・コンソールに Worker 404 | Worker URL 未解決。`setWorkerUrl()` が呼ばれているか、`dist/assets/maplibre-gl-worker-*.js` が配信されているか |
| 「このブラウザでは3D地図を表示できません」 | WebGL2 非対応（古い iOS / 省電力モードの GPU 無効化 / 仮想マシン）。別ブラウザまたは実機で確認 |
| 市区町村セレクトが空・「該当なし」 | `public/data/municipalities.json` が読めていない、または `nankai_target \|\| coastal` の市区町村が 0 件。DevTools の Network で `data/*.json` の 200 と `fixture` を確認 |
| 津波高が「データなし」 | `tsunami_h.json` にその市区町村の行が無い／値が `null`。プリセットは押せなくなり、手動スライダーで指定する |
| 公式想定が何も出ない | 統合タイルに未収録の地域（未公表）か、`#chk-official` が OFF。範囲外タイルは 404 で正常 |
| 青い試算が出ない | `#chk-whatif` が OFF（スライダーを動かすと自動ON）。市区町村を選択中はそのポリゴン外は塗られない（未選択なら全国一律）。`__map.getPaintProperty('tsunami-relief','color-relief-color')` を確認 |
| 地形が平ら | `dem_png` が届いていない（バナー表示）。`npm run check:endpoints` で 200 / CORS `*` を確認 |
| 建物が出ない | ズーム 16 未満、または `building_coverage.json` に無い都市 |
| `?m=` が効かない | 5 桁コードでない、または `municipalities.json` に無いコード（区コードは市へ解決される） |
| `npm run dev` が起動しない（EADDRINUSE） | 5291 が使用中。`lsof -iTCP:5291 -sTCP:LISTEN` で確認して停止 |
| コンソールに「same source for a color-relief layer and for 3D terrain」 | 既知の警告（[§7](#7-既知の制約) 7）。動作に影響なし |
