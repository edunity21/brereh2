// 브라우저 음성 인식(Web Speech API) 래퍼
//
// 오래 연습해도 끊기지 않도록:
// - 세션이 끝나면 곧바로 다시 시작합니다. 오류가 이어지면 조금씩 간격을 늘립니다.
// - PC에서는 한 세션을 45초 넘게 쓰면 말이 끊긴 틈에 새 세션으로 바꿉니다(늦어도 90초).
//   긴 세션은 반응이 느려지거나 멈추는 일이 있어서입니다.
// - 한 번이라도 동작한 뒤에는 스스로 포기하지 않습니다. 탭 없이는 다시 켤 수 없는 상태(blocked)만 알립니다.
// - 앞서 확정한 문장을 다시 붙여 보내는 기기에서는 새로 말한 부분만 넘깁니다.

import { newPart } from './core.js';

const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
const UA = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const IS_MOBILE =
  /Android|iPhone|iPad|iPod|Mobile/i.test(UA) ||
  (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const PERMISSION = new Set(['not-allowed', 'service-not-allowed']);
const TEST = (typeof window !== 'undefined' && window.__bridgeTest) || {};
const ROTATE_AFTER_MS = TEST.rotateAfterMs || 45_000;
const ROTATE_FORCE_MS = TEST.rotateForceMs || 90_000;

export class Speech {
  static supported() {
    return !!SR;
  }

  constructor({ lang = 'ko-KR', onInterim, onFinal, onStatus, onError, onLog } = {}) {
    this.lang = lang;
    this.onInterim = onInterim || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onError = onError || (() => {});
    this.onLog = onLog || (() => {});
    this.want = false;
    this.rec = null;
    this.everWorked = false;
    this.errorStreak = 0;
    this.blocked = false;
    this.restarts = 0;
    this.rotations = 0;
    this.refreshes = 0;
    this.lastResultAt = 0;
    this.rotate = TEST.rotate ?? !IS_MOBILE;
  }

  /** 시작(또는 멈춘 뒤 다시 시작). 사용자 탭 안에서 부르면 아이폰·아이패드에서도 다시 켜집니다. */
  start() {
    if (!SR) return false;
    this.want = true;
    this.blocked = false;
    this.errorStreak = 0;
    clearTimeout(this._timer);
    if (!this.rec) this._spawn();
    return true;
  }

  stop() {
    this.want = false;
    clearTimeout(this._timer);
    clearTimeout(this._rotTimer);
    clearTimeout(this._killTimer);
    const r = this.rec;
    this.rec = null;
    if (r) {
      r.onend = r.onresult = r.onerror = r.onstart = null;
      try { r.abort(); } catch { /* 이미 멈춤 */ }
    }
    this.onStatus('stopped');
  }

  /** 지금 세션을 정리하고 바로 새 세션으로 바꿉니다 (응답이 멈췄을 때). */
  refresh(reason = 'refresh') {
    if (!this.want) return;
    this.refreshes++;
    this.onLog('asr-refresh', reason);
    const r = this.rec;
    if (!r) {
      clearTimeout(this._timer);
      this._spawn();
      return;
    }
    this._end(r, reason);
  }

  _end(r, reason) {
    if (this.rec !== r || r._ending) return;
    r._ending = reason;
    try { r.stop(); } catch { /* 무시 */ }
    // stop()에 응답이 없으면 강제로 끊고 새로 시작
    clearTimeout(this._killTimer);
    this._killTimer = setTimeout(() => {
      if (this.rec !== r) return;
      r.onend = r.onresult = r.onerror = r.onstart = null;
      try { r.abort(); } catch { /* 무시 */ }
      this.rec = null;
      this.onLog('asr-kill', reason);
      this._spawn();
    }, 1500);
  }

  _spawn() {
    if (!this.want || this.rec) return;
    let rec;
    try {
      rec = new SR();
    } catch (err) {
      this._retryLater(err?.name || 'create-failed');
      return;
    }
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    const done = new Set();
    const startedAt = Date.now();
    let sessionText = ''; // 이번 세션에서 받은 확정 글
    let gotResult = false;

    rec.onstart = () => {
      if (this.rec !== rec) return;
      this.onStatus('listening');
      if (this.rotate) {
        clearTimeout(this._rotTimer);
        this._rotTimer = setTimeout(() => {
          this.rotations++;
          this.onLog('asr-rotate', 'force');
          this._end(rec, 'rotate');
        }, ROTATE_FORCE_MS);
      }
    };

    rec.onresult = (e) => {
      if (this.rec !== rec) return;
      const now = Date.now();
      this.lastResultAt = now;
      gotResult = true;
      this.everWorked = true;
      this.errorStreak = 0;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const txt = r?.[0]?.transcript || '';
        if (r.isFinal) {
          if (done.has(i)) continue;
          done.add(i);
          const part = newPart(sessionText, txt);
          sessionText = part !== txt ? txt : (sessionText ? sessionText + ' ' : '') + txt;
          if (part.trim()) this.onFinal(part);
        } else interim += txt;
      }
      interim = newPart(sessionText, interim);
      this.onInterim(interim);
      // PC: 오래 쓴 세션은 말이 끊긴 틈(확정 직후, 잠정 결과 없음)에 새 세션으로 교체
      if (this.rotate && !interim.trim() && now - startedAt > ROTATE_AFTER_MS) {
        this.rotations++;
        this.onLog('asr-rotate', 'pause');
        this._end(rec, 'rotate');
      }
    };

    rec.onerror = (e) => {
      if (this.rec !== rec) return;
      const code = e?.error || 'unknown';
      if (code === 'no-speech' || code === 'aborted') return;
      this.errorStreak++;
      this.onLog('asr-error', code);
      // 처음부터 시작이 안 되는 경우(권한·언어·마이크 충돌)만 포기
      if (!this.everWorked && (PERMISSION.has(code) || code === 'language-not-supported')) return this._giveUp(code, 'fatal');
      if (!this.everWorked && code === 'audio-capture' && this.errorStreak >= 3) return this._giveUp(code, 'fatal');
      // 동작하다가 권한 오류가 이어지면: 탭 없이는 다시 켤 수 없는 상태
      if (PERMISSION.has(code) && this.errorStreak >= 2) return this._giveUp(code, 'blocked');
      this.onError(code, 'transient');
    };

    rec.onend = () => {
      clearTimeout(this._killTimer);
      clearTimeout(this._rotTimer);
      if (this.rec !== rec) return;
      this.rec = null;
      this.onInterim('');
      if (!this.want) return;
      this.restarts++;
      let delay;
      if (rec._ending) delay = 30; // 계획된 교체·새로고침: 바로 다시
      else if (gotResult || this.errorStreak === 0) delay = 120;
      else delay = Math.min(4000, 250 * 2 ** Math.min(4, this.errorStreak));
      if (!rec._ending) this.onStatus('restarting');
      this._timer = setTimeout(() => this._spawn(), delay);
    };

    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      this.rec = null;
      this._retryLater(err?.name || 'start-failed');
    }
  }

  _retryLater(code) {
    this.errorStreak++;
    this.onLog('asr-error', code);
    this.onStatus('restarting');
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._spawn(), Math.min(4000, 400 * this.errorStreak));
  }

  _giveUp(code, kind) {
    this.want = false;
    if (kind === 'blocked') this.blocked = true;
    clearTimeout(this._timer);
    this.onStatus(kind === 'blocked' ? 'blocked' : 'stopped');
    this.onError(code, kind);
  }
}
