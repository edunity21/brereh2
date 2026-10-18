// BRIDGE 발표 리허설 — 핵심 로직
// DOM을 쓰지 않는 순수 함수만 모았습니다. 브라우저와 Node 테스트에서 함께 사용합니다.

export const MAX_RECORD_SEC = 15 * 60; // 최대 녹화 15분 (일시정지 시간 제외)
export const WARN_AT_SEC = [14 * 60, 14 * 60 + 30]; // 종료 1분 전, 30초 전 안내
export const DEFAULT_TARGET_SEC = 10 * 60;
export const DEFAULT_RATE_SPM = 300; // 기준 말하기 속도(분당 음절)
export const DEFAULT_DICTIONARY = ['AI=에이아이', 'BRIDGE=브리지', 'ME=미', 'WE=위'].join('\n');

export const ST = { TODO: 0, SAID: 1, MANUAL: 2 };

/* ───────────── 1. 원고 분할 ───────────── */

const SEP_RE = /^\s*={3,}\s*(.*?)\s*=*\s*$/;
const BULLET_RE = /^\s*(?:[●○◦•▪■□◆◇▶▷►✔✓\-*·]|\d{1,2}[.)])\s+/;

/**
 * 원고 텍스트 → 구간·문장
 * - `===` 줄은 구간 구분선. `=== 첫 번째 다리`처럼 쓰면 구간 이름이 됩니다.
 * - 글머리표(●, -, 1. 등)가 있는 원고에서는 글머리표 줄만 발표 문장으로, 나머지 줄은 메모로 처리합니다.
 * - 글머리표가 없는 원고는 모든 줄이 문장입니다.
 */
export function parseScript(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const hasBullets = lines.some((l) => BULLET_RE.test(l));
  const raw = [];
  const notes = [];
  let cur = { title: '', lines: [] };
  for (const line of lines) {
    if (!line.trim()) continue;
    const sep = line.match(SEP_RE);
    if (sep) {
      const title = sep[1].trim();
      if (cur.lines.length) {
        raw.push(cur);
        cur = { title, lines: [] };
      } else if (title) cur.title = title;
      continue;
    }
    if (hasBullets && !BULLET_RE.test(line)) {
      notes.push(line.trim());
      continue;
    }
    const s = line.replace(BULLET_RE, '').trim();
    if (s) cur.lines.push(s);
  }
  if (cur.lines.length) raw.push(cur);

  const sections = [];
  const sentences = [];
  raw.forEach((sec, si) => {
    const ids = [];
    for (const t of sec.lines) {
      ids.push(sentences.length);
      sentences.push({ id: sentences.length, sectionId: si, text: t });
    }
    sections.push({ id: si, title: sec.title || snippet(sec.lines[0]), named: !!sec.title, sentenceIds: ids });
  });
  return { sections, sentences, notes };
}

function snippet(s, max = 14) {
  const t = String(s ?? '').replace(/[「」『』"“”'‘’]/g, '').trim();
  return t.length > max ? t.slice(0, max).trim() + '…' : t;
}

/* ───────────── 2. 비교용 정규화 ───────────── */

export function parseDictionary(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*([^=]+?)\s*=\s*(.+?)\s*$/);
    if (m) out.push({ key: m[1], lower: m[1].toLowerCase(), reading: m[2] });
  }
  return out.sort((a, b) => b.key.length - a.key.length);
}

