// node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as C from '../js/core.js';

const sample = fs.readFileSync(new URL('../sample-script.txt', import.meta.url), 'utf8');
const sampleModel = () => C.buildModel(C.parseScript(sample));

// 결정적 난수 (재현 가능한 인식 오류 흉내)
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** 사람이 말하고 음성 인식이 받아 적은 것처럼 만들기: 띄어쓰기 변형, 일부 음절 누락·오인식 */
function noisy(text, rand, { drop = 0.06, sub = 0.05 } = {}) {
  const chars = [...text.replace(/\s+/g, rand() < 0.5 ? ' ' : '')];
  const out = [];
  for (const ch of chars) {
    const r = rand();
    if (/[가-힣]/.test(ch) && r < drop) continue;
    if (/[가-힣]/.test(ch) && r < drop + sub) out.push('가');
    else out.push(ch);
  }
  return out.join('');
}

test('예시 원고: 구간 10개, 문장 82개로 나뉜다', () => {
  const p = C.parseScript(sample);
  assert.equal(p.sections.length, 10);
  assert.equal(p.sentences.length, 82);
  assert.equal(p.notes.length, 0);
  assert.equal(p.sentences[1].text, '안녕하십니까? 관리번호 ◌번입니다.');
});

test('글머리표 원고: 글머리표 없는 줄은 메모, 구분선 이름은 구간 이름', () => {
  const p = C.parseScript('먼저 인사드리겠습니다.\n=== 인사\n===\n● 안녕하십니까?\n● 보고서를 말씀드리겠습니다.\n=== 도입 ===\n- 교실 하나를 떠올려 주십시오.');
  assert.deepEqual(p.notes, ['먼저 인사드리겠습니다.']);
  assert.equal(p.sections.length, 2);
  assert.equal(p.sections[0].title, '인사');
  assert.equal(p.sections[1].title, '도입');
  assert.equal(p.sentences.length, 3);
  assert.equal(p.sentences[2].text, '교실 하나를 떠올려 주십시오.');
});

test('숫자 읽기', () => {
  assert.equal(C.readNumber('2.57'), '이점오칠');
  assert.equal(C.readNumber('0.71'), '영점칠일');
  assert.equal(C.readNumber('45'), '사십오');
  assert.equal(C.readNumber('10'), '십');
  assert.equal(C.readNumber('1'), '일');
  assert.equal(C.readNumber('2026'), '이천이십육');
  assert.equal(C.readNumber('10000'), '만');
  assert.equal(C.readNumber('1,500'), '천오백');
});

test('발음 사전·영문·숫자 정규화: 원고와 인식 결과가 같은 문자열이 된다', () => {
  const dict = C.parseDictionary(C.DEFAULT_DICTIONARY);
  assert.equal(C.unitString('BRIDGE-AI 스마트교육', dict), C.unitString('브리지 에이아이 스마트 교육', dict));
  assert.equal(C.unitString('A그룹', dict), '에이그룹');
  assert.equal(C.unitString('ME 프로젝트', dict), C.unitString('미 프로젝트', dict));
  assert.equal(C.unitString('2.57에서 3.28로', dict), C.unitString('이 점 오칠에서 삼 점 이팔로', dict));
  assert.equal(C.unitString('45분 안에', dict), '사십오분안에');
  // 다른 영단어 속 글자는 사전으로 바꾸지 않는다 (Paint의 ai ≠ AI)
  assert.equal(C.unitString('Paint', dict), 'paint');
});

test('자막 조각은 원문 글자 범위를 그대로 가리킨다', () => {
  const m = C.buildModel(C.parseScript('「AI로 연결하고」 2.57점'));
  const s = m.sentences[0];
  const rebuilt = s.segs.map((g) => g.text).join('');
  assert.equal(rebuilt, s.text);
  const ai = s.segs.find((g) => g.text === 'AI');
  assert.equal(ai.u1 - ai.u0, 4); // 에이아이
  assert.ok(ai.wordStart);
});

test('추적: 오류 섞인 인식 결과를 순서대로 넣으면 거의 모든 문장이 인식된다', () => {
  const m = sampleModel();
  const tr = new C.Tracker(m);
  const rand = rng(7);
  let t = 0;
  for (const s of m.sentences) {
    t += s.text.length / 5;
    tr.ingestFinal(noisy(s.text, rand), t);
  }
  const stats = tr.sentenceStats();
  const ok = stats.filter((s) => s.status === 'ok').length;
  assert.ok(ok >= 78, `인식된 문장 ${ok}/82`);
  assert.ok(tr.cursor >= m.N - 3);
  assert.equal(stats.filter((s) => s.status === 'missed').length, 0);
});

