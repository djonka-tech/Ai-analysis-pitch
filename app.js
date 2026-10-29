/* ============================================================
   app.js — интерфейс «ИИ-анализ питча»
   ============================================================ */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const E = window.PitchEngine, LEX = window.PitchLexicon, LLM = window.PitchLLM;

  /* защита от «мёртвой страницы»: любая ошибка видна пользователю */
  window.addEventListener('error', (e) => {
    const msg = (e && e.message) || 'неизвестная ошибка';
    document.title = 'ОШИБКА: ' + msg;
    let b = document.getElementById('errBanner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'errBanner';
      b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99;background:#7f1d1d;color:#fee2e2;padding:10px 16px;font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;border-top:1px solid #b91c1c';
      document.body.appendChild(b);
    }
    b.textContent = 'Ошибка интерфейса: ' + msg + '. Обновите страницу (F5). Если повторяется — сообщите текст ошибки.';
  });
  if (!E || !LEX || !LLM) {
    document.body.innerHTML = '<div style="padding:40px;font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#fca5a5">Не загрузились модули (lexicon.js / engine.js / llm.js). Проверьте, что все файлы лежат рядом с index.html.</div>';
    return;
  }

  const state = {
    report: null, samples: null, sampleRate: 0, audioBlob: null, audioName: '',
    cues: null, recording: false, stream: null, recorder: null, chunks: [], analyser: null,
    audioCtx: null, mediaStreamSrc: null, recognition: null, asrFinal: '', asrInterim: '',
    recStart: 0, recTimerId: null, levelId: null, levelHistory: [], silenceStart: 0, pauseCount: 0,
    cueStart: null, levelThreshold: 0.012, chatHistory: [], demo: false, lastLevel: 0
  };

  const SAMPLE_PITCH = `Добрый день, меня зовут Алексей, мы делаем платформу компьютерного зрения для приёмки товара на складе.
Проблема: склады теряют до 18% рабочего времени на ручной проверке поставок, а ошибки приёмки стоят ритейлеру до 4 миллионов рублей в год на один распределительный центр.
Наше решение — камера на воротах и модель, которая сверяет накладную с фактом за 12 секунд вместо 6 минут. Пилот на двух складах показал точность 99,2%.
Рынок складской автоматизации в России — 42 миллиарда рублей, наш сегмент — приёмка на распределительных центрах, это 3,5 миллиарда.
Бизнес-модель: подписка 120 тысяч рублей в месяц за склад, маржинальность 68 процентов, окупаемость для клиента 7 месяцев.
Traction: четыре пилота, два перешли в годовые контракты, выручка выросла с 300 тысяч до 1,2 миллиона рублей за пять месяцев.
Конкуренты — «Скан-Тех» и зарубежные решения, наше отличие — работа на потоке три метра в секунду без остановки линии.
Команда: три основателя, 12 лет опыта в логистике, мы уже внедрили систему в двух федеральных сетях.
Привлекаем 30 миллионов рублей seed на 18 месяцев: 40 процентов в продукт, 40 в продажи, 20 в найм. К концу раунда — 20 платящих складов и выручка 2,5 миллиона рублей в месяц.
Может быть, мы постараемся выйти в Казахстан, но пока, в общем, надеемся на пилоты. Спасибо, готовы ответить на вопросы.`;

  /* ==================== НАВИГАЦИЯ ==================== */
  function showStep(n) {
    $$('.screen').forEach((s) => s.classList.toggle('hidden', s.dataset.screen !== String(n)));
    $$('.step').forEach((b) => {
      const i = +b.dataset.step;
      b.classList.toggle('active', i === n);
      b.classList.toggle('done', i < n);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  $$('.step').forEach((b) => b.addEventListener('click', () => {
    const n = +b.dataset.step;
    if (n === 4 && !state.report) return;
    if (n === 3) return;
    showStep(n);
  }));

  /* ==================== ФОРМА ==================== */
  const meta = () => ({
    topic: $('#topic').value.trim(),
    industry: $('#industry').value.trim(),
    format: $('#format').value,
    audience: $('#audience').value.trim() || 'инвесторы и эксперты',
    targetDurationSec: +$('#regulation').value
  });

  $('#btnToRec').addEventListener('click', () => {
    if (!$('#topic').value.trim()) {
      $('#topic').focus();
      $('#topic').style.borderColor = '#ef4444';
      flash($('#topic'), 'Укажите тему проекта — по ней строятся вопросы жюри');
      return;
    }
    $('#topic').style.borderColor = '';
    showStep(2);
  });
  $('#btnBack1').addEventListener('click', () => showStep(1));
  $('#btnBack2').addEventListener('click', () => { showStep(2); });
  $('#btnNew').addEventListener('click', () => {
    state.report = null; state.samples = null; state.audioBlob = null; state.cues = null;
    $('#report').innerHTML = ''; $('#transcript').value = ''; updateTrCount();
    showStep(1);
  });

  function flash(input, msg) {
    const d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText = 'color:#fca5a5;font-size:12.5px;margin-top:4px';
    input.parentNode.appendChild(d);
    setTimeout(() => d.remove(), 3500);
  }

  /* ==================== ВКЛАДКИ ==================== */
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== t.dataset.tab));
  }));

  /* ==================== ТРАНСКРИПТ ==================== */
  const tr = $('#transcript');
  function updateTrCount() {
    const words = (tr.value.match(/[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9\-]*/g) || []).length;
    $('#trCount').textContent = words + ' слов · ' + tr.value.length + ' символов';
  }
  tr.addEventListener('input', updateTrCount);
  $('#btnSample').addEventListener('click', () => {
    tr.value = SAMPLE_PITCH; updateTrCount();
    if (!$('#topic').value.trim()) $('#topic').value = 'ИИ-платформа приёмки товара на складе';
    if (!$('#industry').value.trim()) $('#industry').value = 'Логистика и склад';
    $('#trSource').textContent = '— пример питча';
  });
  $('#btnClear').addEventListener('click', () => { tr.value = ''; updateTrCount(); $('#trSource').textContent = ''; });

  /* ==================== ЗАПИСЬ С МИКРОФОНА ==================== */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const asrBadge = $('#asrStatus');
  if (!SR) {
    asrBadge.textContent = 'недоступно в этом браузере';
    asrBadge.className = 'badge bad';
    $('#liveTranscript').textContent = 'Автоматическое распознавание недоступно (нужен Chrome или Edge). Запись всё равно работает: вставьте расшифровку в поле ниже.';
  } else {
    asrBadge.textContent = 'готово (Chrome/Edge, нужен интернет)';
    asrBadge.className = 'badge ok';
  }
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    $('#btnRec').disabled = true;
    $('#recStatus').textContent = 'Запись недоступна: браузер не поддерживает MediaRecorder.';
  }
  if (location.protocol === 'file:') {
    $('#recStatus').textContent = 'Открыто как файл: микрофон может быть недоступен. Запустите start.bat и откройте http://127.0.0.1:8777';
  }

  function pickMime() {
    const list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4', ''];
    for (const m of list) {
      if (!m) return '';
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* noop */ }
    }
    return '';
  }

  function fmtTime(sec) {
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function startAsr() {
    if (!SR) return;
    try {
      const r = new SR();
      r.lang = 'ru-RU'; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
      r.onresult = (ev) => {
        let interim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i];
          if (res.isFinal) {
            const txt = res[0].transcript.trim();
            if (txt) {
              state.asrFinal += (state.asrFinal ? ' ' : '') + txt;
              const now = (Date.now() - state.recStart) / 1000;
              state.cues = state.cues || [];
              state.cues.push({ start: round2(state.cueStart == null ? Math.max(0, now - txt.length / 14) : state.cueStart), end: round2(now), text: txt });
              state.cueStart = null;
            }
          } else {
            interim += res[0].transcript;
            if (state.cueStart == null) state.cueStart = (Date.now() - state.recStart) / 1000;
          }
        }
        state.asrInterim = interim;
        tr.value = (state.asrFinal + ' ' + interim).trim();
        updateTrCount();
        $('#liveTranscript').innerHTML = esc(tr.value || '') + (interim ? ' <span class="muted">…</span>' : '');
        $('#trSource').textContent = '— распознано в браузере';
      };
      r.onerror = (e) => {
        const code = e && e.error;
        asrBadge.textContent = 'ошибка: ' + code;
        asrBadge.className = 'badge bad';
        if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') state.asrDead = true;
        if (code === 'network') addTip('bad', 'Сервис распознавания недоступен (нет интернета). Речь всё равно записывается: вставьте расшифровку вручную.');
        if (code === 'not-allowed') addTip('bad', 'Нет доступа к микрофону для распознавания. Разрешите доступ в браузере.');
      };
      r.onend = () => {
        if (state.recording && !state.asrDead) { try { r.start(); } catch (e) { state.asrDead = true; } }
      };
      r.start();
      state.recognition = r;
    } catch (e) {
      asrBadge.textContent = 'ошибка запуска';
      asrBadge.className = 'badge bad';
    }
  }

  const round2 = (x) => Math.round(x * 100) / 100;

  function addTip(kind, text) {
    const box = $('#liveTips');
    if ($$('.tip', box).some((t) => t.dataset.text === text)) return;
    const d = document.createElement('div');
    d.className = 'tip ' + kind; d.dataset.text = text; d.textContent = text;
    box.appendChild(d);
  }

  function countFillers(text) {
    if (!text) return 0;
    let n = 0;
    for (const item of LEX.FILLERS) {
      let re;
      try { re = new RegExp(E._internal.stemRe(item.f), 'gi'); } catch (e) { continue; }
      const m = text.match(re);
      if (m) n += m.length;
    }
    return n;
  }

  function liveUpdate() {
    const elapsed = (Date.now() - state.recStart) / 1000;
    const words = (tr.value.match(/[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9\-]*/g) || []).length;
    const wpm = elapsed > 8 ? Math.round(words / (elapsed / 60)) : 0;
    $('#lmWords').textContent = words;
    $('#lmWpm').textContent = elapsed > 8 ? wpm : '—';
    $('#lmPauses').textContent = state.pauseCount;
    $('#lmFillers').textContent = countFillers(tr.value);
    $('#lmVolume').textContent = state.lastLevel > 0 ? Math.round(20 * Math.log10(state.lastLevel)) + ' дБ' : '—';
    const limit = +$('#regulation').value;
    $('#recLimit').textContent = limit ? `Регламент: ${fmtTime(limit)}` : 'Без регламента';
    if (elapsed > 12) {
      if (wpm > 185) addTip('warn', 'Темп выше 185 слов/мин — зал не успевает осмыслить цифры. Сделайте паузу.');
      else if (wpm > 0 && wpm < 105) addTip('warn', 'Темп ниже 105 слов/мин — питч может не уложиться в регламент.');
      const f = countFillers(tr.value);
      if (f >= 3) addTip('warn', `Уже ${f} слов-паразитов. Заменяйте их паузой в полсекунды.`);
      if (state.pauseCount === 0) addTip('ok', 'Пока нет длинных пауз — речь идёт ровно.');
    }
    if (state.lastLevel > 0 && 20 * Math.log10(state.lastLevel) < -34 && elapsed > 5) addTip('warn', 'Тихий сигнал: слышно далеко не всё, говорите громче или ближе к микрофону.');
    if (limit && elapsed >= limit) {
      addTip('ok', 'Регламент истёк — можно останавливать запись.');
      if (state.recording) stopRecording();
    }
  }

  function drawLevel() {
    const c = $('#levelCanvas'), dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 800, h = 90;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#08111f'; ctx.fillRect(0, 0, w, h);
    const hist = state.levelHistory.slice(-Math.floor(w / 3));
    ctx.strokeStyle = 'rgba(47,212,79,.85)'; ctx.lineWidth = 2; ctx.beginPath();
    hist.forEach((v, i) => {
      const x = (i / Math.max(1, hist.length - 1)) * w;
      const y = h - Math.min(1, v * 6) * (h - 8) - 4;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = 'rgba(148,163,184,.35)';
    ctx.fillRect(0, h - 3, w, 1);
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      state.stream = stream;
      state.audioCtx = state.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (state.audioCtx.state === 'suspended') await state.audioCtx.resume();
      const src = state.audioCtx.createMediaStreamSource(stream);
      const an = state.audioCtx.createAnalyser();
      an.fftSize = 2048;
      src.connect(an);
      state.analyser = an;
      state.mediaStreamSrc = src;
      const buf = new Float32Array(an.fftSize);
      state.levelHistory = [];
      state.pauseCount = 0; state.silenceStart = 0; state.lastLevel = 0;

      state.levelId = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        const rms = Math.sqrt(s / buf.length);
        state.lastLevel = rms;
        state.levelHistory.push(rms);
        if (state.levelHistory.length > 4000) state.levelHistory.shift();
        const now = Date.now();
        if (rms < state.levelThreshold) {
          if (!state.silenceStart) state.silenceStart = now;
          else if (now - state.silenceStart > 500 && !state.silenceCounted) { state.pauseCount++; state.silenceCounted = true; }
        } else { state.silenceStart = 0; state.silenceCounted = false; }
        drawLevel();
      }, 60);

      const mime = pickMime();
      state.chunks = [];
      state.recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
      state.recorder.ondataavailable = (e) => { if (e.data && e.data.size) state.chunks.push(e.data); };
      state.recorder.onstop = () => {
        state.audioBlob = new Blob(state.chunks, { type: state.recorder.mimeType || 'audio/webm' });
        $('#recStatus').textContent = 'Запись готова: ' + (state.audioBlob.size / 1048576).toFixed(2) + ' МБ';
        $('#analyzeHint').textContent = 'Запись ' + fmtTime((Date.now() - state.recStart) / 1000) + ' готова к анализу.';
        ensureSamples();
      };
      state.recorder.start(1000);

      state.recStart = Date.now();
      state.recording = true;
      state.asrFinal = ''; state.asrInterim = ''; state.cues = null; state.cueStart = null;
      tr.value = ''; updateTrCount();
      $('#liveTips').innerHTML = '';
      $('#liveTranscript').textContent = 'Слушаю…';
      $('#btnRec').classList.add('hidden');
      $('#btnStop').classList.remove('hidden');
      $('#recStatus').textContent = 'Идёт запись. Говорите как на сцене.';
      state.recTimerId = setInterval(() => {
        const el = (Date.now() - state.recStart) / 1000;
        $('#recTimer').textContent = fmtTime(el);
        liveUpdate();
      }, 250);
      startAsr();
    } catch (e) {
      $('#recStatus').textContent = 'Не удалось получить доступ к микрофону: ' + (e && e.message ? e.message : e);
      addTip('bad', 'Разрешите доступ к микрофону в настройках браузера и попробуйте снова.');
    }
  }

  function stopRecording() {
    if (!state.recording) return;
    state.recording = false;
    clearInterval(state.recTimerId);
    clearInterval(state.levelId);
    try { state.recorder && state.recorder.state !== 'inactive' && state.recorder.stop(); } catch (e) { /* noop */ }
    try { state.recognition && state.recognition.stop(); } catch (e) { /* noop */ }
    try { state.stream && state.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* noop */ }
    $('#btnRec').classList.remove('hidden');
    $('#btnStop').classList.add('hidden');
    tr.value = (state.asrFinal + ' ' + state.asrInterim).trim();
    state.asrInterim = '';
    updateTrCount();
    drawLevel();
  }

  $('#btnRec').addEventListener('click', startRecording);
  $('#btnStop').addEventListener('click', stopRecording);

  /* ==================== ФАЙЛ ==================== */
  const dz = $('#dropZone'), fi = $('#fileInput');
  dz.addEventListener('click', () => fi.click());
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  fi.addEventListener('change', () => { if (fi.files[0]) handleFile(fi.files[0]); });

  async function handleFile(file) {
    state.audioName = file.name;
    $('#fileInfo').classList.remove('hidden');
    $('#fileInfo').innerHTML = `<b>${esc(file.name)}</b> · ${(file.size / 1048576).toFixed(2)} МБ · <span class="muted">декодирую…</span>`;
    state.audioBlob = file;
    const ctx = state.audioCtx || (state.audioCtx = new (window.AudioContext || window.webkitAudioContext)());
    try {
      const ab = await file.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      state.sampleRate = buf.sampleRate;
      state.samples = downmix(buf);
      const dur = buf.duration;
      $('#fileInfo').innerHTML = `<b>${esc(file.name)}</b> · ${(file.size / 1048576).toFixed(2)} МБ · ${buf.numberOfChannels} канал(ов) · ${buf.sampleRate} Гц · <b>${fmtTime(dur)}</b> · сигнал готов к анализу`;
      $('#analyzeHint').textContent = 'Аудио загружено (' + fmtTime(dur) + '). Добавьте расшифровку для анализа текста.';
      if (!$('#trSource').textContent) $('#trSource').textContent = '— вставьте расшифровку или загрузите .srt';
    } catch (e) {
      state.samples = null;
      $('#fileInfo').innerHTML = `<b>${esc(file.name)}</b> · <span style="color:#fca5a5">не удалось декодировать аудио</span>. Попробуйте wav/mp3 или конвертируйте файл. Анализ текста всё равно доступен.`;
    }
  }
  function downmix(buf) {
    const n = buf.length, out = new Float32Array(n);
    if (buf.numberOfChannels === 1) { buf.copyFromChannel(out, 0); return out; }
    const tmp = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      buf.copyFromChannel(tmp, c);
      for (let i = 0; i < n; i++) out[i] += tmp[i] / buf.numberOfChannels;
    }
    return out;
  }

  /** декодировать сохранённую запись (микрофон/файл) в сэмплы для анализа */
  let decoding = null;
  function ensureSamples() {
    if (state.samples) return Promise.resolve(true);
    if (!state.audioBlob) return Promise.resolve(false);
    if (decoding) return decoding;
    decoding = (async () => {
      try {
        const ctx = state.audioCtx || (state.audioCtx = new (window.AudioContext || window.webkitAudioContext)());
        const ab = await state.audioBlob.arrayBuffer();
        const buf = await ctx.decodeAudioData(ab);
        state.sampleRate = buf.sampleRate;
        state.samples = downmix(buf);
        if (!$('#analyzeHint').textContent) $('#analyzeHint').textContent = 'Аудио готово: ' + fmtTime(buf.duration);
        return true;
      } catch (e) {
        state.samples = null;
        return false;
      } finally { decoding = null; }
    })();
    return decoding;
  }

  $('#subsInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const parsed = E.parseSubtitle(String(r.result));
      if (parsed) {
        tr.value = parsed.text; state.cues = parsed.cues;
        $('#trSource').textContent = '— из субтитров (' + parsed.cues.length + ' реплик)';
      } else {
        tr.value = String(r.result); $('#trSource').textContent = '— из файла';
      }
      updateTrCount();
    };
    r.readAsText(f, 'utf-8');
  });

  $('#btnWhisper').addEventListener('click', async () => {
    const cfg = LLM.loadConfig();
    const problem = LLM.ready(cfg);
    if (!state.audioBlob) { alert('Сначала загрузите аудио или видео файл.'); return; }
    if (problem) { alert('Для распознавания нужен настроенный ИИ-сервис: ' + problem + '.\nЗаполните панель «ИИ-тренер» внизу страницы.'); return; }
    const btn = $('#btnWhisper');
    btn.disabled = true; btn.textContent = 'Распознаю…';
    try {
      const text = await LLM.transcribe(state.audioBlob, cfg, state.audioName || 'pitch.webm');
      tr.value = text; updateTrCount();
      $('#trSource').textContent = '— распознано через ИИ (' + cfg.model + ')';
    } catch (e) {
      alert('Не удалось распознать: ' + e.message);
    } finally { btn.disabled = false; btn.textContent = 'Распознать через ИИ (нужен ключ)'; }
  });

  /* ==================== АНАЛИЗ ==================== */
  let fakeTimer = null;
  function startFakeProgress(until) {
    let p = 3;
    const bar = $('#progressBar'), label = $('#progressLabel');
    const stages = [
      [10, 'Читаю запись и считаю уровни громкости…'],
      [28, 'Ищу речевые кадры, паузы и слоговые ядра…'],
      [48, 'Считаю основной тон (F0) и вариативность интонации…'],
      [66, 'Разбираю тембр: спектр, HNR, джиттер, шиммер…'],
      [78, 'Анализирую текст: словари, структура, цифры…'],
      [90, 'Формирую оценки и вопросы жюри…']
    ];
    let i = 0;
    bar.style.width = '3%';
    fakeTimer = setInterval(() => {
      p = Math.min(until || 94, p + Math.max(0.6, (94 - p) * 0.06));
      bar.style.width = p.toFixed(1) + '%';
      while (i < stages.length && p >= stages[i][0]) { label.textContent = stages[i][1]; i++; }
    }, 90);
  }
  function stopFakeProgress() {
    clearInterval(fakeTimer);
    $('#progressBar').style.width = '100%';
    $('#progressLabel').textContent = 'Готово. Формирую отчёт…';
  }

  $('#btnAnalyze').addEventListener('click', runAnalysis);

  async function runAnalysis() {
    if (state.recording) stopRecording();
    if (state.audioBlob && !state.samples) {
      showStep(3);
      $('#progressLabel').textContent = 'Декодирую запись…';
      $('#progressBar').style.width = '4%';
      await ensureSamples();
    }
    const text = tr.value.trim();
    const useAudio = !!state.samples;
    if (!useAudio && !text) {
      showStep(2);
      alert('Нужна запись или текст выступления. Запишите питч с микрофона, загрузите файл или вставьте расшифровку.');
      return;
    }
    showStep(3);
    startFakeProgress();
    await new Promise((r) => setTimeout(r, 120));
    try {
      const report = E.analyze({
        samples: state.samples,
        sampleRate: state.sampleRate,
        text,
        cues: state.cues,
        meta: meta(),
        durationSec: state.samples ? state.samples.length / state.sampleRate : 0
      });
      state.report = report;
      stopFakeProgress();
      renderReport(report);
      showStep(4);
    } catch (e) {
      stopFakeProgress();
      $('#progressLabel').innerHTML = '<span style="color:#fca5a5">Ошибка анализа: ' + esc(e.message) + '</span>';
      console.error(e);
    }
  }

  /* ==================== ОТЧЁТ ==================== */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pct = (v) => Math.round(v * 100);
  const scoreColor = (s) => (s >= 75 ? '#22c55e' : s >= 55 ? '#f59e0b' : '#ef4444');

  function renderReport(r) {
    const host = $('#report');
    const m = r.meta, t = r.text, s = r.speech;
    const html = [];

    /* — итог — */
    html.push(`<div class="score-hero">
      <div style="text-align:center">
        <div class="big-score" style="color:${scoreColor(r.total.score)}">${r.total.score}</div>
        <div class="grade-chip" style="background:${r.total.color}22;color:${r.total.color}">${esc(r.total.grade)} — ${esc(r.total.label)}</div>
        <div class="muted small" style="margin-top:8px">${r.total.axes} осей · ${m.hasAudio ? 'речь + текст' : 'только текст'}</div>
      </div>
      <div class="verdict">
        <b>${esc(m.topic || 'Питч')}</b>
        <div class="muted small">${esc(m.format)} · ${esc(m.audience)} · регламент ${m.targetDurationSec ? m.targetDurationSec + ' с' : '—'} · факт ${m.durationSec} с</div>
        <ul>${r.verdict.map((v) => `<li>${esc(v)}</li>`).join('')}</ul>
        ${r.warnings.length ? `<div class="warn-list">⚠ ${r.warnings.map(esc).join('<br>⚠ ')}</div>` : ''}
      </div>
    </div>`);

    /* — графики — */
    html.push(`<div class="panel-card">
      <h2>Профиль питча</h2>
      <div class="charts">
        <div><canvas id="radar" class="chart" height="330"></canvas></div>
        <div>
          ${s ? '<canvas id="timeline" class="chart" height="280"></canvas>' : '<div class="muted">Таймлайн речи появится, если добавить аудиозапись.</div>'}
          ${s ? `<div class="legend">
            <span><i style="background:#2fd44f"></i>тон (полутоны от медианы)</span>
            <span><i style="background:#3b82f6"></i>громкость, дБ</span>
            <span><i style="background:#f59e0b"></i>паузы</span>
          </div>` : ''}
        </div>
      </div>
      <h3>Оценки по осям</h3>
      <div class="axes">${r.scores.map(axisHtml).join('')}</div>
    </div>`);

    /* — речь — */
    if (s) {
      const pace = (t && t.tempo.wordsPerMin) || s.rate.estimatedWordsPerMin;
      html.push(`<div class="panel-card">
        <h2>Речь и голос</h2>
        <div class="split">
          <div>
            <h3>Параметры речи</h3>
            <table class="metrics">
              <tr><td>Длительность</td><td>${s.durationSec} с${m.targetDurationSec ? ' при регламенте ' + m.targetDurationSec + ' с' : ''}</td></tr>
              <tr><td>Речь / паузы</td><td>${s.speechSec} с / ${s.pauseSec} с (${pct(s.pauseRatio)}% времени — паузы)</td></tr>
              <tr><td>Темп</td><td>~${pace} слов/мин · ${s.rate.syllablesPerMin} слогов/мин${t && t.tempo.source ? ' (' + esc(t.tempo.source) + ')' : ''}</td></tr>
              <tr><td>Паузы</td><td>${s.pauses.count} шт.: коротких ${s.pauses.short}, заметных ${s.pauses.notable}, длинных ${s.pauses.long} · макс ${s.pauses.longest} с · ${s.pauses.perMin}/мин</td></tr>
              <tr><td>Тон (F0)</td><td>медиана ${s.f0.medianHz} Гц (${esc(s.f0.voiceType)}), диапазон ${s.f0.p5Hz}–${s.f0.p95Hz} Гц</td></tr>
              <tr><td>Интонация</td><td>вариативность ${s.f0.sdSemitones} полутона (диапазон ${s.f0.rangeSemitones})</td></tr>
              <tr><td>Окончания фраз</td><td>вниз ${pct(s.prosody.downShare)}% · ровно ${pct(s.prosody.flatShare)}% · вверх ${pct(s.prosody.upShare)}%</td></tr>
              <tr><td>Яркость тембра</td><td>центроид ${s.timbre.centroidHz} Гц · наклон ${s.timbre.slopeDbOct} дБ/окт · ВЧ ${pct(s.timbre.hfRatio)}%</td></tr>
              <tr><td>Качество голоса</td><td>HNR ${s.timbre.hnrDb} дБ · джиттер ${s.timbre.jitterPct}% · шиммер ${s.timbre.shimmerPct}%</td></tr>
              <tr><td>Громкость</td><td>${s.loudness.meanDb} дБ · диапазон ${s.loudness.dynRangeDb} дБ · пик ${s.loudness.peakDb} дБ</td></tr>
              <tr><td>Качество записи</td><td>шум ${s.loudness.noiseFloorDb} дБ · SNR ${s.loudness.snrDb} дБ · клиппинг ${s.loudness.clippingPct}%</td></tr>
            </table>
          </div>
          <div>
            <h3>Как это звучит со стороны</h3>
            <p>${esc(soundDescription(s, t))}</p>
            <h3>Паузы</h3>
            ${s.pauses.list.length ? `<div class="chip-list">${s.pauses.list.slice(0, 24).map((p) => `<span class="chip ${p.type === 'длинная' ? 'filler' : ''}">${p.start}–${p.end} с · ${p.dur} с · ${esc(p.type)}</span>`).join('')}</div>` : '<div class="muted small">Значимых пауз не найдено.</div>'}
            <h3>Мелодика фраз</h3>
            ${s.prosody.list.length ? `<div class="chip-list">${s.prosody.list.slice(-14).map((p) => `<span class="chip">${p.start} с · ${esc(p.kind)} (${p.slopeSt > 0 ? '+' : ''}${p.slopeSt} пт/с)</span>`).join('')}</div>` : '<div class="muted small">Фразы короче 0,45 с.</div>'}
          </div>
        </div>
      </div>`);
    }

    /* — текст — */
    if (t && t.hasText) {
      const spans = r.highlights.spans;
      html.push(`<div class="panel-card">
        <h2>Текст и язык</h2>
        <div class="split">
          <div>
            <h3>Метрики текста</h3>
            <table class="metrics">
              <tr><td>Слов / предложений</td><td>${t.words} / ${t.sentences}</td></tr>
              <tr><td>Средняя длина предложения</td><td>${t.avgSentenceLen} слов (максимум ${t.maxSentenceLen})</td></tr>
              <tr><td>Читаемость на слух</td><td>${t.flesch} — ${esc(t.readability)}</td></tr>
              <tr><td>Позитивные слова</td><td>${t.positive.total} (${t.positive.density} на 100 слов)</td></tr>
              <tr><td>Негативные слова</td><td>${t.negative.total} (${t.negative.density} на 100 слов)${t.negative.total ? ' · ' + pct(t.negative.earlyShare) + '% в начале (описание проблемы)' : ''}</td></tr>
              <tr><td>Слова-паразиты</td><td>${t.fillers.total}${t.fillers.perMin != null ? ' · ' + t.fillers.perMin + '/мин' : ''}</td></tr>
              <tr><td>Слова-сомнения (хеджи)</td><td>${t.hedges.total}</td></tr>
              <tr><td>Уверенные формулировки</td><td>${t.boosters.total}</td></tr>
              <tr><td>Штампы и канцелярит</td><td>${t.cliches.total}</td></tr>
              <tr><td>Цифры и метрики</td><td>${t.facts.numbers} (${t.facts.density} на 100 слов), в ${t.facts.sentencesWithNumbers} предложениях</td></tr>
            </table>
          </div>
          <div>
            <h3>Слова в вашем питче</h3>
            ${wordGroup('Позитивные', t.positive.list, 'pos')}
            ${wordGroup('Негативные', t.negative.list, 'neg')}
            ${wordGroup('Слова-паразиты', t.fillers.list, 'filler')}
            ${wordGroup('Хеджи', t.hedges.list, 'hedge')}
            ${wordGroup('Штампы', t.cliches.list, 'cliche')}
            ${t.keywords.length ? `<h3>Ключевые термины</h3><div class="chip-list">${t.keywords.slice(0, 16).map((k) => `<span class="chip">${esc(k.word)} <small>×${k.count}</small></span>`).join('')}</div>` : ''}
          </div>
        </div>
        <h3>Транскрипт с подсветкой</h3>
        <div class="legend">
          <span><i class="pos" style="background:rgba(34,197,94,.5)"></i>позитив</span>
          <span><i style="background:rgba(239,68,68,.5)"></i>негатив</span>
          <span><i style="background:rgba(245,158,11,.55)"></i>слова-паразиты</span>
          <span><i style="background:rgba(139,92,246,.55)"></i>хеджи</span>
          <span><i style="background:rgba(148,163,184,.5)"></i>штампы</span>
          <span><i style="background:rgba(56,189,248,.5)"></i>уверенные формулировки</span>
        </div>
        <div class="transcript-view">${highlightHtml(r.transcript.text, spans)}</div>
      </div>`);
    }

    /* — структура — */
    if (t && t.hasText) {
      html.push(`<div class="panel-card">
        <h2>Структура питча</h2>
        <p class="muted small">Раскрыто ${t.structure.filter((x) => x.found).length} блоков из ${t.structure.length}. Обязательных для Demo Day: ${t.structure.filter((x) => x.required && x.found).length} из ${t.structure.filter((x) => x.required).length}.</p>
        <div class="struct-grid">
          ${t.structure.map((b) => `<div class="struct ${b.found ? 'ok' : 'no'}">
            <h4><span>${b.found ? '✅' : '❌'} ${esc(b.label)}</span><span class="muted small">${b.found ? b.hits + ' упом.' : 'нет'}</span></h4>
            <p>${b.found ? 'Блок прозвучал.' : esc(b.suggestion)}</p>
            ${b.found && b.evidence.length ? `<div class="ev">Слова-маркеры: ${b.evidence.map(esc).join(', ')}</div>` : ''}
            ${!b.found && b.required ? '<div class="ev" style="color:#fca5a5">Обязательный блок</div>' : ''}
          </div>`).join('')}
        </div>
      </div>`);
    }

    /* — обратная связь — */
    html.push(`<div class="panel-card">
      <h2>Разбор: что хорошо и что исправить</h2>
      <div class="fb-grid">
        <div class="fb strong"><h4>💪 Сильные стороны</h4>${r.feedback.strengths.length ? '<ul>' + r.feedback.strengths.map((x) => `<li><b>${esc(x.title)}.</b> ${esc(x.detail)}</li>`).join('') + '</ul>' : '<p class="muted small">Пока не выявлено — раскройте блоки структуры и добавьте цифры.</p>'}</div>
        <div class="fb weak"><h4>🎯 Зоны роста</h4>${r.feedback.weaknesses.length ? '<ul>' + r.feedback.weaknesses.map((x) => `<li><b>${esc(x.title)}.</b> ${esc(x.detail)}<span class="action">→ ${esc(x.action)}</span></li>`).join('') + '</ul>' : '<p class="muted small">Критических замечаний нет.</p>'}</div>
        <div class="fb wins"><h4>⚡ Быстрые улучшения</h4>${r.feedback.quickWins.length ? '<ul>' + r.feedback.quickWins.slice(0, 8).map((x) => `<li>${esc(x.title)}</li>`).join('') + '</ul>' : '<p class="muted small">—</p>'}</div>
      </div>
      ${r.rewrites.length ? `<h3>Переписанные фразы</h3>${r.rewrites.map((x) => `<div class="rewrite"><div class="before">Было: ${esc(x.before)}</div><div class="after">Стало: ${esc(x.after)}</div><div class="why">${esc(x.reasons.join('; ') || 'убраны ослабители')}</div></div>`).join('')}` : ''}
    </div>`);

    /* — вопросы — */
    html.push(`<div class="panel-card">
      <h2>Вопросы как на Demo Day <span class="muted small">(${r.questions.length})</span></h2>
      <p class="muted small">Для каждого вопроса: почему его задают, каркас ответа и чего избегать. Отмечайте отрепетированные — отметки сохраняются в браузере.</p>
      <div class="q-filters" id="qFilters"></div>
      <div class="chat-row" style="margin-bottom:12px">
        <input id="qSearch" type="text" placeholder="Поиск по вопросам: unit-экономика, конкуренты, данные…">
      </div>
      <div id="qList"></div>
    </div>`);

    host.innerHTML = html.join('');
    if (window.requestAnimationFrame) requestAnimationFrame(() => {
      drawRadar($('#radar'), r.scores.filter((a) => a.available !== false));
      if (s) drawTimeline($('#timeline'), s);
    });
    initQuestions(r);
  }

  function axisHtml(a) {
    const color = a.available === false ? '#64748b' : scoreColor(a.score);
    return `<div class="axis">
      <div class="axis-top"><b>${esc(a.label)}</b><span style="color:${color}">${a.available === false ? 'нет данных' : a.score + '/100'}</span></div>
      <div class="track"><i style="width:${a.available === false ? 0 : a.score}%;background:${color}"></i></div>
      <div class="axis-detail">${esc(a.detail)}</div>
      ${a.notes.map((n) => `<div class="axis-note">• ${esc(n)}</div>`).join('')}
    </div>`;
  }

  function wordGroup(title, list, cls) {
    if (!list || !list.length) return `<h3>${title}</h3><div class="muted small">не найдено</div>`;
    return `<h3>${title} <span class="muted small">(${list.reduce((s, x) => s + x.count, 0)})</span></h3>
      <div class="chip-list">${list.slice(0, 18).map((x) => `<span class="chip ${cls}">${esc(x.word)} <small>×${x.count}</small></span>`).join('')}</div>`;
  }

  function highlightHtml(text, spans) {
    if (!text) return '';
    if (!spans || !spans.length) return esc(text);
    let out = '', last = 0;
    for (const m of spans) {
      if (m.start < last) continue;
      out += esc(text.slice(last, m.start));
      out += `<mark class="${m.type}">${esc(text.slice(m.start, m.end))}</mark>`;
      last = m.end;
    }
    out += esc(text.slice(last));
    return out;
  }

  function soundDescription(s, t) {
    const pace = (t && t.tempo.wordsPerMin) || s.rate.estimatedWordsPerMin;
    const bits = [];
    bits.push(`Темп ${pace > 175 ? 'быстрый' : pace < 110 ? 'медленный' : 'рабочий'} (${pace} слов/мин)`);
    bits.push(`интонация ${s.f0.sdSemitones < 1.4 ? 'почти монотонная' : s.f0.sdSemitones > 4.5 ? 'нервная, скачущая' : 'живая'}`);
    bits.push(`тембр ${s.timbre.centroidHz < 900 ? 'глуховатый' : s.timbre.centroidHz > 2800 ? 'резкий, яркий' : 'сбалансированный'}, голос ${s.timbre.hnrDb >= 16 ? 'чистый' : s.timbre.hnrDb >= 11 ? 'слегка шумный' : 'с заметной хрипотцой'}`);
    bits.push(`паузы ${s.pauseRatio > 0.3 ? 'частые и длинные' : s.pauseRatio < 0.06 ? 'почти отсутствуют' : 'в норме'}`);
    if (s.prosody.upShare > 0.3) bits.push('много фраз с подъёмом тона в конце — звучит как вопрос, а не утверждение');
    if (s.pauses.long) bits.push(`${s.pauses.long} пауз длиннее 1,5 с — есть заминки`);
    return bits.join('; ') + '.';
  }

  /* ==================== ГРАФИКИ ==================== */
  function prep(canvas, h) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.parentNode.clientWidth || 600;
    const hh = h || canvas.height || 300;
    canvas.width = Math.max(320, w) * dpr;
    canvas.height = hh * dpr;
    canvas.style.height = hh + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    return { ctx, w: Math.max(320, w), h: hh };
  }

  const SHORT = {
    structure: 'Структура', persuasion: 'Убедительность', clarity: 'Ясность', positivity: 'Позитив',
    qready: 'К вопросам', confidence: 'Уверенность', timbre: 'Тембр', energy: 'Энергия', pace: 'Темп и паузы'
  };

  function drawRadar(canvas, axes) {
    if (!canvas || !axes.length) return;
    const { ctx, w, h } = prep(canvas, 330);
    const n = axes.length, cx = w / 2, cy = h / 2 + 4, R = Math.min(w, h) / 2 - 58;
    ctx.strokeStyle = '#22334f'; ctx.fillStyle = '#0d1728';
    for (let ring = 1; ring <= 4; ring++) {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const a = -Math.PI / 2 + i * 2 * Math.PI / n;
        const r = R * ring / 4;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath(); ctx.stroke();
    }
    ctx.beginPath();
    axes.forEach((ax, i) => {
      const a = -Math.PI / 2 + i * 2 * Math.PI / n;
      const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      ctx.font = '11.5px -apple-system,Segoe UI,Roboto,sans-serif';
      ctx.fillStyle = '#8ba0c2'; ctx.textAlign = 'center';
      const lx = cx + Math.cos(a) * (R + 34), ly = cy + Math.sin(a) * (R + 24);
      const val = ax.score;
      ctx.fillText(SHORT[ax.key] || ax.label, lx, ly);
      ctx.fillStyle = scoreColor(val); ctx.font = 'bold 12px -apple-system,Segoe UI,Roboto,sans-serif';
      ctx.fillText(String(val), lx, ly + 13);
    });
    ctx.closePath();
    ctx.beginPath();
    axes.forEach((ax, i) => {
      const a = -Math.PI / 2 + i * 2 * Math.PI / n;
      const r = R * clamp01(ax.score / 100);
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(47,212,79,.18)'; ctx.fill();
    ctx.strokeStyle = '#2fd44f'; ctx.lineWidth = 2; ctx.stroke();
    axes.forEach((ax, i) => {
      const a = -Math.PI / 2 + i * 2 * Math.PI / n;
      const r = R * clamp01(ax.score / 100);
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 2 * Math.PI);
      ctx.fillStyle = scoreColor(ax.score); ctx.fill();
    });
  }
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  function drawTimeline(canvas, s) {
    if (!canvas) return;
    const { ctx, w, h } = prep(canvas, 280);
    const tl = s.timeline;
    if (!tl.t.length) return;
    const padL = 34, padR = 12, padT = 14, padB = 24;
    const W = w - padL - padR, H = h - padT - padB;
    const dur = tl.t[tl.t.length - 1] || 1;
    const x = (t) => padL + (t / dur) * W;
    const yDb = (d) => padT + H - (Math.max(-60, Math.min(0, d)) + 60) / 60 * H;
    const stMax = 12;
    const ySt = (st) => padT + H / 2 - (Math.max(-stMax, Math.min(stMax, st)) / stMax) * (H / 2);

    // сетка
    ctx.strokeStyle = '#182a45'; ctx.lineWidth = 1;
    ctx.fillStyle = '#6b81a4'; ctx.font = '10.5px -apple-system,Segoe UI,Roboto,sans-serif';
    for (let d = -60; d <= 0; d += 20) {
      const y = yDb(d);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + W, y); ctx.stroke();
      ctx.textAlign = 'right'; ctx.fillText(d + ' дБ', padL - 6, y + 3);
    }
    const stepT = dur > 240 ? 60 : dur > 120 ? 30 : dur > 60 ? 15 : 10;
    for (let tSec = 0; tSec <= dur; tSec += stepT) {
      const xx = x(tSec);
      ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, padT + H); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillText(fmtTime(tSec), xx, h - 8);
    }
    // паузы
    ctx.fillStyle = 'rgba(245,158,11,.22)';
    for (const p of s.pauses.list) ctx.fillRect(x(p.start), padT, Math.max(1, x(p.end) - x(p.start)), H);
    // громкость
    ctx.beginPath();
    for (let i = 0; i < tl.t.length; i++) {
      const xx = x(tl.t[i]), yy = yDb(tl.db[i]);
      if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
    }
    ctx.lineTo(padL + W, padT + H); ctx.lineTo(padL, padT + H); ctx.closePath();
    ctx.fillStyle = 'rgba(59,130,246,.2)'; ctx.fill();
    ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 1.4; ctx.stroke();
    // тон
    ctx.strokeStyle = '#2fd44f'; ctx.lineWidth = 2; ctx.beginPath();
    let started = false;
    const stride = Math.max(1, Math.floor(tl.t.length / (W * 2)));
    for (let i = 0; i < tl.t.length; i += stride) {
      const v = tl.f0st[i];
      if (v == null) { started = false; continue; }
      const xx = x(tl.t[i]), yy = ySt(v);
      if (!started) { ctx.moveTo(xx, yy); started = true; } else ctx.lineTo(xx, yy);
    }
    ctx.stroke();
    // ось полутонов
    ctx.strokeStyle = 'rgba(47,212,79,.35)'; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(padL, ySt(0)); ctx.lineTo(padL + W, ySt(0)); ctx.stroke();
    ctx.setLineDash([]);
  }

  /* ==================== ВОПРОСЫ ==================== */
  const DONE_KEY = 'pitchengine.done';
  function doneSet() { try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY) || '[]')); } catch (e) { return new Set(); } }
  function markDone(hash, on) {
    const s = doneSet();
    if (on) s.add(hash); else s.delete(hash);
    try { localStorage.setItem(DONE_KEY, JSON.stringify(Array.from(s))); } catch (e) { /* noop */ }
  }
  const qHash = (q, topic) => (topic || '') + '|' + q.q.slice(0, 48);

  function initQuestions(r) {
    const filters = $('#qFilters'), list = $('#qList'), search = $('#qSearch');
    const blocks = Array.from(new Set(r.questions.map((q) => q.blockLabel)));
    let active = 'Все';
    filters.innerHTML = ['Все'].concat(blocks).map((b) => `<button class="tab ${b === 'Все' ? 'active' : ''}" data-b="${esc(b)}">${esc(b)}</button>`).join('')
      + `<span class="q-count"></span>`;
    const render = () => {
      const term = (search.value || '').toLowerCase().trim();
      const items = r.questions.filter((q) => (active === 'Все' || q.blockLabel === active)
        && (!term || (q.q + ' ' + q.why + ' ' + q.frame).toLowerCase().indexOf(term) >= 0));
      const done = doneSet();
      $('.q-count', filters).textContent = items.length + ' из ' + r.questions.length;
      list.innerHTML = items.map((q) => {
        const hash = qHash(q, r.meta.topic);
        const isDone = done.has(hash);
        return `<div class="q-card" data-q="${esc(q.id)}">
          <div class="q-head">
            <b>${esc(q.q)}</b>
            <div class="q-badges"><span class="q-block">${esc(q.blockLabel)}</span><span class="q-stars">${'★'.repeat(q.difficulty)}</span></div>
          </div>
          <div class="q-meta">
            <div><b>Почему спросят:</b> ${esc(q.why)}</div>
            <div><b>Каркас ответа:</b> ${esc(q.frame)}</div>
            <div><b>Чего избегать:</b> ${esc(q.avoid)}</div>
          </div>
          <div class="q-src">Источник: ${esc(q.source || 'банк Demo Day')}</div>
          <div class="q-actions">
            <button class="btn ghost small" data-act="rehearse">⏱ Репетировать 60 с</button>
            <button class="btn ghost small" data-act="done">${isDone ? '✓ Отрепетировано' : 'Отметить как отрепетированное'}</button>
            ${isDone ? '<span class="done-flag">готово</span>' : ''}
          </div>
        </div>`;
      }).join('') || '<div class="muted">Ничего не найдено.</div>';
    };
    filters.addEventListener('click', (e) => {
      const b = e.target.closest('[data-b]');
      if (!b) return;
      active = b.dataset.b;
      $$('[data-b]', filters).forEach((x) => x.classList.toggle('active', x === b));
      render();
    });
    search.addEventListener('input', render);
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const card = btn.closest('.q-card');
      const q = r.questions.find((x) => x.id === card.dataset.q);
      if (!q) return;
      if (btn.dataset.act === 'done') {
        const hash = qHash(q, r.meta.topic);
        const on = !doneSet().has(hash);
        markDone(hash, on);
        render();
      } else rehearse(q);
    });
    render();
  }

  function rehearse(q) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-box" style="max-width:620px">
      <div class="muted small">Вопрос жюри · репетиция ответа</div>
      <h3 style="margin:6px 0 12px">${esc(q.q)}</h3>
      <div style="font-size:52px;font-weight:800;font-variant-numeric:tabular-nums" id="rehTimer">60</div>
      <div class="row">
        <button class="btn primary small" id="rehStart">Начать ответ</button>
        <button class="btn ghost small" id="rehShow">Показать каркас</button>
        <button class="btn ghost small" id="rehClose">Закрыть</button>
      </div>
      <div id="rehFrame" class="hidden" style="margin-top:12px">
        <div class="q-meta"><div><b>Каркас ответа:</b> ${esc(q.frame)}</div><div><b>Чего избегать:</b> ${esc(q.avoid)}</div></div>
      </div>
      <p class="muted small" style="margin-top:12px">Говорите вслух 60 секунд. Цель — уложиться в 4–6 предложений: тезис, цифра, доказательство, следующий шаг.</p>
    </div>`;
    document.body.appendChild(modal);
    let id = null, left = 60;
    const t = $('#rehTimer', modal);
    $('#rehStart', modal).addEventListener('click', () => {
      if (id) return;
      left = 60; t.textContent = left;
      id = setInterval(() => {
        left--;
        t.textContent = left;
        t.style.color = left <= 10 ? '#fca5a5' : '';
        if (left <= 0) { clearInterval(id); id = null; t.textContent = 'время'; }
      }, 1000);
    });
    $('#rehShow', modal).addEventListener('click', () => $('#rehFrame', modal).classList.toggle('hidden'));
    $('#rehClose', modal).addEventListener('click', () => { clearInterval(id); modal.remove(); });
    modal.addEventListener('click', (e) => { if (e.target === modal) { clearInterval(id); modal.remove(); } });
  }

  /* ==================== ЭКСПОРТ ==================== */
  function download(name, content, type) {
    const blob = new Blob([content], { type: type || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const slug = (s) => (s || 'pitch').toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 48);
  $('#btnMd').addEventListener('click', () => { if (state.report) download('analiz-pitcha-' + slug(state.report.meta.topic) + '.md', E.buildMarkdown(state.report), 'text/markdown;charset=utf-8'); });
  $('#btnHtml').addEventListener('click', () => { if (state.report) download('otchet-pitcha-' + slug(state.report.meta.topic) + '.html', E.buildStandaloneHtml(state.report), 'text/html;charset=utf-8'); });
  $('#btnJson').addEventListener('click', () => { if (state.report) download('pitch-report-' + slug(state.report.meta.topic) + '.json', JSON.stringify(state.report, null, 2), 'application/json'); });
  $('#btnPrint').addEventListener('click', () => window.print());

  /* ==================== ИИ-ТРЕНЕР ==================== */
  function applyPreset() {
    const p = LLM.PRESETS[$('#llmProvider').value];
    if (p) { $('#llmBase').value = p.base; $('#llmModel').value = p.model; }
  }
  const saved = LLM.loadConfig();
  $('#llmProvider').value = saved.provider;
  $('#llmBase').value = saved.base;
  $('#llmModel').value = saved.model;
  $('#llmKey').value = saved.apiKey;
  $('#llmProvider').addEventListener('change', applyPreset);
  $('#btnLLMSave').addEventListener('click', () => {
    const cfg = { provider: $('#llmProvider').value, base: $('#llmBase').value.trim(), model: $('#llmModel').value.trim(), apiKey: $('#llmKey').value.trim() };
    LLM.saveConfig(cfg);
    const problem = LLM.ready(cfg);
    $('#llmStatus').textContent = problem ? 'не хватает: ' + problem : 'настройки сохранены ✓';
  });
  const cfgNow = () => ({ provider: $('#llmProvider').value, base: $('#llmBase').value.trim(), model: $('#llmModel').value.trim(), apiKey: $('#llmKey').value.trim() });

  function llmGuard() {
    const problem = LLM.ready(cfgNow());
    if (problem) { $('#llmStatus').innerHTML = '<span style="color:#fca5a5">Сначала настройте ИИ-сервис: ' + esc(problem) + '</span>'; return false; }
    return true;
  }
  async function withStatus(btn, label, fn) {
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = label;
    $('#llmStatus').textContent = 'запрос к модели…';
    try { const out = await fn(); $('#llmStatus').textContent = 'готово ✓'; return out; }
    catch (e) { $('#llmStatus').innerHTML = '<span style="color:#fca5a5">Ошибка: ' + esc(e.message) + '</span>'; return null; }
    finally { btn.disabled = false; btn.textContent = old; }
  }

  $('#btnDeep').addEventListener('click', async (e) => {
    if (!state.report || !llmGuard()) return;
    const btn = e.currentTarget;
    const res = await withStatus(btn, 'Анализирую…', () => LLM.deepAnalyze(state.report, cfgNow()));
    if (!res) return;
    const box = $('#deepOut');
    box.classList.remove('hidden');
    box.innerHTML = `<h3 style="margin-top:0">Вывод ИИ-тренера</h3>
      <p>${esc(res.verdict || '')}</p>
      ${listBlock('💪 Сильные стороны', res.top_strengths)}
      ${listBlock('🚨 Критические риски', res.critical_risks)}
      ${res.opening_15 ? `<h4>Первые 15 секунд</h4><div class="rewrite">${esc(res.opening_15)}</div>` : ''}
      ${res.rewrite_60 ? `<h4>Питч на 60 секунд</h4><div class="rewrite"><div class="after" style="white-space:pre-wrap">${esc(res.rewrite_60)}</div></div>` : ''}
      ${res.rewrite_30 ? `<h4>Версия на 30 секунд</h4><div class="rewrite">${esc(res.rewrite_30)}</div>` : ''}
      ${listBlock('✂ Что убрать', res.what_to_cut)}
      ${listBlock('🎙 Что поправить в подаче', res.delivery_fixes)}
      ${Array.isArray(res.questions) && res.questions.length ? `<h4>Неудобные вопросы и готовые ответы</h4>${res.questions.map((q) => `<div class="q-card"><b>${esc(q.q)}</b><div class="q-meta"><div><b>Ответ:</b> ${esc(q.answer)}</div><div><b>Проверяют:</b> ${esc(q.why || '')}</div></div></div>`).join('')}` : ''}`;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  function listBlock(title, arr) {
    if (!Array.isArray(arr) || !arr.length) return '';
    return `<h4>${title}</h4><ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  }

  $('#btnRewrite60').addEventListener('click', async (e) => {
    if (!state.report || !llmGuard()) return;
    const btn = e.currentTarget;
    const res = await withStatus(btn, 'Переписываю…', () => LLM.rewritePitch(state.report, 60, cfgNow()));
    if (!res) return;
    const box = $('#deepOut');
    box.classList.remove('hidden');
    box.innerHTML = `<h3 style="margin-top:0">Питч на 60 секунд (ИИ)</h3>
      <div class="rewrite"><div class="after" style="white-space:pre-wrap">${esc(res.text || '')}</div></div>
      ${listBlock('Тайминг', res.beats)}
      ${listBlock('Что изменилось', res.notes)}`;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  const chatLog = $('#chatLog');
  function pushChat(role, text) {
    const d = document.createElement('div');
    d.className = 'chat-msg ' + role;
    d.textContent = text;
    chatLog.appendChild(d);
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  async function sendChat() {
    if (!state.report || !llmGuard()) return;
    const q = $('#chatInput').value.trim();
    if (!q) return;
    $('#chatInput').value = '';
    pushChat('me', q);
    state.chatHistory.push({ role: 'me', text: q });
    $('#btnChat').disabled = true;
    try {
      const ans = await LLM.askCoach(q, state.report, state.chatHistory, cfgNow());
      pushChat('ai', ans);
      state.chatHistory.push({ role: 'ai', text: ans });
    } catch (e) {
      pushChat('ai', 'Ошибка: ' + e.message);
    } finally { $('#btnChat').disabled = false; }
  }
  $('#btnChat').addEventListener('click', sendChat);
  $('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

  /* ==================== СПРАВКА ==================== */
  $('#btnHelp').addEventListener('click', () => $('#helpModal').classList.remove('hidden'));
  $('#btnHelpClose').addEventListener('click', () => $('#helpModal').classList.add('hidden'));
  $('#helpModal').addEventListener('click', (e) => { if (e.target.id === 'helpModal') $('#helpModal').classList.add('hidden'); });

  /* ==================== ДЕМО-РЕЖИМ ==================== */
  function syntheticVoice(f0, dur, sr, seed) {
    const n = Math.floor(dur * sr), x = new Float32Array(n);
    let rnd = seed || 1;
    const rand = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const harm = [1, 0.5, 0.31, 0.19, 0.11, 0.07];
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const tt = i / sr;
      const f = f0 * (1 + 0.012 * (rand() * 2 - 1)) * (1 + 0.06 * Math.sin(2 * Math.PI * 4.4 * tt));
      phase += 2 * Math.PI * f / sr;
      let v = 0;
      for (let h = 0; h < harm.length; h++) v += harm[h] * Math.sin(phase * (h + 1));
      const env = 0.55 + 0.45 * Math.max(0, Math.sin(2 * Math.PI * 4.3 * tt));
      x[i] = 0.28 * env * v * 0.35 + (rand() * 2 - 1) * 0.0016;
    }
    return x;
  }
  async function demo() {
    $('#topic').value = 'ИИ-платформа приёмки товара на складе';
    $('#industry').value = 'Логистика и склад';
    tr.value = SAMPLE_PITCH; updateTrCount();
    $('#trSource').textContent = '— пример питча (демо)';
    // синтетическая «речь» для демонстрации речевых метрик
    const sr = 16000;
    const parts = [];
    const segs = [[150, 11, 1], [150, 9, 2], [148, 12, 3], [151, 8, 4], [149, 10, 5]];
    segs.forEach((sg, i) => {
      parts.push(syntheticVoice(sg[0], sg[1], sr, sg[2]));
      if (i === 1) parts.push(new Float32Array(Math.floor(1.6 * sr)));
      else if (i === 3) parts.push(new Float32Array(Math.floor(0.5 * sr)));
    });
    const total = parts.reduce((s, p) => s + p.length, 0);
    const buf = new Float32Array(total);
    let off = 0;
    parts.forEach((p) => { buf.set(p, off); off += p.length; });
    state.samples = buf; state.sampleRate = sr;
    state.demo = true;
    await runAnalysis();
    if (state.report) {
      state.report.warnings.push('Демо-режим: аудиодорожка синтезирована для показа речевых метрик, текст — пример питча.');
      renderReport(state.report);
    }
  }
  $('#btnTryDemo').addEventListener('click', demo);

  /* ==================== СТАРТ ==================== */
  $('#ver').textContent = 'версия ' + (LEX.VERSION || '1.0.0');
  updateTrCount();
  if (/[?&]demo=1/.test(location.search)) demo();
  window.addEventListener('resize', () => {
    if (!state.report) return;
    drawRadar($('#radar'), state.report.scores.filter((a) => a.available !== false));
    if (state.report.speech) drawTimeline($('#timeline'), state.report.speech);
  });
})();