export function parseList(text) {
  return String(text ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const DIG = '영일이삼사오육칠팔구';

export function readInteger(str) {
  str = String(str).replace(/^0+(?=\d)/, '');
  if (/^0+$/.test(str)) return '영';
  if (str.length > 16) return [...str].map((d) => DIG[+d]).join('');
  const big = ['', '만', '억', '조'];
  const small = ['', '십', '백', '천'];
  const groups = [];
  for (let end = str.length; end > 0; end -= 4) groups.unshift(str.slice(Math.max(0, end - 4), end));
  let out = '';
  groups.forEach((g, gi) => {
    const level = groups.length - 1 - gi;
    const d4 = g.padStart(4, '0');
    let part = '';
    for (let k = 0; k < 4; k++) {
      const d = +d4[k];
      if (!d) continue;
      const pos = 3 - k;
      part += (d === 1 && pos > 0 ? '' : DIG[d]) + small[pos];
    }
    if (part) out += (part === '일' && level === 1 ? '' : part) + big[level];
  });
  return out;
}

/** "2.57" → "이점오칠", "1,000" → "천" */
export function readNumber(tok) {
  const [int, frac] = String(tok).replace(/,/g, '').split('.');
  let out = readInteger(int || '0');
  if (frac) out += '점' + [...frac].map((d) => DIG[+d]).join('');
  return out;
}

const LETTER = {
  a: '에이', b: '비', c: '씨', d: '디', e: '이', f: '에프', g: '지', h: '에이치', i: '아이', j: '제이',
  k: '케이', l: '엘', m: '엠', n: '엔', o: '오', p: '피', q: '큐', r: '알', s: '에스', t: '티',
  u: '유', v: '브이', w: '더블유', x: '엑스', y: '와이', z: '제트',
};
const spell = (w) => [...w.toLowerCase()].map((c) => LETTER[c] || '').join('');
const isLatin = (c) => !!c && /[A-Za-z]/.test(c);
const isDigit = (c) => !!c && /\d/.test(c);
const isHangul = (c) => !!c && c >= '가' && c <= '힣';

/**
 * 문장 → 비교 단위(음절) 배열. 원고와 인식 결과에 똑같이 적용합니다.
 * 각 단위는 원문 위치(start, end)를 기억하므로 자막 색칠에 그대로 씁니다.
 * - 발음 사전(AI=에이아이 등)을 먼저 적용
 * - 숫자는 한자어 읽기(45 → 사십오, 2.57 → 이점오칠)
 * - 사전에 없는 5자 이하 대문자 영문은 알파벳 이름(A → 에이)
 * - 공백·문장부호·기호는 비교에서 제외
 */
export function toUnits(text, dict = []) {
  const s = String(text ?? '');
  const out = [];
  const push = (reading, start, end) => {
    for (const u of toUnits(reading)) out.push({ ch: u.ch, start, end });
  };
  let i = 0;
  outer: while (i < s.length) {
    for (const d of dict) {
      const L = d.key.length;
      if (s.substr(i, L).toLowerCase() !== d.lower) continue;
      const before = s[i - 1];
      const after = s[i + L];
      if (isLatin(d.key[0]) && isLatin(before)) continue;
      if (isLatin(d.key[L - 1]) && isLatin(after)) continue;
      if (isDigit(d.key[0]) && (isDigit(before) || (before === '.' && isDigit(s[i - 2])))) continue;
      if (isDigit(d.key[L - 1]) && isDigit(after)) continue;
      push(d.reading, i, i + L);
      i += L;
      continue outer;
    }
    const c = s[i];
    if (isDigit(c)) {
      const re = /\d+(?:,\d{3})*(?:\.\d+)?/y;
      re.lastIndex = i;
      const tok = re.exec(s)[0];
      let end = i + tok.length;
      let reading = readNumber(tok);
      if (s[end] === '%') {
        reading += '퍼센트';
        end++;
      }
      push(reading, i, end);
      i = end;
      continue;
    }
    if (isLatin(c)) {
      const re = /[A-Za-z]+/y;
      re.lastIndex = i;
      const w = re.exec(s)[0];
      if (w === w.toUpperCase() && w.length <= 5) push(spell(w), i, i + w.length);
      else for (let k = 0; k < w.length; k++) out.push({ ch: w[k].toLowerCase(), start: i + k, end: i + k + 1 });
      i += w.length;
      continue;
    }
    if (isHangul(c)) out.push({ ch: c, start: i, end: i + 1 });
    i++;
  }
  return out;
}

export const unitString = (text, dict) => toUnits(text, dict).map((u) => u.ch).join('');

/* ───────────── 3. 문자 정렬 ───────────── */

function jamo(ch) {
  if (!ch || ch.length !== 1) return null;
  const c = ch.charCodeAt(0) - 0xac00;
  if (c < 0 || c > 11171) return null;
  return [(c / 588) | 0, ((c % 588) / 28) | 0, c % 28];
}
const NEAR_VOWEL = new Set(['1,5', '5,1', '3,7', '7,3', '10,11', '11,10', '10,15', '15,10', '11,15', '15,11']);

/** 같은 음절 2점, 받침만 다르거나 ㅐ/ㅔ처럼 비슷한 음절 1점, 그 외 -1점 */
export function unitScore(a, b) {
  if (a === b) return 2;
  const pa = jamo(a);
  const pb = jamo(b);
  if (!pa || !pb) return -1;
  if (pa[0] === pb[0] && (pa[1] === pb[1] || NEAR_VOWEL.has(pa[1] + ',' + pb[1]))) return 1;
  return -1;
}

const GAP = 1;

/**
 * 인식 문장(query)을 원고 창(ref[w0..w1))에 국소 정렬합니다.
 * 현재 위치(cursor)에서 멀리 떨어진 곳에서 시작할수록 벌점을 주어
 * 같은 표현이 뒤에 또 나와도 엉뚱한 곳으로 점프하지 않게 합니다.
 */
export function align(query, ref, w0, w1, cursor, opt = {}) {
  const jumpPen = opt.jumpPen ?? 0.08;
  const backPen = opt.backPen ?? 0.35;
  const m = query.length;
  const n = w1 - w0;
  if (!m || n <= 0) return null;
  const W = n + 1;
  let prev = new Float32Array(W).fill(-1e9);
  let curr = new Float32Array(W);
  const trace = new Uint8Array((m + 1) * W);
  const base = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const r = w0 + j;
    base[j] = -(r >= cursor ? (r - cursor) * jumpPen : (cursor - r) * backPen);
  }
  let best = -1e9;
  let bi = -1;
  let bj = -1;
  for (let i = 1; i <= m; i++) {
    curr[0] = -1e9;
    const q = query[i - 1];
    for (let j = 1; j <= n; j++) {
      const s = unitScore(q, ref[w0 + j - 1]);
      let h = base[j - 1] + s;
      let t = 0;
      const d = prev[j - 1] + s;
      if (d > h) { h = d; t = 1; }
      const u = prev[j] - GAP;
      if (u > h) { h = u; t = 2; }
      const l = curr[j - 1] - GAP;
      if (l > h) { h = l; t = 3; }
      curr[j] = h;
      trace[i * W + j] = t;
      if (s > 0 && t <= 1 && h > best) { best = h; bi = i; bj = j; }
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  if (bi < 0) return null;
  const pairs = [];
  let i = bi;
  let j = bj;
  while (i > 0 && j > 0) {
    const t = trace[i * W + j];
    if (t <= 1) {
      if (unitScore(query[i - 1], ref[w0 + j - 1]) > 0) pairs.push([i - 1, w0 + j - 1]);
      if (t === 0) break;
      i--; j--;
    } else if (t === 2) i--;
    else j--;
  }
  pairs.reverse();
  let exact = 0;
  for (const [qi, rj] of pairs) if (query[qi] === ref[rj]) exact++;
  return { score: best, pairs, exact };
}

/* ───────────── 4. 원고 모델 ───────────── */

export function buildModel(parsed, dictText = DEFAULT_DICTIONARY) {
  const dict = parseDictionary(dictText);
  const units = [];
  const sentences = parsed.sentences.map((s) => {
    const us = toUnits(s.text, dict);
    const u0 = units.length;
    for (const u of us) units.push({ ch: u.ch, sid: s.id, start: u.start, end: u.end });
    return { ...s, u0, u1: units.length, segs: segments(s.text, us, u0) };
  });
  const sections = parsed.sections.map((sec) => {
    const ss = sec.sentenceIds.map((id) => sentences[id]);
    return { ...sec, u0: ss[0].u0, u1: ss[ss.length - 1].u1, n: ss[ss.length - 1].u1 - ss[0].u0 };
  });
  return { dict, units, sentences, sections, notes: parsed.notes, N: units.length };
}

/** 자막 렌더링용 조각: 같은 원문 범위를 공유하는 단위를 묶고, 사이의 공백·문장부호는 따로 둡니다. */
function segments(text, us, u0) {
  const segs = [];
  let pos = 0;
  let k = 0;
  while (k < us.length) {
    const { start, end } = us[k];
    let k2 = k;
    while (k2 < us.length && us[k2].start === start && us[k2].end === end) k2++;
    if (start > pos) segs.push({ text: text.slice(pos, start), punct: true });
    const wordStart = start === 0 || /[\s'"“”‘’(「『<[\-·]/.test(text[start - 1]);
    segs.push({ text: text.slice(start, end), u0: u0 + k, u1: u0 + k2, wordStart });
    pos = end;
    k = k2;
  }
  if (pos < text.length) segs.push({ text: text.slice(pos), punct: true });
  return segs;
}

/* ───────────── 5. 위치 추적 ───────────── */

export class Tracker {
  constructor(model, opt = {}) {
    this.m = model;
    this.N = model.N;
    this.ref = model.units.map((u) => u.ch);
    this.status = new Uint8Array(this.N);
    this.tent = new Uint8Array(this.N);
    this.cursor = 0;
    this.tentCursor = 0;
    const S = model.sentences.length;
    this.enter = new Array(S).fill(null);
    this.first = new Array(S).fill(null);
    this.last = new Array(S).fill(null);
    this.minScore = opt.minScore ?? 6;
    this.lastProgress = 0;
    this.enter[0] = 0;
  }

  get focus() {
    return Math.max(this.cursor, this.tentCursor);
  }

  sentenceOfUnit(u) {
    if (u >= this.N) return this.m.sentences.length;
    return this.m.units[u].sid;
  }

  /** 현재 말해야 할 문장 번호 (끝까지 갔으면 문장 수와 같음) */
  current() {
    return this.sentenceOfUnit(this.focus);
  }

  _window(len) {
    const w0 = Math.max(0, this.cursor - 15);
    const w1 = Math.min(this.N, this.cursor + Math.min(700, Math.max(320, len * 3)));
    return [w0, w1];
  }

  _align(q) {
    const [w0, w1] = this._window(q.length);
    const res = align(q, this.ref, w0, w1, this.cursor);
    if (!res || res.score < this.minScore || res.exact < 3) return null;
    return res;
  }

  ingestInterim(text, t) {
    this.tent.fill(0);
    this.tentCursor = this.cursor;
    const q = toUnits(text, this.m.dict).map((u) => u.ch).slice(-300);
    if (q.length < 2) return false;
    const res = this._align(q);
    if (!res) return false;
    let moved = false;
    for (const [, r] of res.pairs) if (r >= this.cursor && this.status[r] === ST.TODO) this.tent[r] = 1;
    const end = res.pairs[res.pairs.length - 1][1] + 1;
    if (end > this.cursor) {
      this.tentCursor = end;
      moved = true;
      this.lastProgress = t;
    }
    this._enter(t);
    return moved;
  }

  ingestFinal(text, t) {
    this.tent.fill(0);
    this.tentCursor = this.cursor;
    const all = toUnits(text, this.m.dict).map((u) => u.ch);
    let moved = false;
    for (let off = 0; off < all.length; off += 150) {
      const q = all.slice(off, off + 150);
      if (q.length < 2) continue;
      const res = this._align(q);
      if (!res) continue;
      for (const [, r] of res.pairs) {
        if (this.status[r] === ST.TODO) this.status[r] = ST.SAID;
        const sid = this.m.units[r].sid;
        if (this.first[sid] == null) this.first[sid] = t;
        this.last[sid] = t;
      }
      const end = res.pairs[res.pairs.length - 1][1] + 1;
      if (end > this.cursor) {
        this.cursor = end;
        moved = true;
        this.lastProgress = t;
      }
    }
    this.tentCursor = this.cursor;
    this._enter(t);
    return moved;
  }

  /** 다음 문장으로 넘기기. manual=true면 현재 문장을 '수동 완료'로 표시합니다. */
  next(t, manual = false) {
    const S = this.m.sentences.length;
    const s = this.sentenceOfUnit(this.focus);
    if (s >= S) return false;
    const sen = this.m.sentences[s];
    if (manual) {
      for (let u = sen.u0; u < sen.u1; u++) if (this.status[u] === ST.TODO) this.status[u] = ST.MANUAL;
      if (this.first[s] == null) this.first[s] = this.enter[s] ?? t;
      this.last[s] = t;
    }
    this.cursor = Math.max(this.cursor, sen.u1);
    this.tent.fill(0);
    this.tentCursor = this.cursor;
    this.lastProgress = t;
    this._enter(t);
    if (this.m.sentences[s + 1] && sen.u1 === this.cursor) this.enter[s + 1] = this.enter[s + 1] ?? t;
    return true;
  }

  /** 이전 문장으로 되돌리기 (문장 중간이면 그 문장의 처음으로) */
  prev(t) {
    const s = Math.min(this.sentenceOfUnit(this.cursor), this.m.sentences.length);
    let target;
    if (s < this.m.sentences.length && this.cursor > this.m.sentences[s].u0) target = s;
    else target = Math.max(0, s - 1);
    const u0 = this.m.sentences[target].u0;
    for (let u = u0; u < this.N; u++) this.status[u] = ST.TODO;
    for (let k = target; k < this.m.sentences.length; k++) {
      this.enter[k] = null;
      this.first[k] = null;
      this.last[k] = null;
    }
    this.cursor = u0;
    this.tent.fill(0);
    this.tentCursor = u0;
    this.enter[target] = t;
    this.lastProgress = t;
    return true;
  }

  _enter(t) {
    const s = this.sentenceOfUnit(this.focus);
    for (let k = 0; k <= Math.min(s, this.m.sentences.length - 1); k++) if (this.enter[k] == null) this.enter[k] = t;
  }

  /** 원문 조각의 표시 상태: said / tent / gap(지나쳤지만 인식 안 됨) / todo */
  segState(seg) {
    let said = 0;
    let tent = 0;
    for (let u = seg.u0; u < seg.u1; u++) {
      if (this.status[u] !== ST.TODO) said++;
      else if (this.tent[u]) tent++;
    }
    if (said) return 'said';
    if (tent) return 'tent';
    if (seg.u1 <= this.cursor) return 'gap';
    return 'todo';
  }

  sentenceStats() {
    return this.m.sentences.map((s) => {
      const n = s.u1 - s.u0;
      let said = 0;
      let manual = 0;
      for (let u = s.u0; u < s.u1; u++) {
        if (this.status[u] === ST.SAID) said++;
        else if (this.status[u] === ST.MANUAL) manual++;
      }
      const ratio = n ? (said + manual) / n : 1;
      let status;
      if (manual) status = 'manual';
      else if (s.u0 >= this.cursor && said === 0) status = 'notReached';
      else if (ratio >= 0.7) status = 'ok';
      else if (ratio >= 0.35) status = 'partial';
      else status = 'missed';
      // 다시 보기 동기화는 '그 문장이 현재 문장이 된 시각'을 기준으로 합니다.
      return { id: s.id, ratio, status, tStart: this.enter[s.id] ?? this.first[s.id], tEnd: this.last[s.id] };
    });
  }

  /** 구간마다 처음 들어간 시각 */
  sectionEnter() {
    return this.m.sections.map((sec) => {
      let best = null;
      for (const id of sec.sentenceIds) {
        const v = this.enter[id];
        if (v != null && (best == null || v < best)) best = v;
      }
      return best;
    });
  }
}

/* ───────────── 6. 시간 계산 ───────────── */

/** 구간별 권장 시간. 기본은 음절 수 비례, 직접 정한 구간은 그대로 두고 나머지를 목표 시간에 맞춰 나눕니다. */
export function recommendedSchedule(sectionUnits, targetSec, overrides = {}) {
  const fixed = sectionUnits.map((_, k) => {
    const v = overrides[k];
    return Number.isFinite(v) && v > 0 ? v : null;
  });
  const fixedSum = fixed.reduce((a, v) => a + (v ?? 0), 0);
  const autoUnits = sectionUnits.reduce((a, n, k) => a + (fixed[k] == null ? n : 0), 0);
  const remain = Math.max(0, targetSec - fixedSum);
  let at = 0;
  return sectionUnits.map((n, k) => {
    const dur = fixed[k] ?? (autoUnits ? (remain * n) / autoUnits : 0);
    const seg = { k, start: at, end: at + dur, dur, manual: fixed[k] != null };
    at += dur;
    return seg;
  });
}

/**
 * 말하기 속도(초당 음절) 추정.
 * 처음 15초는 기준 속도와 섞고, 이후에는 누적 평균과 최근 30초 속도를 반씩 씁니다.
 */
export function estimateRate({ t, cursor, history = [], baseline }) {
  const cum = t > 0 ? cursor / t : 0;
  let recent = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].t <= t - 30) {
      const dt = t - history[i].t;
      if (dt > 0) recent = (cursor - history[i].c) / dt;
      break;
    }
  }
  let r;
  if (t < 15) {
    const w = Math.max(0, t / 15);
    r = (1 - w) * baseline + w * (cum || baseline);
  } else if (recent == null) r = cum;
  else r = 0.5 * cum + 0.5 * recent;
  return Math.min(9, Math.max(1.2, r || baseline));
}

/** 구간별 실제 시작·끝 (아직 못 간 구간은 null) */
export function sectionActuals({ sections, sectionEnter, t, cursor }) {
  const K = sections.length;
  let kc = K;
  for (let k = 0; k < K; k++) {
    if (cursor < sections[k].u1) { kc = k; break; }
  }
  const last = Math.min(kc, K - 1);
  const starts = [0];
  for (let k = 1; k <= last; k++) starts[k] = Math.min(t, Math.max(starts[k - 1], sectionEnter[k] ?? t));
  return sections.map((_, k) => {
    if (k > last) return null;
    // 끝까지 말했다면 마지막 구간의 끝은 현재 시각
    return { start: starts[k], end: k < last ? starts[k + 1] : t, done: k < kc };
  });
}

export function compareSection(actual, rec) {
  if (!rec) return 'ok';
  const r = actual / rec;
  if (r < 0.85) return 'fast';
  if (r > 1.15) return 'slow';
  return 'ok';
}

export function classifyDelta(delta) {
  if (delta > 60) return 'over';
  if (delta > 20) return 'warn';
  if (delta < -20) return 'fast';
  return 'ok';
}

export const STATUS_TEXT = { ok: '적정', warn: '조금 늦음', over: '초과 예상', fast: '빠름' };

/**
 * 타임라인 데이터: 권장 막대와 예측 막대를 같은 시간축에 놓습니다.
 * 예측 막대 = 끝낸 구간의 실제 시간 + 현재 구간 경과 + 남은 음절 ÷ 현재 속도
 */
export function timeline({ sections, schedule, sectionEnter, t, cursor, rate, targetSec }) {
  const K = sections.length;
  const N = K ? sections[K - 1].u1 : 0;
  const act = sectionActuals({ sections, sectionEnter, t, cursor });
  let kc = act.findIndex((a) => a && !a.done);
  if (kc < 0) kc = K;
  const pred = [];
  for (let k = 0; k < K; k++) {
    const a = act[k];
    if (a && a.done) pred.push({ k, start: a.start, end: a.end, kind: 'done', cmp: compareSection(a.end - a.start, schedule[k]?.dur) });
  }
  let at = t;
  if (kc < K) {
    pred.push({ k: kc, start: act[kc].start, end: t, kind: 'now' });
    const rem = Math.max(0, sections[kc].u1 - Math.max(cursor, sections[kc].u0));
    pred.push({ k: kc, start: at, end: at + rem / rate, kind: 'proj' });
    at += rem / rate;
    for (let k = kc + 1; k < K; k++) {
      const d = sections[k].n / rate;
      pred.push({ k, start: at, end: at + d, kind: 'proj' });
      at += d;
    }
  }
  const total = kc < K ? at : t;
  const delta = total - targetSec;
  let recNow = schedule.findIndex((s) => t < s.end);
  if (recNow < 0) recNow = K - 1;
  return { rec: schedule, pred, total, delta, status: classifyDelta(delta), kc, recNow, remainingUnits: Math.max(0, N - cursor) };
}

/* ───────────── 7. 금칙어 ───────────── */

export function findForbidden(text, words, dict) {
  if (!words?.length) return [];
  const t = unitString(text, dict);
  if (!t) return [];
  return words.filter((w) => {
    const k = unitString(w, dict);
    return k.length >= 2 && t.includes(k);
  });
}

/* ───────────── 8. 결과 요약 ───────────── */

export function summarize({ stats, durationSec, targetSec, covered, N }) {
  const count = { ok: 0, partial: 0, missed: 0, notReached: 0, manual: 0 };
  for (const s of stats) count[s.status] = (count[s.status] || 0) + 1;
  const spm = durationSec > 0 ? Math.round((covered / durationSec) * 60) : 0;
  return {
    durationSec,
    targetSec,
    delta: durationSec - targetSec,
    spm,
    coverage: N ? covered / N : 0,
    count,
    total: stats.length,
  };
}

/* ───────────── 9. 표시 형식 ───────────── */

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export function fmtDelta(sec) {
  const r = Math.round(sec || 0);
  if (r === 0) return '±0:00';
  return (r > 0 ? '+' : '−') + fmtTime(Math.abs(r));
}

/** "9:30", "570", "9분 30초" → 초 */
export function parseTime(str) {
  const s = String(str ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d+):(\d{1,2})$/);
  if (m) return +m[1] * 60 + +m[2];
  m = s.match(/^(?:(\d+)\s*분)?\s*(?:(\d+)\s*초)?$/);
  if (m && (m[1] || m[2])) return (+m[1] || 0) * 60 + (+m[2] || 0);
  if (/^\d+(\.\d+)?$/.test(s)) return +s;
  return null;
}

