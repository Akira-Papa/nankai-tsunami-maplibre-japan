/**
 * 全国版 UI（ボトムシート）の配線。地図（MapLibre）には一切触れず、
 * DOM ↔ UiState の同期・URL クエリ（?m=&h=）の反映・状態/バナー/読み取り表示だけを担当する。
 *
 * 契約: ../shared/DATA_CONTRACT.md §1（municipalities.json）／§3（tsunami_h.json）／§6（共通仕様）
 * DOM:  index.html の #sheet 配下（要素 ID は README「UI 要素一覧」参照）
 *
 * main.ts 側の使い方:
 *   const ui = initUi({ municipalities, tsunami }, { onChange, onFlyTo, onResetView }, { heightM: 5 });
 *   ui.setStatus('標高タイル読込中…'); ui.setBanner('…', 'warn'); ui.setReadout('標高 2.3 m');
 *
 * 状態の優先順位（初期化時）: 既定値 < `initial` < URL クエリ（?m= / ?h=）
 * - `setState()` は DOM と URL を更新するが `onChange` は呼ばない（main.ts 発の更新でループしないため）
 * - ユーザー操作は必ず `onChange(state)` を 1 回呼ぶ（スライダーは `input` ごと）
 * - 市区町村をユーザーが選び直したときは `onChange` に続けて `onFlyTo(code)` も呼ぶ
 * - preset が `manual` 以外のとき heightM はデータ由来（市区町村変更時に再計算）。値が無ければ
 *   2025最大 → 2025平均 → 2012最大 の順で代替し、すべて無ければ `manual` へ落として現在値を維持する
 * - シートの可視高さは CSS 変数 `--sheet-visible`（px）へ反映し、`window` に
 *   `CustomEvent('ui:sheet', { detail: { visible, collapsed } })` を送る（地図 padding の調整に任意で使える）
 */
import type { MunicipalitiesFile, TsunamiFile, Municipality, TsunamiRow, HeightPreset } from './data';
import { findMunicipality, findTsunamiRow, heightForPreset } from './data';
import { TSUNAMI_CASES, findCase, JMA_INTENSITY, findIntensity } from './scenarios';

export type { MunicipalitiesFile, TsunamiFile, Municipality, TsunamiRow } from './data';

// ---------------------------------------------------------------------------
// 公開インターフェース
// ---------------------------------------------------------------------------
/** `case` = 選択中の津波ケース（内閣府 ①〜⑪）の市町村別最大津波高 */
export type UiPreset = HeightPreset | 'case' | 'manual';

export interface UiState {
  muniCode: string | null;
  heightM: number;
  preset: 'max_2025' | 'mean_2025' | 'max_2012' | 'case' | 'manual';
  /** 内閣府 津波ケース "1".."11"。null = 指定なし（最大値ベース） */
  caseId: string | null;
  /** 参考表示の震度階級キー（'5-' 等）。地図表示には影響しない */
  intensity: string | null;
  showOfficial: boolean;
  showWhatIf: boolean;
  showBuildings: boolean;
  imagery: 'pale' | 'photo';
  hillshade: boolean;
}

export interface UiCallbacks {
  onChange(s: UiState): void;
  onFlyTo(code: string): void;
  onResetView(): void;
  /** 「震源域と市区町村を一画面に」（任意） */
  onFitCase?(): void;
}

export interface UiHandle {
  setState(p: Partial<UiState>): void;
  setStatus(text: string): void;
  setBanner(msg: string | null, level?: 'warn' | 'error'): void;
  setReadout(text: string | null): void;
  getState(): UiState;
}

export const H_MIN = 0;
export const H_MAX = 35;
export const H_STEP = 0.1;

const DEFAULT_STATE: UiState = {
  muniCode: null,
  heightM: 5.0,
  preset: 'max_2025',
  caseId: null,
  intensity: null,
  showOfficial: true,
  showWhatIf: false,
  showBuildings: true,
  imagery: 'pale',
  hillshade: true,
};

