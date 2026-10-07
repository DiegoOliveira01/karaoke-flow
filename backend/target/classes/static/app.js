"use strict";

/* ============================================================
   Utilitários
   ============================================================ */
const API = "/api/songs";
const STATUS_LABEL = {
  QUEUED: "Na fila",
  SEPARATING: "Separando as vozes…",
  READY: "Pronta",
  FAILED: "Falhou",
};

const $ = (id) => document.getElementById(id);

/** Cria elemento: props viram atributos; "onclick" etc. viram listeners. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value == null) continue;
    if (key === "className") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children);
  return node;
}

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (_) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* sem armazenamento */ }
  },
};

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/** URL de um arquivo da música. ?v= muda quando letra/capa são trocadas (fura o cache). */
function mediaUrl(song, kind) {
  const file = song.files && song.files[kind];
  return file ? `/media/${song.id}/${file}?v=${song.rev || 0}` : null;
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let message = "";
    try { message = (await res.json()).message || ""; } catch (_) { /* corpo vazio */ }
    throw new Error(message || `Erro ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

const putJson = (path, body) =>
  api(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function setStatus(id, message, isError = false) {
  const node = $(id);
  node.textContent = message;
  node.className = "status" + (isError ? " error" : "");
}

/* ============================================================
   Biblioteca
   ============================================================ */
let songs = [];
let current = null;      // música carregada no player
let loadedRev = -1;      // rev da letra/capa já aplicada na tela
let pollTimer = null;

async function refresh() {
  try { songs = await api(API); } catch (_) { /* backend fora do ar: tenta de novo adiante */ }
  renderSongs();
  if (current) {
    const fresh = songs.find((s) => s.id === current.id);
    if (!fresh) unloadSong();
    else syncCurrent(fresh);
  }
  clearTimeout(pollTimer);
  if (songs.some((s) => s.status === "QUEUED" || s.status === "SEPARATING" || s.wordsState === "RUNNING")) {
    pollTimer = setTimeout(refresh, 3000);
  }
}

/** Troca uma música atualizada pelo servidor (letra, capa, ajuste) sem recarregar áudio. */
function replaceSong(updated) {
  const i = songs.findIndex((s) => s.id === updated.id);
  if (i >= 0) songs[i] = updated;
  renderSongs();
  if (current && current.id === updated.id) syncCurrent(updated);
}

function syncCurrent(fresh) {
  current = fresh;
  if (fresh.rev !== loadedRev) applyAssets();
}

function renderSongs() {
  const list = $("songs");
  list.replaceChildren();
  if (songs.length === 0) {
    list.append(el("li", { className: "empty" }, "Nenhuma música ainda. Envie um arquivo de áudio acima."));
    return;
  }
  for (const s of songs) {
    const cover = mediaUrl(s, "cover");
    const thumb = cover
      ? el("img", { className: "thumb", src: cover, alt: "", loading: "lazy" })
      : el("div", { className: "thumb empty", "aria-hidden": "true" }, "♪");

    const meta = [s.artist, STATUS_LABEL[s.status]].filter(Boolean).join(" • ");
    const hasLyrics = !!(s.files && s.files.lyrics);
    const hasWords = !!(s.files && s.files.words);
    const wordsLabel = s.wordsState === "RUNNING" ? "palavras…" : hasWords ? "palavras ✓" : "sem palavras";
    const info = el("div", {},
      el("div", { className: "song-title" }, s.title),
      el("div", { className: "song-meta" }, meta),
      el("div", { className: "tags" },
        el("span", { className: "tag" + (hasLyrics ? " ok" : "") }, hasLyrics ? "letra ✓" : "sem letra"),
        el("span", { className: "tag" + (cover ? " ok" : "") }, cover ? "capa ✓" : "sem capa"),
        hasLyrics ? el("span", { className: "tag" + (hasWords ? " ok" : "") }, wordsLabel) : ""));
    if (s.status === "FAILED" && s.error) info.append(el("div", { className: "song-error" }, s.error));
    if (s.wordsState === "FAILED" && s.wordsError) {
      info.append(el("div", { className: "song-error" }, `Palavras: ${s.wordsError}`));
    }

    const actions = el("div", { className: "song-actions" });
    if (s.status === "READY") {
      actions.append(el("button", { className: "btn", type: "button", onclick: () => loadSong(s) }, "Cantar"));
    }
    actions.append(
      el("button", { className: "btn ghost", type: "button", onclick: () => openLyricsDialog(s) }, "Letra"),
      s.status === "READY" && hasLyrics
        ? el("button", { className: "btn ghost", type: "button", onclick: () => openWordsDialog(s) }, "Palavras")
        : "",
      el("button", { className: "btn ghost", type: "button", onclick: () => openCoverDialog(s) }, "Capa"),
      el("button", { className: "btn ghost", type: "button", onclick: () => removeSong(s) }, "Apagar"));

    const li = el("li", { className: "song" + (current && s.id === current.id ? " active" : "") }, thumb, info, actions);
    li.dataset.status = s.status;
    list.append(li);
  }
}

async function removeSong(song) {
  if (!confirm(`Apagar “${song.title}”?`)) return;
  if (current && song.id === current.id) unloadSong();
  try { await api(`${API}/${song.id}`, { method: "DELETE" }); } catch (_) { /* já não existe */ }
  refresh();
}

$("add-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  $("add-btn").disabled = true;
  setStatus("add-status", "Enviando…");
  try {
    await api(API, { method: "POST", body: new FormData(form) });
    form.reset();
    setStatus("add-status", "Enviada. A separação começa assim que chegar a vez dela.");
    refresh();
  } catch (e) {
    setStatus("add-status", e.message || "Não foi possível enviar.", true);
  } finally {
    $("add-btn").disabled = false;
  }
});

/* ============================================================
   Diálogo: letra (LRCLIB)
   ============================================================ */
let dialogSong = null;

function openLyricsDialog(song) {
  dialogSong = song;
  $("lyrics-title").value = song.title;
  $("lyrics-artist").value = song.artist || "";
  $("lyrics-results").replaceChildren();
  setStatus("lyrics-status", "");
  $("dlg-lyrics").showModal();
  searchLyrics();
}

$("lyrics-form").addEventListener("submit", (ev) => { ev.preventDefault(); searchLyrics(); });

async function searchLyrics() {
  const params = new URLSearchParams({ title: $("lyrics-title").value, artist: $("lyrics-artist").value });
  const list = $("lyrics-results");
  list.replaceChildren();
  setStatus("lyrics-status", "Buscando…");
  try {
    const results = await api(`/api/lyrics/search?${params}`);
    setStatus("lyrics-status", results.length ? "" : "Nada encontrado. Tente só o título, ou outro nome do artista.");
    for (const r of results) list.append(lyricsResultItem(r));
  } catch (e) {
    setStatus("lyrics-status", e.message, true);
  }
}

function lyricsResultItem(r) {
  const button = el("button", { className: "btn", type: "button", disabled: !r.synced }, "Usar");
  button.addEventListener("click", () => chooseLyrics(r, button));
  const badge = el("span", { className: "badge" + (r.synced ? "" : " off") },
    r.synced ? "sincronizada" : "sem sincronia");
  return el("li", { className: "result" },
    el("div", {},
      el("div", { className: "r-title" }, r.title, badge),
      el("div", { className: "r-meta" }, [r.artist, r.album, fmt(r.duration)].filter(Boolean).join(" • "))),
    button,
    r.preview ? el("div", { className: "r-preview" }, r.preview) : "");
}

async function chooseLyrics(result, button) {
  button.disabled = true;
  setStatus("lyrics-status", "Baixando a letra…");
  try {
    replaceSong(await putJson(`${API}/${dialogSong.id}/lyrics`, { lrclibId: result.id }));
    $("dlg-lyrics").close();
  } catch (e) {
    setStatus("lyrics-status", e.message, true);
    button.disabled = false;
  }
}

/* ============================================================
   Diálogo: palavras sincronizadas (alinhamento na voz isolada)
   ============================================================ */
function openWordsDialog(song) {
  dialogSong = song;
  $("words-lang").value = store.get("wordsLang", "pt");
  const running = song.wordsState === "RUNNING";
  $("words-go").disabled = running;
  $("words-go").textContent = song.files.words ? "Refazer palavras" : "Sincronizar palavras";
  setStatus("words-status", running
    ? "Sincronizando… pode levar alguns minutos. Você pode fechar esta janela."
    : song.files.words ? "Esta música já tem palavras sincronizadas. Refazer substitui as atuais." : "");
  $("dlg-words").showModal();
}

$("words-go").addEventListener("click", async () => {
  const language = $("words-lang").value;
  store.set("wordsLang", language);
  $("words-go").disabled = true;
  setStatus("words-status", "Enviando…");
  try {
    replaceSong(await api(`${API}/${dialogSong.id}/words?language=${encodeURIComponent(language)}`, { method: "POST" }));
    $("dlg-words").close();
    refresh(); // começa a acompanhar o andamento
  } catch (e) {
    setStatus("words-status", e.message, true);
    $("words-go").disabled = false;
  }
});

/* ============================================================
   Diálogo: capa (iTunes)
   ============================================================ */
function openCoverDialog(song) {
  dialogSong = song;
  $("cover-term").value = [song.artist, song.title].filter(Boolean).join(" ");
  $("cover-results").replaceChildren();
  setStatus("cover-status", "");
  $("dlg-cover").showModal();
  searchCovers();
}

$("cover-form").addEventListener("submit", (ev) => { ev.preventDefault(); searchCovers(); });

async function searchCovers() {
  const list = $("cover-results");
  list.replaceChildren();
  setStatus("cover-status", "Buscando…");
  try {
    const results = await api(`/api/covers/search?${new URLSearchParams({ term: $("cover-term").value })}`);
    setStatus("cover-status", results.length ? "" : "Nada encontrado. Tente outro termo (só o artista, por exemplo).");
    for (const r of results) {
      const button = el("button", { className: "cover-btn", type: "button", title: `${r.album} — ${r.artist}` },
        el("img", { src: r.thumb, alt: r.album, loading: "lazy" }),
        el("span", {}, r.album),
        el("span", {}, r.artist));
      button.addEventListener("click", () => chooseCover(r));
      list.append(el("li", {}, button));
    }
  } catch (e) {
    setStatus("cover-status", e.message, true);
  }
}

async function chooseCover(result) {
  setStatus("cover-status", "Baixando a imagem…");
  try {
    replaceSong(await putJson(`${API}/${dialogSong.id}/cover`, { url: result.url }));
    $("dlg-cover").close();
  } catch (e) {
    setStatus("cover-status", e.message, true);
  }
}

/* ============================================================
   Mixer (o mesmo estado alimenta o preview e a tela de karaokê)
   ============================================================ */
const FADERS = [
  { key: "lead", label: "Voz do cantor", cls: "lead" },
  { key: "backing", label: "Backing vocals", cls: "backing", hint: "Em algumas músicas fica melhor zerar. Teste." },
  { key: "instrumental", label: "Instrumental", cls: "instrumental" },
];
const mix = { lead: 0, backing: 100, instrumental: 100 };
let activePreset = "karaoke";
const mixerUIs = [];

function buildMixer(slot, withHints) {
  const ui = { inputs: {}, outs: {}, presets: {} };
  ui.presets.karaoke = el("button", { className: "btn", type: "button", onclick: () => setPreset("karaoke") },
    "Karaokê (sem a voz do cantor)");
  ui.presets.original = el("button", { className: "btn ghost", type: "button", onclick: () => setPreset("original") },
    "Original");
  const faders = el("div", { className: "faders" });
  for (const f of FADERS) {
    const input = el("input", { type: "range", min: 0, max: 100, value: mix[f.key], "aria-label": f.label });
    const out = el("output", {});
    input.addEventListener("input", () => {
      mix[f.key] = Number(input.value);
      activePreset = null;
      applyMix();
    });
    faders.append(el("div", { className: `fader ${f.cls}` },
      el("div", { className: "fader-head" }, el("span", {}, f.label), out),
      input,
      withHints && f.hint ? el("p", { className: "hint" }, f.hint) : ""));
    ui.inputs[f.key] = input;
    ui.outs[f.key] = out;
  }
  slot.replaceChildren(el("div", { className: "presets" }, ui.presets.karaoke, ui.presets.original), faders);
  mixerUIs.push(ui);
}

function applyMix() {
  for (const ui of mixerUIs) {
    for (const f of FADERS) {
      ui.inputs[f.key].value = mix[f.key];
      ui.outs[f.key].textContent = `${mix[f.key]}%`;
    }
    ui.presets.karaoke.classList.toggle("on", activePreset === "karaoke");
    ui.presets.original.classList.toggle("on", activePreset === "original");
  }
  if (audio.ctx) {
    for (const f of FADERS) {
      const node = audio.gains[f.key];
      if (node) node.gain.setTargetAtTime(mix[f.key] / 100, audio.ctx.currentTime, 0.02);
    }
  }
  if (current) store.set(`mix:${current.id}`, { mix: { ...mix }, preset: activePreset });
}

function setPreset(name) {
  mix.lead = name === "karaoke" ? 0 : 100;
  mix.backing = 100;
  mix.instrumental = 100;
  activePreset = name;
  applyMix();
}

/** Cada música lembra o próprio ajuste (o que funciona numa não funciona noutra). */
function restoreMix(song) {
  const saved = store.get(`mix:${song.id}`, null);
  if (saved && saved.mix) {
    Object.assign(mix, saved.mix);
    activePreset = saved.preset || null;
    applyMix();
  } else {
    setPreset("karaoke");
  }
}

/* ============================================================
   Áudio (Web Audio: um nó de volume por faixa)
   ============================================================ */
const STEMS = ["instrumental", "lead", "backing"];
const audio = {
  ctx: null, buffers: {}, gains: {}, sources: [],
  duration: 0,
  offset: 0,      // posição (s) quando pausado
  startedAt: 0,   // ctx.currentTime - posição, quando tocando
  playing: false, raf: 0,
};
let seeking = false;
const seeks = [$("seek"), $("st-seek")];

function position() {
  return audio.playing ? audio.ctx.currentTime - audio.startedAt : audio.offset;
}

function stopSources() {
  for (const src of audio.sources) {
    src.onended = null;
    try { src.stop(); } catch (_) { /* já parou */ }
    src.disconnect();
  }
  audio.sources = [];
}

function setPlayIcons() {
  const icon = audio.playing ? "❚❚" : "▶";
  const label = audio.playing ? "Pausar" : "Tocar";
  for (const id of ["play", "st-play"]) {
    $(id).textContent = icon;
    $(id).setAttribute("aria-label", label);
  }
}

function setSeekValues(pos) { for (const s of seeks) s.value = pos; }
function setTimeLabels(pos) {
  $("time").textContent = fmt(pos);
  $("st-time").textContent = `${fmt(pos)} / ${fmt(audio.duration)}`;
}

function startPlayback(from) {
  const ctx = audio.ctx;
  stopSources();
  const when = ctx.currentTime + 0.1; // todas as faixas começam no mesmo instante
  for (const name of STEMS) {
    const src = ctx.createBufferSource();
    src.buffer = audio.buffers[name];
    src.connect(audio.gains[name]);
    src.start(when, from);
    audio.sources.push(src);
  }
  audio.sources[0].onended = onEnded;
  audio.startedAt = when - from;
  audio.playing = true;
  setPlayIcons();
  tick();
}

function pausePlayback() {
  audio.offset = position();
  stopSources();
  audio.playing = false;
  cancelAnimationFrame(audio.raf);
  setPlayIcons();
}

function onEnded() {
  // só dispara quando a faixa termina sozinha (stop() manual zera o onended)
  audio.playing = false;
  audio.offset = 0;
  stopSources();
  cancelAnimationFrame(audio.raf);
  setPlayIcons();
  setSeekValues(0);
  setTimeLabels(0);
  renderLyrics(0);
}

function tick() {
  if (!audio.playing) return;
  const pos = Math.min(position(), audio.duration);
  if (!seeking) {
    setSeekValues(pos);
    setTimeLabels(pos);
  }
  renderLyrics(pos);
  audio.raf = requestAnimationFrame(tick);
}

async function togglePlay() {
  if (!audio.ctx || !audio.buffers.lead) return;
  await audio.ctx.resume();
  if (audio.playing) pausePlayback();
  else startPlayback(audio.offset);
}

function seekTo(to) {
  to = Math.max(0, Math.min(audio.duration, to));
  audio.offset = to;
  setSeekValues(to);
  setTimeLabels(to);
  if (audio.playing) startPlayback(to);
  else renderLyrics(to);
}

$("play").addEventListener("click", togglePlay);
$("st-play").addEventListener("click", togglePlay);
for (const s of seeks) {
  s.addEventListener("input", () => {
    seeking = true;
    const v = Number(s.value);
    for (const other of seeks) if (other !== s) other.value = v;
    setTimeLabels(v);
    renderLyrics(v);
  });
  s.addEventListener("change", () => {
    seeking = false;
    seekTo(Number(s.value));
  });
}

async function loadSong(song) {
  stopSources();
  cancelAnimationFrame(audio.raf);
  audio.playing = false;
  audio.offset = 0;
  audio.buffers = {};
  current = song;
  loadedRev = -1;
  renderSongs();
  setPlayIcons();

  $("now-title").textContent = song.title;
  $("now-artist").textContent = song.artist || "";
  $("play").disabled = true;
  for (const s of seeks) s.disabled = true;
  $("mixer").hidden = true;
  setStatus("player-status", "Carregando as faixas…");

  // O AudioContext precisa nascer de um clique do usuário (política dos navegadores).
  if (!audio.ctx) audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
  const ctx = audio.ctx;

  try {
    const decoded = await Promise.all(STEMS.map(async (name) => {
      const file = song.files[name];
      if (!file) throw new Error(`Faixa “${name}” não encontrada.`);
      const res = await fetch(`/media/${song.id}/${file}`);
      if (!res.ok) throw new Error(`Não consegui baixar a faixa “${name}”.`);
      return [name, await ctx.decodeAudioData(await res.arrayBuffer())];
    }));
    if (!current || current.id !== song.id) return; // trocou de música enquanto carregava

    audio.buffers = Object.fromEntries(decoded);
    audio.duration = Math.max(...decoded.map(([, b]) => b.duration));
    audio.gains = {};
    for (const name of STEMS) {
      const g = ctx.createGain();
      g.connect(ctx.destination);
      audio.gains[name] = g;
    }
    for (const s of seeks) { s.max = audio.duration; s.value = 0; s.disabled = false; }
    $("play").disabled = false;
    $("mixer").hidden = false;
    setTimeLabels(0);
    setStatus("player-status", "");
    restoreMix(song);
    applyAssets();
  } catch (e) {
    setStatus("player-status", e.message || "Erro ao carregar a música.", true);
  }
}

function unloadSong() {
  closeStage();
  stopSources();
  cancelAnimationFrame(audio.raf);
  audio.playing = false;
  audio.offset = 0;
  audio.buffers = {};
  current = null;
  loadedRev = -1;
  lyrics = [];
  wordEls = [];
  hideCountdown();
  $("now-title").textContent = "Escolha uma música";
  $("now-artist").textContent = "Quando a separação terminar, clique em “Cantar”.";
  $("mixer").hidden = true;
  $("play").disabled = true;
  for (const s of seeks) { s.disabled = true; s.value = 0; }
  setPlayIcons();
  setTimeLabels(0);
  setStatus("player-status", "");
  renderSongs();
}

/* ============================================================
   Letra sincronizada
   ============================================================ */
let lyrics = [];          // [{ t: segundos, text }]
let lineEls = [];
let wordEls = [];         // por linha: lista de <span> das palavras (ou null se a linha não tem palavras alinhadas)
let shownCountdown = 0;   // número da contagem regressiva exibido agora (0 = escondida)
let activeIdx = -2;
let offsetMs = 0;         // atraso da letra (positivo = aparece mais tarde)
let offsetSaveTimer = null;

function parseLrc(text) {
  const stamp = /\[(\d{1,3}):(\d{2}(?:[.:]\d{1,3})?)\]/g;
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const times = [];
    let last = 0;
    let m;
    stamp.lastIndex = 0;
    while ((m = stamp.exec(raw)) !== null) {
      times.push(Number(m[1]) * 60 + Number(m[2].replace(":", ".")));
      last = stamp.lastIndex;
    }
    if (!times.length) continue; // tags de metadados ([ar:], [ti:]...) e linhas soltas
    const content = raw.slice(last).replace(/<\d+:\d+(?:[.:]\d+)?>/g, "").trim();
    for (const t of times) out.push({ t, text: content });
  }
  out.sort((a, b) => a.t - b.t);
  // junta linhas em branco repetidas e tira as do começo
  return out.filter((l, i) => l.text || (i > 0 && out[i - 1].text));
}

/** Carrega capa e letra da música atual na tela de karaokê. */
async function applyAssets() {
  if (!current) return;
  const song = current;
  loadedRev = song.rev;
  offsetMs = song.lyricsOffsetMs || 0;

  const cover = mediaUrl(song, "cover");
  const bg = $("stage-bg");
  bg.style.backgroundImage = cover ? `url("${cover}")` : "";
  bg.classList.toggle("has-art", !!cover);
  $("st-title").textContent = song.title;
  $("st-artist").textContent = song.artist || "";

  lyrics = [];
  const url = mediaUrl(song, "lyrics");
  if (url) {
    try {
      const res = await fetch(url);
      if (res.ok) lyrics = parseLrc(await res.text());
    } catch (_) { /* fica sem letra */ }
  }

  let wordsData = null;
  const wordsUrl = mediaUrl(song, "words");
  if (wordsUrl) {
    try {
      const res = await fetch(wordsUrl);
      if (res.ok) wordsData = await res.json();
    } catch (_) { /* sem palavras: usa o preenchimento por linha */ }
  }
  if (!current || current.id !== song.id) return;
  attachWords(wordsData);
  buildLyricsDom();
  updateSyncInfo();
  renderLyrics(position(), true);
}

const normText = (text) => text.toLowerCase().replace(/\s+/g, " ").trim();

/** Liga as palavras alinhadas (words.json) às linhas do LRC pelo tempo da linha. */
function attachWords(data) {
  if (!data || !Array.isArray(data.lines)) return;
  const byTime = new Map();
  for (const line of data.lines) {
    if (line.aligned && Array.isArray(line.words) && line.words.length) {
      byTime.set(Math.round(line.t * 1000), line);
    }
  }
  for (const l of lyrics) {
    const hit = byTime.get(Math.round(l.t * 1000));
    // se o texto não bate, a letra mudou depois do alinhamento: essa linha fica com o preenchimento estimado
    if (hit && normText(hit.text) === normText(l.text)) l.words = hit.words;
  }
}

function buildLyricsDom() {
  const track = $("lyrics-track");
  track.replaceChildren();
  track.style.transform = "translateY(0)";
  wordEls = [];
  lineEls = lyrics.map((l) => {
    const text = el("span", { className: "ly-text" });
    let spans = null;
    if (l.words) {
      text.classList.add("by-word");
      spans = l.words.map((w, k) => {
        const node = el("span", { className: "w" }, w.w);
        text.append(node);
        if (k < l.words.length - 1) text.append(" ");
        return node;
      });
    } else {
      text.textContent = l.text || "♪";
    }
    wordEls.push(spans);
    const line = el("div", { className: "ly" }, text);
    track.append(line);
    return line;
  });
  activeIdx = -2;
  hideCountdown();
  $("no-lyrics").hidden = lyrics.length > 0;
}

/** Índice da última linha cujo tempo já passou (-1 se ainda não começou). */
function findLine(t) {
  let lo = 0, hi = lyrics.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lyrics[mid].t <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

function renderLyrics(pos, force = false) {
  if ($("stage").hidden || lyrics.length === 0) return;
  const t = pos - offsetMs / 1000;
  const idx = findLine(t);
  if (idx !== activeIdx || force) {
    activeIdx = idx;
    const pivot = Math.max(idx, 0);
    lineEls.forEach((node, i) => {
      node.style.setProperty("--d", Math.abs(i - pivot));
      node.classList.toggle("active", i === idx);
      if (i !== idx) node.style.removeProperty("--p");
    });
    centerLine(pivot);
  }
  if (idx >= 0) {
    const spans = wordEls[idx];
    if (spans) {
      // cada palavra enche entre o início e o fim alinhados a ela
      const words = lyrics[idx].words;
      for (let k = 0; k < words.length; k++) {
        const w = words[k];
        const p = Math.min(1, Math.max(0, (t - w.s) / Math.max(0.05, w.e - w.s)));
        spans[k].style.setProperty("--wp", `${(p * 100).toFixed(0)}%`);
      }
    } else {
      // sem palavras alinhadas: estimativa linear ao longo da linha
      const start = lyrics[idx].t;
      const next = idx + 1 < lyrics.length ? lyrics[idx + 1].t : start + 7;
      const span = Math.max(0.5, Math.min(next - start, 7));
      const p = Math.min(1, Math.max(0, (t - start) / span));
      lineEls[idx].style.setProperty("--p", `${(p * 100).toFixed(1)}%`);
    }
  }
  renderCountdown(t, idx);
}

function centerLine(i) {
  const target = lineEls[i];
  if (!target) return;
  const viewportHeight = $("lyrics-viewport").clientHeight;
  const y = viewportHeight * 0.42 - (target.offsetTop + target.offsetHeight / 2);
  $("lyrics-track").style.transform = `translateY(${y}px)`;
}

/* ---------- contagem regressiva ---------- */
const COUNTDOWN_SECONDS = 3;   // quantos segundos antes da voz entrar
const COUNTDOWN_MIN_GAP = 5;   // só avisa depois de uma pausa de pelo menos isto (evita piscar entre frases)

const startOf = (line) => (line.words ? line.words[0].s : line.t);

/** Quando a linha i termina de ser cantada (estimado se ela não tem palavras alinhadas). */
function endOf(i) {
  const l = lyrics[i];
  if (l.words) return l.words[l.words.length - 1].e;
  const next = lyrics[i + 1];
  return l.t + (next ? Math.min(next.t - l.t, 7) : 7);
}

function nextSungIndex(from) {
  for (let i = from; i < lyrics.length; i++) if (lyrics[i].text) return i;
  return -1;
}

/** 3, 2 ou 1 quando a voz está prestes a voltar depois de uma pausa; 0 caso contrário. */
function countdownValue(t, idx) {
  let next;
  let gapStart;
  if (idx < 0) {                       // introdução, antes de qualquer linha
    next = nextSungIndex(0);
    gapStart = 0;
  } else if (!lyrics[idx].text) {      // trecho instrumental marcado com ♪
    next = nextSungIndex(idx + 1);
    gapStart = lyrics[idx].t;
  } else {                             // pausa longa sem marcador: depois do fim da linha atual
    gapStart = endOf(idx);
    if (t < gapStart) return 0;
    next = nextSungIndex(idx + 1);
  }
  if (next < 0) return 0;
  const singStart = startOf(lyrics[next]);
  if (singStart - gapStart < COUNTDOWN_MIN_GAP) return 0;
  const left = singStart - t;
  return left > 0 && left <= COUNTDOWN_SECONDS ? Math.ceil(left) : 0;
}

function renderCountdown(t, idx) {
  const value = countdownValue(t, idx);
  if (value === shownCountdown) return;
  shownCountdown = value;
  const box = $("countdown");
  box.hidden = value === 0;
  if (value) {
    $("countdown-num").textContent = String(value);
    box.classList.remove("tick");
    void box.offsetWidth; // reinicia a animação de pulso a cada número
    box.classList.add("tick");
  }
}

function hideCountdown() {
  shownCountdown = 0;
  $("countdown").hidden = true;
}

/* ---------- ajuste de sincronia ---------- */
function updateSyncInfo() {
  const secs = (Math.abs(offsetMs) / 1000).toFixed(1).replace(".", ",");
  $("sync-info").textContent = offsetMs === 0
    ? "Sem ajuste. Se a letra aparece antes de cantarem, use “Atrasar”; se aparece depois, “Adiantar”."
    : `Letra ${offsetMs > 0 ? "atrasada" : "adiantada"} em ${secs} s.`;
}

function changeOffset(deltaMs, reset = false) {
  if (!current) return;
  offsetMs = reset ? 0 : Math.max(-60000, Math.min(60000, offsetMs + deltaMs));
  updateSyncInfo();
  renderLyrics(position(), true);
  clearTimeout(offsetSaveTimer);
  const id = current.id;
  offsetSaveTimer = setTimeout(async () => {
    try { replaceSong(await putJson(`${API}/${id}/lyrics-offset`, { offsetMs })); } catch (_) { /* tenta na próxima */ }
  }, 600);
}
$("sync-earlier").addEventListener("click", () => changeOffset(-500));
$("sync-later").addEventListener("click", () => changeOffset(500));
$("sync-reset").addEventListener("click", () => changeOffset(0, true));

/* ============================================================
   Tela de karaokê
   ============================================================ */
const stage = $("stage");
const panel = $("stage-panel");
let idleTimer = null;
let wakeLock = null;

const display = { art: 55, blur: 6, contrast: 60, ...store.get("display", {}) };
const DISPLAY_CONTROLS = [
  { key: "art", input: "set-art", out: "out-art", fmt: (v) => `${v}%` },
  { key: "blur", input: "set-blur", out: "out-blur", fmt: (v) => `${v} px` },
  { key: "contrast", input: "set-contrast", out: "out-contrast", fmt: (v) => `${v}%` },
];

function applyDisplay() {
  const c = display.contrast / 100;
  stage.style.setProperty("--art", display.art / 100);
  stage.style.setProperty("--blur", `${display.blur}px`);
  stage.style.setProperty("--shadow", (0.25 + c * 0.75).toFixed(2));
  stage.style.setProperty("--scrim", (0.1 + c * 0.5).toFixed(2));
  for (const d of DISPLAY_CONTROLS) {
    $(d.input).value = display[d.key];
    $(d.out).textContent = d.fmt(display[d.key]);
  }
  store.set("display", display);
}
for (const d of DISPLAY_CONTROLS) {
  $(d.input).addEventListener("input", (e) => {
    display[d.key] = Number(e.target.value);
    applyDisplay();
  });
}

/** Mostra os controles e agenda o sumiço deles (a letra fica limpa na TV). */
function wakeStage() {
  stage.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (panel.hidden) stage.classList.add("idle"); }, 3000);
}
for (const ev of ["pointermove", "pointerdown", "touchstart"]) {
  stage.addEventListener(ev, wakeStage, { passive: true });
}

function togglePanel(show) {
  panel.hidden = show === undefined ? !panel.hidden : !show;
  $("st-settings").setAttribute("aria-expanded", String(!panel.hidden));
  wakeStage();
}
$("st-settings").addEventListener("click", () => togglePanel());

async function lockScreen() {
  try { wakeLock = (await navigator.wakeLock?.request("screen")) || null; } catch (_) { /* sem suporte */ }
}

async function openStage() {
  if (!current || !audio.buffers.lead) return;
  stage.hidden = false;
  document.body.classList.add("stage-open");
  applyDisplay();
  updateSyncInfo();
  wakeStage();
  renderLyrics(position(), true);
  try { await stage.requestFullscreen(); } catch (_) { /* segue em janela cheia, sem fullscreen real */ }
  lockScreen();
}

function closeStage() {
  if (stage.hidden) return;
  stage.hidden = true;
  panel.hidden = true;
  hideCountdown();
  document.body.classList.remove("stage-open");
  clearTimeout(idleTimer);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else stage.requestFullscreen().catch(() => {});
}

$("open-stage").addEventListener("click", openStage);
$("st-close").addEventListener("click", closeStage);
$("st-fs").addEventListener("click", toggleFullscreen);

document.addEventListener("fullscreenchange", () => {
  $("st-fs").textContent = document.fullscreenElement ? "Sair da tela cheia" : "Tela cheia";
  renderLyrics(position(), true); // o tamanho da área mudou
});
window.addEventListener("resize", () => renderLyrics(position(), true));
document.addEventListener("visibilitychange", () => {
  if (!stage.hidden && document.visibilityState === "visible") lockScreen();
});

document.addEventListener("keydown", (e) => {
  if (stage.hidden) return;
  wakeStage();
  const tag = e.target.tagName;
  const inControl = tag === "INPUT" || tag === "BUTTON" || tag === "TEXTAREA";
  if (e.key === "Escape") {
    if (!panel.hidden) togglePanel(false);
    else closeStage();
  } else if (e.code === "Space" && !inControl) {
    e.preventDefault();
    togglePlay();
  } else if (e.key === "ArrowRight" && tag !== "INPUT") {
    seekTo(position() + 5);
  } else if (e.key === "ArrowLeft" && tag !== "INPUT") {
    seekTo(position() - 5);
  }
});

/* ============================================================
   Início
   ============================================================ */
buildMixer($("mixer-slot"), true);
buildMixer($("stage-mixer-slot"), false);
applyMix();
applyDisplay();
refresh();