export function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ───────────── 10. 음성 인식 결과 정리 ───────────── */

/**
 * 일부 기기(특히 안드로이드)는 새 인식 결과에 앞서 확정한 문장을 통째로 다시 붙여 보냅니다.
 * prev(이번 세션에서 이미 받은 글)로 시작하면 그 뒤에 새로 말한 부분만 돌려줍니다.
 */
export function newPart(prev, txt) {
  const t = String(txt ?? '');
  const p = String(prev ?? '').replace(/\s+/g, '');
  if (!p) return t;
  if (!t.replace(/\s+/g, '').startsWith(p)) return t;
  let need = p.length;
  let i = 0;
  while (i < t.length && need > 0) {
    if (!/\s/.test(t[i])) need--;
    i++;
  }
  return t.slice(i).trim();
}

/* ───────────── 11. 속도 안내 ───────────── */

/** 최근 win초 동안의 말하기 속도(초당 음절). 기록이 짧으면 null */
export function recentRate(history, t, cursor, win = 20) {
  if (!history?.length || t < 8) return null;
  let base = history[0];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].t <= t - win) {
      base = history[i];
      break;
    }
  }
  const dt = t - base.t;
  return dt >= 6 ? Math.max(0, cursor - base.c) / dt : null;
}

export const PACE = {
  measuring: { word: '속도 재는 중', tip: '조금만 말하면 속도를 알려 드려요' },
  slower2: { word: '더 천천히', tip: '이대로면 목표보다 일찍 끝나요' },
  slower: { word: '조금 천천히', tip: '살짝 빠릅니다' },
  good: { word: '속도 좋아요', tip: '이대로 이어 가세요' },
  faster: { word: '조금 빠르게', tip: '살짝 느립니다' },
  faster2: { word: '더 빠르게', tip: '이대로면 목표 시간을 넘겨요' },
  over: { word: '마무리하세요', tip: '목표 시간이 지났습니다' },
  done: { word: '원고 끝', tip: '마무리 인사 후 ■' },
};

