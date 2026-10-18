// 브라우저 음성 인식(Web Speech API) 래퍼
// - 연속 인식이 끊기면 자동으로 다시 시작합니다.
// - 확정 결과(final)와 잠정 결과(interim)를 나눠 전달합니다.

const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

const FATAL = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported']);

export class Speech {
  static supported() {
    return !!SR;
  }

  constructor({ lang = 'ko-KR', onInterim, onFinal, onStatus, onError } = {}) {
    this.lang = lang;
    this.onInterim = onInterim || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onError = onError || (() => {});
    this.want = false;
    this.rec = null;
    this.restarts = 0;
    this.quickEnds = 0;
    this.lastResultAt = 0;
    this.audioCaptureErrors = 0;
  }

  start() {
    if (!SR) return false;
    this.want = true;
    this._spawn();
    return true;
  }

  stop() {
    this.want = false;
    clearTimeout(this._timer);
    const r = this.rec;
    this.rec = null;
    if (r) {
      try { r.onend = null; r.abort(); } catch { /* 이미 멈춤 */ }
    }
    this.onStatus('stopped');
  }

  _spawn() {
    if (!this.want) return;
    const rec = new SR();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    const done = new Set();
    const startedAt = Date.now();

    rec.onstart = () => this.onStatus('listening');
    rec.onresult = (e) => {
      this.lastResultAt = Date.now();
      this.quickEnds = 0;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const txt = r[0]?.transcript || '';
        if (r.isFinal) {
          if (!done.has(i)) {
            done.add(i);
            if (txt.trim()) this.onFinal(txt);
          }
        } else interim += txt;
      }
      this.onInterim(interim);
    };
    rec.onerror = (e) => {
      const code = e.error || 'unknown';
      if (code === 'no-speech' || code === 'aborted') return;
      if (FATAL.has(code)) {
        this.want = false;
        this.onError(code, true);
        return;
      }
      if (code === 'audio-capture') {
        this.audioCaptureErrors++;
        if (this.audioCaptureErrors >= 3) {
          this.want = false;
          this.onError(code, true);
          return;
        }
      }
      this.onError(code, false);
    };
    rec.onend = () => {
      this.onInterim('');
      if (this.rec !== rec) return;
      this.rec = null;
      if (!this.want) {
        this.onStatus('stopped');
        return;
      }
      // 너무 빨리 반복해서 끊기면 조금씩 늦춰 재시작
      if (Date.now() - startedAt < 1500) this.quickEnds++;
      const delay = Math.min(3000, 150 + this.quickEnds * 500);
      this.restarts++;
      this.onStatus('restarting');
      this._timer = setTimeout(() => this._spawn(), delay);
    };

    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      this.rec = null;
      this.onError(err?.name || 'start-failed', false);
      this._timer = setTimeout(() => this._spawn(), 1000);
    }
  }
}