const PRESET_DEFS: { key: UiPreset; label: string; title: string }[] = [
  { key: 'max_2025', label: '2025 最大', title: '内閣府 2025 市町村別 最大津波高（海岸最大値）' },
  { key: 'mean_2025', label: '2025 平均', title: '内閣府 2025 市町村別 平均津波高' },
  { key: 'max_2012', label: '2012 最大', title: '内閣府 2012 市町村別 最大津波高' },
  { key: 'case', label: 'ケース別', title: '上で選んだ内閣府 津波ケース（大すべり域の位置）の市町村別最大津波高（2025 一覧表）' },
  { key: 'manual', label: '手動', title: 'スライダーで任意の高さを指定' },
];

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------
export function clampHeight(h: number): number {
  if (!Number.isFinite(h)) return H_MIN;
  return Math.round(Math.max(H_MIN, Math.min(H_MAX, h)) * 10) / 10;
}

/** URL クエリ（?m=&h=）を読む。不正値は無視。`h` があればプリセットは `manual` 扱い */
export function readUrlState(search: string = window.location.search): Partial<UiState> {
  const p = new URLSearchParams(search);
  const out: Partial<UiState> = {};
  const m = p.get('m');
  if (m && /^\d{5}$/.test(m)) out.muniCode = m;
  const c = p.get('c');
  if (c && findCase(c)) {
    out.caseId = c;
    out.preset = 'case';
  }
  const si = p.get('si');
  if (si && findIntensity(si)) out.intensity = si;
  const h = p.get('h');
  if (h !== null && h !== '') {
    const n = Number(h);
    if (Number.isFinite(n)) {
      out.heightM = clampHeight(n);
      out.preset = 'manual';
    }
  }
  return out;
}

