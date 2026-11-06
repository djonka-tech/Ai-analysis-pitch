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

  const themeButton=$('#btnTheme');
  function setStageTheme(enabled){document.documentElement.dataset.stageTheme=enabled?'on':'off';themeButton.textContent=enabled?'Прежние цвета':'Цвета презентации';themeButton.setAttribute?.('aria-pressed',String(enabled));}
  try{setStageTheme(localStorage.getItem('pitch.stageTheme')!=='off');}catch(_){setStageTheme(true);}
  themeButton.addEventListener('click',()=>{const enabled=document.documentElement.dataset.stageTheme!=='on';setStageTheme(enabled);try{localStorage.setItem('pitch.stageTheme',enabled?'on':'off');}catch(_){}});

  const state = {
    report: null, samples: null, sampleRate: 0, audioBlob: null, audioName: '',
    cues: null, recording: false, stream: null, recorder: null, chunks: [], analyser: null,
    audioCtx: null, mediaStreamSrc: null, recognition: null, asrFinal: '', asrInterim: '',
    recStart: 0, recTimerId: null, levelId: null, levelHistory: [], silenceStart: 0, pauseCount: 0,
    inputMode: 'mic', audioSource: null, audioVersion: 0, starting: false, finishing: null, previewUrl: null, analyzing: false, cueStart: null, levelThreshold: 0.012, chatHistory: [], demo: false, lastLevel: 0
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
    if (state.recording || state.starting || state.finishing) return;
    state.report = null; state.textDraft=''; state.demo=false; resetAudio();
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
  function setInputMode(mode) {
    if(!['mic','file','text'].includes(mode)||state.recording||state.starting||state.finishing||state.analyzing)return false;
    if(state.inputMode!==mode){
      if(state.inputMode==='text')state.textDraft=tr.value;
      resetAudio();state.demo=false;
      tr.value=mode==='text'?(state.textDraft||''):'';
      $('#trSource').textContent='';updateTrCount();
    }
    state.inputMode=mode;
    $$('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===mode));
    $$('.panel').forEach(x=>x.classList.toggle('hidden',x.dataset.panel!==mode));
    syncTranscriptMode();return true;
  }
  function syncTranscriptMode(){
    tr.readOnly=state.inputMode!=='text';
    tr.placeholder=state.inputMode==='text'?'Введите или вставьте текст выступления.':'Здесь будет автоматическая расшифровка или текст из субтитров. Ручной ввод доступен только в режиме «Только текст».';
    $('#transcriptHint').textContent=state.inputMode==='text'?'Этот текст используется для оценки содержания. Без аудио подача не оценивается.':'Расшифровка доступна для чтения и копирования. Редактирование — только в режиме «Только текст».';
  }
  $$('.tab').forEach(t=>t.addEventListener('click',()=>setInputMode(t.dataset.tab)));

  /* ==================== ТРАНСКРИПТ ==================== */
  const tr = $('#transcript');
  syncTranscriptMode();
  function updateTrCount() {
    const words = (tr.value.match(/[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9\-]*/g) || []).length;
    $('#trCount').textContent = words + ' слов · ' + tr.value.length + ' символов';
  }
  tr.addEventListener('input', updateTrCount);
  $('#btnSample').addEventListener('click', () => {
    tr.value = SAMPLE_PITCH; updateTrCount();
    if (!$('#topic').value.trim()) $('#topic').value = 'ИИ-платформа приёмки товара на складе';
    if (!$('#industry').value.trim()) $('#industry').value = 'Транспорт и логистика';
    $('#trSource').textContent = '— пример питча';
  });
  $('#btnClear').addEventListener('click', () => { tr.value = ''; updateTrCount(); $('#trSource').textContent = ''; });

  /* ==================== ЗАПИСЬ С МИКРОФОНА ==================== */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const asrBadge = $('#asrStatus');
  if (!SR) {
    asrBadge.textContent = 'недоступно в этом браузере';
    asrBadge.className = 'badge bad';
    $('#liveTranscript').textContent = 'Автоматическое распознавание недоступно (нужен Chrome или Edge). Запись работает без распознавания. Для анализа содержания загрузите субтитры в режиме файла или выберите «Только текст».';
  } else {
    asrBadge.textContent = 'готово (Chrome/Edge, нужен интернет)';
    asrBadge.className = 'badge ok';
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !(window.AudioContext || window.webkitAudioContext)) {
    $('#btnRec').disabled = true;
    $('#recStatus').textContent = window.isSecureContext ? 'Браузер не поддерживает запись. Загрузите готовый аудиофайл.' : 'Микрофону нужен HTTPS или localhost. Загрузите файл или откройте сайт через localhost.';
  }
  if (location.protocol === 'file:') {
    $('#recStatus').textContent = 'Открыто как файл: микрофон может быть недоступен. Откройте приложение через localhost для более надёжной записи';
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
    if (!SR || !$('#enableAsr').checked) return;
    try {
      const r = new SR();
      r.lang = 'ru-RU'; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
      r.onresult = (ev) => {
        if (!state.recording || state.recognition !== r) return;
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
        if (code === 'network') addTip('bad', 'Сервис распознавания недоступен (нет интернета). Аудио записывается. Для содержания можно загрузить субтитры или использовать режим «Только текст».');
        if (code === 'not-allowed') addTip('bad', 'Нет доступа к микрофону для распознавания. Разрешите доступ в браузере.');
      };
      r.onend = () => {
        if (state.recording && state.recognition === r && !state.asrDead) { try { r.start(); } catch (e) { state.asrDead = true; } }
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
    const wpm = elapsed > 8 && words ? Math.round(words / (elapsed / 60)) : 0;
    $('#lmWords').textContent = words;
    $('#lmWpm').textContent = elapsed > 8 && words ? wpm : '—';
    $('#lmPauses').textContent = state.pauseCount;
    $('#lmFillers').textContent = countFillers(tr.value);
    $('#lmVolume').textContent = state.lastLevel > 0.008 ? 'Слышно' : state.lastLevel > 0.0003 ? 'Тихо' : 'Нет сигнала';
    const limit = +$('#regulation').value;
    $('#recLimit').textContent = limit ? `Регламент: ${fmtTime(limit)}` : 'Без регламента';
    if (elapsed > 12) {
      if (wpm > 185) addTip('warn', 'Темп выше 185 слов/мин — зал не успевает осмыслить цифры. Сделайте паузу.');
      else if (wpm > 0 && wpm < 105) addTip('warn', 'Темп ниже 105 слов/мин — питч может не уложиться в регламент.');
      const f = countFillers(tr.value);
      if (f >= 3) addTip('warn', `Уже ${f} слов-паразитов. Заменяйте их паузой в полсекунды.`);
      if (state.pauseCount === 0) addTip('ok', 'Пока нет длинных пауз — речь идёт ровно.');
    }
    if (state.lastLevel > 0 && 20 * Math.log10(state.lastLevel) < -34 && elapsed > 5) addTip('warn', 'Низкий уровень записи. Проверьте выбранный микрофон, его усиление и расстояние до него.');
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

  function resetAudio() {
    state.audioVersion++;
    state.samples = null; state.sampleRate = 0; state.audioBlob = null; state.audioName = ''; state.audioSource = null; state.cues = null;
    releasePlayback('audioPreview');releasePlayback('reportAudio');
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
    $('#audioPreview').removeAttribute('src'); $('#audioPreview').classList.add('hidden'); $('#previewPlayer').classList.add('hidden');
    $('#inputStatus').textContent = ''; $('#analyzeHint').textContent = '';
    $('#fileInfo').classList.add('hidden');
    ['lmWords','lmWpm','lmPauses','lmFillers','lmVolume'].forEach(id => { $('#' + id).textContent = '—'; });
  }

  let playbackContext=null;
  const playbackRoutes=new WeakMap(),boundPlayback=new WeakSet();
  function volumeControls(id){
    return `<div class="playback-volume"><label for="volume_${id}">Громкость</label><output id="volumeLabel_${id}" for="volume_${id}">100%</output><input id="volume_${id}" type="range" min="0" max="3" step="0.1" value="1" aria-label="Громкость прослушивания"><small id="volumeHint_${id}"></small></div>`;
  }
  function releasePlayback(id,root){
    const audio=$('#'+id,root);if(!audio)return;
    audio.pause?.();
    const route=playbackRoutes.get(audio);
    if(route){route.source.disconnect();route.gain.disconnect();route.limiter?.disconnect();route.connected=false;}
  }
  function bindPlayback(id,root){
    const audio=$('#'+id,root),slider=$('#volume_'+id,root),label=$('#volumeLabel_'+id,root),hint=$('#volumeHint_'+id,root);
    if(!audio||!slider||boundPlayback.has(audio))return;
    boundPlayback.add(audio);slider.value=String(state.playbackGain??1);
    const show=()=>{label.textContent=Math.round(Number(slider.value)*100)+'%';slider.setAttribute?.('aria-valuetext',label.textContent);};show();
    const apply=async()=>{
      const requested=Math.max(0,Math.min(3,Number(slider.value)||0));
      state.playbackGain=requested;
      let route=playbackRoutes.get(audio);
      try{
        if(route?.fallback)throw new Error('ordinary volume only');
        const Context=window.AudioContext||window.webkitAudioContext;
        if(!Context)throw new Error('no audio context');
        playbackContext=playbackContext||new Context();
        if(!playbackContext.createMediaElementSource||!playbackContext.createGain)throw new Error('no playback gain');
        await playbackContext.resume();
        // Another input/play event may have finished initialization while resume
        // was pending. A media element may have only one source node.
        route=playbackRoutes.get(audio);
        if(!route){
          const gain=playbackContext.createGain();
          const limiter=playbackContext.createDynamicsCompressor?.();
          if(limiter){limiter.threshold.value=-3;limiter.knee.value=3;limiter.ratio.value=12;limiter.attack.value=.003;limiter.release.value=.15;}
          route={source:playbackContext.createMediaElementSource(audio),gain,limiter,connected:false};playbackRoutes.set(audio,route);
        }
        if(!route.connected){route.source.connect(route.gain);if(route.limiter){route.gain.connect(route.limiter);route.limiter.connect(playbackContext.destination);}else route.gain.connect(playbackContext.destination);route.connected=true;}
        const latest=Math.max(0,Math.min(3,Number(slider.value)||0));
        route.gain.gain.value=latest;audio.volume=1;audio.muted=latest===0;
      }catch(_){
        // Keep ordinary playback usable when Web Audio amplification is unavailable.
        if(route){route.fallback=true;try{route.source.disconnect();route.gain.disconnect();route.limiter?.disconnect();route.source.connect(playbackContext.destination);}catch(__){}}
        const value=Math.min(1,Number(slider.value)||0);audio.volume=value;audio.muted=value===0;slider.max='1';slider.value=String(value);state.playbackGain=value;
        hint.textContent='В этом браузере доступна регулировка до 100%. Дополнительно используйте громкость компьютера.';
      }
      show();
    };
    slider.addEventListener('input',apply);audio.addEventListener('play',apply);
  }

  function previewAudio() {
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(state.audioBlob);
    $('#audioPreview').src = state.previewUrl;
    $('#audioPreview').classList.remove('hidden'); $('#previewPlayer').classList.remove('hidden');bindPlayback('audioPreview');
  }

  async function listMics() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const selected = $('#micDevice').value;
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
      $('#micDevice').innerHTML = '<option value="">Системный микрофон по умолчанию</option>';
      devices.forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || 'Микрофон ' + (i + 1); $('#micDevice').appendChild(o); });
      if ([...$('#micDevice').options].some(o => o.value === selected)) $('#micDevice').value = selected;
    } catch (_) { /* список устройств может быть закрыт до выдачи разрешения */ }
  }
  listMics();
  navigator.mediaDevices?.addEventListener?.('devicechange', listMics);

  function releaseCapture() {
    clearInterval(state.recTimerId); clearInterval(state.levelId);
    try { state.recognition?.stop(); } catch (_) {}
    try { state.mediaStreamSrc?.disconnect(); } catch (_) {}
    try { state.analyser?.disconnect(); } catch (_) {}
    try { state.monitorGain?.disconnect(); } catch (_) {}
    state.stream?.getTracks().forEach(t => t.stop());
    state.stream = null;
    $('#btnRec').classList.remove('hidden'); $('#btnStop').classList.add('hidden');
    $('#micDevice').disabled = false;
  }

  async function startRecording() {
    if (state.starting || state.recording || state.finishing || state.analyzing) return;
    state.starting = true; $('#btnRec').disabled = true;
    try {
      const deviceId = $('#micDevice').value;
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      } catch (e) {
        if (!['OverconstrainedError', 'NotSupportedError'].includes(e.name)) throw e;
        stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
      }
      state.stream = stream;
      const ctx = state.audioCtx = state.audioCtx?.state !== 'closed' && state.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      await ctx.resume();
      const src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser();
      an.fftSize = 2048; src.connect(an);
      const monitor = ctx.createGain(); monitor.gain.value = 0;
      an.connect(monitor); monitor.connect(ctx.destination); state.monitorGain = monitor;
      state.analyser = an; state.mediaStreamSrc = src;
      const mime = pickMime();
      let recorder;
      try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
      catch (_) { recorder = new MediaRecorder(stream); }
      resetAudio(); state.audioSource = 'mic'; state.recorder = recorder;
      const chunks = []; state.chunks = chunks;
      let resolveFinished;
      const finished = new Promise(resolve => { resolveFinished = resolve; });
      state.captureFinished = finished;
      recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
      let finalized = false;
      recorder.onstop = async () => {
        if (finalized) return;
        finalized = true;
        state.recording = false; state.finishing = finished;
        releaseCapture();
        try {
          state.audioBlob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || 'audio/webm' });
          if (!state.audioBlob.size) throw new Error('Браузер вернул пустую запись. Проверьте микрофон или загрузите файл.');
          previewAudio();
          const ready = await ensureSamples();
          $('#recStatus').textContent = ready ? 'Запись готова. Прослушайте её перед анализом.' : 'Запись сохранена, но браузер не смог прочитать звук. Попробуйте другой браузер или WAV/MP3.';
          $('#inputStatus').textContent = ready ? 'Источник: запись с микрофона' : 'Звук недоступен для анализа; текст можно разобрать отдельно.';
        } catch (e) { $('#recStatus').textContent = e.message; }
        finally { state.finishing = null; resolveFinished(); }
      };
      recorder.onerror = () => { addTip('bad', 'Браузер прервал запись. Попробуйте отключить распознавание речи и повторить запись.'); stopRecording(); };
      recorder.start();
      state.recStart = Date.now(); state.recording = true;
      state.asrDead = false; state.asrFinal = ''; state.asrInterim = ''; state.cueStart = null;
      state.levelHistory = []; state.pauseCount = 0; state.silenceStart = 0; state.silenceCounted = false; state.lastLevel = 0;
      tr.value = ''; updateTrCount(); $('#trSource').textContent = '';
      $('#recTimer').textContent = '00:00'; $('#liveTips').innerHTML = '';
      $('#liveTranscript').textContent = $('#enableAsr').checked ? 'Слушаю…' : 'Распознавание отключено. Аудио записывается.';
      $('#btnRec').classList.add('hidden'); $('#btnStop').classList.remove('hidden'); $('#micDevice').disabled = true;
      $('#recStatus').textContent = 'Идёт запись.';
      const buf = new Float32Array(an.fftSize);
      state.levelId = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        const rms = Math.sqrt(buf.reduce((sum, v) => sum + v * v, 0) / buf.length);
        state.lastLevel = rms; state.levelHistory.push(rms);
        if (state.levelHistory.length > 4000) state.levelHistory.shift();
        const time = Date.now();
        // Относительный порог для устройств с разным усилением.
        const recent = state.levelHistory.slice(-150).slice().sort((a,b) => a-b);
        const threshold = Math.max(0.0001, (recent[Math.floor(recent.length * 0.9)] || 0) * 0.16);
        if (rms < threshold) {
          if (!state.silenceStart) state.silenceStart = time;
          else if (time - state.silenceStart > 500 && !state.silenceCounted) { state.pauseCount++; state.silenceCounted = true; }
        } else { state.silenceStart = 0; state.silenceCounted = false; }
        drawLevel();
      }, 60);
      state.recTimerId = setInterval(() => { $('#recTimer').textContent = fmtTime((Date.now() - state.recStart) / 1000); liveUpdate(); }, 250);
      stream.getAudioTracks().forEach(t => t.addEventListener('ended', () => { if (state.recording) { addTip('bad', 'Микрофон отключён. Запись остановлена.'); stopRecording(); } }));
      listMics(); startAsr();
    } catch (e) {
      state.recording = false; releaseCapture();
      const messages = {
        NotAllowedError: 'Доступ запрещён. Разрешите микрофон в браузере и в настройках конфиденциальности Windows.',
        NotFoundError: 'Микрофон не найден. Подключите устройство и выберите его в списке.',
        NotReadableError: 'Микрофон занят или недоступен системе. Закройте приложения, использующие его, и повторите.',
        OverconstrainedError: 'Выбранный микрофон недоступен. Выберите системный микрофон по умолчанию.',
        SecurityError: 'Браузер запретил запись. Откройте приложение через localhost или HTTPS.'
      };
      $('#recStatus').textContent = messages[e.name] || 'Не удалось начать запись: ' + e.message;
    } finally { state.starting = false; $('#btnRec').disabled = false; }
  }

  function stopRecording() {
    if (!state.recording) return state.finishing || Promise.resolve();
    state.recording = false; state.finishing = state.captureFinished;
    clearInterval(state.recTimerId); clearInterval(state.levelId);
    try { state.recognition?.stop(); } catch (_) {}
    $('#recStatus').textContent = 'Сохраняю запись…';
    $('#btnStop').classList.add('hidden');
    tr.value = (state.asrFinal + ' ' + state.asrInterim).trim(); updateTrCount();
    try {
      if (state.recorder.state !== 'inactive') state.recorder.stop();
    } catch (_) { state.recorder.onstop(); }
    return state.finishing;
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
    if (state.recording || state.starting || state.finishing || state.analyzing) return;
    if(state.inputMode!=='file')setInputMode('file');
    resetAudio();
    const version = state.audioVersion;
    state.audioSource = 'file';
    tr.value = ''; updateTrCount(); $('#trSource').textContent = '';
    state.audioName = file.name;
    $('#fileInfo').classList.remove('hidden');
    $('#fileInfo').innerHTML = `<b>${esc(file.name)}</b> · ${(file.size / 1048576).toFixed(2)} МБ · <span class="muted">декодирую…</span>`;
    state.audioBlob = file;
    try {
      const ctx = state.audioCtx || (state.audioCtx = new (window.AudioContext || window.webkitAudioContext)());
      const ab = await file.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      if (version !== state.audioVersion) return;
      state.sampleRate = buf.sampleRate;
      state.samples = downmix(buf);
      const dur = buf.duration; previewAudio();
      $('#inputStatus').textContent = 'Источник: загруженный файл. Все показатели относятся к записи. Без расшифровки темп приблизительный.';
      $('#fileInfo').innerHTML = `<b>${esc(file.name)}</b> · ${(file.size / 1048576).toFixed(2)} МБ · ${buf.numberOfChannels} канал(ов) · ${buf.sampleRate} Гц · <b>${fmtTime(dur)}</b> · сигнал готов к анализу`;
      $('#analyzeHint').textContent = 'Аудио загружено (' + fmtTime(dur) + '). Для анализа содержания загрузите субтитры или запустите распознавание.';
      if (!$('#trSource').textContent) $('#trSource').textContent = '— загрузите субтитры или запустите распознавание';
    } catch (e) {
      if (version !== state.audioVersion) return;
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
    if (decoding && decoding.version === state.audioVersion) return decoding;
    const version = state.audioVersion, blob = state.audioBlob;
    const task = (async () => {
      try {
        const ctx = state.audioCtx || (state.audioCtx = new (window.AudioContext || window.webkitAudioContext)());
        const ab = await blob.arrayBuffer();
        const buf = await ctx.decodeAudioData(ab);
        if (version !== state.audioVersion) return false;
        state.sampleRate = buf.sampleRate;
        state.samples = downmix(buf);
        if (!$('#analyzeHint').textContent) $('#analyzeHint').textContent = 'Аудио готово: ' + fmtTime(buf.duration);
        return true;
      } catch (e) {
        if (version === state.audioVersion) state.samples = null;
        return false;
      } finally { if (decoding?.version === version) decoding = null; }
    })();
    task.version = version; decoding = task;
    return task;
  }

  $('#subsInput').addEventListener('change', (e) => {
    if(state.inputMode!=='file')return;
    const version=state.audioVersion;
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      if(version!==state.audioVersion||state.inputMode!=='file')return;
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
    if(state.inputMode!=='file')return;
    const version=state.audioVersion;
    const cfg = LLM.loadConfig();
    const problem = LLM.ready(cfg);
    if (!state.audioBlob) { alert('Сначала загрузите аудио или видео файл.'); return; }
    if (problem) { alert('Для распознавания нужен настроенный ИИ-сервис: ' + problem + '.\nЗаполните панель «ИИ-тренер» внизу страницы.'); return; }
    const btn = $('#btnWhisper');
    btn.disabled = true; btn.textContent = 'Распознаю…';
    try {
      const text = await LLM.transcribe(state.audioBlob, cfg, state.audioName || 'pitch.webm');
      if(version!==state.audioVersion||state.inputMode!=='file')return;
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
      [10, 'Читаем запись…'],
      [28, 'Проверяем ритм выступления…'],
      [48, 'Слушаем интонацию…'],
      [66, 'Готовим рекомендации по подаче…'],
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
    if (state.starting || state.analyzing) return;
    state.analyzing = true; $('#btnAnalyze').disabled = true;
    try {
    if (state.recording) await stopRecording();
    if (state.finishing) await state.finishing;
    if (state.audioBlob && !state.samples) {
      showStep(3);
      $('#progressLabel').textContent = 'Декодирую запись…';
      $('#progressBar').style.width = '4%';
      await ensureSamples();
    }
    const text = tr.value.trim();
    const useAudio = !!state.samples;
    if(state.inputMode!=='text'&&!useAudio){showStep(2);alert('В этом режиме нужна аудиозапись. Запишите голос или загрузите файл. Для ручного текста выберите «Только текст».');return;}
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
        meta: { ...meta(), inputSource: state.audioSource || 'text' },
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
    } finally { state.analyzing = false; $('#btnAnalyze').disabled = false; }
  }

  /* ==================== ОТЧЁТ ==================== */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pct = (v) => Math.round(v * 100);
  const scoreColor = (s) => (s >= 75 ? '#22c55e' : s >= 55 ? '#f59e0b' : '#ef4444');

  function coachingRows(r, group) {
    const s = r.speech, t = r.text;
    const choices = group === 'speech' ? [
      ['confidence', 'Выразительность', !s ? '' : s.f0.sdSemitones < 1.4 ? 'Выделите голосом три главные мысли. Сделайте акцент на результате и вашем запросе к жюри.' : 'Сохраните разнообразную интонацию, особенно в начале и в финале.'],
      ['pace', 'Темп и ритм', !s ? '' : s.pauseRatio > .3 ? 'Сократите заминки между мыслями. Перед записью выпишите пять опорных тезисов.' : ((t.tempo.wordsPerMin || s.rate.estimatedWordsPerMin) > 175 ? 'Замедляйтесь на цифрах и делайте короткую остановку после ключевой мысли.' : ((t.tempo.wordsPerMin || s.rate.estimatedWordsPerMin) < 110 ? 'Уберите затянутое вступление. Переходите к проблеме и результату уже в первых фразах.' : 'Сохраняйте этот ритм. Отделяйте ключевые цифры короткой паузой.'))],
      ['energy', 'Акценты в речи', !s ? '' : s.loudness.dynRangeDb < 8 ? 'Избегайте чтения на одной громкости. Произнесите главный результат с заметным акцентом.' : 'Акценты уже слышны. Проверьте, что они приходятся на пользу клиенту и запрос к аудитории.']
    ] : [
      ['clarity', 'Понятность', t.fillers.total || t.cliches.total ? 'Уберите повторяющиеся вводные слова и общие фразы. В каждом предложении оставьте одну мысль.' : 'Сохраняйте короткие, прямые фразы. Проверьте, понятны ли термины человеку вне вашей отрасли.'],
      ['persuasion', 'Конкретика', t.facts.numbers < 3 ? 'Добавьте три проверяемых числа: масштаб проблемы, результат и следующий план.' : 'Числа уже есть. Укажите, откуда они взяты и за какой период получены.'],
      ['qready', 'Полнота аргументов', t.missing.some(x=>x.required) ? 'Дополните недостающие блоки ниже, затем отрепетируйте вопросы по этим темам.' : 'Подготовьте доказательства к основным утверждениям и потренируйте короткие ответы.']
    ];
    return choices.map(([key,label,advice]) => {
      const score = r.scores.find(a => a.key === key);
      const available = score && score.available !== false;
      return `<div class="coach-row"><div><span class="eyebrow">${esc(label)}</span><div class="row-score" style="color:${available ? scoreColor(score.score) : 'var(--muted)'}">${available ? score.score + '<small>/100</small>' : '—'}</div></div><p>${esc(available ? advice : 'Нужно больше данных для оценки. Добавьте запись с различимым голосом и полную расшифровку.')}</p></div>`;
    }).join('');
  }

  function renderReport(r) {
    const host = $('#report');
    const m = r.meta, t = r.text, s = r.speech;
    const html = [];
    const feedback = E.buildCoachingFeedback(r);
    const map = E.buildContentMap(r);
    const overview = [
      t.hasText ? 'Найдены упоминания ' + r.structure.filter(x=>x.found).length + ' тем из ' + r.structure.length + '. Полноту аргументов стоит проверить отдельно.' : 'Для разбора содержания добавьте расшифровку.',
      'Содержание: ' + (r.total.textScore ?? 'нет данных') + '. Подача: ' + (r.total.deliveryScore ?? 'нет данных') + '.'
    ];

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
        <ul>${overview.map((v) => `<li>${esc(v)}</li>`).join('')}</ul>
        ${r.warnings.length ? `<div class="warn-list">⚠ ${r.warnings.map(esc).join('<br>⚠ ')}</div>` : ''}
      </div>
    </div>`);

    html.push(`<div class="panel-card"><h2>Профиль питча</h2><div class="profile-grid"><canvas id="radar" class="chart" role="img" aria-label="Диаграмма оценок питча. Числовые значения доступны в блоке Оценки по осям." height="360"></canvas><div class="profile-explanation"><h3>Как читать диаграмму</h3><p class="muted">Чем дальше точка от центра, тем выше оценка. Сравнивайте направления между собой: самые короткие лучи показывают, над чем работать сначала.</p><h3>На что обратить внимание</h3><ol>${r.scores.filter(x=>x.available!==false).slice().sort((a,b)=>a.score-b.score).slice(0,3).map(x=>`<li><b>${esc(x.key==='qready'?'Полнота аргументов':x.label)} — ${x.score}/100.</b><p class="muted small">${esc(axisExplanation(x,r))}</p></li>`).join('')}</ol><p class="muted small">«Полнота аргументов» учитывает ключевые темы и наличие чисел. Это не проверка истинности фактов. Недоступные направления в диаграмме не показаны.</p></div></div></div>`);
    html.push(`<div class="panel-card"><h2>Оценки по осям</h2><div class="axes">${r.scores.map(a=>axisHtml(a,r)).join('')}</div></div>`);

    /* Карта содержания вместо технического графика. */
    html.push(`<div class="panel-card">
      <h2>Карта питча</h2>
      <p class="muted small">Где в выступлении встречаются основные темы. По субтитрам указано начало реплики; без них время приблизительное. Найденное упоминание не означает, что тема раскрыта полностью.</p>
      ${state.previewUrl ? `<div class="pitch-player"><div class="player-heading"><span class="player-icon" aria-hidden="true">▶</span><div><b>Ваше выступление</b><small>Перемотайте к нужному моменту или выберите «Слушать» у темы ниже</small></div></div><audio id="reportAudio" controls preload="metadata" src="${esc(state.previewUrl)}"></audio>${volumeControls('reportAudio')}</div>` : ''}
      ${map.length ? `<ol class="story-map">${map.map(item=>`<li><div class="story-time">${item.start==null?'Фрагмент '+(item.order+1):fmtTime(item.start)}<small>${item.start==null?'по тексту':item.estimated?'примерно':'по субтитрам'}</small></div><div><h3>${esc(item.label)}</h3><p>${esc(item.excerpt)}</p></div>${item.start!=null&&state.previewUrl?`<button class="btn ghost small" data-seek="${item.start}">Слушать</button>`:''}</li>`).join('')}</ol>` : '<p class="muted">Добавьте расшифровку, чтобы увидеть последовательность тем.</p>'}

    </div>`);

    /* — речь — */
    if(s){
      const speechAdvice=feedback.improvements.filter(x=>/остановку на|акценты голосом|Замедлитесь|Сократите затянутое|Уложитесь/.test(x.title));
      html.push(`<div class="panel-card"><h2>Речь и голос</h2><div class="speech-scores">${['confidence','pace','energy'].map(key=>{const a=r.scores.find(x=>x.key===key);return `<div><span class="muted small">${esc({confidence:'Выразительность',pace:'Темп и паузы',energy:'Динамика'}[key])}</span><b style="color:${a?.available!==false?scoreColor(a?.score||0):'var(--muted)'}">${a?.available!==false?a.score+'/100':'нет данных'}</b></div>`;}).join('')}</div><div class="split"><div><h3>Параметры речи</h3><table class="metrics">
        <tr><td>Длительность</td><td>${s.durationSec} с${m.targetDurationSec?' при регламенте '+m.targetDurationSec+' с':''}</td></tr>
        <tr><td>Темп речи</td><td>${esc(E.describeTempo(s,t))}</td></tr>
        <tr><td>Речь и остановки</td><td>${s.speechSec} с речи, ${s.pauseSec} с остановок внутри выступления</td></tr>
        <tr><td>Паузы</td><td>${s.pauses.count} пауз; длиннее полутора секунд — ${s.pauses.long}; самая длинная — ${s.pauses.longest} с</td></tr>
        <tr><td>Интонация</td><td>${s.f0.sdSemitones<1.4?'Мало изменений высоты голоса. Добавьте акценты на результате и запросе.':s.f0.sdSemitones>4.5?'Большие перепады высоты голоса. Проверьте, выделяют ли они важные мысли.':'Есть разнообразие интонаций. Проверьте, совпадают ли акценты с главными тезисами.'}</td></tr>
        <tr><td>Акценты громкостью</td><td>${s.loudness.dynRangeDb<8?'Изменения выражены слабо. Попробуйте выделить голосом ключевые фразы.':'Изменения громкости присутствуют. Это характеристика записи, а не громкости в зале.'}</td></tr>
        <tr><td>Запись</td><td>${s.loudness.clippingPct>.05?'Есть перегрузка: уменьшите усиление микрофона.':s.loudness.meanDb<-40?'Тихий сигнал: проверьте микрофон, усиление и расстояние.':'Сильная перегрузка по уровню сигнала не обнаружена.'}</td></tr>
      </table></div><div><h3>Что исправить в подаче</h3>${speechAdvice.length?'<ol class="precise-list">'+speechAdvice.map(x=>`<li><b>${esc(x.title)}</b><p>${esc(x.evidence)}</p><span class="action">${esc(x.action)}</span></li>`).join('')+'</ol>':'<p class="muted">По доступным признакам явных замечаний не выделено. Прослушайте запись и проверьте, слышен ли акцент на главном результате.</p>'}<h3>Где были паузы</h3>${s.pauses.list.length?'<div class="chip-list">'+s.pauses.list.slice().sort((a,b)=>b.dur-a.dur).slice(0,8).sort((a,b)=>a.start-b.start).map(x=>`<span class="chip">${fmtTime(x.start)}–${fmtTime(x.end)} · ${x.dur} с</span>`).join('')+'</div>':'<p class="muted small">Значимых остановок не найдено.</p>'}<p class="muted small">Смысловая пауза может быть полезна. Автоматическая оценка не отличает её от заминки по смыслу.</p></div></div></div>`);
    }else html.push('<div class="panel-card"><h2>Речь и голос</h2><p class="muted">Без аудиозаписи этот раздел не оценивается.</p></div>');

    /* — текст — */
    if(t.hasText)html.push(`<div class="panel-card"><h2>Текст и язык</h2>
      <h3>Транскрипт с подсветкой</h3><div class="legend"><span><i style="background:#22c55e"></i>позитив</span><span><i style="background:#ef4444"></i>негатив</span><span><i style="background:#f59e0b"></i>слова-паразиты</span><span><i style="background:#8b5cf6"></i>сомнения</span><span><i style="background:#94a3b8"></i>шаблоны</span><span><i style="background:#38bdf8"></i>уверенные утверждения</span></div><div class="transcript-view">${highlightHtml(r.transcript.text,r.highlights.spans)}</div>
      <h3>Что влияет на понятность</h3><p class="muted small">Здесь показано, что в вашем тексте может затруднять понимание и на что обратить внимание.</p><div class="language-metrics clarity-metrics">
        <div><span class="clarity-title">Лишние вводные слова</span><b class="${t.fillers.total?'clarity-attention':'clarity-good'}">${t.fillers.total}<small>найдено в тексте</small></b><p>${t.fillers.list.length?'Например: <strong>'+esc(t.fillers.list.slice(0,3).map(x=>'«'+x.word+'»').join(', '))+'</strong>. Если выражение не добавляет смысла, замените его короткой паузой.':'Слова-паразиты по словарю <strong>не найдены</strong>. Переслушайте запись: распознавание может пропустить часть слов.'}</p></div>
        <div><span class="clarity-title">Длина предложений</span><b class="${t.avgSentenceLen>20?'clarity-attention':'clarity-good'}">${t.avgSentenceLen}<small>слов в среднем</small></b><p>${t.longSentences.length?'<strong>Длинных предложений: '+t.longSentences.length+'.</strong> Попробуйте разделить их: одна главная мысль — одна фраза.':'Предложений длиннее 24 слов <strong>не найдено</strong>. Проверьте, что каждая фраза передаёт одну основную мысль.'}</p></div>
        <div><span class="clarity-title">Фразы, которым не хватает деталей</span><b class="${t.cliches.total?'clarity-attention':'clarity-good'}">${t.cliches.total}<small>найдено в тексте</small></b><p>${t.cliches.list.length?'Например: <strong>'+esc(t.cliches.list.slice(0,2).map(x=>'«'+x.word+'»').join(', '))+'</strong>. Объясните, что именно делает продукт и какую пользу получает клиент.':'Шаблонные выражения по словарю <strong>не найдены</strong>. Убедитесь, что главные обещания подкреплены примерами.'}</p></div>
        <div><span class="clarity-title">Легко ли следить за мыслью</span><b class="${t.flesch<45?'clarity-attention':'clarity-good'}">${t.flesch>=60?'Легче':t.flesch>=45?'Средне':'Сложнее'}</b><p>${t.flesch>=60?'По длине слов и фраз текст выглядит <strong>несложным</strong>. Проверьте, понятны ли термины человеку вне вашей отрасли.':t.flesch>=45?'Сложность выглядит <strong>умеренной</strong>. Замените редкие термины простым объяснением, где это возможно.':'Слова и фразы выглядят <strong>сложными для восприятия</strong>. Сократите длинные объяснения и поясните термины.'} Это приблизительная оценка, без проверки смысла.</p></div>
      </div><h3>Что влияет на убедительность и структуру</h3><div class="language-metrics">
        <div><b>${t.hedges.total}</b><span>неопределённых формулировок</span><p><strong>Конкретика.</strong> Отделите гипотезы от фактов. Не заменяйте честное сомнение неподтверждённым обещанием.</p></div>
        <div><b>${t.facts.numbers}</b><span>числовых примеров</span><p><strong>Конкретика и полнота аргументов.</strong> ${t.facts.examples.length?esc(t.facts.examples.slice(0,3).join('; ')):'Добавьте измеримый результат.'} Программа не проверяет достоверность чисел.</p></div>
        <div><b>${t.positive.total}</b><span>слов о пользе и результате</span><p><strong>Позитивный язык и конкретика.</strong> Учитывается доля таких слов; подкрепляйте их результатами и примерами.</p></div>
        <div><b>${t.facts.sentencesWithNumbers} / ${t.sentences}</b><span>предложений с числами</span><p><strong>Конкретика.</strong> Учитывается доля предложений с числовыми деталями. Это не подтверждение истинности фактов.</p></div>
        <div><b>${t.structure.filter(x=>x.required&&x.found).length} / ${t.structure.filter(x=>x.required).length}</b><span>необходимых тем обозначено</span><p><strong>Структура.</strong> Включены основные и отраслевые критерии. Ниже показано, какие темы требуют дополнения.</p></div>
      </div>
      <details class="language-details"><summary>Посмотреть найденные выражения</summary>${wordGroup('Позитивные слова',t.positive.list,'pos')}${wordGroup('Негативные слова',t.negative.list,'neg')}${wordGroup('Слова-сомнения',t.hedges.list,'hedge')}${wordGroup('Шаблонные выражения',t.cliches.list,'cliche')}${wordGroup('Уверенные формулировки',t.boosters.list,'booster')}</details>
    </div>`);

    /* — структура — */
    if(t.hasText){
      const core=r.structure.filter(x=>!x.sector),sector=r.structure.filter(x=>x.sector);
      html.push(`<div class="panel-card"><h2>Структура питча</h2><p class="muted small">Профиль: <b>${esc(t.industryProfile.label)}</b>. Оценка учитывает основные темы${sector.length?' и '+sector.length+' отраслевых критерия':''}. Найденные признаки не подтверждают истинность утверждений.</p><h3>Основные блоки</h3><div class="struct-grid">${core.map(b=>`<div class="struct ${b.found?'ok':'no'}"><h4><span>${b.found?'✓':'○'} ${esc(b.label)}</span></h4><p>${b.found?'Найдены слова-маркеры темы. Проверьте полноту объяснения.':esc(b.suggestion)}</p>${b.found&&b.evidence.length?`<div class="ev">${b.evidence.map(esc).join(', ')}</div>`:''}</div>`).join('')}</div>${sector.length?`<h3>Отраслевые метрики: ${esc(t.industryProfile.label)}</h3><div class="struct-grid">${sector.map(b=>`<div class="struct ${b.found?'ok':'no'}"><h4>${b.found?'✓':'○'} ${esc(b.label)}</h4><p>${esc(b.suggestion)}</p><div class="ev">${b.found?'Есть в тексте: '+b.evidence.map(esc).join(' '):b.quantified?'Нужны название метрики и число в одном предложении.':'Нужно явно описать этот аспект.'}</div></div>`).join('')}</div>`:'<p class="muted small">Для профильных метрик выберите конкретную отрасль на первом шаге.</p>'}</div>`);
    }

    /* — обратная связь — */
    const feedbackList = items => items.length ? '<ol class="precise-list">'+items.map(x=>`<li><b>${esc(x.title)}</b><p>${esc(x.evidence)}</p><span class="action">${esc(x.action)}</span></li>`).join('')+'</ol>' : '<p class="muted small">Недостаточно оснований для вывода. Проверьте запись и расшифровку.</p>';
    html.push(`<div class="panel-card"><h2>Разбор: что хорошо и что исправить</h2><div class="fb-grid">
      <div class="fb strong"><h4>Сильные стороны</h4>${feedbackList(feedback.strengths)}</div>
      <div class="fb weak"><h4>Что исправить в первую очередь</h4>${feedbackList(feedback.improvements)}</div>
      <div class="fb wins"><h4>План следующего прогона</h4><ol class="precise-list">${feedback.practice.map(x=>`<li><b>${esc(x.title)}</b><p>${esc(x.action)}</p></li>`).join('')}</ol></div>
    </div></div>`);

    /* Вопросы и рабочая репетиция сохраняются. */
    html.push(`<div class="panel-card"><h2>Вопросы Demo Day</h2><p class="muted small">${r.questions.length} вопросов. Отрасль: ${esc(t.industryProfile.label)}. Сначала профильные вопросы и пробелы, затем основные темы проекта.</p><button id="btnOtherQuestions" class="btn ghost small">Другие варианты вопросов</button><div id="qFilters" class="question-toolbar"></div><div id="qList"></div><button id="qMore" class="btn ghost">Показать ещё вопросы</button></div>`);

    releasePlayback('reportAudio');
    host.innerHTML = html.join('');
    if(state.previewUrl)bindPlayback('reportAudio');
    $$('[data-seek]',host).forEach(button=>button.addEventListener('click',()=>{const audio=$('#reportAudio');audio.currentTime=+button.dataset.seek;audio.play().catch(()=>{});}));
    if(window.requestAnimationFrame)requestAnimationFrame(()=>drawRadar($('#radar'),r.scores.filter(a=>a.available!==false)));
    $('#btnOtherQuestions').addEventListener('click',()=>{r.meta.questionVariant=(r.meta.questionVariant||0)+1;r.questions=E.generateQuestions(r);renderReport(r);});
    initQuestions(r);
  }

  function axisExplanation(a,r){
    const t=r.text,s=r.speech;
    if(a.available===false)return 'Для этого направления недостаточно данных.';
    const missing=t.missing.filter(x=>x.required).map(x=>x.label);
    const explanations={
      structure:missing.length?'Не найдены маркеры тем: '+missing.join(', ')+'.':'Маркеры обязательных тем есть. Проверьте, что за каждым тезисом стоит объяснение.',
      persuasion:'Найдено '+t.facts.numbers+' выражений с числами и '+t.hedges.total+' слов-сомнений. Добавляйте источник и период к каждому результату.',
      clarity:'Средняя длина предложения — '+t.avgSentenceLen+' слов; вводных заполнителей — '+t.fillers.total+'. Примеры ниже в тексте.',
      positivity:'Слова результата: '+t.positive.total+'; слова о проблемах: '+t.negative.total+'. Негатив в описании проблемы клиента может быть уместен.',
      qready:'Учитываются основные темы, числовые примеры и профильные критерии отрасли «'+t.industryProfile.label+'». Полнота смысла автоматически не проверяется.',
      confidence:s&&s.f0.sdSemitones<1.4?'Интонация меняется мало. Выделите голосом ключевой результат и запрос к аудитории.':'Оценка учитывает изменения интонации и акценты громкостью. Темп и слова-паразиты оцениваются отдельно.',
      timbre:'Это оценка доступного звукового сигнала. Микрофон и шум могут влиять на результат.',
      energy:s&&s.loudness.dynRangeDb<8?'Акценты громкостью выражены слабо. Подчеркните главный тезис голосом.':'Оценка отражает изменения громкости в записи, а не громкость в комнате.',
      pace:t.tempo.wordsPerMin?'По полной записи и расшифровке — '+t.tempo.wordsPerMin+' слов в минуту. Паузы учитываются.':'Без полной расшифровки темп приблизительный. Добавьте текст для точного подсчёта слов.'
    };
    return explanations[a.key]||'Оценка по доступным признакам выступления.';
  }
  function axisHtml(a,r) {
    const labels={confidence:'Выразительность',timbre:'Качество записи',energy:'Акценты в речи',pace:'Темп и ритм',structure:'Структура питча',persuasion:'Конкретика',clarity:'Понятность',positivity:'Позитивный язык',qready:'Полнота аргументов'};
    const available=a.available!==false;
    return `<div class="axis"><div class="axis-top"><b>${esc(labels[a.key]||a.label)}</b><span style="color:${available?scoreColor(a.score):'var(--muted)'}">${available?a.score+'/100':'нет данных'}</span></div><div class="track"><i style="width:${available?a.score:0}%;background:${scoreColor(a.score)}"></i></div><div class="axis-detail">${esc(axisExplanation(a,r))}</div></div>`;
  }
  function wordGroup(title,list,cls){
    return `<h3>${esc(title)}</h3>${list.length?'<div class="chip-list">'+list.slice(0,8).map(x=>`<span class="chip ${cls}">${esc(x.word)} <small>×${x.count}</small></span>`).join('')+'</div>':'<p class="muted small">По словарю не найдены.</p>'}`;
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

  function prep(canvas, h) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(220,canvas.clientWidth || canvas.parentNode.clientWidth || 360);
    const hh = h || canvas.height || 300;
    canvas.width = w * dpr;
    canvas.height = hh * dpr;
    canvas.style.height = hh + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    return { ctx, w: w, h: hh };
  }

  const SHORT = {
    structure: 'Структура', persuasion: 'Конкретика', clarity: 'Ясность', positivity: 'Позитив',
    qready: 'Аргументы', confidence: 'Подача', timbre: 'Запись', energy: 'Акценты', pace: 'Ритм'
  };

  function drawRadar(canvas, axes) {
    if (!canvas || !axes.length) return;
    const { ctx, w, h } = prep(canvas, 360);
    const n = axes.length, cx = w / 2, cy = h / 2 + 4, R = Math.min(w, h) * 0.25;
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
      const lx = cx + Math.cos(a) * (R + 26), ly = cy + Math.sin(a) * (R + 24);
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
    const filters = $('#qFilters'), list = $('#qList');
    const blocks = Array.from(new Set(r.questions.map(q=>q.blockLabel)));
    filters.innerHTML = `<label class="field"><span>Тема</span><select id="qCategory"><option value="">Все темы</option>${blocks.map(b=>`<option>${esc(b)}</option>`).join('')}</select></label><label class="field"><span>Показать</span><select id="qStatus"><option value="all">Все вопросы</option><option value="todo">Ещё не репетировал</option><option value="done">Отрепетированные</option></select></label><label class="field"><span>Порядок</span><select id="qSort"><option value="priority">Сначала важные</option><option value="easy">Сначала простые</option><option value="hard">Сначала сложные</option></select></label><label class="field question-search"><span>Поиск</span><input id="qSearch" placeholder="Например, конкуренты"></label><span id="qCount" class="muted small" aria-live="polite"></span>`;
    let limit = 6;
    const render = () => {
      const done=doneSet(), category=$('#qCategory').value, status=$('#qStatus').value, term=$('#qSearch').value.trim().toLowerCase();
      const items = r.questions.filter(q=>(!category || q.blockLabel===category) && (!term || (q.q+' '+q.frame).toLowerCase().includes(term)) && (status==='all' || done.has(qHash(q,r.meta.topic)) === (status==='done')));
      const order=$('#qSort').value;
      if(order!=='priority') items.sort((a,b)=>order==='easy' ? a.difficulty-b.difficulty : b.difficulty-a.difficulty);
      $('#qCount').textContent = `Найдено ${items.length} · показано ${Math.min(limit,items.length)}`;
      list.innerHTML = items.slice(0,limit).map((q,i)=>`<article class="question-card" data-q="${esc(q.id)}"><div class="question-top"><span>${esc(q.blockLabel)}</span><span>${['','Базовый','На подумать','Сложный'][q.difficulty] || 'Вопрос'}${done.has(qHash(q,r.meta.topic)) ? ' · Отрепетирован' : ''}</span></div><h3>${esc(q.q)}</h3><p class="question-source">${esc(q.source)}</p><details><summary>Как подготовить ответ</summary><p><b>Что проверяют:</b> ${esc(q.why)}</p><p><b>План ответа:</b> ${esc(q.frame)}</p><p><b>Чего избегать:</b> ${esc(q.avoid)}</p></details><div class="q-actions"><button class="btn primary small" data-act="rehearse">Записать ответ</button><button class="btn ghost small" data-act="done">${done.has(qHash(q,r.meta.topic)) ? 'Снять отметку' : 'Отметить готовым'}</button></div></article>`).join('') || '<p class="empty-state">По этим условиям вопросов нет. Измените фильтры.</p>';
      $('#qMore').classList.toggle('hidden',limit>=items.length);
    };
    ['qCategory','qStatus','qSort','qSearch'].forEach(id=>$('#'+id).addEventListener(id==='qSearch'?'input':'change',()=>{limit=6;render();}));
    $('#qMore').addEventListener('click',()=>{limit+=6;render();});
    list.addEventListener('click', e=>{
      const btn=e.target.closest('[data-act]'); if(!btn)return;
      const q=r.questions.find(x=>x.id===btn.closest('[data-q]').dataset.q); if(!q)return;
      if(btn.dataset.act==='done'){const hash=qHash(q,r.meta.topic);markDone(hash,!doneSet().has(hash));render();}
      else rehearse(q,render);
    });
    render();
  }

  // Independent capture: practicing an answer must never replace the original pitch.
  async function captureAnswer({ onText, onStatus }) {
    let stream, recorder, recognition, active = false, finalText = '', interim = '', stopped = false;
    const chunks = [];
    let resolveDone, rejectDone;
    const done = new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
    // A permission failure can happen before the caller receives the controller.
    done.catch(()=>{});
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Запись недоступна в этом браузере. Введите ответ текстом ниже.');
      const deviceId=$('#micDevice').value;
      stream = await navigator.mediaDevices.getUserMedia({audio:deviceId ? {deviceId:{exact:deviceId}} : true});
      const mime=pickMime();
      try { recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined); }
      catch (_) { recorder=new MediaRecorder(stream); }
      const release=()=>{active=false;try{recognition?.stop();}catch(_){}stream.getTracks().forEach(t=>t.stop());};
      recorder.ondataavailable=e=>{if(e.data?.size)chunks.push(e.data);};
      recorder.onstop=()=>{
        if(stopped)return; stopped=true; release();
        const blob=new Blob(chunks,{type:recorder.mimeType||chunks[0]?.type||'audio/webm'});
        if(!blob.size){rejectDone(new Error('Получилась пустая запись. Проверьте микрофон или введите ответ текстом.'));return;}
        resolveDone({blob,text:(finalText+' '+interim).trim()});
      };
      recorder.onerror=()=>{onStatus('Браузер прервал запись. Сохраняем доступную часть.'); if(recorder.state!=='inactive')recorder.stop();else recorder.onstop();};
      recorder.start();active=true;
      stream.getAudioTracks().forEach(t=>t.addEventListener('ended',()=>{if(active){onStatus('Микрофон отключён. Сохраняем ответ.');if(recorder.state!=='inactive')recorder.stop();}}));
      if(SR){
        try {
          recognition=new SR();recognition.lang='ru-RU';recognition.continuous=true;recognition.interimResults=true;
          recognition.onresult=e=>{
            if(!active)return;interim='';
            for(let i=e.resultIndex;i<e.results.length;i++){
              if(e.results[i].isFinal)finalText+=(finalText?' ':'')+e.results[i][0].transcript.trim();
              else interim+=e.results[i][0].transcript;
            }
            onText((finalText+' '+interim).trim());
          };
          recognition.onerror=e=>{
            onStatus('Звук записывается. Распознавание недоступно: после записи можно ввести текст вручную.');
            if(['not-allowed','service-not-allowed','network','audio-capture'].includes(e.error))recognition.onend=null;
          };
          recognition.onend=()=>{if(active){try{recognition.start();}catch(_){onStatus('Добавьте расшифровку вручную после записи.');}}};
          recognition.start();
        }catch(_){onStatus('Звук записывается. Если текст не появится, введите его после записи.');}
      }else onStatus('Звук записывается. В этом браузере расшифровку нужно ввести вручную.');
      return {
        done,
        stop(){if(active){active=false;try{recognition?.stop();}catch(_){}try{if(recorder.state!=='inactive')recorder.stop();else recorder.onstop();}catch(_){recorder.onstop();}}return done;},
        cancel(){active=false;try{recognition?.abort();}catch(_){}try{if(recorder.state!=='inactive')recorder.stop();}catch(_){}stream.getTracks().forEach(t=>t.stop());}
      };
    }catch(e){
      stream?.getTracks().forEach(t=>t.stop());
      const messages={NotAllowedError:'Разрешите доступ к микрофону в браузере и Windows или введите ответ текстом.',NotFoundError:'Микрофон не найден. Подключите его или введите ответ текстом.',NotReadableError:'Микрофон занят другим приложением. Закройте его и попробуйте снова.'};
      throw new Error(messages[e.name]||e.message);
    }
  }

  function rehearse(q, onComplete=()=>{}) {
    const modal=document.createElement('div');modal.className='modal rehearsal-modal';
    modal.innerHTML=`<div class="modal-box rehearsal-box" role="dialog" aria-modal="true" aria-labelledby="rehTitle"><div class="section-heading"><span class="eyebrow">Репетиция ответа</span><button class="btn ghost small" id="rehClose" aria-label="Закрыть репетицию">Закрыть</button></div><h2 id="rehTitle">${esc(q.q)}</h2><p class="muted">Ответьте за минуту: главный тезис → доказательство → вывод.</p><div class="rehearsal-controls"><span id="rehTimer">00:00 / 01:00</span><button class="btn primary" id="rehStart">Начать запись ответа</button><button class="btn danger hidden" id="rehStop">Завершить ответ</button></div><p id="rehStatus" class="muted small" role="status">Можно записать голос или сразу ввести ответ текстом.</p><div id="rehPlayer" class="pitch-player hidden"><div class="player-heading"><span class="player-icon" aria-hidden="true">▶</span><div><b>Ваш ответ</b><small>Прослушайте перед повторной попыткой</small></div></div><audio id="rehAudio" controls class="hidden"></audio>${volumeControls('rehAudio')}</div><label class="field"><span>Ваш ответ · можно исправить расшифровку</span><textarea id="rehText" rows="5" placeholder="Распознанный ответ появится здесь. Если распознавание не работает, введите его вручную."></textarea></label><div class="row"><button class="btn primary" id="rehAnalyze">Разобрать ответ</button><button class="btn ghost hidden" id="rehDone">Отметить отрепетированным</button></div><div id="rehResult" aria-live="polite"></div><details class="answer-plan"><summary>Посмотреть план ответа</summary><p>${esc(q.frame)}</p><p class="muted">Избегайте: ${esc(q.avoid)}</p></details></div>`;
    document.body.appendChild(modal);
    const $r=id=>$('#'+id,modal);
    let capture=null, pending=false, closed=false, timer=null, started=0, blob=null, url=null, savedDuration=0;
    const cleanup=()=>{closed=true;releasePlayback('rehAudio',modal);clearInterval(timer);capture?.cancel();if(url)URL.revokeObjectURL(url);modal.remove();document.removeEventListener('keydown',escape);};
    const escape=e=>{if(e.key==='Escape')cleanup();};
    document.addEventListener('keydown',escape);
    $r('rehClose').addEventListener('click',cleanup);
    modal.addEventListener('click',e=>{if(e.target===modal)cleanup();});
    function controls(busy){$r('rehStart').disabled=busy;$r('rehAnalyze').disabled=busy;$r('rehText').disabled=busy;}
    function resultHtml(result){
      return `<div class="answer-result"><h3>${esc(result.title)}</h3><p class="muted small">${esc(result.note)}</p><div class="answer-checks">${result.items.map(x=>`<div><span class="status-dot ${x.ok?'good':'improve'}"></span><div><b>${esc(x.label)}</b><p>${esc(x.advice)}</p></div></div>`).join('')}</div></div>`;
    }
    async function analyze(){
      if(closed||pending)return;
      const text=$r('rehText').value.trim();
      if(!text&&!blob){$r('rehStatus').textContent='Сначала запишите или введите ответ.';return;}
      pending=true;controls(true);$r('rehStatus').textContent='Разбираем ответ…';
      try{
        let speech=null;
        if(blob){
          try{const ctx=state.audioCtx||(state.audioCtx=new (window.AudioContext||window.webkitAudioContext)());const buffer=await ctx.decodeAudioData(await blob.arrayBuffer());speech=E.analyzeAudio(downmix(buffer),buffer.sampleRate);}
          catch(_){/* текстовый разбор доступен и при неподдерживаемом кодеке */}
        }
        if(closed)return;
        const result=E.evaluateAnswer({text,question:q,speech,durationSec:savedDuration});
        $r('rehResult').innerHTML=resultHtml(result);
        $r('rehStatus').textContent=text?'Разбор готов. Исправьте текст и повторите анализ или запишите новый ответ.':'Запись готова. Для разбора содержания добавьте расшифровку и нажмите «Разобрать ответ».';
        $r('rehDone').classList.remove('hidden');
      }catch(e){if(!closed)$r('rehStatus').textContent='Не удалось разобрать ответ: '+e.message;}
      finally{pending=false;if(!closed)controls(false);}
    }
    async function finish(){
      if(!capture||pending)return;
      savedDuration=Math.min(60,(Date.now()-started)/1000);
      clearInterval(timer);$r('rehStop').disabled=true;$r('rehStatus').textContent='Сохраняем ответ…';
      try{await capture.stop();}catch(_){} // done handler owns UI and error handling.
    }
    $r('rehStart').addEventListener('click',async()=>{
      if(pending||capture)return;
      pending=true;controls(true);$r('rehStatus').textContent='Ожидаем доступ к микрофону…';
      $r('rehResult').innerHTML='';$r('rehDone').classList.add('hidden');$r('rehText').value='';blob=null;
      if(url){URL.revokeObjectURL(url);url=null;}$r('rehAudio').removeAttribute('src');$r('rehAudio').classList.add('hidden');$r('rehPlayer').classList.add('hidden');
      try{
        const controller=await captureAnswer({onText:text=>{if(!closed)$r('rehText').value=text;},onStatus:text=>{if(!closed)$r('rehStatus').textContent=text;}});
        if(closed){controller.cancel();return;}
        capture=controller;pending=false;started=Date.now();savedDuration=0;
        $r('rehStatus').textContent=SR ? 'Записываем ответ. Когда закончите, нажмите «Завершить ответ».' : 'Записываем звук. Распознавание здесь недоступно: после записи введите расшифровку вручную.';
        $r('rehStop').disabled=false;$r('rehStop').classList.remove('hidden');
        $r('rehTimer').textContent='00:00 / 01:00';
        timer=setInterval(()=>{const elapsed=(Date.now()-started)/1000;$r('rehTimer').textContent=fmtTime(Math.min(60,elapsed))+' / 01:00';if(elapsed>=60)finish();},250);
        controller.done.then(async saved=>{
          clearInterval(timer);savedDuration=savedDuration||Math.min(60,(Date.now()-started)/1000);capture=null;
          if(closed)return;
          blob=saved.blob;url=URL.createObjectURL(blob);$r('rehAudio').src=url;$r('rehAudio').classList.remove('hidden');$r('rehPlayer').classList.remove('hidden');bindPlayback('rehAudio',modal);
          $r('rehText').value=saved.text;$r('rehStop').classList.add('hidden');pending=false;controls(false);
          $r('rehStart').textContent='Записать заново';await analyze();
        }).catch(e=>{clearInterval(timer);capture=null;pending=false;if(!closed){controls(false);$r('rehStop').classList.add('hidden');$r('rehStatus').textContent=e.message;}});
      }catch(e){if(!closed)$r('rehStatus').textContent=e.message;pending=false;if(!closed)controls(false);}
    });
    $r('rehStop').addEventListener('click',finish);
    $r('rehAnalyze').addEventListener('click',analyze);
    $r('rehDone').addEventListener('click',()=>{markDone(qHash(q,state.report?.meta.topic),true);$r('rehStatus').textContent='Отметка сохранена. Можно переходить к следующему вопросу.';onComplete();});
    $r('rehText').addEventListener('input',()=>{$r('rehResult').innerHTML='';$r('rehDone').classList.add('hidden');});
    $r('rehStart').focus();
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
    if (state.recording || state.starting || state.finishing || state.analyzing) return;
    setInputMode('mic');
    resetAudio(); state.audioSource = 'demo';
    $('#topic').value = 'ИИ-платформа приёмки товара на складе';
    $('#industry').value = 'Транспорт и логистика';
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
  window.addEventListener('resize',()=>{if(state.report)drawRadar($('#radar'),state.report.scores.filter(a=>a.available!==false));});
  $('#ver').textContent = 'версия ' + (LEX.VERSION || '1.0.0');
  updateTrCount();
  if (/[?&]demo=1/.test(location.search)) demo();

})();
