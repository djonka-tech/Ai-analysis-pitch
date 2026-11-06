/* ============================================================
   engine.js — PitchEngine
   Полностью офлайн-движок анализа питча:
     • акустика речи (тон, тембр, громкость, паузы, темп, уверенность)
     • лингвистика текста (позитив/негатив, слова-паразиты, хеджи, структура)
     • оценки, обратная связь, вопросы уровня Demo Day, отчёт
   Работает в браузере (window.PitchEngine) и в Node (module.exports).
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PitchEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function LEX() {
    if (typeof globalThis !== 'undefined' && globalThis.PitchLexicon) return globalThis.PitchLexicon;
    if (typeof require === 'function') { try { return require('./lexicon.js'); } catch (e) { /* noop */ } }
    throw new Error('PitchLexicon не загружен: подключите lexicon.js до engine.js');
  }

  /* ==================== УТИЛИТЫ ==================== */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const round = (v, d) => { const k = Math.pow(10, d == null ? 1 : d); return Math.round(v * k) / k; };
  const sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
  const mean = (a) => (a.length ? sum(a) / a.length : 0);
  const stdev = (a) => { if (a.length < 2) return 0; const m = mean(a); let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m); return Math.sqrt(s / (a.length - 1)); };
  function median(a) { if (!a.length) return 0; const b = Array.prototype.slice.call(a).sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }
  function percentile(a, p) { if (!a.length) return 0; const b = Array.prototype.slice.call(a).sort((x, y) => x - y); const i = clamp(p, 0, 1) * (b.length - 1); const lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? b[lo] : b[lo] + (b[hi] - b[lo]) * (i - lo); }
  const db = (x) => 20 * Math.log10(Math.max(x, 1e-8));
  const semitones = (f, ref) => 12 * Math.log2(f / (ref || 55));
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const pct = (v) => Math.round(v * 100);

  /* ==================== FFT / DSP ==================== */
  function fftInPlace(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const ur = re[i + k], ui = im[i + k];
          const xr = re[i + k + half], xi = im[i + k + half];
          const vr = xr * cr - xi * ci, vi = xr * ci + xi * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  function hann(n) { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)); return w; }

  /** Butterworth low-pass 2-го порядка (RBJ) */
  function lowpass(x, sr, fc, q) {
    q = q || 0.707;
    const w0 = 2 * Math.PI * fc / sr, cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * q);
    const b0 = (1 - cw) / 2, b1 = 1 - cw, b2 = (1 - cw) / 2;
    const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = (b0 / a0) * x[i] + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }

  function resample(x, srcRate, dstRate) {
    if (Math.abs(srcRate - dstRate) < 1) return x instanceof Float32Array ? x : Float32Array.from(x);
    let y = x;
    if (dstRate < srcRate) y = lowpass(x, srcRate, dstRate * 0.45, 0.707);
    const n = Math.max(1, Math.floor(x.length * dstRate / srcRate));
    const out = new Float32Array(n), ratio = srcRate / dstRate;
    for (let i = 0; i < n; i++) {
      const p = i * ratio, i0 = Math.floor(p), t = p - i0;
      const a = y[i0] || 0, b = (i0 + 1 < y.length) ? y[i0 + 1] : a;
      out[i] = a + (b - a) * t;
    }
    return out;
  }

  /** Нормализованная автокорреляция → частота основного тона */
  function pitchOfFrame(f, sr, fmin, fmax) {
    const n = f.length;
    let m = 0; for (let i = 0; i < n; i++) m += f[i]; m /= n;
    let energy = 0; for (let i = 0; i < n; i++) { const v = f[i] - m; energy += v * v; }
    if (energy < 1e-9) return { f0: 0, r: 0 };
    const lagMin = Math.max(2, Math.floor(sr / fmax)), lagMax = Math.min(n - 3, Math.ceil(sr / fmin));
    const rs = new Float32Array(lagMax + 2);
    let best = -1, bestLag = lagMin;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let num = 0, d1 = 0, d2 = 0;
      for (let i = 0; i + lag < n; i++) { const a = f[i] - m, b = f[i + lag] - m; num += a * b; d1 += a * a; d2 += b * b; }
      const r = num / Math.sqrt(d1 * d2 + 1e-12);
      rs[lag] = r;
      if (r > best) { best = r; bestLag = lag; }
    }
    // защита от субгармоник: берём самый короткий лаг с почти максимальной корреляцией
    let lag = bestLag;
    for (let l = lagMin + 1; l < bestLag; l++) {
      if (rs[l] > rs[l - 1] && rs[l] >= rs[l + 1] && rs[l] >= Math.max(0.85 * best, 0.4)) { lag = l; break; }
    }
    const y0 = rs[lag - 1] || 0, y1 = rs[lag] || 0, y2 = rs[lag + 1] || 0;
    const den = y0 - 2 * y1 + y2;
    const shift = Math.abs(den) > 1e-9 ? clamp(0.5 * (y0 - y2) / den, -0.5, 0.5) : 0;
    const lagRef = lag + shift;
    const f0 = sr / lagRef;
    if (!isFinite(f0) || f0 < fmin || f0 > fmax) return { f0: 0, r: 0 };
    return { f0, r: clamp(y1, 0, 1) };
  }

  /* ==================== АНАЛИЗ РЕЧИ ==================== */
  /**
   * @param {Float32Array} samples моно-сигнал
   * @param {number} sampleRate частота дискретизации
   * @param {object} opts { maxSec, onProgress }
   */
  function analyzeAudio(samples, sampleRate, opts) {
    opts = opts || {};
    const T0 = now();
    const maxSec = opts.maxSec || 600;
    let x = samples;
    if (!(x instanceof Float32Array)) x = Float32Array.from(x);
    const srcDur = x.length / sampleRate;
    if (srcDur > maxSec) x = x.subarray(0, Math.floor(maxSec * sampleRate));
    const durationSec = x.length / sampleRate;
    const progress = (p) => { if (typeof opts.onProgress === 'function') opts.onProgress(p); };

    // 1. Пиковый уровень, клиппинг
    let peak = 0, clipCount = 0;
    for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; if (a > 0.985) clipCount++; }

    // 2. Рабочие частоты
    const sr4 = 4000, sr8 = 8000;
    const x4 = resample(x, sampleRate, sr4);
    const x8 = resample(x, sampleRate, sr8);
    progress(0.12);

    // 3. Кадры энергии на 4 кГц
    const hop4 = 40, frame4 = 128;                       // 10 мс / 32 мс
    const nFrames = Math.max(0, Math.floor((x4.length - frame4) / hop4) + 1);
    const rmsArr = new Float32Array(nFrames), dbArr = new Float32Array(nFrames), zcrArr = new Float32Array(nFrames);
    for (let i = 0; i < nFrames; i++) {
      const s = i * hop4; let e = 0, zc = 0, prev = 0;
      for (let j = 0; j < frame4; j++) { const v = x4[s + j]; e += v * v; if (j > 0 && ((v >= 0) !== (prev >= 0))) zc++; prev = v; }
      const r = Math.sqrt(e / frame4);
      rmsArr[i] = r; dbArr[i] = db(r); zcrArr[i] = zc / frame4;
    }
    const noiseFloorDb = percentile(dbArr, 0.15);
    const loudDb = percentile(dbArr, 0.97);
    // порог речи: на 7 дБ выше шума, но не ближе 12 дБ к громким кадрам
    // (иначе запись без пауз — «сплошная речь» — распознаётся как тишина)
    let thrDb = Math.max(noiseFloorDb + 7, loudDb - 35, -55);
    if (thrDb > loudDb - 12) thrDb = loudDb - 12;
    if (loudDb - noiseFloorDb > 15 && thrDb < noiseFloorDb + 3) thrDb = noiseFloorDb + 3;

    // запись без полезного сигнала (микрофон выключен / файл пустой)
    if (loudDb < -70 || nFrames < 4) {
      return {
        ok: false, noSignal: true, durationSec: round(durationSec, 2), analyzedSec: round(durationSec, 2), trimmed: srcDur > maxSec,
        speechSec: 0, pauseSec: round(durationSec, 2), pauseRatio: 1, speechRatio: 0,
        pauses: { count: 0, list: [], longest: 0, mean: 0, long: 0, notable: 0, short: 0, perMin: 0 },
        f0: { meanHz: 0, medianHz: 0, p5Hz: 0, p95Hz: 0, sdSemitones: 0, rangeSemitones: 0, voicedShare: 0, frames: 0, voiceType: '—' },
        timbre: { centroidHz: 0, centroidSd: 0, rolloffHz: 0, slopeDbOct: 0, hfRatio: 0, zcr: 0, hnrDb: 0, jitterPct: 0, shimmerPct: 0, flux: 0 },
        rate: { syllables: 0, syllablesPerMin: 0, articulationRate: 0, onsetVariabilityMs: 0, estimatedWordsPerMin: 0 },
        prosody: { phrases: 0, up: 0, down: 0, flat: 0, upShare: 0, downShare: 0, flatShare: 0, list: [] },
        loudness: { meanDb: 0, sdDb: 0, p10Db: 0, p90Db: 0, dynRangeDb: 0, peakDb: round(db(peak), 1), clippingPct: 0, noiseFloorDb: round(noiseFloorDb, 1), snrDb: 0 },
        timeline: { t: [], f0st: [], db: [], speech: [] },
        debug: { frames: nFrames, thrDb: round(thrDb, 1), elapsedMs: Math.round(now() - T0) }
      };
    }

    // 4. Маска речи с гистерезисом
    const speech = new Uint8Array(nFrames);
    let above = 0, below = 0;
    for (let i = 0; i < nFrames; i++) {
      if (dbArr[i] > thrDb) { above++; below = 0; if (above >= 2) speech[i] = 1; }
      else { below++; above = 0; if (below < 8 && i > 0) speech[i] = speech[i - 1]; }
    }
    let firstSp = -1, lastSp = -1;
    for (let i = 0; i < nFrames; i++) if (speech[i]) { if (firstSp < 0) firstSp = i; lastSp = i; }
    if (firstSp < 0) { firstSp = 0; lastSp = nFrames - 1; }

    const hopSec = hop4 / sr4;
    const speechSec = sum(speech) * hopSec;
    const spanSec = (lastSp - firstSp + 1) * hopSec;
    const pauseSec = Math.max(0, spanSec - speechSec);
    const speechFrames = [];
    for (let i = 0; i < nFrames; i++) if (speech[i]) speechFrames.push(i);

    // 5. Паузы
    const pauses = [];
    let runStart = -1;
    for (let i = firstSp; i <= lastSp + 1; i++) {
      const silent = (i > lastSp) || !speech[i];
      if (silent && runStart < 0) runStart = i;
      if (!silent && runStart >= 0) {
        const d = (i - runStart) * hopSec;
        if (d >= 0.28 && (i - runStart) >= 4) {
          pauses.push({
            start: round(runStart * hopSec, 2), end: round(i * hopSec, 2), dur: round(d, 2),
            type: d > 1.5 ? 'длинная' : d > 0.8 ? 'заметная' : 'короткая'
          });
        }
        runStart = -1;
      }
    }

    // 6. Тон (F0) на 4 кГц
    const f0len = 160, hopF0 = 40;                       // 40 мс / 10 мс
    const nF0 = Math.max(0, Math.floor((x4.length - f0len) / hopF0) + 1);
    const f0raw = new Float32Array(nF0), rraw = new Float32Array(nF0), ampraw = new Float32Array(nF0);
    const win = hann(f0len), buf = new Float32Array(f0len);
    for (let i = 0; i < nF0; i++) {
      const s = i * hopF0;
      for (let j = 0; j < f0len; j++) buf[j] = x4[s + j] * win[j];
      const p = pitchOfFrame(buf, sr4, 70, 400);
      f0raw[i] = p.f0; rraw[i] = p.r;
      let pk = 0; for (let j = 0; j < f0len; j++) { const a = Math.abs(x4[s + j]); if (a > pk) pk = a; }
      ampraw[i] = pk;
      if (i % 400 === 0) progress(0.12 + 0.5 * (i / Math.max(1, nF0)));
    }

    // медианная фильтрация + отбраковка выбросов
    const f0 = new Float32Array(nF0), voiced = new Uint8Array(nF0);
    for (let i = 0; i < nF0; i++) {
      const w = [];
      for (let k = Math.max(0, i - 2); k <= Math.min(nF0 - 1, i + 2); k++) if (f0raw[k] > 0) w.push(f0raw[k]);
      const med = w.length ? median(w) : 0;
      if (f0raw[i] > 0 && med > 0 && Math.abs(f0raw[i] - med) / med < 0.25) { f0[i] = f0raw[i]; voiced[i] = 1; }
      else if (f0raw[i] > 0 && med > 0 && Math.abs(f0raw[i] - med) / med < 0.5) { f0[i] = med; voiced[i] = 1; }
    }
    const f0vals = [], stVals = [], rvals = [], avals = [];
    for (let i = 0; i < nF0; i++) if (voiced[i]) { f0vals.push(f0[i]); stVals.push(semitones(f0[i])); rvals.push(rraw[i]); avals.push(ampraw[i]); }
    const f0mean = mean(f0vals), f0med = median(f0vals);
    const stSd = stdev(stVals), stLo = percentile(stVals, 0.05), stHi = percentile(stVals, 0.95);
    const voicedShare = nF0 ? f0vals.length / nF0 : 0;

    // джиттер и шиммер (локальные)
    let jSum = 0, jN = 0, sSum = 0, sN = 0;
    for (let i = 1; i < nF0; i++) {
      if (voiced[i] && voiced[i - 1] && (f0[i] > 0) && (f0[i - 1] > 0)) {
        jSum += Math.abs(f0[i] - f0[i - 1]); jN++;
        sSum += Math.abs(ampraw[i] - ampraw[i - 1]); sN++;
      }
    }
    const jitterPct = jN && f0mean ? (jSum / jN) / f0mean * 100 : 0;
    const shimmerPct = sN && mean(avals) ? (sSum / sN) / mean(avals) * 100 : 0;
    const rMean = rvals.length ? clamp(mean(rvals), 0.05, 0.98) : 0.5;
    const hnrDb = 10 * Math.log10(rMean / (1 - rMean));

    progress(0.62);

    // 7. Спектр / тембр на 8 кГц
    const N = 512, hop8 = 160;                            // 64 мс / 20 мс
    const nSpec = Math.max(0, Math.floor((x8.length - N) / hop8) + 1);
    const winS = hann(N), re = new Float64Array(N), im = new Float64Array(N), mag = new Float64Array(N / 2 + 1);
    const centroids = [], rolloffs = [], slopes = [], hfRatios = [], fluxes = [];
    let prevMag = null;
    for (let i = 0; i < nSpec; i++) {
      const tSec = i * hop8 / sr8;
      const fi = Math.round(tSec / hopSec);
      if (fi < nFrames && !speech[fi]) continue;           // считаем только речевые кадры
      const s = i * hop8;
      for (let j = 0; j < N; j++) { re[j] = x8[s + j] * winS[j]; im[j] = 0; }
      fftInPlace(re, im);
      let msum = 0, fsum = 0, hf = 0, cum = 0, flux = 0;
      for (let k = 1; k <= N / 2; k++) {
        const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        mag[k] = m;
        const fk = k * sr8 / N;
        msum += m; fsum += fk * m;
        if (fk > 1000) hf += m;
        if (prevMag) { const d = m - prevMag[k]; if (d > 0) flux += d; }
      }
      prevMag = mag.slice(0);
      if (msum < 1e-6) continue;
      // rolloff 85%
      let acc = 0, roll = 0;
      for (let k = 1; k <= N / 2; k++) { acc += mag[k]; if (acc >= 0.85 * msum) { roll = k * sr8 / N; break; } }
      // наклон спектра, дБ/октава (100..3500 Гц)
      let sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
      for (let k = 1; k <= N / 2; k++) {
        const fk = k * sr8 / N;
        if (fk < 120 || fk > 3500 || mag[k] < 1e-7) continue;
        const xx = Math.log2(fk), yy = 20 * Math.log10(mag[k]);
        sx += xx; sy += yy; sxx += xx * xx; sxy += xx * yy; cnt++;
      }
      const denom = cnt * sxx - sx * sx;
      const slope = cnt > 8 && Math.abs(denom) > 1e-9 ? (cnt * sxy - sx * sy) / denom : -6;
      centroids.push(fsum / msum);
      rolloffs.push(roll);
      slopes.push(slope);
      hfRatios.push(hf / msum);
      fluxes.push(flux / msum);
      if (i % 300 === 0) progress(0.62 + 0.28 * (i / Math.max(1, nSpec)));
    }
    const centroidHz = mean(centroids), centroidSd = stdev(centroids);
    const rolloffHz = mean(rolloffs), slopeDbOct = mean(slopes), hfRatio = mean(hfRatios), flux = mean(fluxes);
    let zcrMean = 0, zcN = 0;
    for (let i = 0; i < nFrames; i++) if (speech[i]) { zcrMean += zcrArr[i]; zcN++; }
    zcrMean = zcN ? zcrMean / zcN : 0;

    progress(0.92);

    // 8. Слоговые ядра → темп речи
    const env = new Float32Array(nFrames);
    for (let i = 0; i < nFrames; i++) {
      let s = 0, c = 0;
      for (let k = Math.max(0, i - 2); k <= Math.min(nFrames - 1, i + 2); k++) { s += rmsArr[k]; c++; }
      env[i] = s / c;
    }
    const envThr = Math.max(percentile(env, 0.5) * 1.05, thrDb === 0 ? 0 : Math.pow(10, thrDb / 20) * 1.6);
    let syll = 0; const onsets = [];
    for (let i = firstSp + 2; i <= lastSp - 2; i++) {
      if (!speech[i] || env[i] < envThr) continue;
      if (env[i] > env[i - 1] && env[i] >= env[i + 1] && env[i] > env[i - 2] && env[i] >= env[i + 2]) {
        let localMin = Infinity;
        for (let k = Math.max(firstSp, i - 7); k <= Math.min(lastSp, i + 7); k++) localMin = Math.min(localMin, env[k]);
        if (db(env[i]) - db(localMin + 1e-9) >= 4) {
          if (!onsets.length || i - onsets[onsets.length - 1] >= 7) { syll++; onsets.push(i); }
        }
      }
    }
    const syllPerMin = durationSec > 1 ? syll / durationSec * 60 : 0;
    const articulationRate = speechSec > 1 ? syll / speechSec * 60 : 0;
    const onsetGaps = [];
    for (let i = 1; i < onsets.length; i++) onsetGaps.push((onsets[i] - onsets[i - 1]) * hopSec * 1000);

    // 9. Мелодика окончаний фраз
    const segs = [];
    let cur = null;
    for (let i = firstSp; i <= lastSp; i++) {
      if (speech[i]) { if (!cur) cur = { start: i, end: i }; else cur.end = i; }
      else if (cur && (i - cur.end) * hopSec > 0.5) { segs.push(cur); cur = null; }
    }
    if (cur) segs.push(cur);
    let up = 0, down = 0, flat = 0;
    const phrases = [];
    for (const sg of segs) {
      const dur = (sg.end - sg.start + 1) * hopSec;
      if (dur < 0.45) continue;
      const tail = [];
      for (let i = Math.max(0, sg.end - 15); i <= sg.end; i++) if (voiced[i]) tail.push({ t: i * hopSec, st: semitones(f0[i]) });
      if (tail.length < 4) continue;
      const tm = mean(tail.map((p) => p.t)), sm = mean(tail.map((p) => p.st));
      let num = 0, den = 0;
      for (const p of tail) { num += (p.t - tm) * (p.st - sm); den += (p.t - tm) * (p.t - tm); }
      const slopeSt = den > 1e-9 ? num / den : 0;
      const kind = slopeSt > 1.8 ? 'восходящая' : slopeSt < -1.8 ? 'нисходящая' : 'ровная';
      if (kind === 'восходящая') up++; else if (kind === 'нисходящая') down++; else flat++;
      phrases.push({ start: round(sg.start * hopSec, 2), end: round((sg.end + 1) * hopSec, 2), dur: round(dur, 2), slopeSt: round(slopeSt, 2), kind });
    }
    const phraseTotal = up + down + flat || 1;

    // 10. Громкость
    const speechDb = [];
    for (let i = 0; i < nFrames; i++) if (speech[i]) speechDb.push(dbArr[i]);
    const loudness = {
      meanDb: round(mean(speechDb), 1),
      sdDb: round(stdev(speechDb), 1),
      p10Db: round(percentile(speechDb, 0.1), 1),
      p90Db: round(percentile(speechDb, 0.9), 1),
      dynRangeDb: round(percentile(speechDb, 0.9) - percentile(speechDb, 0.1), 1),
      peakDb: round(db(peak), 1),
      clippingPct: round(clipCount / Math.max(1, x.length) * 100, 3),
      noiseFloorDb: round(noiseFloorDb, 1),
      snrDb: round(mean(speechDb) - noiseFloorDb, 1)
    };

    // 11. Таймлайн для графиков (~25 к/с)
    const stepFrames = 4;
    const tl = { t: [], f0st: [], db: [], speech: [] };
    const refSt = f0med ? semitones(f0med) : 0;
    for (let i = 0; i < nFrames; i += stepFrames) {
      tl.t.push(round(i * hopSec, 2));
      tl.db.push(round(dbArr[i], 1));
      const j = Math.min(nF0 - 1, Math.round(i * hop4 / hopF0));
      tl.f0st.push(voiced[j] ? round(semitones(f0[j]) - refSt, 2) : null);
      tl.speech.push(speech[i]);
    }

    progress(1);

    return {
      ok: true,
      durationSec: round(durationSec, 2),
      analyzedSec: round(durationSec, 2),
      trimmed: srcDur > maxSec,
      speechSec: round(speechSec, 2),
      pauseSec: round(pauseSec, 2),
      pauseRatio: spanSec > 0 ? round(pauseSec / spanSec, 3) : 0,
      speechRatio: spanSec > 0 ? round(speechSec / spanSec, 3) : 0,
      pauses: {
        count: pauses.length, list: pauses,
        longest: pauses.length ? Math.max.apply(null, pauses.map((p) => p.dur)) : 0,
        mean: pauses.length ? round(mean(pauses.map((p) => p.dur)), 2) : 0,
        long: pauses.filter((p) => p.type === 'длинная').length,
        notable: pauses.filter((p) => p.type === 'заметная').length,
        short: pauses.filter((p) => p.type === 'короткая').length,
        perMin: spanSec > 0 ? round(pauses.length / (spanSec / 60), 1) : 0
      },
      f0: {
        meanHz: round(f0mean, 1), medianHz: round(f0med, 1),
        p5Hz: round(percentile(f0vals, 0.05), 1), p95Hz: round(percentile(f0vals, 0.95), 1),
        sdSemitones: round(stSd, 2), rangeSemitones: round(stHi - stLo, 2),
        voicedShare: round(voicedShare, 3), frames: f0vals.length,
        voiceType: f0med && f0med < 120 ? 'низкий' : f0med && f0med < 175 ? 'средний' : 'высокий'
      },
      timbre: {
        centroidHz: round(centroidHz, 0), centroidSd: round(centroidSd, 0), rolloffHz: round(rolloffHz, 0),
        slopeDbOct: round(slopeDbOct, 2), hfRatio: round(hfRatio, 3), zcr: round(zcrMean, 3),
        hnrDb: round(hnrDb, 1), jitterPct: round(jitterPct, 2), shimmerPct: round(shimmerPct, 2),
        flux: round(flux, 3)
      },
      rate: {
        syllables: syll, syllablesPerMin: round(syllPerMin, 0),
        articulationRate: round(articulationRate, 0),
        onsetVariabilityMs: round(stdev(onsetGaps), 0),
        estimatedWordsPerMin: round(syllPerMin / 2.7, 0)
      },
      prosody: {
        phrases: phrases.length, up, down, flat,
        upShare: round(up / phraseTotal, 3), downShare: round(down / phraseTotal, 3),
        flatShare: round(flat / phraseTotal, 3),
        list: phrases.slice(0, 400)
      },
      loudness,
      timeline: tl,
      debug: { frames: nFrames, thrDb: round(thrDb, 1), elapsedMs: Math.round(now() - T0) }
    };
  }

  /* ==================== АНАЛИЗ ТЕКСТА ==================== */
  const VOWELS = /[аеёиоуыэюяaeiouy]/g;

  function tokenize(text) {
    const out = [];
    const re = /[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9\-]*/g;
    let m;
    while ((m = re.exec(text))) out.push({ w: m[0], norm: m[0].toLowerCase().replace(/ё/g, 'е'), start: m.index, end: m.index + m[0].length });
    return out;
  }
  function splitSentences(text) {
    const parts = [];
    const re = /[^.!?…\n]+[.!?…]*/g;
    let m;
    while ((m = re.exec(text))) {
      const s = m[0].trim();
      if (s) parts.push({ text: s, start: m.index, end: m.index + m[0].length });
    }
    return parts;
  }
  function syllablesIn(word) { const m = word.toLowerCase().match(VOWELS); return Math.max(1, m ? m.length : 1); }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  /** регулярка по основе/фразе: допускает падежные окончания */
  function stemRe(stem) {
    return stem.split(/\s+/).map((w) => {
      const e = escapeRe(w.replace(/ё/g, 'е'));
      if (w.length <= 3) return e + '(?![а-яa-z])';
      return e + '[а-яa-z]{0,4}(?![а-яa-z])';
    }).join('\\s+');
  }
  /** подсветка + подсчёт вхождений по списку основ */
  function collect(text, stems, type, weightOf) {
    const found = new Map(), marks = [];
    const low = text.toLowerCase().replace(/ё/g, 'е');
    for (const stem of stems) {
      const raw = typeof stem === 'string' ? { f: stem, w: 1 } : stem;
      const base = raw.f || raw;
      let re;
      try { re = new RegExp(stemRe(base), 'gi'); } catch (e) { continue; }
      let m, guard = 0;
      while ((m = re.exec(low)) && guard++ < 500) {
        const key = base;
        found.set(key, (found.get(key) || 0) + 1);
        marks.push({ start: m.index, end: m.index + m[0].length, type, word: text.substr(m.index, m[0].length) });
        if (m[0].length === 0) re.lastIndex++;
      }
      void weightOf;
    }
    const list = Array.from(found.entries()).map(([w, c]) => ({ word: w, count: c })).sort((a, b) => b.count - a.count);
    return { list, marks, total: list.reduce((s, i) => s + i.count, 0), unique: list.length };
  }
  function countStems(text, stems) {
    const toks = tokenize(text).map((t) => t.norm);
    let n = 0;
    for (const stem of stems) {
      const base = (typeof stem === 'string' ? stem : stem.f).replace(/ё/g, 'е').toLowerCase();
      if (base.indexOf(' ') >= 0) { n += collect(text, [base], 'x').total; continue; }
      for (const t of toks) if (t.indexOf(base) === 0) n++;
    }
    return n;
  }

  /**
   * @param {string} text транскрипт питча
   * @param {object} ctx { topic, industry, format, durationSec, targetDurationSec, speech }
   */
  const metric = (key,label,stems,quantified,suggestion,question,answer) => ({key:'sector_'+key,label,stems,quantified,suggestion,question,answer,weight:1.2,required:true,sector:true});
  const INDUSTRIES = [
    {key:'it',label:'Технологии и IT',match:/технолог|\bit\b|\bии\b|saas|кибер|данны|софт/i,weights:{solution:1.3,traction:1.4},criteria:[
      metric('quality','Качество и скорость продукта',['точност','ошибок','время ответа','задержк','доступност'],true,'Назовите точность, частоту ошибок, время ответа или доступность продукта и условия замера.','На каких данных измерены точность или скорость и с чем вы сравнивали результат?','Тестовый набор → метрика и число → база сравнения → ограничения.'),
      metric('integration','Внедрение и интеграция',['интеграц','api','миграц','внедрение занимает','подключение занимает'],false,'Объясните, как подключается продукт, какие системы и данные нужны.','Какие интеграции и данные нужны первому клиенту для запуска?','Системы клиента → доступ к данным → этапы подключения → ответственный.'),
      metric('usage','Использование и удержание',['удержан','retention','активных пользовател','dau','mau','отток'],true,'Покажите активных пользователей, удержание или отток за определённый период.','Сколько пользователей возвращаются и какой период наблюдения это подтверждает?','Когорта → период → активность или удержание → что улучшили.') ]},
    {key:'finance',label:'Финансы и страхование',match:/финанс|финтех|страхован|платеж|платёж|банк/i,weights:{risks:1.3,business:1.3},required:['risks'],criteria:[
      metric('operation','Экономика финансовой операции',['стоимость транзакц','комисси','доход на операц','убыточност','стоимость выплат'],true,'Назовите доход и затраты на одну операцию, полис или клиента.','Какова экономика одной операции с учётом комиссий, потерь и обслуживания?','Доход на операцию → переменные затраты → потери → итоговая маржа.'),
      metric('loss','Управление финансовым риском',['просрочк','дефолт','мошеннич','финансовые потер','доля выплат'],true,'Покажите измеряемый риск: просрочку, мошенничество, потери или страховые выплаты.','Как измеряется финансовый риск и каковы результаты проверки модели риска?','Вид риска → выборка → метрика → ограничения → меры контроля.'),
      metric('compliance','Данные и требования к работе',['лиценз','регулятор','персональн','защита данных','согласие клиент'],false,'Объясните, какие данные и разрешения нужны для вашего сценария.','Какие данные и разрешения необходимы для запуска финансового продукта?','Сценарий → данные → необходимые проверки и разрешения → ответственный.') ]},
    {key:'education',label:'Образование и карьера',match:/образован|edtech|карьер|hr|обучен/i,weights:{traction:1.5,problem:1.2},criteria:[
      metric('learning','Измеримый результат обучения или найма',['успеваем','балл','результат обучен','трудоустрой','время найма','прирост знаний'],true,'Покажите, как изменились знания, результат обучения, трудоустройство или время найма.','Какой результат получает учащийся или кандидат и как вы отделяете его от внешних факторов?','Исходный уровень → результат → период → сравнение → ограничения.'),
      metric('completion','Завершение и возвращаемость',['завершили курс','доходимост','завершение курс','удержан','повторное обучен'],true,'Назовите долю завершивших обучение или удержание учащихся за период.','Какая доля участников завершает программу и почему остальные уходят?','Число участников → завершение → причины ухода → проверенные изменения.'),
      metric('payer','Плательщик и канал внедрения',['платит родител','платит школ','заказчик','работодател','лицензия для школ','платит компани'],false,'Уточните, кто покупает продукт: учащийся, родитель, школа или работодатель.','Кто платит за результат и как вы выходите на этого заказчика?','Пользователь → плательщик → решение о покупке → канал продаж.') ]},
    {key:'health',label:'Здоровье и медицина',match:/здоров|медицин|medtech|фарма|биотех/i,weights:{risks:1.4,traction:1.5},required:['risks'],criteria:[
      metric('clinical','Проверка медицинского результата',['чувствительност','специфичност','эффективност','клинический результат','точность диагност'],true,'Назовите метрику результата, выборку и условия исследования.','Какими исследованиями подтверждён медицинский результат и каковы ограничения выборки?','Дизайн исследования → выборка → метрика → сравнение → ограничения.'),
      metric('registration','Путь проверки и допуска',['регистрац','клиническ','испытан','медицинское изделие','сертификац'],false,'Опишите стадию испытаний и проверки применимости продукта к заявленному сценарию.','На какой стадии проверки и допуска находится продукт и что ещё предстоит подтвердить?','Назначение продукта → текущая стадия → недостающие проверки → план.'),
      metric('workflow','Использование в работе врача или клиники',['врач','клиник','маршрут пациент','медицинский процесс'],false,'Покажите место продукта в работе врача или клиники и ответственность за решение.','Как продукт встраивается в работу клиники и кто принимает окончательное решение?','Пользователь → шаг процесса → ответственность → работа при ошибке.') ]},
    {key:'retail',label:'Торговля и услуги',match:/торгов|услуг|ритейл|retail|e-com|маркетплейс/i,weights:{business:1.4,traction:1.4},criteria:[
      metric('sales','Экономика продажи',['средний чек','марж','конверси','стоимость заказ'],true,'Укажите средний чек, конверсию или маржу после переменных расходов.','Сколько вы зарабатываете на заказе после привлечения и обслуживания клиента?','Чек → себестоимость → привлечение → обслуживание → маржа.'),
      metric('repeat','Повторные покупки',['повторн','удержан','возвращаем','частота покуп'],true,'Покажите долю повторных покупок или частоту возвращения клиентов.','Какая доля клиентов покупает повторно и за какой период?','Когорта → период → повторная покупка → причина возвращения.'),
      metric('service','Качество обслуживания',['возврат','время обслуживан','отмен','жалоб','время доставк'],true,'Укажите возвраты, отмены, жалобы или время обслуживания.','Что происходит с возвратами, отменами и качеством сервиса при росте заказов?','Объём заказов → метрика качества → затраты на исправления → план роста.') ]},
    {key:'production',label:'Производство и промышленность',match:/производств|промышлен|робот/i,weights:{solution:1.3,traction:1.5},criteria:[
      metric('output','Эффект на производственной линии',['брак','простой','производительност','выпуск','oee'],true,'Покажите изменение брака, простоя или производительности на линии.','Как изменились выпуск, брак или простой в пилоте на реальном производстве?','Линия → исходный уровень → результат → срок измерения.'),
      metric('payback','Затраты и окупаемость внедрения',['окупаем','капитальн','затраты на внедрен','стоимость внедрен'],true,'Назовите полную стоимость внедрения и срок окупаемости.','Какова полная стоимость внедрения с остановками, обучением и обслуживанием?','Оборудование → интеграция → простой → обслуживание → окупаемость.'),
      metric('safety','Совместимость и безопасность',['безопасност','сертификац','совместим','техническое обслуживан'],false,'Опишите требования к линии, безопасности и обслуживанию.','Какие ограничения по безопасности и совместимости проверены на площадке?','Условия площадки → проверки → ограничения → план обслуживания.') ]},
    {key:'logistics',label:'Транспорт и логистика',match:/транспорт|логист|склад|доставк/i,weights:{traction:1.5,business:1.2},criteria:[
      metric('time','Сроки и пропускная способность',['время доставк','время приемк','время приёмк','за минут','за секунд','час','срок доставк'],true,'Назовите время операции или объём потока до и после внедрения.','На каком объёме и маршруте подтверждено сокращение времени операции?','Маршрут или склад → поток → время до и после → период пилота.'),
      metric('cost','Стоимость логистической операции',['стоимость доставк','рублей за','себестоим','эконом','затрат'],true,'Покажите стоимость доставки, рейса или обработки единицы груза.','Какова экономия на одной доставке или единице груза с учётом внедрения?','Единица расчёта → исходные затраты → новые затраты → объём → окупаемость.'),
      metric('reliability','Ошибки, потери и выполнение сроков',['ошиб','потер','точност','в срок','поврежден','повреждён'],true,'Назовите долю ошибок, потерь или доставок в срок.','Как изменились ошибки, потери или выполнение сроков в пилоте?','База сравнения → метрика качества → объём проверки → ограничения.') ]},
    {key:'construction',label:'Строительство и недвижимость',match:/строител|недвижим|proptech/i,weights:{risks:1.2,business:1.3},criteria:[
      metric('budget','Сроки и бюджет объекта',['срок строител','смет','бюджет объект','стоимость квадрат','эконом'],true,'Назовите влияние на срок, смету или стоимость единицы площади.','Как подтверждено влияние на сроки или смету конкретного объекта?','Тип объекта → исходный план → результат → способ проверки.'),
      metric('demand','Подтверждённый спрос',['сдел','продаж','аренд','заявк','загрузк'],true,'Покажите сделки, заявки, продажи или загрузку объекта.','Какие реальные сделки или заявки подтверждают спрос?','Объект → сегмент клиента → заявки → сделки → срок цикла.'),
      metric('permits','Документы и ограничения внедрения',['разрешен','разрешён','проектная документац','согласован','строительные норм'],false,'Опишите необходимые согласования и ограничения применения.','Какие согласования и ограничения могут задержать применение решения?','Сценарий → документы → текущий статус → зависимость → план.') ]},
    {key:'energy',label:'Энергетика и экология',match:/энерг|эколог|климат|переработ/i,weights:{traction:1.5,risks:1.1},criteria:[
      metric('resource','Измеримый ресурсный эффект',['квт','киловатт','потреблен','потреблён','экономия энерг','экономия вод'],true,'Покажите экономию энергии, воды или другого ресурса и период измерения.','На какой базе измерена экономия ресурса и как учтены условия эксплуатации?','Объект → исходное потребление → результат → сезонность и условия.'),
      metric('impact','Экологический эффект',['выброс','co2','отход','переработ','углерод'],true,'Укажите изменение выбросов или отходов и метод расчёта.','Как рассчитано сокращение выбросов или отходов и кто может проверить расчёт?','Граница расчёта → исходные данные → эффект → метод проверки.'),
      metric('economics','Экономика эксплуатации',['окупаем','тариф','затраты на обслуживан','себестоим'],true,'Назовите тариф, расходы на эксплуатацию и срок окупаемости.','При каких тарифах и затратах проект окупается?','Стоимость внедрения → эксплуатация → тариф → окупаемость → чувствительность.') ]},
    {key:'agri',label:'Сельское хозяйство и питание',match:/сельск|питан|агро|agri|food|общепит/i,weights:{traction:1.4,business:1.3},criteria:[
      metric('yield','Выход продукции и потери',['урожайн','выход продук','потер','списан','тонн','килограмм'],true,'Покажите выход продукции, урожайность, потери или списания.','На каком сезоне или объёме подтверждено изменение выхода продукции?','Условия → объём → исходный выход или потери → результат.'),
      metric('unit','Себестоимость единицы',['себестоим','марж','стоимость порц','рублей за','стоимость килограмм'],true,'Назовите себестоимость единицы продукции и маржу с учётом потерь.','Как меняется себестоимость с учётом сырья, логистики и сезонности?','Единица продукции → сырьё → производство → логистика → потери → маржа.'),
      metric('quality','Безопасность и качество продукции',['безопасност','санитар','ветеринар','контроль качеств','срок годност'],false,'Опишите контроль качества, условия хранения и применимые проверки.','Как организованы контроль качества и безопасность продукции?','Проверяемый риск → этап контроля → ответственный → действия при отклонении.') ]},
    {key:'media',label:'Медиа, культура и развлечения',match:/медиа|культур|развлеч|игр|контент|реклам|маркетинг/i,weights:{traction:1.5,business:1.2},criteria:[
      metric('audience','Вовлечённость и возвращаемость',['удержан','просмотр','вовлечен','вовлечён','возвращаем','аудитор'],true,'Покажите вовлечённость, просмотры или возвращаемость за период.','Какая метрика показывает, что аудитория возвращается, а не приходит один раз?','Когорта → период → возвращаемость → органический и платный трафик.'),
      metric('monetization','Доход от аудитории',['arpu','доход на пользовател','подписк','реклам','средний чек'],true,'Назовите доход на пользователя, подписку или рекламный контракт.','Как аудитория превращается в доход и сколько стоит её привлечение?','Источник дохода → доход на клиента → привлечение → удержание → маржа.'),
      metric('rights','Права на контент и распространение',['авторск','правообладател','лиценз','права на контент','дистрибуц'],false,'Объясните права на контент и каналы его распространения.','Кому принадлежат права на контент и от каких площадок вы зависите?','Правообладатель → разрешения → канал → зависимость → альтернативы.') ]},
    {key:'social',label:'Государство и социальные проекты',match:/государств|социальн|госсектор|govtech/i,weights:{problem:1.4,traction:1.5,risks:1.1},social:true,criteria:[
      metric('reach','Охват целевой группы',['благополучател','получател','охват','участник','человек'],true,'Назовите целевую группу, её размер и фактический охват.','Скольким людям из целевой группы проект уже помог и как это подтверждено?','Целевая группа → потребность → охват → подтверждение результата.'),
      metric('effect','Измеримый социальный эффект',['социальный эффект','снизил','сократил','улучшил','доля','результат'],true,'Покажите изменение состояния целевой группы до и после проекта.','Как вы измеряете изменение жизни получателей помощи, а не только число мероприятий?','Исходное состояние → показатель результата → период → способ проверки.'),
      metric('funding','Финансирование и устойчивость',['бюджет','грант','донор','софинансирован','госзаказ','финансирован'],false,'Объясните источник финансирования, срок поддержки и план устойчивости.','Кто финансирует проект и что будет после окончания текущей поддержки?','Источник → срок → расходы на получателя → обязательства → продолжение.') ]}
  ];

  function getIndustryProfile(industry) {
    const value=String(industry||'').trim();
    const profile=INDUSTRIES.find(x=>x.match.test(value));
    return profile || {key:'general',label:value||'Общие критерии',criteria:[],weights:{}};
  }


  function analyzeText(text, ctx) {
    const L = LEX();
    ctx = ctx || {};
    const clean = (text || '').trim();
    const tokens = tokenize(clean);
    const sentences = splitSentences(clean);
    const words = tokens.length;
    const wordLowers = tokens.map((t) => t.norm);
    const sentLens = sentences.map((s) => tokenize(s.text).length).filter((n) => n > 0);
    const syllTotal = tokens.reduce((s, t) => s + syllablesIn(t.norm), 0);
    const asl = sentLens.length ? mean(sentLens) : 0;
    const asw = words ? syllTotal / words : 0;
    const flesch = words && sentLens.length ? 206.835 - 1.3 * asl - 60.1 * asw : 0;

    const pos = collect(clean, L.POSITIVE, 'pos');
    const neg = collect(clean, L.NEGATIVE, 'neg');
    const fil = collect(clean, L.FILLERS.map((f) => f), 'filler');
    const hed = collect(clean, L.HEDGES.map((h) => h), 'hedge');
    const boo = collect(clean, L.BOOSTERS, 'booster');
    const cli = collect(clean, L.CLICHES, 'cliche');

    // позитив/негатив с учётом веса
    const posWeighted = L.POSITIVE.reduce((s, f) => s + (pos.list.find((x) => x.word === f) ? pos.list.find((x) => x.word === f).count : 0), 0);
    const filWeighted = L.FILLERS.reduce((s, f) => { const hit = fil.list.find((x) => x.word === f.f); return s + (hit ? hit.count * f.w : 0); }, 0);
    const hedWeighted = L.HEDGES.reduce((s, f) => { const hit = hed.list.find((x) => x.word === f.f); return s + (hit ? hit.count * f.w : 0); }, 0);

    // цифры и факты
    const numRe = /(?:\d+[.,]?\d*\s*(?:%|₽|руб|р\.|млн|млрд|тыс|к\b|раз|х|икс|секунд|минут|час|балл|процент|квт|киловатт|тонн|килограмм|пользовател\w*|клиент\w*|месяц\w*|год\w*|дн\w*|человек\w*|штук\w*))|(?:[хx×]\s?\d+[.,]?\d*)|(?:\d+[.,]?\d*\s?(?:в|во)\s?\d+)/gi;
    const numbers = (clean.match(numRe) || []);
    const anyDigits = (clean.match(/\d+/g) || []);
    const factDensity = words ? numbers.length / words * 100 : 0;

    // предложения с цифрами
    const sentWithNum = sentences.filter((s) => /\d/.test(s.text)).length;

    // Core structure plus sector-specific criteria. Quantified criteria need a
    // matching metric and a number in the same sentence, not elsewhere in the pitch.
    const industryProfile=getIndustryProfile(ctx.industry);
    const definitions=L.STRUCTURE.map(block=>{
      const b={...block,weight:industryProfile.weights?.[block.key]||block.weight};
      if(['market','business','traction','ask'].includes(b.key))b.quantified=true;
      if(industryProfile.required?.includes(b.key))b.required=true;
      if(industryProfile.social && b.key==='market'){
        b.quantified=false;
        b.label='Масштаб задачи и целевая группа';b.stems=['целевая групп','благополучател','получател','масштаб','охват','потребност'];
        b.suggestion='Назовите целевую группу, её размер, подтверждённую потребность и доступный охват.';
      }
      if(industryProfile.social && b.key==='business'){
        b.quantified=false;
        b.label='Финансирование и устойчивость';b.stems=['бюджет','грант','донор','софинансирован','финансирован','госзаказ'];
        b.suggestion='Покажите источник финансирования, расходы и продолжение проекта после текущей поддержки.';
      }
      return b;
    }).concat(industryProfile.criteria);
    const structure=definitions.map(b=>{
      const hit=collect(clean,b.stems,'block');
      const relevant=hit.marks.filter(mark=>sentences.some(sentence=>mark.start>=sentence.start && mark.start<sentence.end && (!b.quantified || /\d/.test(clean.slice(Math.max(sentence.start,mark.start-50),Math.min(sentence.end,mark.end+70))))));
      const supported=sentences.filter(sentence=>relevant.some(mark=>mark.start>=sentence.start && mark.start<sentence.end));
      const found=(b.sector||b.quantified) ? supported.length>0 : hit.total>0;
      const marks=(b.sector||b.quantified) ? relevant : hit.marks;
      return {key:b.key,label:b.label,weight:b.weight,required:!!b.required,sector:!!b.sector,quantified:!!b.quantified,found,hits:hit.total,
        evidence:(b.sector||b.quantified)?relevant.slice(0,2).map(mark=>clean.slice(Math.max(0,mark.start-60),Math.min(clean.length,mark.end+90)).trim()):hit.list.slice(0,6).map(x=>x.word),suggestion:b.suggestion,hooks:b.hooks||[],marks};
    });

    // ключевые термины (частотные, без стоп-слов)
    const stop = new Set(L.STOPWORDS.map((s) => s.replace(/ё/g, 'е')));
    const freq = new Map();
    for (const w of wordLowers) {
      if (w.length < 4 || stop.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
    const keywords = Array.from(freq.entries()).filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]).slice(0, 25)
      .map(([word, count]) => ({ word, count }));

    // негатив по позиции (в начале — это описание проблемы, это нормально)
    const third = Math.max(1, Math.floor(clean.length * 0.33));
    const negEarly = neg.marks.filter((m) => m.start < third).length;

    const longSentences = sentences.filter((s) => tokenize(s.text).length > 24);
    const wpmFromAudio = words > 0 && ctx.speech && !ctx.speech.trimmed && ctx.speech.durationSec > 3 ? round(words / (ctx.speech.durationSec / 60), 0) : null;
    const wpmFromDuration = !ctx.speech && ctx.durationSec > 3 && words ? round(words / (ctx.durationSec / 60), 0) : null;

    return {
      hasText: words > 0,
      industryProfile:{key:industryProfile.key,label:industryProfile.label,criteria:industryProfile.criteria.map(x=>x.key)},
      chars: clean.length, words, sentences: sentences.length, uniqueWords: new Set(wordLowers).size,
      avgSentenceLen: round(asl, 1), maxSentenceLen: sentLens.length ? Math.max.apply(null, sentLens) : 0,
      syllables: syllTotal, flesch: round(flesch, 1),
      readability: flesch >= 60 ? 'легко воспринимается на слух' : flesch >= 45 ? 'средняя сложность' : 'тяжело для восприятия на слух',
      lexicalDiversity: words ? round(new Set(wordLowers).size / words, 3) : 0,
      positive: { total: pos.total, unique: pos.unique, list: pos.list.slice(0, 40), marks: pos.marks, density: words ? round(pos.total / words * 100, 2) : 0, weighted: posWeighted },
      negative: { total: neg.total, unique: neg.unique, list: neg.list.slice(0, 40), marks: neg.marks, density: words ? round(neg.total / words * 100, 2) : 0, earlyShare: neg.total ? round(negEarly / neg.total, 2) : 0 },
      fillers: { total: fil.total, unique: fil.unique, list: fil.list, marks: fil.marks, per100: words ? round(fil.total / words * 100, 2) : 0, perMin: ctx.speech && ctx.speech.speechSec > 3 ? round(fil.total / (ctx.speech.speechSec / 60), 1) : null, weighted: filWeighted },
      hedges: { total: hed.total, unique: hed.unique, list: hed.list, marks: hed.marks, per100: words ? round(hed.total / words * 100, 2) : 0, weighted: hedWeighted },
      boosters: { total: boo.total, unique: boo.unique, list: boo.list, marks: boo.marks, per100: words ? round(boo.total / words * 100, 2) : 0 },
      cliches: { total: cli.total, unique: cli.unique, list: cli.list, marks: cli.marks, per100: words ? round(cli.total / words * 100, 2) : 0 },
      facts: { numbers: numbers.length, digits: anyDigits.length, density: round(factDensity, 2), sentencesWithNumbers: sentWithNum, examples: numbers.slice(0, 12) },
      structure,
      structureCoverage: round(structure.filter((s) => s.found).reduce((a, b) => a + b.weight, 0) / structure.reduce((a, b) => a + b.weight, 0), 3),
      missing: structure.filter((s) => !s.found).map((s) => ({ key: s.key, label: s.label, required: s.required, sector: s.sector, quantified: s.quantified, suggestion: s.suggestion })),
      longSentences: longSentences.slice(0, 6).map((s) => s.text),
      keywords,
      sentencesList: sentences.map((s) => s.text),
      tempo: { wordsPerMin: wpmFromAudio || wpmFromDuration, source: wpmFromAudio ? 'по расшифровке и полной длительности, включая паузы' : (wpmFromDuration ? 'заданная длительность' : null) }
    };
  }

  /* ==================== ПОДСВЕТКА ТЕКСТА ==================== */
  function highlightSpans(textAnalysis, extraMarks) {
    const all = []
      .concat((extraMarks || []))
      .concat(textAnalysis.positive.marks, textAnalysis.negative.marks, textAnalysis.fillers.marks,
        textAnalysis.hedges.marks, textAnalysis.cliches.marks, textAnalysis.boosters.marks);
    all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const out = [];
    let last = -1;
    for (const m of all) {
      if (m.start >= last && m.end > m.start) { out.push(m); last = m.end; }
    }
    return out;
  }

  /* ==================== ОЦЕНКИ ==================== */
  function bandScore(v, lo, hi, softness) {
    // 100 внутри [lo,hi], плавное падение за границами
    if (v >= lo && v <= hi) return 100;
    const s = softness || Math.max(1, (hi - lo) / 2);
    const d = v < lo ? lo - v : v - hi;
    return Math.round(clamp(100 * Math.exp(-Math.pow(d / s, 2)), 0, 100));
  }

  function scoreText(t) {
    const axes = [];
    const req = t.structure.filter((s) => s.required);
    const reqCoverage = req.length ? req.filter((s) => s.found).length / req.length : 0;
    const structureScore = Math.round(100 * (0.65 * t.structureCoverage + 0.35 * reqCoverage));
    axes.push({
      key: 'structure', label: 'Структура питча', score: structureScore, group: 'text',
      detail: `Блоков раскрыто: ${t.structure.filter((s) => s.found).length} из ${t.structure.length}. Обязательных: ${req.filter((s) => s.found).length} из ${req.length}.`,
      notes: t.missing.filter((m) => m.required).map((m) => `Нет блока «${m.label}»`)
    });

    const fd = t.facts.density;
    const factPart = bandScore(fd, 1.5, 8, 1.6);
    const hedgePart = Math.round(clamp(100 - t.hedges.per100 * 45, 0, 100));
    const boostPart = Math.round(clamp(t.boosters.per100 / 1.5 * 100, 0, 100));
    const specPart = t.sentences ? Math.round(t.facts.sentencesWithNumbers / t.sentences * 100) : 0;
    const persuasion = Math.round(0.3 * factPart + 0.25 * hedgePart + 0.15 * boostPart + 0.2 * specPart + 0.1 * Math.round(clamp(t.positive.density / 3 * 100, 0, 100)));
    axes.push({
      key: 'persuasion', label: 'Убедительность и конкретика', score: persuasion, group: 'text',
      detail: `Цифр и метрик: ${t.facts.numbers} (${fd} на 100 слов). Хеджей: ${t.hedges.total}. Утверждений-усилителей: ${t.boosters.total}.`,
      notes: fd < 1.5 ? ['Мало измеримых фактов: жюри запомнит эмоции, а не результат'] : []
    });

    const clarParts = [
      100 - clamp(t.fillers.per100 * 55, 0, 70),
      bandScore(t.avgSentenceLen, 8, 20, 8),
      100 - clamp(t.cliches.per100 * 35, 0, 60),
      bandScore(t.flesch, 45, 75, 18)
    ];
    const clarity = Math.round(0.35 * clarParts[0] + 0.25 * clarParts[1] + 0.2 * clarParts[2] + 0.2 * clarParts[3]);
    axes.push({
      key: 'clarity', label: 'Ясность и чистота языка', score: clarity, group: 'text',
      detail: `Слов-паразитов: ${t.fillers.total} (${t.fillers.per100} на 100 слов). Средняя длина предложения: ${t.avgSentenceLen} слов. Штампов: ${t.cliches.total}. Индекс читаемости: ${t.flesch} (${t.readability}).`,
      notes: t.fillers.per100 > 1.5 ? ['Много слов-паразитов: они крадут время и вес фраз'] : []
    });

    // позитивный язык: доля позитива и уместность негатива
    const posCount = t.positive.total, negCount = t.negative.total;
    const ratio = posCount + negCount ? posCount / (posCount + negCount) : 0.5;
    let positivity = Math.round(clamp(40 + ratio * 70, 0, 100));
    if (t.positive.density >= 2.5) positivity = Math.min(100, positivity + 8);
    if (negCount && t.negative.earlyShare >= 0.6) positivity = Math.min(100, positivity + 6); // негатив про проблему — это хорошо
    if (t.negative.density > t.positive.density) positivity = Math.max(0, positivity - 12);
    axes.push({
      key: 'positivity', label: 'Позитивный язык', score: positivity, group: 'text',
      detail: `Позитивных слов: ${posCount} (${t.positive.density} на 100 слов), негативных: ${negCount} (${t.negative.density}). ${negCount && t.negative.earlyShare >= 0.6 ? 'Большая часть негатива — в описании проблемы, это уместно.' : ''}`,
      notes: t.positive.density < 1.5 ? ['Добавьте язык результата: «растёт», «дешевле», «быстрее» — с цифрой'] : []
    });

    // готовность к вопросам
    const critical = ['market', 'business', 'traction', 'competition', 'team', 'ask'];
    const critFound = t.structure.filter((s) => critical.indexOf(s.key) >= 0 && s.found).length;
    let qReady = Math.round(critFound / critical.length * 70 + clamp(t.facts.numbers / 8, 0, 1) * 30);
    if (t.structure.find((s) => s.key === 'risks' && s.found)) qReady = Math.min(100, qReady + 5);
    const sector=t.structure.filter(x=>x.sector);
    if(sector.length)qReady=Math.round(qReady*.7+sector.filter(x=>x.found).length/sector.length*30);
    axes.push({
      key: 'qready', label: 'Полнота аргументов', score: qReady, group: 'text',
      detail: `Ключевых блоков для вопросов раскрыто: ${critFound} из ${critical.length}. Цифр в тексте: ${t.facts.numbers}.`,
      notes: critFound < critical.length ? ['Пробелы в блоках ' + t.structure.filter((s) => critical.indexOf(s.key) >= 0 && !s.found).map((s) => '«' + s.label + '»').join(', ') + ' почти гарантируют вопросы жюри'] : []
    });
    return axes;
  }

  function describeTempo(s, t) {
    if (t?.tempo.wordsPerMin) return `${t.tempo.wordsPerMin} слов/мин — по расшифровке и длительности записи, включая паузы`;
    return `Приблизительно ${s.rate.estimatedWordsPerMin} слов/мин — оценка по звуковым импульсам, без распознавания слов. Для точного подсчёта добавьте полную расшифровку.`;
  }

  function scoreSpeech(s, t) {
    const axes = [];
    if (!s) return axes;
    const f = s.f0, ti = s.timbre, lo = s.loudness, r = s.rate, p = s.pauses, pr = s.prosody;

    // Expressiveness measures vocal variation, not filler vocabulary, pace or
    // frame-to-frame jitter. Those belong to separate axes and feedback.
    const pace = (t && t.tempo.wordsPerMin) || r.estimatedWordsPerMin;
    const intonationScore=clamp(100*Math.min(f.sdSemitones/1.8,1)-Math.max(0,f.sdSemitones-5)*8,0,100);
    const dynamicsScore=bandScore(lo.dynRangeDb,6,24,10);
    let confidence=Math.round(.75*intonationScore+.25*dynamicsScore);
    if(f.sdSemitones<.6)confidence=Math.min(confidence,45);
    else if(f.sdSemitones<1.2)confidence=Math.min(confidence,60);
    const cNotes=[];
    if(f.sdSemitones<1.4)cNotes.push('Интонация меняется мало: выделите голосом главный результат и запрос.');
    if(f.sdSemitones>5)cNotes.push('Большие перепады тона: проверьте, помогают ли они выделить важные мысли.');
    if(lo.dynRangeDb<6)cNotes.push('Акценты громкостью выражены слабо.');
    axes.push({key:'confidence',label:'Выразительность',score:confidence,group:'speech',
      detail:'Оценка изменений интонации и динамики голоса. Слова-паразиты и скорость речи учитываются отдельно.',notes:cNotes});

    // тембр и дикция
    const hnrScore = Math.round(clamp((ti.hnrDb - 6) / 16 * 100, 0, 100));
    const jitScore = Math.round(clamp(100 - (ti.jitterPct - 0.4) * 45, 0, 100));
    const shimScore = Math.round(clamp(100 - (ti.shimmerPct - 2) * 12, 0, 100));
    const brightScore = bandScore(ti.centroidHz, 900, 2600, 800);
    const snrScore = Math.round(clamp((lo.snrDb - 8) / 22 * 100, 0, 100));
    const timbre = Math.round(0.3 * hnrScore + 0.2 * jitScore + 0.15 * shimScore + 0.2 * brightScore + 0.15 * snrScore);
    const tNotes = [];
    if (ti.hnrDb < 12) tNotes.push(`Низкая гармоничность записи (HNR ${ti.hnrDb} дБ). Причиной могут быть шум, микрофон или особенности голоса.`);
    if (ti.jitterPct > 1.5) tNotes.push(`Приблизительная нестабильность высоты (джиттер ${ti.jitterPct}%; не медицинское измерение)`);
    if (ti.shimmerPct > 5) tNotes.push(`Неровная громкость внутри фраз (шиммер ${ti.shimmerPct}%)`);
    if (ti.centroidHz < 800) tNotes.push(`Низкий спектральный центроид (${ti.centroidHz} Гц): зависит от голоса и микрофона`);
    if (ti.centroidHz > 2800) tNotes.push(`Очень яркий/резкий тембр (центроид ${ti.centroidHz} Гц)`);
    if (lo.snrDb < 15) tNotes.push(`Низкий запас над шумом (${lo.snrDb} дБ): запись шумная`);
    axes.push({
      key: 'timbre', label: 'Тембр и качество записи', score: timbre, group: 'speech',
      detail: `Тип голоса: ${f.voiceType} (медиана ${f.medianHz} Гц). Яркость: центроид ${ti.centroidHz} Гц, наклон спектра ${ti.slopeDbOct} дБ/окт, доля ВЧ ${pct(ti.hfRatio)}%. HNR ${ti.hnrDb} дБ, джиттер ${ti.jitterPct}%, шиммер ${ti.shimmerPct}%, SNR ${lo.snrDb} дБ.`,
      notes: tNotes
    });

    // энергия и динамика
    // Absolute gain is a recording setting, not speaker energy.
    const loudScore = 100 - clamp(lo.clippingPct * 30, 0, 80);
    const dynScore = bandScore(lo.dynRangeDb, 6, 24, 6);
    const clipPen = clamp(lo.clippingPct * 60, 0, 30);
    const energy = Math.round(clamp(0.45 * loudScore + 0.35 * dynScore + 0.2 * bandScore(pace, 110, 175, 50) - clipPen, 0, 100));
    const eNotes = [];
    if (lo.meanDb < -40) eNotes.push(`Низкий уровень записи (${lo.meanDb} dBFS). Проверьте усиление микрофона; это не оценка громкости в зале.`);
    if (lo.peakDb > -1) eNotes.push('Уровень близок к цифровому пределу: уменьшите усиление микрофона.');
    if (lo.dynRangeDb < 8) eNotes.push('Плоская динамика: нет акцентов громкостью');
    if (lo.clippingPct > 0.05) eNotes.push('Есть клиппинг — микрофон перегружен');
    axes.push({
      key: 'energy', label: 'Динамика записи', score: energy, group: 'speech',
      detail: `Средняя громкость речи: ${lo.meanDb} dBFS, динамический диапазон ${lo.dynRangeDb} дБ, пик ${lo.peakDb} dBFS, шум ${lo.noiseFloorDb} dBFS.`,
      notes: eNotes
    });

    // темп и паузы
    const paceIdeal = bandScore(pace, 125, 165, 42);
    const pauseRatioScore = bandScore(s.pauseRatio, 0.08, 0.24, 0.12);
    const pauseCountScore = bandScore(p.perMin, 5, 16, 6);
    const sentScore = t ? bandScore(t.avgSentenceLen, 8, 19, 7) : 100;
    const pacePauses = Math.round(0.4 * paceIdeal + 0.25 * pauseRatioScore + 0.15 * pauseCountScore + 0.2 * sentScore);
    const ppNotes = [];
    if (pace > 175) ppNotes.push(`Быстрый темп (${pace} слов/мин): аудитория не успевает осмыслить цифры`);
    if (pace < 110) ppNotes.push(`Медленный темп (${pace} слов/мин): питч рискует не уложиться в регламент`);
    if (s.pauseRatio > 0.3) ppNotes.push(`Слишком много пауз: ${pct(s.pauseRatio)}% времени`);
    if (s.pauseRatio < 0.06) ppNotes.push('Почти нет пауз: речь сливается в поток, ключевые мысли не выделяются');
    axes.push({
      key: 'pace', label: 'Темп и паузы', score: pacePauses, group: 'speech',
      detail: `${describeTempo(s, t)} Слоговых импульсов ${r.syllablesPerMin}/мин. Речь ${s.speechSec} с, паузы ${s.pauseSec} с. Пауз: ${p.count} (коротких ${p.short}, заметных ${p.notable}, длинных ${p.long}), длиннейшая ${p.longest} с.`,
      notes: ppNotes
    });
    return axes;
  }

  /* ==================== ГЕНЕРАЦИЯ ВОПРОСОВ ==================== */
  function buildPointEdits(t){
    if(!t?.hasText)return [];
    const L=LEX(),out=[];
    for(const sentence of t.sentencesList){
      const fillers=collect(sentence,L.FILLERS,'filler');
      let after=sentence;
      const distinct=[];
      for(const mark of fillers.marks.slice().sort((a,b)=>a.start-b.start||b.end-a.end))if(!distinct.length||mark.start>=distinct[distinct.length-1].end)distinct.push(mark);
      for(const mark of distinct.reverse())after=after.slice(0,mark.start)+after.slice(mark.end);
      after=after.replace(/(^|[^\p{L}])(в настоящее время|на сегодняшний день)(?=$|[^\p{L}])/giu,'$1сейчас').replace(/\s+([,.!?])/g,'$1').replace(/^[\s,;:]+|[,;:]+$/g,'').replace(/,\s*,/g,',').replace(/\s{2,}/g,' ').trim();
      after=after.charAt(0).toUpperCase()+after.slice(1);
      if(after!==sentence&&tokenize(after).length>=3)out.push({title:'Сократить фразу',before:sentence,after,reason:'Убраны словарные заполнители или длинное вводное выражение. Проверьте, что смысл сохранён.'});
      else if(collect(sentence,L.CLICHES,'cliche').total)out.push({title:'Уточнить общую характеристику',before:sentence,advice:'Замените общую характеристику конкретной функцией, сравнением или подтверждённым результатом. Например: «пользователь делает [действие] за [время]».',reason:'Автоматически придумать вашу функцию и результат нельзя.'});
      else if(collect(sentence,L.HEDGES,'hedge').total)out.push({title:'Уточнить гипотезу',before:sentence,advice:'Сохраните неопределённость, если результат ещё не подтверждён. Добавьте, что проверите, к какому сроку и по какой метрике.',reason:'Слова-сомнения не удалены автоматически, чтобы не превратить гипотезу в факт.'});
      else if(tokenize(sentence).length>24)out.push({title:'Разделить длинную мысль',before:sentence,advice:'Разделите предложение на проблему, действие и результат. Не удаляйте условия и ограничения.',reason:'Для точного разделения длинной фразы требуется проверить её смысл.'});
      if(out.length>=5)break;
    }
    return out;
  }

  function generateQuestions(report) {
    const L=LEX(),t=report.text,profile=getIndustryProfile(report.meta?.industry),out=[],seen=new Set();
    const push=(q,source,priority,criterion=null)=>{
      if(!q)return;
      const normalized=q.q.toLowerCase().replace(/[^a-zа-яё0-9]+/g,' ').trim();
      if(seen.has(normalized))return;seen.add(normalized);
      out.push({id:'',block:q.b,blockLabel:criterion?'Отраслевые метрики':blockLabel(q.b),q:q.q,difficulty:q.d||2,why:q.why,frame:q.f,avoid:q.a,source,priority,criterion,industry:profile.key});
    };
    let seed=0;for(const ch of (report.transcript?.text||'')+(report.meta?.topic||''))seed=(Math.imul(seed,31)+ch.charCodeAt(0))>>>0;
    const variant=Number(report.meta?.questionVariant)||0;
    for(const [index,criterion] of profile.criteria.entries()){
      const alternatives=[criterion.question,
        'Какой результат по направлению «'+criterion.label+'» сделает пилот успешным и за какой срок вы его проверите?',
        'Какое допущение в теме «'+criterion.label+'» самое рискованное и какие данные могут его опровергнуть?'];
      const choice=(seed+index+variant)%alternatives.length;
      const question=alternatives[choice];
      const check=t.structure.find(x=>x.key===criterion.key);
      push({b:criterion.key,d:check?.found?2:3,q:question,
        why:check?.found?'В питче найдена тема «'+criterion.label+'». Эксперт проверит, чем подтверждён результат.':'Для отрасли «'+profile.label+'» важна тема «'+criterion.label+'», но нужные признаки в тексте не найдены.',
        f:choice===1?'Исходный уровень → критерий успеха → способ замера → срок пилота → решение по результату.':choice===2?'Допущение → почему оно важно → какие данные его опровергнут → тест → план при неудаче.':criterion.answer,a:'Не выдавайте целевые показатели за измеренный результат. Если данных нет, назовите план проверки.'},'Отраслевой эксперт: '+profile.label,check?.found?110:120,criterion.key);
    }
    // Pick a few gaps, one question per topic; do not dump the complete bank.
    const baseMissing=t.hasText?t.missing.filter(x=>x.required&&!x.sector).slice(0,4):[];
    for(const block of baseMissing){
      if(profile.social&&['market','business'].includes(block.key))continue;
      const q=(L.GAP_QUESTIONS[block.key]||[])[0]||L.QUESTIONS.find(x=>x.b===block.key);
      push(q,'Пробел в питче: '+block.label,100);
    }
    const core=profile.social?['problem','solution','traction','team','ask','risks']:['problem','solution','market','business','traction','competition','team','ask'];
    for(const block of core){
      if(out.some(q=>q.block===block))continue;
      const choices=L.QUESTIONS.filter(x=>x.b===block);const q=choices[(seed+variant)%Math.max(1,choices.length)];push(q,'Базовый вопрос по проекту',60);
    }
    if(profile.social){
      push({b:'market',d:2,q:'Как вы определили целевую группу и какой части получателей реально доступен проект?',why:'Проверка масштаба социальной задачи и доступности помощи.',f:'Целевая группа → подтверждённая потребность → доступный охват → ограничения.',a:'Не подменяйте результат числом проведённых мероприятий.'},'Эксперт по социальным проектам',90);
    }
    out.sort((a,b)=>b.priority-a.priority);
    // 12 focused questions at most. Delivery issues stay in coaching, not jury questions.
    return out.slice(0,12).map((q,i)=>({...q,id:'q'+(i+1)}));
  }

  const BLOCK_LABELS = {
    problem: 'Проблема', solution: 'Решение', product: 'Продукт', market: 'Рынок', business: 'Бизнес-модель',
    traction: 'Traction', competition: 'Конкуренты', team: 'Команда', ask: 'Ask', timing: 'Почему сейчас',
    risks: 'Риски', cta: 'Финал', corp: 'Корпоративный заказчик', finance: 'Финансы', legal: 'Право и данные',
    hr: 'Найм', delivery: 'Подача', meta: 'Стратегия'
  };
  function blockLabel(k) { return BLOCK_LABELS[k] || 'Общее'; }

  /* ==================== УЛУЧШЕНИЕ ФРАЗ ==================== */
  function improveSentence(sentence, L) {
    L = L || LEX();
    let out = sentence, reasons = [];
    for (const r of L.IMPROVE_RULES) {
      const before = out;
      out = out.replace(r.re, r.to);
      if (before !== out) reasons.push(r.reason);
    }
    out = out.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim();
    if (out.length && !/[.!?…]$/.test(out)) out += '.';
    out = out.charAt(0).toUpperCase() + out.slice(1);
    return { before: sentence.trim(), after: out, reasons: Array.from(new Set(reasons)) };
  }

  function buildRewrites(t) {
    if (!t || !t.hasText) return [];
    const scored = t.sentencesList.map((s) => {
      let bad = 0;
      const low = s.toLowerCase();
      bad += (low.match(/(ээ+|мм+|ну,|вот,|короче|типа|как бы|это самое|в общем)/g) || []).length * 3;
      bad += (low.match(/(может быть|наверное|возможно|кажется|постараемся|попробуем|надеюсь|хотелось бы|вроде)/g) || []).length * 3;
      bad += (low.match(/(является|осуществляется|в настоящее время|на сегодняшний день|данный|в рамках|в целях)/g) || []).length * 2;
      bad += (low.match(/(инновацион|уникальн|не имеющ|широкий спектр|команда профессионалов)/g) || []).length * 2;
      const w = tokenize(s).length;
      if (w > 24) bad += 2;
      if (!/\d/.test(s) && w > 8) bad += 1;
      return { s, bad };
    }).filter((x) => x.bad >= 2).sort((a, b) => b.bad - a.bad).slice(0, 5);
    const L = LEX();
    return scored.map((x) => {
      const r = improveSentence(x.s, L);
      r.score = x.bad;
      return r;
    }).filter((r) => r.before !== r.after);
  }

  /* ==================== СБОРКА ОТЧЁТА ==================== */
  const WEIGHTS = {
    structure: 0.16, persuasion: 0.14, clarity: 0.08, positivity: 0.06, qready: 0.06,
    confidence: 0.16, timbre: 0.12, energy: 0.1, pace: 0.12
  };

  function gradeOf(score) {
    if (score >= 85) return { grade: 'A', label: 'Высокая оценка по измеренным признакам', color: '#22c55e' };
    if (score >= 72) return { grade: 'B', label: 'Хорошо, нужна доводка', color: '#84cc16' };
    if (score >= 58) return { grade: 'C', label: 'Рабочая версия, много правок', color: '#f59e0b' };
    if (score >= 42) return { grade: 'D', label: 'Слабый питч, требуется переработка', color: '#f97316' };
    return { grade: 'E', label: 'Критические пробелы', color: '#ef4444' };
  }

  function buildFeedback(report) {
    const t = report.text, s = report.speech, strengths = [], weaknesses = [], quickWins = [];
    const st = (title, detail) => strengths.push({ title, detail });
    const wk = (title, detail, action) => weaknesses.push({ title, detail, action });
    const qw = (title) => quickWins.push({ title });

    if (t) {
      const found = t.structure.filter((x) => x.found).map((x) => x.label);
      if (found.length >= 5) st('Структура', `Раскрыты блоки: ${found.join(', ')}.`);
      for (const m of t.missing.filter((x) => x.required)) wk(`Нет блока «${m.label}»`, m.suggestion, m.suggestion);
      if (t.facts.density >= 2) st('Конкретика', `Плотность цифр ${t.facts.density} на 100 слов — жюри услышит факты.`);
      else wk('Мало цифр', `Плотность ${t.facts.density} на 100 слов при ориентире ≥1,5.`, 'Добавьте 3 числа: рынок, метрика роста, цена/экономия.');
      if (t.positive.density >= 2.5) st('Позитивный язык', `${t.positive.total} слов результата, например: ${t.positive.list.slice(0, 5).map((x) => x.word).join(', ')}.`);
      else wk('Мало языка результата', `Позитивных слов ${t.positive.total} (${t.positive.density} на 100 слов).`, 'Замените описание процесса на выгоду: «быстрее», «дешевле», «растёт» + цифра.');
      if (t.fillers.total > 0) wk('Слова-паразиты', `${t.fillers.total} шт.: ${t.fillers.list.slice(0, 6).map((x) => x.word).join(', ')}.`, 'Заменяйте заполнитель на паузу 0,5 секунды.');
      if (t.hedges.total > 0) wk('Слова-сомнения', `${t.hedges.total} шт.: ${t.hedges.list.slice(0, 6).map((x) => x.word).join(', ')}.`, 'Каждое «может быть» замените на срок и ответственного.');
      if (t.cliches.total > 0) wk('Штампы', `${t.cliches.total} штампов: ${t.cliches.list.slice(0, 5).map((x) => x.word).join(', ')}.`, 'Каждый штамп → измеримый факт.');
      if (t.avgSentenceLen > 22) wk('Длинные фразы', `Средняя длина предложения ${t.avgSentenceLen} слов.`, 'Правило: одна мысль — одно предложение до 15 слов.');
      if (t.tempo.wordsPerMin && t.tempo.wordsPerMin > 175) wk('Слишком быстрый темп', `${t.tempo.wordsPerMin} слов/мин.`, 'Снижайте до 140–160 и делайте паузу после каждой цифры.');
      if (t.tempo.wordsPerMin && t.tempo.wordsPerMin < 110) wk('Медленный темп', `${t.tempo.wordsPerMin} слов/мин.`, 'Уберите вводные слова, добавьте динамики в первые 20 секунд.');
      if (t.structure.find((x) => x.key === 'ask' && x.found)) st('Есть запрос (Ask)', 'Питч завершается конкретным запросом.');
    }
    if (s) {
      if (s.f0.sdSemitones >= 1.5 && s.f0.sdSemitones <= 3.8) st('Живая интонация', `Вариативность тона ${s.f0.sdSemitones} полутона — голос звучит вовлечённо.`);
      else if (s.f0.sdSemitones < 1.5) wk('Монотонность', `Вариативность тона ${s.f0.sdSemitones} полутона.`, 'Выделяйте голосом 3 главные цифры питча; понижайте тон в конце утверждений.');
      if (s.timbre.hnrDb >= 16) st('Чистый голос', `HNR ${s.timbre.hnrDb} дБ — гармоничность записи высокая; разборчивость слов отдельно не проверялась.`);
      else wk('Голос с шумом', `HNR ${s.timbre.hnrDb} дБ, джиттер ${s.timbre.jitterPct}%.`, 'Разминка голоса, опора на дыхание, вода, снижение темпа в начале.');
      if (s.loudness.meanDb < -40) wk('Низкий уровень записи', `Уровень ${s.loudness.meanDb} dBFS.`, 'Проверьте микрофон и его усиление. Громкость в комнате здесь не измеряется.');
      if (s.pauseRatio > 0.3) wk('Много пауз', `Паузы занимают ${pct(s.pauseRatio)}% времени.`, 'Проговорите переходы между слайдами до автоматизма.');
      if (s.pauses.long > 0) wk('Длинные паузы', `${s.pauses.long} пауз длиннее 1,5 с (максимум ${s.pauses.longest} с).`, 'Держите перед глазами план из 5 слов, а не полный текст.');
      if (s.prosody.upShare > 0.3) wk('Восходящие окончания', `${pct(s.prosody.upShare)}% фраз заканчиваются подъёмом тона.`, 'В конце утверждений опускайте тон — это звучит как факт.');
      if (s.loudness.snrDb < 15) wk('Шумная запись', `Запас над шумом ${s.loudness.snrDb} дБ.`, 'Записывайте в тихой комнате, ближе к микрофону.');
    }
    // быстрые шаги
    if (report.scores) {
      const sorted = report.scores.filter((x) => x.available !== false).slice().sort((a, b) => a.score - b.score);
      for (const a of sorted.slice(0, 4)) qw(`Поднять «${a.label}» (сейчас ${a.score}/100): ${a.notes[0] || a.detail}`);
    }
    if (t && t.rewrites) for (const r of t.rewrites.slice(0, 2)) qw(`Переписать фразу: «${r.before.slice(0, 70)}${r.before.length > 70 ? '…' : ''}»`);
    return { strengths, weaknesses, quickWins };
  }

  /**
   * Главная точка входа.
   * @param {object} input { samples, sampleRate, text, meta, durationSec, onProgress }
   */
  function analyze(input) {
    input = input || {};
    const meta = Object.assign({
      topic: '', industry: '', format: 'Demo Day', audience: 'инвесторы и эксперты',
      targetDurationSec: 180, createdAt: new Date().toISOString()
    }, input.meta || {});
    const progress = typeof input.onProgress === 'function' ? input.onProgress : function () {};
    progress(0.02, 'Подготовка');

    let speech = null, noSignal = false, audioDuration = 0;
    if (input.samples && input.samples.length && input.sampleRate) {
      speech = analyzeAudio(input.samples, input.sampleRate, {
        maxSec: input.maxSec || 600,
        onProgress: (p) => progress(0.05 + p * 0.6, 'Анализ речи: тон, тембр, паузы')
      });
      audioDuration = speech.durationSec;
      if (speech.noSignal) { noSignal = true; speech = null; }
    }
    progress(0.7, 'Анализ текста');
    const text = analyzeText(input.text || '', { topic: meta.topic, industry: meta.industry, durationSec: input.durationSec, speech });
    const durationSec = (speech && speech.durationSec) || audioDuration || input.durationSec || 0;

    progress(0.82, 'Оценки и рекомендации');
    let scores = scoreText(text).concat(scoreSpeech(speech, text));
    // доступность осей
    scores.forEach((a) => { a.available = true; });
    if (!text.hasText) scores.forEach((a) => { if (a.group === 'text') a.available = false; });
    if (speech && (speech.durationSec < 8 || speech.speechSec < 3 || speech.f0.frames < 30)) scores.forEach(a => { if (a.group === 'speech') a.available = false; });
    if(speech && speech.f0.voicedShare<.12)scores.forEach(a=>{if(a.key==='confidence'){a.available=false;a.notes=['Недостаточно участков с определяемой высотой голоса.'];}});
    if (!speech) scores.forEach((a) => { if (a.group === 'speech') a.available = false; });

    const avail = scores.filter((a) => a.available);
    const wsum = avail.reduce((s, a) => s + (WEIGHTS[a.key] || 0.1), 0) || 1;
    const rawTotal = Math.round(avail.reduce((s, a) => s + a.score * (WEIGHTS[a.key] || 0.1) / wsum, 0));
    const groupScore = group => {
      const axes = avail.filter(a => a.group === group);
      return axes.length ? Math.round(axes.reduce((v,a) => v + a.score * WEIGHTS[a.key], 0) / axes.reduce((v,a) => v + WEIGHTS[a.key], 0)) : null;
    };
    const textScore = groupScore('text'), deliveryScore = groupScore('speech');
    let total = rawTotal;
    const scoreLimits = [];
    function limit(value, reason) { if (total > value) { total = value; scoreLimits.push(reason); } }
    if (deliveryScore != null) {
      limit(deliveryScore + 15, 'Слабая подача ограничивает общий балл, даже если текст сильный.');
      const core = avail.filter(a => ['confidence', 'pace'].includes(a.key));
      if (core.some(a => a.score <= 45)) limit(59, 'Есть серьёзные трудности с темпом, паузами или интонацией.');
      else if (core.some(a => a.score < 60)) limit(71, 'Подачу нужно доработать перед выступлением.');
    }
    if (text.hasText && text.words < 40) limit(49, 'Слишком короткий текст для полноценной оценки питча.');
    const grade = gradeOf(total);
    if (!speech && text.hasText) grade.label += ' (только текст; подача не оценена)';

    const report = {
      meta: Object.assign({}, meta, {
        durationSec: round(durationSec, 1),
        targetDurationSec: meta.targetDurationSec,
        inTarget: meta.targetDurationSec ? durationSec <= meta.targetDurationSec * 1.05 : null,
        hasAudio: !!speech, hasText: text.hasText,
        engine: 'PitchEngine ' + (LEX().VERSION || '1.0.0')
      }),
      transcript: {
        text: input.text || '',
        words: text.words, sentences: text.sentences,
        cues: input.cues || null
      },
      text, speech, scores,
      total: Object.assign({ score: total }, grade, { axes: avail.length, textScore, deliveryScore, rawScore: rawTotal, scoreLimits }),
      warnings: []
    };

    report.warnings.push(...scoreLimits);
    if (speech && deliveryScore == null) report.warnings.push('Недостаточно речевых данных: нужно хотя бы 8 секунд записи с различимым голосом. Оценки подачи недоступны.');
    if (speech && !text.tempo.wordsPerMin) report.warnings.push('Нет полной расшифровки: темп по звуку приблизительный, оценки подачи предварительные.');
    if (!speech && text.hasText) report.warnings.push('Оценён только текст. Без записи нельзя оценить темп, паузы и интонацию.');
    if (meta.targetDurationSec && durationSec > meta.targetDurationSec * 1.05) report.warnings.push(`Выступление ${round(durationSec, 1)} с — дольше регламента ${meta.targetDurationSec} с.`);
    if (meta.targetDurationSec && durationSec && durationSec < meta.targetDurationSec * 0.6) report.warnings.push(`Выступление ${round(durationSec, 1)} с — заметно короче регламента ${meta.targetDurationSec} с.`);
    if (noSignal) report.warnings.push('В аудиозаписи не обнаружен речевой сигнал (слишком тихо или микрофон выключен) — анализ речи пропущен.');
    if (speech && speech.trimmed) report.warnings.push('Проанализированы только первые 10 минут записи.');

    progress(0.9, 'Формирование вопросов');
    report.questions = generateQuestions(report);
    report.rewrites = buildPointEdits(text).filter(x=>x.after).map(x=>({before:x.before,after:x.after,reasons:[x.reason]}));
    report.highlights = { spans: highlightSpans(text) };
    report.timeline = speech ? speech.timeline : null;
    report.structure = text.structure.map((x) => ({ key: x.key, label: x.label, found: x.found, hits: x.hits, evidence: x.evidence, required: x.required, sector: x.sector, quantified: x.quantified, suggestion: x.suggestion }));
    progress(0.96, 'Итоговые выводы');
    report.feedback = buildFeedback(report);
    report.verdict = buildVerdict(report);
    progress(1, 'Готово');
    return report;
  }

  function buildVerdict(report) {
    const t = report.text, s = report.speech, out = [];
    out.push(`Итог: ${report.total.score}/100 (${report.total.grade}) — ${report.total.label}.`);
    if (t && t.hasText) {
      out.push(`Раскрыто блоков питча: ${t.structure.filter((x) => x.found).length} из ${t.structure.length}; цифр/метрик: ${t.facts.numbers}; слов-паразитов: ${t.fillers.total}; хеджей: ${t.hedges.total}.`);
    }
    if (s) {
      const pace = (t && t.tempo.wordsPerMin) || s.rate.estimatedWordsPerMin;
      out.push(`Речь: ${s.durationSec} с, ${describeTempo(s, t)}, паузы ${pct(s.pauseRatio)}% времени, вариативность тона ${s.f0.sdSemitones} полутона, HNR ${s.timbre.hnrDb} дБ.`);
    }
    const worst = report.scores.filter((a) => a.available !== false).slice().sort((a, b) => a.score - b.score)[0];
    if (worst) out.push(`Главная зона роста: «${worst.label}» (${worst.score}/100). ${worst.notes[0] || worst.detail}`);
    out.push(`Заготовленных вопросов жюри: ${report.questions.length}.`);
    return out;
  }

  /* ==================== ЭКСПОРТ ОТЧЁТА ==================== */
  function buildMarkdown(r) {
    const L=[`# Анализ питча: ${r.meta.topic || 'без темы'}`, '', `Общая оценка: ${r.total.score}/100. ${r.total.label}.`, `Содержание: ${r.total.textScore ?? 'нет данных'}. Подача: ${r.total.deliveryScore ?? 'нет данных'}.`, '', 'Оценка помогает тренироваться и не подтверждает достоверность фактов.', '', '## Карта питча'];
    for(const item of buildContentMap(r))L.push(`- ${item.start==null ? 'Фрагмент '+(item.order+1) : (item.estimated?'Примерно ':'')+item.start+' с'} — ${item.label}: ${item.excerpt}`);
    L.push('', '## Подача и понятность');
    for(const key of ['confidence','pace','energy','clarity','persuasion','qready']){
      const axis=r.scores.find(x=>x.key===key);if(!axis)continue;
      const names={confidence:'Выразительность',pace:'Темп и ритм',energy:'Акценты в речи',clarity:'Понятность',persuasion:'Конкретика',qready:'Полнота аргументов'};
      L.push(`- ${names[key]}: ${axis.available===false?'недостаточно данных':axis.score+'/100'}.`);
    }
    L.push('', '## Структура питча', '', '### Уже есть');
    r.structure.filter(x=>x.found).forEach(x=>L.push('- '+x.label));
    L.push('', '### Стоит добавить');
    r.structure.filter(x=>!x.found).forEach(x=>L.push('- '+x.label+': '+x.suggestion));
    const feedback=buildCoachingFeedback(r);
    L.push('', '## Разбор: что хорошо и что исправить', '', '### Сильные стороны');
    feedback.strengths.forEach((x,i)=>L.push(`${i+1}. ${x.title}. ${x.evidence} ${x.action}`));
    L.push('', '### Что исправить в первую очередь');
    feedback.improvements.forEach((x,i)=>L.push(`${i+1}. ${x.title}. ${x.evidence} ${x.action}`));
    L.push('', '### План следующего прогона');
    feedback.practice.forEach((x,i)=>L.push(`${i+1}. ${x.title}. ${x.action}`));
    L.push('', '## Скажите точнее');
    for(const x of r.rewrites)L.push('- Было: '+x.before,'- Попробуйте так: '+x.after,'');
    L.push('', '## Вопросы уровня Demo Day');
    for(const q of r.questions)L.push('', '### '+q.q, 'Тема: '+q.blockLabel, 'Что проверяют: '+q.why, 'План ответа: '+q.frame, 'Избегайте: '+q.avoid);
    L.push('', '## Текст выступления', r.transcript.text || 'Расшифровка не добавлена.');
    if(r.warnings.length)L.push('', '## Что учтено в оценке', ...r.warnings.map(x=>'- '+x));
    return L.join('\n');
  }

  function buildStandaloneHtml(r) {
    const esc=x=>String(x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const body=buildMarkdown(r).split('\n').map(line=>{
      const heading=line.match(/^(#{1,3}) (.*)/);
      if(heading)return `<h${heading[1].length}>${esc(heading[2])}</h${heading[1].length}>`;
      return line?`<p>${esc(line.replace(/^- /,'• '))}</p>`:'';
    }).join('');
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Разбор питча</title><style>body{font:16px/1.7 system-ui,sans-serif;color:#e8eefb;background:#070d18;max-width:900px;margin:auto;padding:40px 24px}h1{font-size:34px;line-height:1.2}h2{margin-top:40px;border-top:1px solid #1e3050;padding-top:24px}h3{margin-top:24px;font-size:18px}p{margin:8px 0}h1,h2{color:#2fd44f}@media print{body{background:white;color:#111;padding:0}h1,h2{color:#111}h2,h3{break-after:avoid}}</style></head><body>${body}</body></html>`;
  }

  /* ==================== СУБТИТРЫ (SRT/VTT) ==================== */
  function parseSubtitle(raw) {
    if (!raw || !/-->/.test(raw)) return null;
    const cues = [];
    const blocks = raw.replace(/\r/g, '').split(/\n{2,}/);
    const t = (x) => {
      const m = x.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
      if (!m) return null;
      return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+(m[4].padEnd(3, '0'))) / 1000;
    };
    for (const b of blocks) {
      const lines = b.split('\n').filter((l) => l.trim());
      const idx = lines.findIndex((l) => /-->/.test(l));
      if (idx < 0) continue;
      const [a, z] = lines[idx].split('-->');
      const start = t(a), end = t(z);
      const text = lines.slice(idx + 1).join(' ').replace(/<[^>]+>/g, '').trim();
      if (start != null && end != null && text) cues.push({ start, end, text });
    }
    if (!cues.length) return null;
    return { cues, text: cues.map((c) => c.text).join(' ') };
  }

  // Marks identify the first mention, not a semantic verification of completeness.
  function buildContentMap(report) {
    const text=(report.transcript?.text||'').trim();
    if(!text)return [];
    const duration=report.meta?.durationSec||0;
    const cues=report.transcript?.cues||[];
    const ranges=[];let cursor=0;
    for(const cue of cues){
      const fragment=(cue.text||'').trim();
      if(!fragment || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start<0 || cue.end<cue.start)continue;
      const at=text.indexOf(fragment,cursor);
      if(at<0)continue;
      ranges.push({from:at,to:at+fragment.length,start:cue.start,end:cue.end});cursor=at+fragment.length;
    }
    return (report.text?.structure||[]).filter(b=>b.found&&b.marks?.length).map(b=>{
      const mark=b.marks.reduce((a,c)=>a.start<c.start?a:c);
      const cue=ranges.find(c=>mark.start>=c.from&&mark.start<c.to);
      const start=cue ? cue.start : duration ? Math.min(duration,mark.start/text.length*duration) : null;
      const sentenceStart=Math.max(text.lastIndexOf('.',mark.start-1),text.lastIndexOf('\n',mark.start-1))+1;
      let sentenceEnd=text.indexOf('.',mark.end);if(sentenceEnd<0)sentenceEnd=Math.min(text.length,mark.end+100);
      const excerpt=text.slice(sentenceStart,sentenceEnd+1).trim();
      return {key:b.key,label:b.label,offset:mark.start,start:start==null?null:round(start,1),estimated:!cue&&start!=null,excerpt:excerpt.length>180?excerpt.slice(0,177)+'…':excerpt};
    }).sort((a,b)=>a.offset-b.offset).map((item,order)=>({...item,order}));
  }

  function evaluateAnswer({text='',question={},speech=null,durationSec=0}) {
    const t=analyzeText(text,{}), items=[];
    const duration=speech?.durationSec||durationSec;
    if(t.hasText){
      items.push({label:'Объём ответа',ok:t.words>=25&&t.words<=160,advice:t.words<25?'Пока слишком кратко: добавьте объяснение и один пример.':t.words>160?'Сократите ответ до главного тезиса, доказательства и вывода.':'Объём подходит для короткого ответа. Начните с прямого ответа на вопрос.'});
      const facts=/\d/.test(text);
      items.push({label:'Доказательства',ok:facts,advice:facts?'Числа есть. Проверьте их источник и связь с вопросом: программа не проверяет достоверность.':'Добавьте конкретный пример, результат или число, которое подтверждает ваш тезис.'});
      const excess=t.fillers.total+t.hedges.total+t.cliches.total;
      items.push({label:'Ясность формулировок',ok:excess<3,advice:excess>=3?'Есть вводные слова или сомнения. Попробуйте сказать короче и прямее.':'Явных повторяющихся ослабителей немного. Проверьте, что каждое предложение помогает ответить на вопрос.'});
      const tokens=tokenize((question.q||'')+' '+(question.frame||'')).map(x=>x.norm).filter(w=>w.length>=5);
      const shared=[...new Set(tokens.filter(w=>text.toLowerCase().includes(w.slice(0,Math.max(5,w.length-2)))))].slice(0,4);
      items.push({label:'Связь с вопросом',ok:shared.length>0,advice:shared.length?'Найдены совпадения с темой: '+shared.join(', ')+'. Это подсказка по словам; проверьте, что первая фраза прямо отвечает на вопрос.':'Явных совпадений с темой мало. Начните с прямого ответа и сверьтесь с планом. Пересказ своими словами тоже может быть уместным.'});
    }else items.push({label:'Содержание пока не оценено',ok:false,advice:'Распознавание не вернуло текст. Прослушайте запись, введите расшифровку и повторите разбор.'});
    if(duration)items.push({label:'Время ответа',ok:duration>=15&&duration<=62,advice:duration<15?'Ответ короче 15 секунд. Если мысль не раскрыта, добавьте обоснование и пример.':duration>62?'Ответ вышел за минуту. Уберите вступление и оставьте главное.':'Ответ уложился в минуту. Проверьте, что вы успели сделать вывод.'});
    if(speech&&!speech.noSignal)items.push({label:'Подача',ok:speech.pauseRatio<.35&&speech.f0.sdSemitones>=1.2,advice:speech.pauseRatio>=.35?'Заметны затяжные остановки. Запишите три опорных слова и повторите ответ.':speech.f0.sdSemitones<1.2?'Добавьте голосовой акцент на главном доказательстве и выводе.':'Сохраняйте ритм. Выделяйте голосом основной аргумент.'});
    else if(speech?.noSignal)items.push({label:'Проверьте микрофон',ok:false,advice:'В записи не обнаружен различимый голос. Выберите другой микрофон и повторите запись.'});
    return {title:t.hasText?'Что улучшить в ответе':'Сначала добавьте расшифровку',note:'Локальный разбор по признакам речи и текста. Он не проверяет истинность фактов и полноту ответа по смыслу.',items};
  }


  function buildCoachingFeedback(report) {
    const t=report.text,s=report.speech, text=(report.transcript.text||'').trim();
    const strengths=[],issues=[];
    const add=(priority,title,evidence,action)=>issues.push({priority,title,evidence,action});
    const quote=value=>String(value||'').length>160?String(value).slice(0,157)+'…':String(value||'');
    const snippet=group=>{
      const mark=group.marks?.[0];
      return mark ? quote(text.slice(Math.max(0,mark.start-35),Math.min(text.length,mark.end+65))) : '';
    };
    const clock=seconds=>String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(Math.floor(seconds%60)).padStart(2,'0');
    if(t.hasText){
      const covered=t.structure.filter(x=>x.required&&x.found);
      if(covered.length)strengths.push({title:'Основные темы уже обозначены',evidence:covered.map(x=>x.label).join(', ')+'.',action:'Сохраните эти темы. Упоминание по словам-маркерам ещё не гарантирует полноту аргумента.'});
      if(t.facts.numbers)strengths.push({title:'Есть измеримые ориентиры',evidence:'В тексте найдены: '+t.facts.examples.slice(0,3).join('; ')+'.',action:'Оставьте важные цифры и подпишите источник и период.'});
      if(t.fillers.total===0&&t.hedges.total===0)strengths.push({title:'Не найдены явные слова-паразиты и сомнения',evidence:'В доступной расшифровке нет совпадений со словарём этих выражений.',action:'Сохраните прямые формулировки. Качество распознавания влияет на этот вывод.'});
      for(const item of buildContentMap(report).filter(x=>['problem','solution','traction'].includes(x.key))){
        strengths.push({title:'Обозначена тема «'+item.label+'»',evidence:'Из текста: «'+quote(item.excerpt)+'».',action:'Сохраните этот тезис и проверьте, понятен ли он слушателю вне проекта.'});
      }
      const missing=t.missing.filter(x=>x.required).slice().sort((a,b)=>Number(!!b.sector)-Number(!!a.sector));
      if(missing.length){
        missing.slice(0,3).forEach((block,i)=>add(100-i,'Дополните блок «'+block.label+'»',block.quantified?'Не найдены название показателя и число в одном предложении для темы «'+block.label+'».':'Не найдены слова-маркеры темы «'+block.label+'» в доступной расшифровке.',block.suggestion+' Если тема уже раскрыта, проверьте текст распознавания и сформулируйте тезис прямее.'));
      }
      if(t.facts.density<1.5)add(85,'Подкрепите обещания доказательствами','Найдено '+t.facts.numbers+' выражений с числами на '+t.words+' слов.','Добавьте один результат проверки продукта: сколько клиентов участвовало, какой эффект получен и за какой срок.');
      if(t.fillers.total)add(80,'Уберите повторяющиеся вводные слова','Найдено '+t.fillers.total+' совпадений. Например: «'+snippet(t.fillers)+'».','Выпишите эти выражения и повторите фрагмент, заменяя заполнитель короткой паузой.');
      if(t.hedges.total)add(78,'Сделайте обещания определённее','Встречается: «'+snippet(t.hedges)+'».','Разделите подтверждённый результат и гипотезу. Для следующего шага назовите срок и способ проверки; не превращайте предположение в ложный факт.');
      if(t.longSentences.length)add(73,'Разделите длинную мысль','Тяжёлый для чтения фрагмент: «'+quote(t.longSentences[0])+'».','Разбейте его на две-три фразы: проблема, действие, результат. В каждой оставьте одну основную мысль.');
      if(t.cliches.total)add(72,'Замените общую фразу конкретикой','Например: «'+snippet(t.cliches)+'».','Вместо общей характеристики назовите конкретную функцию или результат для клиента.');
    }else add(110,'Добавьте расшифровку','Без текста содержание и полнота структуры не оценены.','Вернитесь к записи и вставьте полный текст выступления.');
    if(s&&report.total.deliveryScore!=null){
      const longest=s.pauses.list.slice().sort((a,b)=>b.dur-a.dur)[0];
      if(longest&&longest.dur>1.5)add(92,'Проверьте остановку на '+clock(longest.start),'Внутри выступления обнаружена пауза '+longest.dur+' с ('+clock(longest.start)+'–'+clock(longest.end)+').','Прослушайте этот участок. Если это заминка, заранее запишите переход к следующей мысли; смысловую паузу можно оставить.');
      if(s.f0.sdSemitones<1.4)add(90,'Добавьте акценты голосом','Высота тона меняется мало на проанализированном участке.','Выберите три фразы: польза клиенту, главный результат, запрос к жюри. Произнесите их с отдельным акцентом и короткой паузой после.');
      const pace=t.tempo.wordsPerMin;
      if(pace&&pace>175)add(87,'Замедлитесь на цифрах','По тексту и полной длительности получается '+pace+' слов в минуту.','Повторите фрагмент с результатами медленнее и сделайте паузу после каждого ключевого числа.');
      else if(pace&&pace<110)add(87,'Сократите затянутое объяснение','По тексту и полной длительности получается '+pace+' слов в минуту.','Уберите повтор одного тезиса и длинное вступление. Сравните две записи одного и того же фрагмента.');
      else if(pace)strengths.push({title:'Темп в рабочем диапазоне',evidence:'По расшифровке и полной длительности — '+pace+' слов в минуту.',action:'Сохраните этот ритм; на важных цифрах дайте слушателю время осмыслить результат.'});
    }
    if(report.meta.targetDurationSec&&report.meta.durationSec>report.meta.targetDurationSec*1.05)add(105,'Уложитесь в регламент','Запись длится '+Math.round(report.meta.durationSec)+' с при лимите '+report.meta.targetDurationSec+' с.','Сократите примерно '+Math.ceil(report.meta.durationSec-report.meta.targetDurationSec)+' с: сначала уберите повторные объяснения и второстепенные примеры.');
    issues.sort((a,b)=>b.priority-a.priority);
    const improvements=issues.slice(0,8);
    const practice=improvements.map(x=>({title:x.title,action:x.action}));
    if(practice.length<6)practice.push({title:'Проверьте первый тезис',action:'Дайте послушать первые 15 секунд человеку вне проекта и попросите назвать проблему и клиента.'});
    if(practice.length<6)practice.push({title:'Подготовьте доказательство',action:'Для главного результата подготовьте источник числа или пример клиента. Автоматический анализ не проверяет достоверность.'});
    if(practice.length<6)practice.push({title:'Ответьте на вопрос жюри',action:'Запишите минутный ответ на первый вопрос из списка ниже и сравните два варианта.'});
    if(practice.length<6)practice.push({title:'Повторите выступление',action:'Сделайте ещё один прогон по тому же тексту и сравните подачу, а не только общий балл.'});
    if(practice.length<6)practice.push({title:'Проверьте запрос к аудитории',action:'Сформулируйте в одном предложении, что вам нужно от жюри и какой результат даст эта поддержка.'});
    if(practice.length<6)practice.push({title:'Сравните с альтернативой',action:'Подготовьте один конкретный критерий, по которому клиент выберет ваш продукт вместо текущего способа решения.'});
    return {strengths:strengths.slice(0,6),improvements,practice:practice.slice(0,6)};
  }


  return {
    analyze, analyzeAudio, analyzeText, describeTempo, buildContentMap, evaluateAnswer, buildCoachingFeedback, getIndustryProfile, buildPointEdits, generateQuestions, buildMarkdown, buildStandaloneHtml,
    improveSentence, buildRewrites, parseSubtitle, highlightSpans, gradeOf, WEIGHTS,
    _internal: { fftInPlace, pitchOfFrame, resample, lowpass, tokenize, splitSentences, stemRe, collect, percentile, median, bandScore, blockLabel }
  };
});