const fmtM = (v: number | null | undefined): string =>
  typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)} m` : 'データなし';
const fmtHa = (v: number | null | undefined): string =>
  typeof v === 'number' && Number.isFinite(v) ? `約 ${Math.round(v).toLocaleString('ja-JP')} ha` : 'データなし';

/** 検索用の正規化（全角→半角・カタカナ→ひらがな・小文字） */
function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .trim();
}

function $<T extends HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`[ui] missing element: ${sel}`);
  return el;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// initUi
// ---------------------------------------------------------------------------
export function initUi(
  data: { municipalities: MunicipalitiesFile; tsunami: TsunamiFile },
  cb: UiCallbacks,
  initial: Partial<UiState> = {},
): UiHandle {
  // ---- DOM ----
  const sheet = $<HTMLElement>('#sheet');
  const handle = $<HTMLButtonElement>('#sheet-handle');
  const sheetHead = $<HTMLElement>('#sheet-head');
  const summaryMuni = $<HTMLElement>('#summary-muni');
  const summaryHeight = $<HTMLElement>('#summary-height');

  const selPref = $<HTMLSelectElement>('#sel-pref');
  const selMuni = $<HTMLSelectElement>('#sel-muni');
  const search = $<HTMLInputElement>('#muni-search');
  const btnFly = $<HTMLButtonElement>('#btn-flyto');
  const muniInfo = $<HTMLElement>('#muni-info');
  const muniEmpty = $<HTMLElement>('#muni-empty');
  const muniName = $<HTMLElement>('#muni-name');
  const thMax2025 = $<HTMLElement>('#th-max2025');
  const thMean2025 = $<HTMLElement>('#th-mean2025');
  const thMax2012 = $<HTMLElement>('#th-max2012');
  const thArea2025 = $<HTMLElement>('#th-area2025');
  const muniNote = $<HTMLElement>('#muni-note');

  const selCase = $<HTMLSelectElement>('#sel-case');
  const caseDesc = $<HTMLElement>('#case-desc');
  const caseMapLegend = $<HTMLElement>('#case-map-legend');
  const btnCaseFit = $<HTMLButtonElement>('#btn-case-fit');
  const selIntensity = $<HTMLSelectElement>('#sel-intensity');
  const intensityDesc = $<HTMLElement>('#intensity-desc');
  const btnHelp = $<HTMLButtonElement>('#btn-help');
  const helpEl = $<HTMLElement>('#help');
  const helpClose = $<HTMLButtonElement>('#help-close');

  const slider = $<HTMLInputElement>('#height');
  const heightOut = $<HTMLOutputElement>('#height-out');
  const presetsEl = $<HTMLElement>('#presets');

  const chkOfficial = $<HTMLInputElement>('#chk-official');
  const legend = $<HTMLElement>('#legend');
  const chkWhatIf = $<HTMLInputElement>('#chk-whatif');
  const whatIfNote = $<HTMLElement>('#whatif-note');
  const chkBuildings = $<HTMLInputElement>('#chk-buildings');
  const chkPhoto = $<HTMLInputElement>('#chk-photo');
  const chkHillshade = $<HTMLInputElement>('#chk-hillshade');
  const btnReset = $<HTMLButtonElement>('#btn-reset');

  const statusEl = $<HTMLElement>('#status');
  const bannerEl = $<HTMLElement>('#banner');
  const bannerText = $<HTMLElement>('#banner-text');
  const bannerClose = $<HTMLButtonElement>('#banner-close');
  const readoutEl = $<HTMLElement>('#readout');

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const desktopLayout = window.matchMedia('(min-width: 720px)');

  // ---- データ ----
  const targets: Municipality[] = data.municipalities.municipalities
    .filter((m) => m.nankai_target || m.coastal)
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code));
  const prefHasTarget = new Set(targets.map((m) => m.pref_code));
  const prefectures = data.municipalities.prefectures
    .filter((p) => prefHasTarget.has(p.code))
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code));

  const muniOf = (code: string | null | undefined): Municipality | null => findMunicipality(data.municipalities, code);
  const rowOf = (code: string | null | undefined): TsunamiRow | null => findTsunamiRow(data.tsunami, muniOf(code));

  // ---- 状態 ----
  const state: UiState = { ...DEFAULT_STATE, ...stripUndefined(initial), ...readUrlState() };
  state.heightM = clampHeight(state.heightM);
  {
    const m = muniOf(state.muniCode);
    state.muniCode = m ? m.code : null; // 区コード → 市コードへ正規化、未知コードは破棄
  }

  // -------------------------------------------------------------------------
  // URL 同期（Safari は replaceState を短時間に 100 回超えると SecurityError を投げるため間引く）
  // -------------------------------------------------------------------------
  let urlTimer: number | undefined;
  function syncUrl(): void {
    window.clearTimeout(urlTimer);
    urlTimer = window.setTimeout(() => {
      try {
        const url = new URL(window.location.href);
        if (state.muniCode) url.searchParams.set('m', state.muniCode);
        else url.searchParams.delete('m');
        if (state.caseId) url.searchParams.set('c', state.caseId);
        else url.searchParams.delete('c');
        if (state.intensity) url.searchParams.set('si', state.intensity);
        else url.searchParams.delete('si');
        url.searchParams.set('h', state.heightM.toFixed(1));
        const next = url.pathname + url.search + url.hash;
        if (next !== window.location.pathname + window.location.search + window.location.hash) {
          history.replaceState(history.state, '', next);
        }
      } catch (e) {
        console.debug('[ui] replaceState skipped', e);
      }
    }, 250);
  }

  function emit(): void {
    syncUrl();
    cb.onChange({ ...state });
  }

  // -------------------------------------------------------------------------
  // 都道府県・市区町村セレクト
  // -------------------------------------------------------------------------
  function buildPrefOptions(): void {
    selPref.replaceChildren();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'すべての都道府県';
    selPref.appendChild(all);
    for (const p of prefectures) {
      const o = document.createElement('option');
      o.value = p.code;
      o.textContent = p.name;
      selPref.appendChild(o);
    }
  }

  function filteredMunicipalities(): Municipality[] {
    const q = normalize(search.value);
    const pref = selPref.value;
    return targets.filter((m) => {
      if (pref && m.pref_code !== pref) return false;
      if (!q) return true;
      return normalize(`${m.name} ${m.pref} ${m.code}`).includes(q);
    });
  }

  function buildMuniOptions(): void {
    const list = filteredMunicipalities();
    const selected = muniOf(state.muniCode);
    // 選択中の市区町村がフィルタで消えても選択状態が見えるよう先頭へ残す
    if (selected && !list.some((m) => m.code === selected.code)) list.unshift(selected);
    selMuni.replaceChildren();
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = list.length ? `市区町村を選択（${list.length}件）` : '該当なし';
    selMuni.appendChild(ph);
    const showPref = !selPref.value;
    for (const m of list) {
      const o = document.createElement('option');
      o.value = m.code;
      o.textContent = showPref ? `${m.name}（${m.pref}）` : m.name;
      selMuni.appendChild(o);
    }
    selMuni.value = selected ? selected.code : '';
    selMuni.disabled = list.length === 0;
  }

  function renderMuniInfo(): void {
    const muni = muniOf(state.muniCode);
    const row = findTsunamiRow(data.tsunami, muni);
    btnFly.disabled = !muni;
    if (!muni) {
      muniInfo.hidden = true;
      muniEmpty.hidden = false;
      summaryMuni.textContent = '市区町村未選択';
      return;
    }
    muniInfo.hidden = false;
    muniEmpty.hidden = true;
    muniName.textContent = `${muni.pref} ${muni.name}`;
    summaryMuni.textContent = muni.name;
    thMax2025.textContent = fmtM(row?.max_2025);
    thMean2025.textContent = fmtM(row?.mean_2025);
    thMax2012.textContent = fmtM(row?.max_2012);
    thArea2025.textContent = fmtHa(row?.area_ha_2025);
    const note = row ? row.note : '内閣府 2025 市町村別一覧表に掲載がありません（海岸線を持つ市区町村として選択可）';
    muniNote.textContent = note;
    muniNote.hidden = !note;
  }

  /** プリセットの値（m）。無ければ null */
  function presetValue(preset: UiPreset, code: string | null = state.muniCode): number | null {
    if (preset === 'manual') return null;
    if (preset === 'case') {
      const row = rowOf(code);
      const v = state.caseId ? row?.cases_2025?.[state.caseId] : null;
      return typeof v === 'number' && Number.isFinite(v) ? clampHeight(v) : null;
    }
    const v = heightForPreset(rowOf(code), preset);
    return v === null ? null : clampHeight(v);
  }

  /** 市区町村選択後: 現在のプリセットの値を適用。無ければ 2025最大→2025平均→2012最大 の順で代替 */
  function applyPresetForMuni(): void {
    if (state.preset === 'manual') return;
    const order: UiPreset[] = [state.preset, 'max_2025', 'mean_2025', 'max_2012'];
    for (const p of order) {
      const v = presetValue(p);
      if (v !== null) {
        state.preset = p;
        state.heightM = v;
        return;
      }
    }
    state.preset = 'manual'; // 値が無い市区町村 → 手動のまま現在値を維持
  }

  // -------------------------------------------------------------------------
  // プリセット・スライダー
  // -------------------------------------------------------------------------
  const presetButtons = new Map<UiPreset, HTMLButtonElement>();
  function buildPresets(): void {
    presetsEl.replaceChildren();
    for (const def of PRESET_DEFS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset';
      b.dataset.preset = def.key;
      b.title = def.title;
      b.setAttribute('aria-pressed', 'false');
      const label = document.createElement('span');
      label.className = 'preset-label';
      label.textContent = def.label;
      const val = document.createElement('span');
      val.className = 'preset-value';
      b.append(label, val);
      b.addEventListener('click', () => {
        if (def.key === 'manual') {
          state.preset = 'manual';
        } else if (def.key === 'case' && !state.caseId) {
          // ケース未選択なら選択欄へ誘導するだけ（推測の値は入れない）
          selCase.focus();
          return;
        } else {
          const v = presetValue(def.key);
          if (v === null) return; // データなし（aria-disabled）
          state.preset = def.key;
          state.heightM = v;
        }
        renderHeight();
        renderPresets();
        renderCase();
        emit();
      });
      presetButtons.set(def.key, b);
      presetsEl.appendChild(b);
    }
  }

  function renderPresets(): void {
    for (const def of PRESET_DEFS) {
      const b = presetButtons.get(def.key);
      if (!b) continue;
      const val = b.querySelector<HTMLElement>('.preset-value');
      const active = state.preset === def.key;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
      if (def.key === 'manual') {
        if (val) val.textContent = active ? `${state.heightM.toFixed(1)} m` : '';
        b.removeAttribute('aria-disabled');
        continue;
      }
      const v = presetValue(def.key);
      const has = v !== null;
      if (val) {
        if (def.key === 'case' && !state.caseId) val.textContent = 'ケース未選択';
        else val.textContent = state.muniCode ? (has ? `${(v as number).toFixed(1)} m` : 'データなし') : '—';
      }
      if (has) b.removeAttribute('aria-disabled');
      else b.setAttribute('aria-disabled', 'true');
      b.classList.toggle('unavailable', !has);
    }
  }

  // -------------------------------------------------------------------------
  // 津波ケース（内閣府 ①〜⑪＝大すべり域の位置）
  // -------------------------------------------------------------------------
  function buildCaseOptions(): void {
    selCase.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '指定なし（全ケースの最大値で表示）';
    selCase.appendChild(none);
    for (const c of TSUNAMI_CASES) {
      const o = document.createElement('option');
      o.value = c.id;
      const tag = c.branchFault ? '・分岐断層あり' : c.slipCount === 2 ? '・2箇所' : '';
      o.textContent = `${c.label} ${c.regions}${tag}`;
      selCase.appendChild(o);
    }
    selCase.disabled = TSUNAMI_CASES.length === 0;
    if (TSUNAMI_CASES.length === 0) none.textContent = '準備中';
  }

  function renderCase(): void {
    const c = findCase(state.caseId);
    if (selCase.value !== (c ? c.id : '')) selCase.value = c ? c.id : '';
    caseMapLegend.hidden = !c;
    if (!c) {
      caseDesc.textContent = '指定なしのときは、各市区町村の「①〜⑪の最大値」（2025 一覧表の最大値）を使います。';
      return;
    }
    const parts = [`${c.label}: 大すべり域・超大すべり域を「${c.regions}」に設定`];
    if (c.branchFault) parts.push('熊野灘の分岐断層が動く想定');
    if (c.slipCount === 2) parts.push('大すべり域を2箇所に設定');
    if (c.note) parts.push(c.note);
    const muni = muniOf(state.muniCode);
    if (muni) {
      const v = presetValue('case');
      const max = presetValue('max_2025');
      parts.push(
        v === null
          ? `${muni.name}: このケースの公表値はありません`
          : `${muni.name}: このケースの最大津波高 ${v.toFixed(1)} m` + (max !== null ? `（全ケース最大 ${max.toFixed(1)} m）` : ''),
      );
    } else {
      parts.push('市区町村を選ぶと、そのケースの市町村別最大津波高（公表値）を表示・反映します');
    }
    caseDesc.textContent = parts.join('。') + '。';
  }

  btnCaseFit.addEventListener('click', () => cb.onFitCase?.());

  selCase.addEventListener('change', () => {
    const next = findCase(selCase.value)?.id ?? null;
    state.caseId = next;
    if (next) {
      const v = presetValue('case');
      if (v !== null) {
        state.preset = 'case';
        state.heightM = v;
      } else if (state.preset === 'case') {
        applyPresetForMuni(); // 値が無い市区町村では最大値系へ代替
      }
    } else if (state.preset === 'case') {
      state.preset = 'max_2025';
      applyPresetForMuni();
    }
    renderCase();
    renderHeight();
    renderPresets();
    emit();
  });

  // -------------------------------------------------------------------------
  // 震度（参考表示。地図には影響しない）
  // -------------------------------------------------------------------------
  function buildIntensityOptions(): void {
    selIntensity.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '選択なし';
    selIntensity.appendChild(none);
    for (const lv of JMA_INTENSITY) {
      const o = document.createElement('option');
      o.value = lv.key;
      o.textContent = lv.label;
      selIntensity.appendChild(o);
    }
    selIntensity.disabled = JMA_INTENSITY.length === 0;
    if (JMA_INTENSITY.length === 0) none.textContent = '準備中';
  }

  function renderIntensity(): void {
    const lv = findIntensity(state.intensity);
    if (selIntensity.value !== (lv ? lv.key : '')) selIntensity.value = lv ? lv.key : '';
    intensityDesc.replaceChildren();
    intensityDesc.hidden = !lv;
    if (!lv) return;
    const dl = document.createElement('dl');
    for (const [k, v] of [
      ['人の体感・行動', lv.people],
      ['屋内の状況', lv.indoor],
      ['屋外の状況', lv.outdoor],
    ]) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    const head = document.createElement('div');
    head.className = 'intensity-head';
    head.textContent = `${lv.label}（気象庁 震度階級関連解説表より）`;
    intensityDesc.append(head, dl);
  }

  selIntensity.addEventListener('change', () => {
    state.intensity = findIntensity(selIntensity.value)?.key ?? null;
    renderIntensity();
    emit();
  });

  // -------------------------------------------------------------------------
  // 操作案内
  // -------------------------------------------------------------------------
  function setHelpOpen(open: boolean): void {
    helpEl.hidden = !open;
    btnHelp.setAttribute('aria-expanded', String(open));
    if (open) helpClose.focus();
  }
  btnHelp.addEventListener('click', () => setHelpOpen(helpEl.hidden));
  helpClose.addEventListener('click', () => setHelpOpen(false));
  helpEl.addEventListener('click', (e) => {
    if (e.target === helpEl) setHelpOpen(false);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !helpEl.hidden) setHelpOpen(false);
  });

  function renderHeight(): void {
    const h = state.heightM;
    const text = `${h.toFixed(1)} m`;
    heightOut.value = text;
    summaryHeight.textContent = text;
    if (slider.valueAsNumber !== h) slider.value = String(h);
    slider.setAttribute('aria-valuenow', String(h));
    slider.setAttribute('aria-valuetext', `${h.toFixed(1)} メートル（東京湾平均海面基準）`);
  }

  slider.min = String(H_MIN);
  slider.max = String(H_MAX);
  slider.step = String(H_STEP);
  slider.setAttribute('aria-valuemin', String(H_MIN));
  slider.setAttribute('aria-valuemax', String(H_MAX));

  const onSlider = (): void => {
    const h = clampHeight(slider.valueAsNumber);
    if (h === state.heightM && state.preset === 'manual') return;
    state.heightM = h;
    state.preset = 'manual';
    renderHeight();
    renderPresets();
    emit();
  };
  slider.addEventListener('input', onSlider);
  slider.addEventListener('change', onSlider);

  // -------------------------------------------------------------------------
  // トグル
  // -------------------------------------------------------------------------
  function renderToggles(): void {
    chkOfficial.checked = state.showOfficial;
    legend.hidden = !state.showOfficial;
    chkWhatIf.checked = state.showWhatIf;
    whatIfNote.classList.toggle('is-on', state.showWhatIf);
    chkBuildings.checked = state.showBuildings;
    chkPhoto.checked = state.imagery === 'photo';
    chkHillshade.checked = state.hillshade;
  }

  chkOfficial.addEventListener('change', () => {
    state.showOfficial = chkOfficial.checked;
    renderToggles();
    emit();
  });
  chkWhatIf.addEventListener('change', () => {
    state.showWhatIf = chkWhatIf.checked;
    renderToggles();
    emit();
  });
  chkBuildings.addEventListener('change', () => {
    state.showBuildings = chkBuildings.checked;
    emit();
  });
  chkPhoto.addEventListener('change', () => {
    state.imagery = chkPhoto.checked ? 'photo' : 'pale';
    emit();
  });
  chkHillshade.addEventListener('change', () => {
    state.hillshade = chkHillshade.checked;
    emit();
  });
  btnReset.addEventListener('click', () => cb.onResetView());

  // -------------------------------------------------------------------------
  // 市区町村選択イベント
  // -------------------------------------------------------------------------
  function selectMuni(code: string | null, opts: { fly: boolean }): void {
    const muni = muniOf(code);
    state.muniCode = muni ? muni.code : null;
    applyPresetForMuni();
    renderMuniInfo();
    renderHeight();
    renderPresets();
    renderCase();
    emit();
    if (opts.fly && state.muniCode) cb.onFlyTo(state.muniCode);
  }

  selPref.addEventListener('change', buildMuniOptions);
  let searchTimer: number | undefined;
  search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(buildMuniOptions, 120);
  });
  search.addEventListener('keydown', (e) => {
    // Enter で候補が 1 件ならそのまま選択
    if (e.key !== 'Enter') return;
    const list = filteredMunicipalities();
    if (list.length === 1) {
      e.preventDefault();
      selectMuni(list[0].code, { fly: true });
      buildMuniOptions();
    }
  });
  selMuni.addEventListener('change', () => selectMuni(selMuni.value || null, { fly: true }));
  btnFly.addEventListener('click', () => {
    if (state.muniCode) cb.onFlyTo(state.muniCode);
  });

  // -------------------------------------------------------------------------
  // ボトムシート（開閉・可視高さ）
  // -------------------------------------------------------------------------
  let sheetRaf = 0;
  function updateSheetInset(): void {
    if (sheetRaf) return;
    sheetRaf = requestAnimationFrame(() => {
      sheetRaf = 0;
      const root = document.documentElement;
      const collapsedVisible = Math.round(handle.offsetHeight + sheetHead.offsetHeight + 6);
      root.style.setProperty('--sheet-collapsed-visible', `${collapsedVisible}px`);
      const visible = desktopLayout.matches
        ? 0
        : Math.max(0, Math.round(window.innerHeight - sheet.getBoundingClientRect().top));
      root.style.setProperty('--sheet-visible', `${visible}px`);
      window.dispatchEvent(
        new CustomEvent('ui:sheet', { detail: { visible, collapsed: sheet.classList.contains('collapsed') } }),
      );
    });
  }

  function setSheetCollapsed(collapsed: boolean): void {
    sheet.classList.toggle('collapsed', collapsed);
    handle.setAttribute('aria-expanded', String(!collapsed));
    handle.setAttribute('aria-label', collapsed ? '操作パネルを開く' : '操作パネルを閉じる');
    if (collapsed) sheet.scrollTop = 0;
    updateSheetInset();
  }
  handle.addEventListener('click', () => setSheetCollapsed(!sheet.classList.contains('collapsed')));
  sheetHead.addEventListener('click', () => {
    if (sheet.classList.contains('collapsed')) setSheetCollapsed(false);
  });
  sheet.addEventListener('transitionend', updateSheetInset);
  new ResizeObserver(updateSheetInset).observe(sheet);
  window.addEventListener('resize', updateSheetInset);
  desktopLayout.addEventListener('change', updateSheetInset);

  let touchStartY: number | null = null;
  sheet.addEventListener(
    'touchstart',
    (e) => {
      touchStartY = e.touches.length === 1 ? e.touches[0].clientY : null;
    },
    { passive: true },
  );
  sheet.addEventListener(
    'touchend',
    (e) => {
      if (touchStartY === null) return;
      const dy = e.changedTouches[0].clientY - touchStartY;
      touchStartY = null;
      const target = e.target as HTMLElement | null;
      // セレクト・スライダー・入力欄上のスワイプは開閉に使わない
      if (target?.closest('select, input, button.preset')) return;
      const collapsed = sheet.classList.contains('collapsed');
      if (collapsed && dy < -40) setSheetCollapsed(false);
      else if (!collapsed && dy > 60 && sheet.scrollTop <= 0) setSheetCollapsed(true);
    },
    { passive: true },
  );

  // -------------------------------------------------------------------------
  // ステータス・バナー・読み取り
  // -------------------------------------------------------------------------
  function setStatus(text: string): void {
    const t = (text ?? '').trim();
    statusEl.textContent = t;
    statusEl.hidden = !t;
  }

  function setBanner(msg: string | null, level: 'warn' | 'error' = 'warn'): void {
    if (!msg) {
      bannerEl.hidden = true;
      bannerText.textContent = '';
      return;
    }
    bannerEl.classList.remove('warn', 'error');
    bannerEl.classList.add(level);
    bannerEl.setAttribute('role', level === 'error' ? 'alert' : 'status');
    bannerText.textContent = msg;
    bannerEl.hidden = false;
  }
  bannerClose.addEventListener('click', () => setBanner(null));

  function setReadout(text: string | null): void {
    const t = (text ?? '').trim();
    readoutEl.textContent = t;
    readoutEl.hidden = !t;
  }

  // -------------------------------------------------------------------------
  // setState / getState
  // -------------------------------------------------------------------------
  function setState(p: Partial<UiState>): void {
    const patch = stripUndefined(p);
    let muniChanged = false;
    if ('muniCode' in patch) {
      const muni = muniOf(patch.muniCode);
      const next = muni ? muni.code : null;
      muniChanged = next !== state.muniCode;
      state.muniCode = next;
    }
    if ('caseId' in patch) state.caseId = findCase(patch.caseId)?.id ?? null;
    if ('intensity' in patch) state.intensity = findIntensity(patch.intensity)?.key ?? null;
    if (patch.preset !== undefined) state.preset = patch.preset;
    if (patch.heightM !== undefined) {
      state.heightM = clampHeight(patch.heightM);
    } else if (muniChanged || patch.preset !== undefined || 'caseId' in patch) {
      applyPresetForMuni(); // 高さ未指定なら現在のプリセット値を再適用
    }
    if (patch.showOfficial !== undefined) state.showOfficial = patch.showOfficial;
    if (patch.showWhatIf !== undefined) state.showWhatIf = patch.showWhatIf;
    if (patch.showBuildings !== undefined) state.showBuildings = patch.showBuildings;
    if (patch.imagery !== undefined) state.imagery = patch.imagery;
    if (patch.hillshade !== undefined) state.hillshade = patch.hillshade;

    if (muniChanged) buildMuniOptions();
    renderMuniInfo();
    renderHeight();
    renderPresets();
    renderCase();
    renderIntensity();
    renderToggles();
    syncUrl();
  }

  function getState(): UiState {
    return { ...state };
  }

  // -------------------------------------------------------------------------
  // 初期描画
  // -------------------------------------------------------------------------
  buildPrefOptions();
  if (state.muniCode) {
    const muni = muniOf(state.muniCode);
    if (muni) selPref.value = muni.pref_code;
    applyPresetForMuni(); // preset が manual 以外なら高さはデータ由来（?h= 指定時は readUrlState が manual にしている）
  }
  buildMuniOptions();
  buildCaseOptions();
  buildIntensityOptions();
  buildPresets();
  renderMuniInfo();
  renderHeight();
  renderPresets();
  renderCase();
  renderIntensity();
  renderToggles();
  setSheetCollapsed(false);
  setStatus('');
  setBanner(null);
  setReadout(null);
  if (reducedMotion.matches) sheet.style.transition = 'none';
  syncUrl();

  return { setState, setStatus, setBanner, setReadout, getState };
}
