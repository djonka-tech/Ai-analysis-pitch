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
    if (loudDb < -50) {
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
    const syllPerMin = speechSec > 1 ? syll / speechSec * 60 : 0;
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
        articulationRate: round(syllPerMin, 0),
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
    const numRe = /(?:\d+[.,]?\d*\s*(?:%|₽|руб|р\.|млн|млрд|тыс|к\b|раз|х|икс|пользовател\w*|клиент\w*|месяц\w*|год\w*|дн\w*|человек\w*|штук\w*))|(?:[хx×]\s?\d+[.,]?\d*)|(?:\d+[.,]?\d*\s?(?:в|во)\s?\d+)/gi;
    const numbers = (clean.match(numRe) || []);
    const anyDigits = (clean.match(/\d+/g) || []);
    const factDensity = words ? numbers.length / words * 100 : 0;

    // предложения с цифрами
    const sentWithNum = sentences.filter((s) => /\d/.test(s.text)).length;

    // структура
    const structure = L.STRUCTURE.map((b) => {
      const hit = collect(clean, b.stems, 'block');
      return { key: b.key, label: b.label, weight: b.weight, required: !!b.required, found: hit.total > 0, hits: hit.total, evidence: hit.list.slice(0, 6).map((x) => x.word), suggestion: b.suggestion, hooks: b.hooks || [], marks: hit.marks };
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
    const wpmFromAudio = ctx.speech && ctx.speech.speechSec > 3 ? round(words / (ctx.speech.speechSec / 60), 0) : null;
    const wpmFromDuration = !wpmFromAudio && ctx.durationSec > 3 && words ? round(words / (ctx.durationSec / 60), 0) : null;

    return {
      hasText: words > 0,
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
      missing: structure.filter((s) => !s.found).map((s) => ({ key: s.key, label: s.label, required: s.required, suggestion: s.suggestion })),
      longSentences: longSentences.slice(0, 6).map((s) => s.text),
      keywords,
      sentencesList: sentences.map((s) => s.text),
      tempo: { wordsPerMin: wpmFromAudio || wpmFromDuration, source: wpmFromAudio ? 'аудио' : (wpmFromDuration ? 'заданная длительность' : null) }
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
    axes.push({
      key: 'qready', label: 'Готовность к вопросам', score: qReady, group: 'text',
      detail: `Ключевых блоков для вопросов раскрыто: ${critFound} из ${critical.length}. Цифр в тексте: ${t.facts.numbers}.`,
      notes: critFound < critical.length ? ['Пробелы в блоках ' + t.structure.filter((s) => critical.indexOf(s.key) >= 0 && !s.found).map((s) => '«' + s.label + '»').join(', ') + ' почти гарантируют вопросы жюри'] : []
    });
    return axes;
  }

  function scoreSpeech(s, t) {
    const axes = [];
    if (!s) return axes;
    const f = s.f0, ti = s.timbre, lo = s.loudness, r = s.rate, p = s.pauses, pr = s.prosody;

    // уверенность голоса
    const varScore = bandScore(f.sdSemitones, 1.5, 3.8, 1.2);
    const fillerRatePerMin = t && t.fillers.perMin != null ? t.fillers.perMin : null;
    const fillPen = fillerRatePerMin != null ? clamp(fillerRatePerMin * 6, 0, 45) : 0;
    const hedgePen = t ? clamp(t.hedges.per100 * 25, 0, 30) : 0;
    const pausePen = clamp((s.pauseRatio - 0.22) * 130, 0, 30);
    const longPen = clamp(p.long * 5, 0, 18);
    const upPen = clamp(pr.upShare * 22, 0, 18);
    const stabBonus = clamp((ti.hnrDb - 10) * 1.2, -8, 12);
    const pace = (t && t.tempo.wordsPerMin) || r.estimatedWordsPerMin;
    const paceScore = bandScore(pace, 120, 165, 45);
    let confidence = 0.3 * varScore + 0.2 * paceScore + 0.16 * (100 - clamp(ti.jitterPct * 30, 0, 80)) + 0.14 * (100 - clamp(ti.shimmerPct * 10, 0, 80)) + 0.2 * 100;
    confidence = confidence - fillPen - hedgePen - pausePen - longPen - upPen + stabBonus;
    confidence = Math.round(clamp(confidence, 0, 100));
    const cNotes = [];
    if (f.sdSemitones < 1.4) cNotes.push('Монотонная подача: интонация почти не меняется');
    if (f.sdSemitones > 4.5) cNotes.push('Слишком «скачущая» интонация: голос звучит нервно');
    if (p.long > 0) cNotes.push(`Длинных пауз (>1,5 с): ${p.long}`);
    if (pr.upShare > 0.3) cNotes.push(`Восходящие окончания фраз: ${pct(pr.upShare)}% — звучит как вопрос, а не утверждение`);
    if (fillerRatePerMin != null && fillerRatePerMin > 4) cNotes.push(`Слов-заполнителей ${fillerRatePerMin} в минуту`);
    if (hedgePen > 10) cNotes.push('Много слов-сомнений');
    axes.push({
      key: 'confidence', label: 'Уверенность подачи', score: confidence, group: 'speech',
      detail: `Вариативность тона: ${f.sdSemitones} полутона (диапазон ${f.rangeSemitones}). Темп ~${pace} слов/мин. Паузы: ${pct(s.pauseRatio)}% времени. Джиттер ${ti.jitterPct}%, шиммер ${ti.shimmerPct}%.`,
      notes: cNotes
    });

    // тембр и дикция
    const hnrScore = Math.round(clamp((ti.hnrDb - 6) / 16 * 100, 0, 100));
    const jitScore = Math.round(clamp(100 - (ti.jitterPct - 0.4) * 45, 0, 100));
    const shimScore = Math.round(clamp(100 - (ti.shimmerPct - 2) * 12, 0, 100));
    const brightScore = bandScore(ti.centroidHz, 900, 2600, 800);
    const snrScore = Math.round(clamp((lo.snrDb - 8) / 22 * 100, 0, 100));
    const timbre = Math.round(0.3 * hnrScore + 0.2 * jitScore + 0.15 * shimScore + 0.2 * brightScore + 0.15 * snrScore);
    const tNotes = [];
    if (ti.hnrDb < 12) tNotes.push(`Голос звучит с шумом/хрипотцой (HNR ${ti.hnrDb} дБ): помогает больше опоры на дыхание`);
    if (ti.jitterPct > 1.5) tNotes.push(`Нестабильность высоты тона (джиттер ${ti.jitterPct}% при норме <1%)`);
    if (ti.shimmerPct > 5) tNotes.push(`Неровная громкость внутри фраз (шиммер ${ti.shimmerPct}%)`);
    if (ti.centroidHz < 800) tNotes.push(`Тёмный/глухой тембр (центроид ${ti.centroidHz} Гц): артикуляция звучит вяло`);
    if (ti.centroidHz > 2800) tNotes.push(`Очень яркий/резкий тембр (центроид ${ti.centroidHz} Гц)`);
    if (lo.snrDb < 15) tNotes.push(`Низкий запас над шумом (${lo.snrDb} дБ): запись шумная`);
    axes.push({
      key: 'timbre', label: 'Тембр и дикция', score: timbre, group: 'speech',
      detail: `Тип голоса: ${f.voiceType} (медиана ${f.medianHz} Гц). Яркость: центроид ${ti.centroidHz} Гц, наклон спектра ${ti.slopeDbOct} дБ/окт, доля ВЧ ${pct(ti.hfRatio)}%. HNR ${ti.hnrDb} дБ, джиттер ${ti.jitterPct}%, шиммер ${ti.shimmerPct}%, SNR ${lo.snrDb} дБ.`,
      notes: tNotes
    });

    // энергия и динамика
    const loudScore = bandScore(lo.meanDb, -27, -14, 6);
    const dynScore = bandScore(lo.dynRangeDb, 10, 26, 8);
    const clipPen = clamp(lo.clippingPct * 60, 0, 30);
    const energy = Math.round(clamp(0.45 * loudScore + 0.35 * dynScore + 0.2 * bandScore(pace, 110, 175, 50) - clipPen, 0, 100));
    const eNotes = [];
    if (lo.meanDb < -30) eNotes.push(`Тихая подача (${lo.meanDb} дБ): в зале попросят говорить громче`);
    if (lo.meanDb > -10) eNotes.push('Слишком громко: есть риск перегруза и усталости зала');
    if (lo.dynRangeDb < 8) eNotes.push('Плоская динамика: нет акцентов громкостью');
    if (lo.clippingPct > 0.05) eNotes.push('Есть клиппинг — микрофон перегружен');
    axes.push({
      key: 'energy', label: 'Энергия и динамика', score: energy, group: 'speech',
      detail: `Средняя громкость речи: ${lo.meanDb} дБ, динамический диапазон ${lo.dynRangeDb} дБ, пик ${lo.peakDb} дБ, шум ${lo.noiseFloorDb} дБ.`,
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
      detail: `Темп ~${pace} слов/мин (слогов ${r.syllablesPerMin}/мин). Речь ${s.speechSec} с, паузы ${s.pauseSec} с. Пауз: ${p.count} (коротких ${p.short}, заметных ${p.notable}, длинных ${p.long}), длиннейшая ${p.longest} с.`,
      notes: ppNotes
    });
    return axes;
  }

  /* ==================== ГЕНЕРАЦИЯ ВОПРОСОВ ==================== */
  function generateQuestions(report) {
    const L = LEX();
    const t = report.text, s = report.speech;
    const topic = (report.meta && report.meta.topic) || 'ваш проект';
    const out = [];
    const push = (q, src) => {
      out.push({
        id: 'q' + (out.length + 1), block: q.b, blockLabel: blockLabel(q.b), q: q.q, difficulty: q.d,
        why: q.why, frame: q.f, avoid: q.a, source: src
      });
    };
    // 1. пробелы в структуре — приоритет 1
    const missing = t ? t.missing : [];
    for (const m of missing) {
      const bank = L.GAP_QUESTIONS[m.key] || [];
      for (const q of bank) push(q, 'Пробел в питче: ' + m.label);
    }
    // 2. слабые места текста
    if (t && t.facts.density < 1.5) push({ b: 'traction', d: 3, q: 'Ваш питч почти без цифр. Какие три числа доказывают, что проект работает?', why: 'В тексте мало измеримых фактов.', f: 'Выручка/пользователи/пилоты в динамике: «с N до M за K месяцев».', a: 'Не заменяйте числа прилагательными («значительный рост»).' }, 'Анализ текста');
    if (t && t.hedges.total >= 3) push({ b: 'team', d: 2, q: `Вы ${t.hedges.total} раз использовали слова-сомнения. Насколько вы уверены в плане?`, why: 'Хеджи снижают доверие к прогнозу.', f: 'Дайте план с датами и метриками вместо «постараемся».', a: 'Не оправдывайтесь: замените сомнение обязательством со сроком.' }, 'Анализ текста');
    if (t && t.fillers.total >= 5) push({ b: 'delivery', d: 1, q: `В речи ${t.fillers.total} слов-паразитов. Как будете говорить «чисто» на сцене?`, why: 'Заполнители снижают воспринимаемую экспертность.', f: 'Механика: пауза 0,5 с вместо «эээ», карточки с 5 опорными словами, 3 прогона вслух.', a: 'Не обещайте «исправлюсь» без конкретного приёма.' }, 'Анализ текста');
    // 3. универсальный банк
    for (const q of L.QUESTIONS) push(q, 'Demo Day');
    // 4. вопросы по подаче
    if (s) {
      const issues = [];
      if (s.f0.sdSemitones < 1.4) issues.push('monotone');
      const pace = (t && t.tempo.wordsPerMin) || s.rate.estimatedWordsPerMin;
      if (pace > 175) issues.push('fast');
      if (pace < 110) issues.push('slow');
      if (s.pauses.long > 0) issues.push('pauses');
      if (t && t.fillers.total >= 5) issues.push('fillers');
      if (t && t.hedges.total >= 3) issues.push('hedges');
      if (s.loudness.meanDb < -30) issues.push('quiet');
      if (s.timbre.jitterPct > 2 || s.timbre.hnrDb < 10) issues.push('timbre');
      for (const id of issues.slice(0, 5)) {
        const q = L.DELIVERY_QUESTIONS.find((x) => x.id === id);
        if (q) push(q, 'Анализ речи');
      }
    }
    // 5. вопросы про тему проекта
    if (topic && topic.length > 2) {
      push({ b: 'problem', d: 2, q: `«${topic}»: почему эта задача не решена до сих пор, если она такая очевидная?`, why: 'Проверка понимания причинно-следственных связей рынка.', f: 'Назовите конкретный барьер (технология, регулирование, данные, экономика) и объясните, что изменилось.', a: 'Не отвечайте «никто не догадался»: это сигнал поверхностного анализа.' }, 'Тема проекта');
      push({ b: 'market', d: 3, q: `Кто в нише «${topic}» станет вашим первым крупным заказчиком и сколько это денег?`, why: 'Проверка конкретности плана продаж.', f: 'Имя/профиль заказчика → объём контракта → срок сделки → что уже сделано для него.', a: 'Не называйте «все компании отрасли».' }, 'Тема проекта');
    }
    // приоритезация: пробелы и критические блоки выше
    const crit = { market: 3, business: 3, traction: 4, ask: 3, competition: 2, team: 2, problem: 2, solution: 2, risks: 2, corp: 2, finance: 2, legal: 1, hr: 1, delivery: 1, meta: 1, timing: 1, cta: 1, product: 1 };
    out.forEach((q) => { q.priority = (q.source.indexOf('Пробел') === 0 ? 100 : 0) + (crit[q.block] || 1) * 10 + (4 - q.difficulty) + (q.block === 'corp' && report.meta && report.meta.format === 'Демо-день корпорации' ? 15 : 0); });
    out.sort((a, b) => b.priority - a.priority);
    out.forEach((q, i) => { q.id = 'q' + (i + 1); });
    return out;
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
    if (score >= 85) return { grade: 'A', label: 'Готов к Demo Day', color: '#22c55e' };
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
      if (s.timbre.hnrDb >= 16) st('Чистый голос', `HNR ${s.timbre.hnrDb} дБ — голос звучит уверенно и разборчиво.`);
      else wk('Голос с шумом', `HNR ${s.timbre.hnrDb} дБ, джиттер ${s.timbre.jitterPct}%.`, 'Разминка голоса, опора на дыхание, вода, снижение темпа в начале.');
      if (s.loudness.meanDb < -30) wk('Тихая подача', `Средняя громкость ${s.loudness.meanDb} дБ.`, 'Петличный микрофон и проверка громкости на последнем ряду.');
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
    if (!speech) scores.forEach((a) => { if (a.group === 'speech') a.available = false; });

    const avail = scores.filter((a) => a.available);
    const wsum = avail.reduce((s, a) => s + (WEIGHTS[a.key] || 0.1), 0) || 1;
    const total = Math.round(avail.reduce((s, a) => s + a.score * (WEIGHTS[a.key] || 0.1) / wsum, 0));
    const grade = gradeOf(total);

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
      total: Object.assign({ score: total }, grade, { axes: avail.length }),
      warnings: []
    };

    if (meta.targetDurationSec && durationSec > meta.targetDurationSec * 1.05) report.warnings.push(`Выступление ${round(durationSec, 1)} с — дольше регламента ${meta.targetDurationSec} с.`);
    if (meta.targetDurationSec && durationSec && durationSec < meta.targetDurationSec * 0.6) report.warnings.push(`Выступление ${round(durationSec, 1)} с — заметно короче регламента ${meta.targetDurationSec} с.`);
    if (noSignal) report.warnings.push('В аудиозаписи не обнаружен речевой сигнал (слишком тихо или микрофон выключен) — анализ речи пропущен.');
    if (speech && speech.trimmed) report.warnings.push('Проанализированы только первые 10 минут записи.');

    progress(0.9, 'Формирование вопросов');
    report.questions = generateQuestions(report);
    report.rewrites = buildRewrites(text);
    report.highlights = { spans: highlightSpans(text) };
    report.timeline = speech ? speech.timeline : null;
    report.structure = text.structure.map((x) => ({ key: x.key, label: x.label, found: x.found, hits: x.hits, evidence: x.evidence, required: x.required, suggestion: x.suggestion }));
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
      out.push(`Речь: ${s.durationSec} с, темп ~${pace} слов/мин, паузы ${pct(s.pauseRatio)}% времени, вариативность тона ${s.f0.sdSemitones} полутона, HNR ${s.timbre.hnrDb} дБ.`);
    }
    const worst = report.scores.filter((a) => a.available !== false).slice().sort((a, b) => a.score - b.score)[0];
    if (worst) out.push(`Главная зона роста: «${worst.label}» (${worst.score}/100). ${worst.notes[0] || worst.detail}`);
    out.push(`Заготовленных вопросов жюри: ${report.questions.length}.`);
    return out;
  }

  /* ==================== ЭКСПОРТ ОТЧЁТА ==================== */
  function bar(score) { const n = Math.round(clamp(score, 0, 100) / 5); return '█'.repeat(n) + '░'.repeat(20 - n); }

  function buildMarkdown(r) {
    const s = r.speech, t = r.text, m = r.meta;
    const L = [];
    L.push(`# Анализ питча: ${m.topic || 'без темы'}`);
    L.push('');
    L.push(`**Формат:** ${m.format} · **Аудитория:** ${m.audience} · **Отрасль:** ${m.industry || '—'} · **Дата:** ${new Date(m.createdAt).toLocaleString('ru-RU')}`);
    L.push('');
    L.push(`## Итог: ${r.total.score}/100 — ${r.total.grade} (${r.total.label})`);
    L.push('');
    L.push('```');
    for (const a of r.scores) L.push(`${a.label.padEnd(30, ' ')} ${String(a.score).padStart(3, ' ')}/100 ${bar(a.score)}`);
    L.push('```');
    L.push('');
    for (const v of r.verdict) L.push(`- ${v}`);
    if (r.warnings.length) { L.push(''); L.push('**Замечания:**'); r.warnings.forEach((w) => L.push(`- ${w}`)); }
    L.push('');
    L.push('## 1. Речь и голос');
    if (s) {
      L.push('');
      L.push('| Параметр | Значение | Норма/ориентир |');
      L.push('|---|---|---|');
      const pace = (t && t.tempo.wordsPerMin) || s.rate.estimatedWordsPerMin;
      L.push(`| Длительность | ${s.durationSec} с | ${m.targetDurationSec} с |`);
      L.push(`| Время речи / пауз | ${s.speechSec} с / ${s.pauseSec} с (${pct(s.pauseRatio)}%) | паузы ≤ 25% |`);
      L.push(`| Темп | ~${pace} слов/мин (${s.rate.syllablesPerMin} слог/мин) | 130–160 |`);
      L.push(`| Паузы | ${s.pauses.count} (коротких ${s.pauses.short}, заметных ${s.pauses.notable}, длинных ${s.pauses.long}), макс ${s.pauses.longest} с | 5–15 пауз/мин |`);
      L.push(`| Высота тона | медиана ${s.f0.medianHz} Гц (${s.f0.voiceType}), диапазон ${s.f0.p5Hz}–${s.f0.p95Hz} Гц | — |`);
      L.push(`| Вариативность тона | ${s.f0.sdSemitones} полутона (диапазон ${s.f0.rangeSemitones}) | 1,5–3,8 |`);
      L.push(`| Окончания фраз | нисходящих ${pct(s.prosody.downShare)}%, ровных ${pct(s.prosody.flatShare)}%, восходящих ${pct(s.prosody.upShare)}% | восходящих < 25% |`);
      L.push(`| Тембр: яркость | центроид ${s.timbre.centroidHz} Гц, наклон ${s.timbre.slopeDbOct} дБ/окт, ВЧ ${pct(s.timbre.hfRatio)}% | 900–2600 Гц |`);
      L.push(`| Тембр: качество | HNR ${s.timbre.hnrDb} дБ, джиттер ${s.timbre.jitterPct}%, шиммер ${s.timbre.shimmerPct}% | HNR > 15, джиттер < 1%, шиммер < 4% |`);
      L.push(`| Громкость | ${s.loudness.meanDb} дБ (диапазон ${s.loudness.dynRangeDb} дБ, пик ${s.loudness.peakDb} дБ) | −27…−14 |`);
      L.push(`| Запись | шум ${s.loudness.noiseFloorDb} дБ, SNR ${s.loudness.snrDb} дБ, клиппинг ${s.loudness.clippingPct}% | SNR > 20 дБ |`);
      L.push('');
      L.push(`Минуты речи: ${s.rate.syllables} слоговых ядер, вариативность слоговых интервалов ${s.rate.onsetVariabilityMs} мс.`);
    } else L.push('_Аудио не предоставлено: анализ речи не выполнялся._');
    L.push('');
    L.push('## 2. Текст и язык');
    if (t && t.hasText) {
      L.push('');
      L.push('| Параметр | Значение |');
      L.push('|---|---|');
      L.push(`| Слов / предложений | ${t.words} / ${t.sentences} |`);
      L.push(`| Средняя длина предложения | ${t.avgSentenceLen} слов (макс ${t.maxSentenceLen}) |`);
      L.push(`| Читаемость | ${t.flesch} — ${t.readability} |`);
      L.push(`| Позитивные слова | ${t.positive.total} (${t.positive.density} на 100 слов): ${t.positive.list.slice(0, 12).map((x) => x.word).join(', ') || '—'} |`);
      L.push(`| Негативные слова | ${t.negative.total} (${t.negative.density} на 100 слов): ${t.negative.list.slice(0, 12).map((x) => x.word).join(', ') || '—'} |`);
      L.push(`| Слова-паразиты | ${t.fillers.total}: ${t.fillers.list.map((x) => x.word + ' ×' + x.count).join(', ') || '—'} |`);
      L.push(`| Слова-сомнения (хеджи) | ${t.hedges.total}: ${t.hedges.list.map((x) => x.word + ' ×' + x.count).join(', ') || '—'} |`);
      L.push(`| Слова уверенности | ${t.boosters.total}: ${t.boosters.list.map((x) => x.word + ' ×' + x.count).join(', ') || '—'} |`);
      L.push(`| Штампы и канцелярит | ${t.cliches.total}: ${t.cliches.list.map((x) => x.word + ' ×' + x.count).join(', ') || '—'} |`);
      L.push(`| Цифры и метрики | ${t.facts.numbers} (${t.facts.density} на 100 слов), в ${t.facts.sentencesWithNumbers} предложениях |`);
      L.push('');
      L.push('### Структура питча');
      L.push('');
      L.push('| Блок | Есть | Упоминаний | Что добавить |');
      L.push('|---|---|---|---|');
      for (const b of t.structure) L.push(`| ${b.label}${b.required ? ' *' : ''} | ${b.found ? '✅' : '❌'} | ${b.hits} | ${b.found ? '—' : b.suggestion.replace(/\|/g, '/')} |`);
      L.push('');
      L.push('\\* обязательный блок для Demo Day');
      if (t.keywords.length) { L.push(''); L.push(`**Ключевые термины:** ${t.keywords.map((k) => k.word + ' (' + k.count + ')').join(', ')}`); }
    } else L.push('_Транскрипт не предоставлен: анализ текста не выполнялся._');
    L.push('');
    L.push('## 3. Сильные стороны');
    r.feedback.strengths.forEach((x) => L.push(`- **${x.title}.** ${x.detail}`));
    if (!r.feedback.strengths.length) L.push('- Пока не выявлено — начните с раскрытия блоков структуры.');
    L.push('');
    L.push('## 4. Зоны роста и что делать');
    r.feedback.weaknesses.forEach((x) => L.push(`- **${x.title}.** ${x.detail}\n  - *Что делать:* ${x.action}`));
    if (!r.feedback.weaknesses.length) L.push('- Критических замечаний нет.');
    L.push('');
    L.push('## 5. Быстрые улучшения');
    r.feedback.quickWins.slice(0, 8).forEach((x, i) => L.push(`${i + 1}. ${x.title}`));
    L.push('');
    if (r.rewrites && r.rewrites.length) {
      L.push('## 6. Переписанные фразы');
      r.rewrites.forEach((x, i) => { L.push(''); L.push(`**${i + 1}.**`); L.push(`- Было: «${x.before}»`); L.push(`- Стало: «${x.after}»`); L.push(`- Почему: ${x.reasons.join('; ') || 'убраны ослабители'}`); });
      L.push('');
    }
    L.push('## ' + (r.rewrites && r.rewrites.length ? 7 : 6) + '. Вопросы уровня Demo Day и заготовки ответов');
    const groups = {};
    r.questions.forEach((q) => { (groups[q.blockLabel] = groups[q.blockLabel] || []).push(q); });
    for (const k of Object.keys(groups)) {
      L.push('');
      L.push(`### ${k}`);
      for (const q of groups[k]) {
        L.push('');
        L.push(`**${q.q}**  _(${'★'.repeat(q.difficulty)})_`);
        L.push(`- Почему спросят: ${q.why}`);
        L.push(`- Каркас ответа: ${q.frame}`);
        L.push(`- Чего избегать: ${q.avoid}`);
        if (q.source) L.push(`- Источник: ${q.source}`);
      }
    }
    L.push('');
    L.push('---');
    L.push('_Отчёт сформирован локально приложением «ИИ-анализ питча» (PitchEngine). Речевые метрики рассчитаны по записи (автокорреляционный анализ тона, спектральные признаки, детекция пауз и слоговых ядер); текстовые — по транскрипту и словарям русского языка. Это инструмент тренировки, а не оценка жюри._');
    return L.join('\n');
  }

  function buildStandaloneHtml(r) {
    const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const axis = (a) => `<div class="axis"><div class="axis-top"><b>${esc(a.label)}</b><span>${a.available === false ? 'н/д' : a.score + '/100'}</span></div>
      <div class="track"><i style="width:${a.available === false ? 0 : a.score}%;background:${a.available === false ? '#64748b' : a.score >= 75 ? '#22c55e' : a.score >= 55 ? '#f59e0b' : '#ef4444'}"></i></div>
      <div class="axis-detail">${esc(a.detail)}</div>${a.notes.map((n) => `<div class="axis-note">• ${esc(n)}</div>`).join('')}</div>`;
    const metric = (k, v) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`;
    const s = r.speech, t = r.text;
    let html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Анализ питча — ${esc(r.meta.topic)}</title>
<style>
:root{color-scheme:light dark}
body{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;max-width:1000px;margin:0 auto;padding:32px 20px;line-height:1.55;background:#0b1220;color:#e6edf7}
h1{margin:0 0 4px;font-size:30px}h2{margin-top:34px;border-bottom:1px solid #1e293b;padding-bottom:6px;font-size:21px}h3{font-size:17px;margin-bottom:6px}
.sub{color:#93a4bd;font-size:14px}
.score{display:flex;gap:18px;align-items:center;margin:18px 0;padding:18px;border-radius:14px;background:#111c31;border:1px solid #1e293b}
.big{font-size:46px;font-weight:700}.grade{padding:4px 12px;border-radius:999px;background:#0f2f1f;color:#4ade80;font-weight:600}
.axis{margin:10px 0;padding:10px 12px;background:#111c31;border:1px solid #1e293b;border-radius:10px}
.axis-top{display:flex;justify-content:space-between;gap:10px}.axis-detail{color:#9fb0c9;font-size:13px;margin-top:4px}
.axis-note{color:#fbbf24;font-size:13px}
.track{height:7px;background:#1e293b;border-radius:6px;margin:6px 0;overflow:hidden}.track i{display:block;height:100%}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:14px}td,th{border:1px solid #1e293b;padding:7px 9px;text-align:left;vertical-align:top}
th{background:#111c31}
.q{background:#111c31;border:1px solid #1e293b;border-radius:10px;padding:12px 14px;margin:10px 0}
.q b{color:#cfe0f7}.q .meta{color:#93a4bd;font-size:13px;margin-top:6px}
.tag{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;background:#1e293b;color:#a5b4fc;margin-left:6px}
ul{margin:6px 0 6px 18px}li{margin:3px 0}
.bad{color:#fca5a5}.good{color:#86efac}
footer{margin-top:36px;color:#7b8ba6;font-size:12px;border-top:1px solid #1e293b;padding-top:12px}
</style></head><body>
<h1>Анализ питча${r.meta.topic ? ': ' + esc(r.meta.topic) : ''}</h1>
<div class="sub">Формат: ${esc(r.meta.format)} · Аудитория: ${esc(r.meta.audience)} · Отрасль: ${esc(r.meta.industry || '—')} · ${esc(new Date(r.meta.createdAt).toLocaleString('ru-RU'))}</div>
<div class="score"><div class="big">${r.total.score}</div><div><div class="grade">${esc(r.total.grade)} — ${esc(r.total.label)}</div><div class="sub">оценка по ${r.total.axes} осям${r.meta.hasAudio ? '' : ' (без аудио)'}${r.meta.hasText ? '' : ' (без текста)'}</div></div></div>
<ul>${r.verdict.map((v) => `<li>${esc(v)}</li>`).join('')}</ul>
<h2>Оценки</h2>${r.scores.map(axis).join('')}`;
    if (s) {
      html += `<h2>Речь и голос</h2><table>`
        + metric('Длительность', s.durationSec + ' с (регламент ' + r.meta.targetDurationSec + ' с)')
        + metric('Речь / паузы', s.speechSec + ' с / ' + s.pauseSec + ' с (' + pct(s.pauseRatio) + '%)')
        + metric('Темп', '~' + ((t && t.tempo.wordsPerMin) || s.rate.estimatedWordsPerMin) + ' слов/мин')
        + metric('Паузы', s.pauses.count + ' шт. (коротких ' + s.pauses.short + ', заметных ' + s.pauses.notable + ', длинных ' + s.pauses.long + '), макс ' + s.pauses.longest + ' с')
        + metric('Тон', 'медиана ' + s.f0.medianHz + ' Гц (' + s.f0.voiceType + '), диапазон ' + s.f0.p5Hz + '–' + s.f0.p95Hz + ' Гц, вариативность ' + s.f0.sdSemitones + ' полутона')
        + metric('Окончания фраз', 'вниз ' + pct(s.prosody.downShare) + '%, ровно ' + pct(s.prosody.flatShare) + '%, вверх ' + pct(s.prosody.upShare) + '%')
        + metric('Тембр', 'центроид ' + s.timbre.centroidHz + ' Гц, наклон ' + s.timbre.slopeDbOct + ' дБ/окт, ВЧ ' + pct(s.timbre.hfRatio) + '%')
        + metric('Качество голоса', 'HNR ' + s.timbre.hnrDb + ' дБ, джиттер ' + s.timbre.jitterPct + '%, шиммер ' + s.timbre.shimmerPct + '%')
        + metric('Громкость', s.loudness.meanDb + ' дБ, диапазон ' + s.loudness.dynRangeDb + ' дБ, пик ' + s.loudness.peakDb + ' дБ')
        + metric('Запись', 'шум ' + s.loudness.noiseFloorDb + ' дБ, SNR ' + s.loudness.snrDb + ' дБ, клиппинг ' + s.loudness.clippingPct + '%')
        + `</table>`;
    }
    if (t && t.hasText) {
      html += `<h2>Текст и язык</h2><table>`
        + metric('Слов / предложений', t.words + ' / ' + t.sentences)
        + metric('Средняя длина предложения', t.avgSentenceLen + ' слов')
        + metric('Читаемость', t.flesch + ' — ' + t.readability)
        + metric('Позитивные слова', t.positive.total + ': ' + (t.positive.list.slice(0, 14).map((x) => x.word).join(', ') || '—'))
        + metric('Негативные слова', t.negative.total + ': ' + (t.negative.list.slice(0, 14).map((x) => x.word).join(', ') || '—'))
        + metric('Слова-паразиты', t.fillers.total + ': ' + (t.fillers.list.map((x) => x.word + ' ×' + x.count).join(', ') || '—'))
        + metric('Хеджи', t.hedges.total + ': ' + (t.hedges.list.map((x) => x.word + ' ×' + x.count).join(', ') || '—'))
        + metric('Уверенные формулировки', t.boosters.total + ': ' + (t.boosters.list.map((x) => x.word + ' ×' + x.count).join(', ') || '—'))
        + metric('Штампы', t.cliches.total + ': ' + (t.cliches.list.map((x) => x.word + ' ×' + x.count).join(', ') || '—'))
        + metric('Цифры и метрики', t.facts.numbers + ' (' + t.facts.density + ' на 100 слов)')
        + `</table><h3>Структура питча</h3><table><tr><th>Блок</th><th>Есть</th><th>Упоминаний</th><th>Что добавить</th></tr>`
        + t.structure.map((b) => `<tr><td>${esc(b.label)}${b.required ? ' *' : ''}</td><td>${b.found ? '✅' : '❌'}</td><td>${b.hits}</td><td>${esc(b.found ? '—' : b.suggestion)}</td></tr>`).join('')
        + `</table>`;
    }
    html += `<h2>Сильные стороны</h2><ul>${r.feedback.strengths.map((x) => `<li><b>${esc(x.title)}.</b> ${esc(x.detail)}</li>`).join('') || '<li>—</li>'}</ul>`;
    html += `<h2>Зоны роста</h2><ul>${r.feedback.weaknesses.map((x) => `<li><b class="bad">${esc(x.title)}.</b> ${esc(x.detail)}<br><i>Что делать: ${esc(x.action)}</i></li>`).join('') || '<li>—</li>'}</ul>`;
    html += `<h2>Быстрые улучшения</h2><ol>${r.feedback.quickWins.map((x) => `<li>${esc(x.title)}</li>`).join('')}</ol>`;
    if (r.rewrites && r.rewrites.length) html += `<h2>Переписанные фразы</h2>${r.rewrites.map((x) => `<div class="q"><div class="bad"><b>Было:</b> ${esc(x.before)}</div><div class="good"><b>Стало:</b> ${esc(x.after)}</div><div class="meta">${esc(x.reasons.join('; '))}</div></div>`).join('')}`;
    const groups = {};
    r.questions.forEach((q) => { (groups[q.blockLabel] = groups[q.blockLabel] || []).push(q); });
    html += `<h2>Вопросы Demo Day и каркасы ответов</h2>`;
    for (const k of Object.keys(groups)) {
      html += `<h3>${esc(k)}</h3>`;
      for (const q of groups[k]) {
        html += `<div class="q"><b>${esc(q.q)}</b><span class="tag">${'★'.repeat(q.difficulty)}</span><div class="meta"><b>Почему спросят:</b> ${esc(q.why)}<br><b>Каркас ответа:</b> ${esc(q.frame)}<br><b>Чего избегать:</b> ${esc(q.avoid)}</div></div>`;
      }
    }
    html += `<footer>Отчёт сформирован локально приложением «ИИ-анализ питча» (${esc(r.meta.engine)}). Речевые метрики: автокорреляционный анализ основного тона, спектральные признаки (центроид, наклон, ВЧ), детекция пауз и слоговых ядер, HNR/джиттер/шиммер. Текстовые: словари русского языка, структура питча, шаблоны вопросов. Инструмент тренировки, а не оценка жюри.</footer>
</body></html>`;
    return html;
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

  return {
    analyze, analyzeAudio, analyzeText, generateQuestions, buildMarkdown, buildStandaloneHtml,
    improveSentence, buildRewrites, parseSubtitle, highlightSpans, gradeOf, WEIGHTS,
    _internal: { fftInPlace, pitchOfFrame, resample, lowpass, tokenize, splitSentences, stemRe, collect, percentile, median, bandScore, blockLabel }
  };
});