test('추적: 문장 두 개를 건너뛰면 누락으로 남고 다음 문장에서 다시 따라잡는다', () => {
  const m = sampleModel();
  const tr = new C.Tracker(m);
  let t = 0;
  m.sentences.forEach((s, i) => {
    t += 5;
    if (i === 20 || i === 21) return;
    tr.ingestFinal(s.text, t);
  });
  const st = tr.sentenceStats();
  assert.equal(st[20].status, 'missed');
  assert.equal(st[21].status, 'missed');
  assert.equal(st[22].status, 'ok');
  assert.equal(st[81].status, 'ok');
});

test('추적: 짧고 흔한 표현이 멀리 뒤에 또 나와도 점프하지 않는다', () => {
  const m = sampleModel();
  const tr = new C.Tracker(m);
  tr.ingestFinal(m.sentences[2].text, 5); // 3번째 문장까지 말함
  const before = tr.cursor;
  tr.ingestFinal('다리입니다', 8); // 원고 훨씬 뒤에 여러 번 나오는 말
  assert.ok(tr.cursor - before < 30, `cursor jumped ${tr.cursor - before}`);
});

test('잠정 결과는 임시 표시만 하고, 확정 결과가 와야 확정된다', () => {
  const m = sampleModel();
  const tr = new C.Tracker(m);
  const s = m.sentences[1];
  tr.ingestInterim('안녕하십니까 관리번호', 1);
  assert.equal(tr.cursor, 0);
  assert.ok(tr.tentCursor > s.u0);
  assert.equal(tr.current(), 1);
  tr.ingestFinal('안녕하십니까 관리번호 삼번입니다', 2);
  assert.equal(tr.tentCursor, tr.cursor);
  assert.ok(tr.cursor >= s.u1 - 1);
});

test('수동 넘기기와 되돌리기', () => {
  const m = sampleModel();
  const tr = new C.Tracker(m);
  tr.next(3, true);
  tr.next(8, true);
  assert.equal(tr.current(), 2);
  const st = tr.sentenceStats();
  assert.equal(st[0].status, 'manual');
  assert.equal(st[1].status, 'manual');
  assert.equal(st[2].status, 'notReached');
  tr.prev(9);
  assert.equal(tr.current(), 1);
  assert.equal(tr.sentenceStats()[1].status, 'notReached');
});

test('권장 시간: 음절 비례 배분, 직접 정한 구간은 유지하고 나머지를 다시 나눈다', () => {
  const sch = C.recommendedSchedule([100, 300, 200], 600);
  assert.deepEqual(sch.map((s) => Math.round(s.dur)), [100, 300, 200]);
  const o = C.recommendedSchedule([100, 300, 200], 600, { 1: 240 });
  assert.equal(o[1].dur, 240);
  assert.equal(Math.round(o.reduce((a, s) => a + s.dur, 0)), 600);
  assert.equal(Math.round(o[0].dur), 120);
});

test('속도 추정: 처음엔 기준 속도, 이후엔 실제 속도', () => {
  assert.equal(C.estimateRate({ t: 0, cursor: 0, baseline: 5 }), 5);
  const hist = [];
  for (let t = 0; t <= 60; t++) hist.push({ t, c: t * 4 });
  const r = C.estimateRate({ t: 60, cursor: 240, history: hist, baseline: 5 });
  assert.ok(Math.abs(r - 4) < 0.01);
});

test('타임라인: 예측 종료 = 경과 + 남은 음절 ÷ 속도, 상태 색 판정', () => {
  const m = sampleModel();
  const sch = C.recommendedSchedule(m.sections.map((s) => s.n), 600);
  const half = Math.floor(m.N / 2);
  const enter = m.sections.map((s) => (s.u0 <= half ? (s.u0 / m.N) * 300 : null));
  const tl = C.timeline({ sections: m.sections, schedule: sch, sectionEnter: enter, t: 300, cursor: half, rate: half / 300, targetSec: 600 });
  assert.ok(Math.abs(tl.total - 600) < 1, `total ${tl.total}`);
  assert.equal(tl.status, 'ok');
  const last = tl.pred[tl.pred.length - 1];
  assert.ok(Math.abs(last.end - tl.total) < 0.01);
  // 앞 구간은 실제(done), 현재 구간은 now, 이후는 proj
  assert.ok(tl.pred.some((p) => p.kind === 'done'));
  assert.equal(tl.pred.filter((p) => p.kind === 'now').length, 1);
  const slow = C.timeline({ sections: m.sections, schedule: sch, sectionEnter: enter, t: 300, cursor: half, rate: (half / 300) * 0.7, targetSec: 600 });
  assert.equal(slow.status, 'over');
  assert.equal(C.classifyDelta(-30), 'fast');
  assert.equal(C.classifyDelta(30), 'warn');
});