/**
 * 지금 속도가 목표 시간에 맞는지 판정합니다.
 * 필요한 속도 = 남은 음절 ÷ 목표까지 남은 시간. 지금 속도 ÷ 필요한 속도 = ratio.
 * ratio 1이면 딱 맞음, 1보다 크면 빠름(천천히), 작으면 느림(빠르게).
 * x는 속도계 바늘 위치(0 느림 ~ 0.5 적정 ~ 1 빠름).
 */
export function paceAdvice({ t, cursor, N, targetSec, nowRate }) {
  const remainUnits = Math.max(0, N - cursor);
  const remainSec = targetSec - t;
  const nowSpm = nowRate > 0 ? Math.round(nowRate * 60) : null;
  if (remainUnits <= 0) return { level: 'done', ratio: 1, x: 0.5, nowSpm, needSpm: null };
  if (remainSec <= 5) return { level: 'over', ratio: 0, x: 0, nowSpm, needSpm: null };
  const need = remainUnits / remainSec;
  const needSpm = Math.round(need * 60);
  if (t < 12 || !(nowRate > 0)) return { level: 'measuring', ratio: null, x: 0.5, nowSpm: null, needSpm };
  const ratio = nowRate / need;
  const level = ratio > 1.2 ? 'slower2' : ratio > 1.08 ? 'slower' : ratio >= 0.92 ? 'good' : ratio >= 0.8 ? 'faster' : 'faster2';
  const x = Math.max(0, Math.min(1, 0.5 + (ratio - 1) / 0.6));
  return { level, ratio, x, nowSpm, needSpm };
}

/** 90 → "1분 30초", 38 → "38초" */
export function humanDuration(sec) {
  const s = Math.round(Math.abs(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (!m) return `${r}초`;
  return r ? `${m}분 ${r}초` : `${m}분`;
}

/** 예측 − 목표 → "목표보다 2분 47초 일찍" / "38초 늦게" / "목표와 거의 같음" */
export function humanDelta(delta) {
  if (Math.abs(delta) < 5) return '목표와 거의 같음';
  return `목표보다 ${humanDuration(delta)} ${delta < 0 ? '일찍' : '늦게'}`;
}
