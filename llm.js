/* ============================================================
   llm.js — опциональный ИИ-тренер (OpenAI-совместимый API / Ollama)
   Базовый анализ работает без этого файла: он нужен только для
   «углублённого» разбора, переписывания питча и диалога с тренером.
   ============================================================ */
(function (root) {
  'use strict';

  const PRESETS = {
    openai: { base: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needKey: true, label: 'OpenAI' },
    deepseek: { base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needKey: true, label: 'DeepSeek' },
    openrouter: { base: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', needKey: true, label: 'OpenRouter' },
    groq: { base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', needKey: true, label: 'Groq' },
    ollama: { base: 'http://127.0.0.1:11434/v1', model: 'llama3.1', needKey: false, label: 'Ollama' },
    custom: { base: '', model: '', needKey: false, label: 'Свой endpoint' }
  };

  const KEY = 'pitchengine.llm';

  function loadConfig() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { saved = {}; }
    const provider = saved.provider || 'openai';
    const preset = PRESETS[provider] || PRESETS.openai;
    return {
      provider,
      base: saved.base || preset.base,
      model: saved.model || preset.model,
      apiKey: saved.apiKey || ''
    };
  }
  function saveConfig(cfg) {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); return true; } catch (e) { return false; }
  }
  function ready(cfg) {
    const preset = PRESETS[cfg.provider] || PRESETS.openai;
    if (!cfg.base) return 'не задан Base URL';
    if (preset.needKey && !cfg.apiKey) return 'не задан API-ключ';
    if (!cfg.model) return 'не задана модель';
    return null;
  }

  async function chat(messages, cfg, opts) {
    opts = opts || {};
    const url = cfg.base.replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: cfg.model,
      messages,
      temperature: opts.temperature == null ? 0.3 : opts.temperature,
      max_tokens: opts.maxTokens || 2200
    };
    if (opts.json) body.response_format = { type: 'json_object' };
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) {
      throw new Error('Сеть недоступна или сервис не разрешает запросы из браузера (CORS). ' + (e && e.message ? e.message : ''));
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 400); } catch (e) { detail = ''; }
      throw new Error('HTTP ' + res.status + ' от ' + url + (detail ? ': ' + detail : ''));
    }
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    if (!text) throw new Error('Пустой ответ модели');
    return text;
  }

  function parseJson(text) {
    let t = String(text).trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
    return JSON.parse(t);
  }

  /** Компактная выжимка отчёта для промпта */
  function digest(report) {
    const t = report.text, s = report.speech, m = report.meta;
    const L = [];
    L.push(`Тема проекта: ${m.topic || '—'}`);
    L.push(`Отрасль: ${m.industry || '—'} | Формат: ${m.format} | Аудитория: ${m.audience} | Регламент: ${m.targetDurationSec} с | Длительность: ${m.durationSec} с`);
    L.push(`Итоговый балл: ${report.total.score}/100 (${report.total.grade} — ${report.total.label})`);
    L.push('Оценки по осям: ' + report.scores.filter((x) => x.available !== false).map((x) => `${x.label} ${x.score}`).join('; '));
    if (t && t.hasText) {
      L.push(`Текст: слов ${t.words}, предложений ${t.sentences}, средняя длина ${t.avgSentenceLen}, читаемость ${t.flesch}.`);
      L.push(`Позитивные слова (${t.positive.total}): ${t.positive.list.slice(0, 10).map((x) => x.word).join(', ') || '—'}`);
      L.push(`Негативные (${t.negative.total}): ${t.negative.list.slice(0, 10).map((x) => x.word).join(', ') || '—'}`);
      L.push(`Слова-паразиты (${t.fillers.total}): ${t.fillers.list.map((x) => x.word + '×' + x.count).join(', ') || '—'}`);
      L.push(`Хеджи (${t.hedges.total}): ${t.hedges.list.map((x) => x.word + '×' + x.count).join(', ') || '—'}`);
      L.push(`Штампы (${t.cliches.total}): ${t.cliches.list.map((x) => x.word + '×' + x.count).join(', ') || '—'}`);
      L.push(`Цифры/метрики: ${t.facts.numbers} (${t.facts.density} на 100 слов)`);
      L.push('Структура: ' + t.structure.map((x) => `${x.label}${x.found ? '+' : '−'}`).join(', '));
      L.push('Пробелы: ' + (t.missing.map((x) => x.label).join(', ') || 'нет'));
    } else L.push('Транскрипт отсутствует.');
    if (s) {
      const pace = (t && t.tempo.wordsPerMin) || s.rate.estimatedWordsPerMin;
      L.push(`Речь: темп ~${pace} слов/мин, паузы ${Math.round(s.pauseRatio * 100)}% (длинных ${s.pauses.long}), тон медиана ${s.f0.medianHz} Гц, вариативность ${s.f0.sdSemitones} полутона, восходящих окончаний ${Math.round(s.prosody.upShare * 100)}%.`);
      L.push(`Тембр: центроид ${s.timbre.centroidHz} Гц, HNR ${s.timbre.hnrDb} дБ, джиттер ${s.timbre.jitterPct}%, шиммер ${s.timbre.shimmerPct}%. Громкость ${s.loudness.meanDb} дБ, диапазон ${s.loudness.dynRangeDb} дБ.`);
    } else L.push('Аудио отсутствует.');
    const transcript = (report.transcript.text || '').slice(0, 6000);
    L.push('--- ТРАНСКРИПТ ---');
    L.push(transcript || '(нет)');
    return L.join('\n');
  }

  const SYS_COACH = 'Ты опытный тренер по питчам и венчурный аналитик (уровень Demo Day и корпоративного акселератора). Отвечай по-русски, конкретно, без воды и комплиментов. Опирайся только на данные отчёта. Если данных нет — скажи прямо. Формат: короткие абзацы и списки, максимум 200 слов, если не попросили иначе.';

  async function deepAnalyze(report, cfg) {
    const prompt = `${digest(report)}

Задача: дай глубокий разбор этого питча. Верни СТРОГО JSON без пояснений:
{
  "verdict": "2-3 предложения: главный вывод и что решает исход",
  "top_strengths": ["3 сильные стороны с опорой на данные"],
  "critical_risks": ["3 слабых места, из-за которых могут не дать денег/пилот"],
  "rewrite_60": "переписанный питч на 60 секунд (готовый текст для чтения вслух, с цифрами-заглушками [N])",
  "rewrite_30": "версия на 30 секунд (1 абзац)",
  "opening_15": "первые 15 секунд: точная фраза-крючок",
  "questions": [{"q":"жёсткий вопрос жюри","answer":"готовый ответ 2-4 предложения с цифрой [N]","why":"что проверяют"}],
  "what_to_cut": ["что убрать из выступления"],
  "delivery_fixes": ["что поправить в подаче: темп, паузы, интонация, голос — по метрикам"]
}
Вопросов сделай 8, самых неудобных для этого питча.`;
    const txt = await chat([
      { role: 'system', content: SYS_COACH },
      { role: 'user', content: prompt }
    ], cfg, { json: true, temperature: 0.4, maxTokens: 3000 });
    return parseJson(txt);
  }

  async function rewritePitch(report, seconds, cfg) {
    const prompt = `${digest(report)}

Перепиши питч так, чтобы он звучал ${seconds} секунд при темпе 145 слов/мин (примерно ${Math.round(seconds * 145 / 60)} слов).
Требования: живая устная речь, первое предложение — крючок, в каждом блоке цифра (если в данных нет — ставь [N]), без штампов, без канцелярита, без «может быть» и «постараемся».
Верни СТРОГО JSON: {"text":"готовый текст питча","beats":["тайминг: 0-10 с — крючок", "..."],"notes":["что изменил и почему"]}`;
    const txt = await chat([
      { role: 'system', content: SYS_COACH },
      { role: 'user', content: prompt }
    ], cfg, { json: true, temperature: 0.5, maxTokens: 1600 });
    return parseJson(txt);
  }

  async function askCoach(question, report, history, cfg) {
    const messages = [
      { role: 'system', content: SYS_COACH },
      { role: 'user', content: 'Данные отчёта о моём питче:\n' + digest(report) }
    ];
    (history || []).slice(-6).forEach((h) => messages.push({ role: h.role === 'me' ? 'user' : 'assistant', content: h.text }));
    messages.push({ role: 'user', content: question });
    return chat(messages, cfg, { temperature: 0.5, maxTokens: 900 });
  }

  /** Транскрипция загруженного аудио через OpenAI-совместимый /audio/transcriptions */
  async function transcribe(blob, cfg, filename) {
    const url = cfg.base.replace(/\/+$/, '') + '/audio/transcriptions';
    const fd = new FormData();
    fd.append('file', blob, filename || 'pitch.webm');
    fd.append('model', cfg.transcribeModel || 'whisper-1');
    fd.append('language', 'ru');
    const headers = {};
    if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;
    const res = await fetch(url, { method: 'POST', headers, body: fd });
    if (!res.ok) {
      let d = ''; try { d = (await res.text()).slice(0, 300); } catch (e) { d = ''; }
      throw new Error('HTTP ' + res.status + (d ? ': ' + d : ''));
    }
    const data = await res.json();
    if (!data.text) throw new Error('Сервис не вернул текст');
    return data.text;
  }

  root.PitchLLM = { PRESETS, loadConfig, saveConfig, ready, chat, deepAnalyze, rewritePitch, askCoach, transcribe, digest, parseJson };
})(typeof globalThis !== 'undefined' ? globalThis : this);