test('타임라인: 원고를 끝까지 말하면 예측 = 경과 시간', () => {
  const m = sampleModel();
  const sch = C.recommendedSchedule(m.sections.map((s) => s.n), 600);
  const enter = m.sections.map((s) => (s.u0 / m.N) * 420);
  const tl = C.timeline({ sections: m.sections, schedule: sch, sectionEnter: enter, t: 432, cursor: m.N, rate: 5, targetSec: 600 });
  assert.equal(tl.total, 432);
  assert.equal(tl.kc, m.sections.length);
  assert.equal(tl.status, 'fast');
  assert.ok(tl.pred.every((p) => p.kind === 'done'));
});

test('최대 녹화 15분', () => {
  assert.equal(C.MAX_RECORD_SEC, 900);
  assert.deepEqual(C.WARN_AT_SEC, [840, 870]);
});

test('금칙어 감지', () => {
  const dict = C.parseDictionary(C.DEFAULT_DICTIONARY);
  assert.deepEqual(C.findForbidden('저희 승평 중학교에서는', ['승평중', '순천'], dict), ['승평중']);
  assert.deepEqual(C.findForbidden('관리번호 삼번입니다', ['승평중'], dict), []);
});

test('시간 입력·표시', () => {
  assert.equal(C.parseTime('1:30'), 90);
  assert.equal(C.parseTime('2분 5초'), 125);
  assert.equal(C.parseTime('75'), 75);
  assert.equal(C.parseTime(''), null);
  assert.equal(C.fmtTime(605), '10:05');
  assert.equal(C.fmtDelta(-168), '−2:48');
  assert.equal(C.fmtDelta(38), '+0:38');
});

test('반복해서 오는 인식 결과는 새로 말한 부분만 남긴다', () => {
  assert.equal(C.newPart('', '안녕하십니까'), '안녕하십니까');
  assert.equal(C.newPart('안녕하십니까', '안녕하십니까 관리번호 삼번입니다'), '관리번호 삼번입니다');
  assert.equal(C.newPart('안녕 하십니까', '안녕하십니까 관리번호'), '관리번호');
  assert.equal(C.newPart('안녕하십니까', '보고서를 말씀드리겠습니다'), '보고서를 말씀드리겠습니다');
});

test('속도 안내: 필요한 속도와 비교해 천천히·좋아요·빠르게를 알려 준다', () => {
  // 2,163음절을 10분에: 필요한 속도 약 3.6음절/초
  const base = { t: 60, cursor: 216, N: 2163, targetSec: 600 };
  assert.equal(C.paceAdvice({ ...base, nowRate: 3.6 }).level, 'good');
  assert.equal(C.paceAdvice({ ...base, nowRate: 5 }).level, 'slower2'); // 분당 300음절 → 더 천천히
  assert.equal(C.paceAdvice({ ...base, nowRate: 4.0 }).level, 'slower');
  assert.equal(C.paceAdvice({ ...base, nowRate: 3.1 }).level, 'faster');
  assert.equal(C.paceAdvice({ ...base, nowRate: 2.5 }).level, 'faster2');
  assert.equal(C.paceAdvice({ ...base, t: 5, nowRate: 3.6 }).level, 'measuring');
  assert.equal(C.paceAdvice({ ...base, t: 598, nowRate: 3.6 }).level, 'over');
  assert.equal(C.paceAdvice({ ...base, cursor: 2163, nowRate: 3.6 }).level, 'done');
  const good = C.paceAdvice({ ...base, nowRate: 3.6 });
  assert.ok(Math.abs(good.x - 0.5) < 0.02);
  assert.equal(good.needSpm, 216);
});

test('최근 속도와 시간 문구', () => {
  const hist = [];
  for (let t = 0; t <= 40; t++) hist.push({ t, c: t * 3 });
  assert.ok(Math.abs(C.recentRate(hist, 40, 120) - 3) < 0.01);
  assert.equal(C.recentRate(hist, 5, 15), null);
  assert.equal(C.humanDuration(167), '2분 47초');
  assert.equal(C.humanDelta(-167), '목표보다 2분 47초 일찍');
  assert.equal(C.humanDelta(38), '목표보다 38초 늦게');
  assert.equal(C.humanDelta(3), '목표와 거의 같음');
});
