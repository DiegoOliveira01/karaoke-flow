"use strict";

/* ============================================================
   Utilitários
   ============================================================ */
const API = "/api/songs";
const CARD_STATUS = { QUEUED: "Na fila", SEPARATING: "Separando…" };
const STATUS_LABEL = {
  QUEUED: "Na fila",
  SEPARATING: "Separando as vozes…",
  READY: "Pronta",
  FAILED: "Falhou",
};

const $ = (id) => document.getElementById(id);

/* ---------- modo convidado ---------- */
let serverInfo = { url: location.origin, local: true };
const isGuest = () => !serverInfo.local;

async function loadServerInfo() {
  try {
    serverInfo = await api("/api/server-info");
  } catch (_) { /* mantém padrão local */ }
}

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
  await loadServerInfo();
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

/* ---------- biblioteca: busca, ordenação e visual ---------- */
const savedLib = store.get("lib", {});
const lib = {
  query: "",
  sort: ["recent", "title", "artist"].includes(savedLib.sort) ? savedLib.sort : "recent",
  mode: savedLib.mode === "list" || savedLib.mode === "grid" ? savedLib.mode
    : (window.matchMedia && window.matchMedia("(max-width: 560px)").matches ? "list" : "grid"),
};
const saveLib = () => store.set("lib", { sort: lib.sort, mode: lib.mode });

/** Sem acentos e em minúsculas, para a busca achar "coracao" em "Coração". */
const plain = (text) => (text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function visibleSongs() {
  const q = plain(lib.query.trim());
  const list = songs.filter((s) => !q || plain(`${s.title} ${s.artist}`).includes(q));
  const byText = (a, b) => a.localeCompare(b, "pt", { sensitivity: "base" });
  if (lib.sort === "title") list.sort((a, b) => byText(a.title, b.title));
  else if (lib.sort === "artist") {
    list.sort((a, b) => byText(a.artist || "\uffff", b.artist || "\uffff") || byText(a.title, b.title));
  } else list.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return list;
}

/** Capa de mentira quando a música não tem imagem: cor própria (pelo nome) e as iniciais. */
function placeholderInfo(song) {
  let h = 0;
  for (const ch of `${song.title}${song.artist || ""}`) h = (h * 31 + ch.codePointAt(0)) % 360;
  const letters = (song.title.match(/[\p{L}\p{N}]/gu) || []).slice(0, 2).join("").toUpperCase() || "♪";
  return { letters, background: `linear-gradient(135deg, hsl(${h} 55% 42%), hsl(${(h + 55) % 360} 60% 22%))` };
}

function tag(label, state) {
  const text = state === "ok" ? `✓ ${label}` : state === "busy" ? `${label}…` : label;
  return el("span", { className: `tag ${state}` }, text);
}

function songCard(s, menuOpen) {
  const cover = mediaUrl(s, "cover");
  const hasLyrics = !!(s.files && s.files.lyrics);
  const hasWords = !!(s.files && s.files.words);
  const pending = s.status === "QUEUED" || s.status === "SEPARATING";

  let art;
  if (cover) {
    art = el("img", { src: cover, alt: "", loading: "lazy" });
  } else {
    const ph = placeholderInfo(s);
    art = el("div", { className: "ph", "aria-hidden": "true" }, ph.letters);
    art.style.background = ph.background;
  }
  const media = el("div", { className: "cover" }, art,
    el("span", { className: "eq", "aria-hidden": "true" }, el("i"), el("i"), el("i")),
    s.status === "FAILED" ? el("span", { className: "badge-status bad" }, "Falhou") : "");

  const body = el("div", { className: "song-body" },
    el("div", { className: "song-title", title: s.title }, s.title),
    el("div", { className: "song-artist" + (s.artist ? "" : " none") }, s.artist || "sem artista"),
    el("div", { className: "tags" },
      tag("letra", hasLyrics ? "ok" : "off"),
      hasLyrics ? tag("palavras", s.wordsState === "RUNNING" ? "busy" : hasWords ? "ok" : "off") : "",
      tag("capa", cover ? "ok" : "off")));
  if (s.status === "FAILED" && s.error) body.append(el("div", { className: "song-error" }, s.error));
  if (s.wordsState === "FAILED" && s.wordsError) {
    body.append(el("div", { className: "song-error" }, `Palavras: ${s.wordsError}`));
  }

  const actions = el("div", { className: "song-actions" });
  if (s.status === "READY") {
    actions.append(el("button", {
      className: "btn", type: "button", "aria-label": `Cantar ${s.title}`, onclick: () => loadSong(s),
    }, el("span", { "aria-hidden": "true" }, "▶"), el("span", { className: "lb" }, " Cantar")));
  } else if (pending) {
    actions.append(el("div", { className: "proc", title: STATUS_LABEL[s.status] },
      el("span", { className: "spin", "aria-hidden": "true" }), el("span", { className: "lb" }, CARD_STATUS[s.status])));
  }

  const menu = el("details", { className: "menu" });
  if (menuOpen) menu.setAttribute("open", "");
  const item = (label, action, cls = "") => el("button", {
    type: "button", className: cls, onclick: () => { menu.removeAttribute("open"); action(); },
  }, label);
  menu.append(
    el("summary", { title: "Mais ações", "aria-label": `Mais ações para ${s.title}` }, "⋯"),
    el("div", { className: "menu-list" },
      item(hasLyrics ? "Trocar letra" : "Escolher letra", () => openLyricsDialog(s)),
      s.status === "READY" && hasLyrics ? item("Palavras sincronizadas", () => openWordsDialog(s)) : "",
      item(cover ? "Trocar capa" : "Escolher capa", () => openCoverDialog(s)),
      item("Apagar", () => removeSong(s), "danger")));
  if (!isGuest()) actions.append(menu);

  const li = el("li", { className: "song" + (current && s.id === current.id ? " active" : "") }, media, body, actions);
  li.dataset.status = s.status;
  li.dataset.id = s.id;
  return li;
}

function emptyState(message, withButton) {
  const box = el("li", { className: "empty-state" },
    el("div", { className: "big", "aria-hidden": "true" }, "♪"),
    el("h2", {}, message.title),
    el("p", {}, message.text));
  if (withButton) {
    box.append(el("button", { className: "btn", type: "button", onclick: () => openAddDialog() }, "+ Adicionar música"));
  }
  return box;
}

function renderSongs() {
  renderNowPlaying();
  const list = $("songs");
  // as atualizações automáticas (a cada 3 s enquanto separa) não podem fechar um menu que o usuário abriu
  const openMenu = list.querySelector(".menu[open]");
  const openId = openMenu ? openMenu.closest(".song").dataset.id : null;

  list.replaceChildren();
  list.className = `songs ${lib.mode}`;
  const shown = visibleSongs();
  const n = songs.length;
  $("lib-count").textContent = n === 0 ? "" : shown.length === n ? `${n} ${n === 1 ? "música" : "músicas"}` : `${shown.length} de ${n}`;

  if (n === 0) {
    list.append(emptyState({
      title: "Sua biblioteca está vazia",
      text: "Adicione um arquivo de áudio (ou arraste-o para esta tela). As vozes são separadas automaticamente.",
    }, true));
    return;
  }
  if (shown.length === 0) {
    list.append(emptyState({ title: "Nada encontrado", text: `Nenhuma música combina com “${lib.query.trim()}”.` }, false));
    return;
  }
  for (const s of shown) list.append(songCard(s, s.id === openId));
}

async function removeSong(song) {
  if (!confirm(`Apagar “${song.title}”?`)) return;
  if (current && song.id === current.id) unloadSong();
  try { await api(`${API}/${song.id}`, { method: "DELETE" }); } catch (_) { /* já não existe */ }
  refresh();
}

/* ---------- painel "tocando agora" ---------- */
function updateTitle() {
  document.title = current ? `${audio.playing ? "▶ " : ""}${current.title} — Karaokê` : "Karaokê";
}

function renderNowPlaying() {
  const player = $("player");
  player.classList.toggle("empty", !current);
  const cover = current ? mediaUrl(current, "cover") : null;
  const box = $("np-cover");
  box.style.background = "";
  box.style.backgroundImage = "";
  box.textContent = "";
  if (!current) {
    box.textContent = "♪";
  } else if (cover) {
    box.style.backgroundImage = `url("${cover}")`;
  } else {
    const ph = placeholderInfo(current);
    box.style.background = ph.background;
    box.textContent = ph.letters;
  }
  player.style.setProperty("--np-art", cover ? `url("${cover}")` : "none");
  $("np-eyebrow").textContent = current ? "Tocando agora" : "Player";
}

/* ---------- avisos rápidos ---------- */
let toastTimer = null;
function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
}

/* ---------- frase da tela principal (uma nova a cada carregamento) ---------- */
function showQuote() {
  const list = window.QUOTES;
  if (!Array.isArray(list) || list.length === 0) {
    $("quote").hidden = true;
    return;
  }
  const last = store.get("lastQuote", -1);
  let i = Math.floor(Math.random() * list.length);
  if (list.length > 1 && i === last) i = (i + 1) % list.length; // nunca repete a da vez anterior
  store.set("lastQuote", i);
  const q = list[i];
  $("quote-text").textContent = `“${q.text}”`;
  $("quote-author").textContent = q.author ? `— ${q.author}` : "";
  $("quote").title = q.author ? `${q.text} — ${q.author}` : q.text;
}

/* ---------- adicionar músicas (diálogo, arrastar e soltar, vários arquivos) ---------- */
const AUDIO_EXT = /\.(mp3|flac|wav|m4a|aac|ogg|opus|wma|aiff?|alac|webm)$/i;
const isAudio = (file) => (file.type || "").startsWith("audio/") || AUDIO_EXT.test(file.name);

/** "03 - Artista - Título.mp3" -> { artist, title }. Sem " - " no nome, tudo vira título. */
function guessMeta(filename) {
  let base = filename.replace(/\.[^.]+$/, "").replace(/_+/g, " ").trim();
  base = base.replace(/^\d{1,3}\s*[-–.)]\s*/, ""); // número da faixa
  const m = base.match(/^(.+?)\s+[-–]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: "", title: base };
}

const addInput = $("add-file");

function onAddFilesChosen() {
  const files = [...addInput.files];
  const many = files.length > 1;
  $("add-title").disabled = many;
  $("add-artist").disabled = many;
  $("dropzone").classList.toggle("picked", files.length > 0);
  $("add-btn").disabled = files.length === 0;
  $("add-btn").textContent = many ? `Separar vozes de ${files.length} músicas` : "Separar vozes";

  if (files.length === 0) {
    $("dz-title").textContent = "Arraste um áudio aqui ou clique para escolher";
    $("dz-sub").textContent = "MP3, FLAC, WAV, M4A… você pode escolher vários de uma vez";
    $("add-hint").textContent = "Título e artista ajudam a achar a letra e a capa depois.";
    return;
  }
  if (many) {
    $("dz-title").textContent = `${files.length} arquivos selecionados`;
    $("dz-sub").textContent = files.slice(0, 3).map((f) => f.name).join(", ") + (files.length > 3 ? "…" : "");
    $("add-hint").textContent = "Título e artista serão deduzidos dos nomes dos arquivos (formato “Artista - Título”).";
    return;
  }
  const guess = guessMeta(files[0].name);
  $("dz-title").textContent = files[0].name;
  $("dz-sub").textContent = `${(files[0].size / 1048576).toFixed(1)} MB · clique para trocar`;
  $("add-hint").textContent = "Confira o título e o artista: ajudam a achar a letra e a capa depois.";
  if (!$("add-title").value) $("add-title").value = guess.title;
  if (!$("add-artist").value) $("add-artist").value = guess.artist;
}
addInput.addEventListener("change", onAddFilesChosen);

function openAddDialog(files) {
  $("add-form").reset();
  setStatus("add-status", "");
  onAddFilesChosen();
  if (!$("dlg-add").open) $("dlg-add").showModal();
  if (files && files.length) setAddFiles(files);
}

function setAddFiles(files) {
  if (typeof DataTransfer === "undefined") {
    setStatus("add-status", "Este navegador não permite arrastar aqui. Use a área acima para escolher.", true);
    return;
  }
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  addInput.files = transfer.files;
  onAddFilesChosen();
}

$("add-open").addEventListener("click", () => openAddDialog());

$("add-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const files = [...addInput.files];
  if (files.length === 0) return;
  const many = files.length > 1;
  $("add-btn").disabled = true;
  let sent = 0;
  try {
    for (const file of files) {
      setStatus("add-status", many ? `Enviando ${sent + 1} de ${files.length}…` : "Enviando…");
      const guess = guessMeta(file.name);
      const body = new FormData();
      body.append("file", file);
      body.append("title", many ? guess.title : $("add-title").value.trim() || guess.title);
      body.append("artist", many ? guess.artist : $("add-artist").value.trim() || guess.artist);
      await api(API, { method: "POST", body });
      sent++;
    }
    $("dlg-add").close();
    toast(sent === 1 ? "Música enviada. Separando as vozes…" : `${sent} músicas enviadas. Separando as vozes…`);
    refresh();
  } catch (e) {
    const done = sent ? ` (${sent} já ${sent === 1 ? "foi enviada" : "foram enviadas"})` : "";
    setStatus("add-status", `${e.message || "Não foi possível enviar."}${done}`, true);
    $("add-btn").disabled = false;
    if (sent) refresh();
  }
});

/* ---------- ligações da biblioteca ---------- */
function syncViewButtons() {
  for (const b of document.querySelectorAll("[data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === lib.mode));
}

function initLibraryUi() {
  $("sort").value = lib.sort;
  syncViewButtons();
  $("search").addEventListener("input", (e) => { lib.query = e.target.value; renderSongs(); });
  $("sort").addEventListener("change", (e) => { lib.sort = e.target.value; saveLib(); renderSongs(); });
  for (const b of document.querySelectorAll("[data-view]")) {
    b.addEventListener("click", () => { lib.mode = b.dataset.view; saveLib(); syncViewButtons(); renderSongs(); });
  }

  // menus ⋯: fecham ao clicar fora ou com Esc
  document.addEventListener("click", (e) => {
    for (const m of document.querySelectorAll(".menu[open]")) if (!m.contains(e.target)) m.removeAttribute("open");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") for (const m of document.querySelectorAll(".menu[open]")) m.removeAttribute("open");
    // "/" foca a busca (menos quando se está digitando, ou em outra tela)
    if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (!$("stage").hidden || !$("editor").hidden || document.querySelector("dialog[open]")) return;
      e.preventDefault();
      $("search").focus();
    }
  });

  // arrastar arquivos de áudio para qualquer lugar da página
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    if (!document.querySelector("dialog[open]")) $("drop-overlay").hidden = false;
  });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) $("drop-overlay").hidden = true;
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    $("drop-overlay").hidden = true;
    const files = [...e.dataTransfer.files].filter(isAudio);
    if (files.length === 0) { toast("Nenhum arquivo de áudio encontrado."); return; }
    if ($("dlg-add").open) setAddFiles(files); else openAddDialog(files);
  });
}

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
  $("words-manual").disabled = running; // o automático ainda vai gravar o words.json: espere terminar
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

$("words-manual").addEventListener("click", async () => {
  const song = dialogSong;
  $("dlg-words").close();
  if (!current || current.id !== song.id || !audio.buffers.lead) await loadSong(song);
  if (!current || current.id !== song.id || !audio.buffers.lead) return; // falhou ao carregar: o erro aparece no player
  openEditor();
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
  ui.presets.karaoke = el("button", { className: "btn", type: "button", title: "Sem a voz do cantor", onclick: () => setPreset("karaoke") },
    "Karaokê");
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
  rate: 1,        // velocidade de reprodução (o editor de sincronia toca em câmera lenta)
};
let seeking = false;
const seeks = [$("seek"), $("st-seek"), $("ed-seek")];

function position() {
  return audio.playing ? (audio.ctx.currentTime - audio.startedAt) * audio.rate : audio.offset;
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
  document.body.classList.toggle("is-playing", audio.playing);
  updateTitle();
  for (const id of ["play", "st-play", "ed-play"]) {
    $(id).textContent = icon;
    $(id).setAttribute("aria-label", label);
  }
}

function setSeekValues(pos) { for (const s of seeks) s.value = pos; }
function setTimeLabels(pos) {
  $("time").textContent = fmt(pos);
  $("st-time").textContent = `${fmt(pos)} / ${fmt(audio.duration)}`;
  $("ed-time").textContent = `${fmt(pos)} / ${fmt(audio.duration)}`;
}

function startPlayback(from) {
  const ctx = audio.ctx;
  stopSources();
  const when = ctx.currentTime + 0.1; // todas as faixas começam no mesmo instante
  for (const name of STEMS) {
    const src = ctx.createBufferSource();
    src.buffer = audio.buffers[name];
    src.connect(audio.gains[name]);
    src.playbackRate.value = audio.rate;
    src.start(when, from);
    audio.sources.push(src);
  }
  audio.sources[0].onended = onEnded;
  audio.startedAt = when - from / audio.rate;
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
  renderEditor(pos);
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
  ed.stopAt = null;
  if (audio.playing) startPlayback(to);
  else {
    renderLyrics(to);
    renderEditor(to);
  }
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
    renderEditor(v);
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
  if (window.matchMedia && window.matchMedia("(max-width: 960px)").matches) {
    $("player").scrollIntoView({ behavior: "smooth", block: "start" }); // no celular o player fica acima da lista
  }

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
    await applyAssets(); // o editor de sincronia precisa da letra já carregada
  } catch (e) {
    setStatus("player-status", e.message || "Erro ao carregar a música.", true);
  }
}

function unloadSong() {
  closeEditor(true);
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
  renderNowPlaying();
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
  if (data && Array.isArray(data.lines)) {
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
  assignActivation();
}

/**
 * Quando cada linha "entra" na tela: o tempo do LRC ou, se as palavras começam antes dele
 * (cantor adiantado, ou palavras marcadas à mão), o início da primeira palavra.
 * Sempre em ordem crescente, que é o que a busca binária do findLine precisa.
 */
function assignActivation() {
  let previous = -Infinity;
  for (const l of lyrics) {
    const a = l.words ? Math.min(l.t, l.words[0].s) : l.t;
    l.a = Math.max(a, previous);
    previous = l.a;
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
    if ((lyrics[mid].a ?? lyrics[mid].t) <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
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
   Editor de sincronia manual (palavra a palavra)

   Os tempos ficam no mesmo referencial da tela de karaokê (já descontado o ajuste de sincronia da letra),
   então o que você vê tocando aqui é o que a tela mostra depois de salvar.
   ============================================================ */
const ed = {
  open: false,
  sig: "",
  lines: [],            // [{ t, text, words: [{ w, s, e, tap }] }]
  li: 0, wi: 0,         // palavra selecionada: onde o próximo toque grava
  holding: false,
  holdTrue: 0,          // posição do áudio quando o toque começou
  rows: [], chips: [],
  playingRow: -1,
  reactionMs: store.get("edReactionMs", 120),
  stopAt: null,         // posição do áudio (s) em que o "ouvir linha" para
  dirty: false,
  voiceOn: true,
  mixBefore: null,
  draftTimer: null,
};
const TAP_MAX_HELD = 0.18;  // segurou menos que isto (s em tempo real) = toque curto
const TAP_MAX_LEN = 1.5;    // toque curto: a palavra dura até a próxima, no máximo isto
const TAP_LAST_LEN = 0.6;   // toque curto na última palavra da linha

const toFrame = (pos) => pos - offsetMs / 1000;   // áudio -> referencial da tela de karaokê
const toTrue = (t) => t + offsetMs / 1000;        // o inverso
const reactionMedia = () => (ed.reactionMs / 1000) * audio.rate;
const roundMs = (x) => Math.round(x * 1000) / 1000;
const isTimed = (w) => w.s != null && w.e != null;
const edLine = () => ed.lines[ed.li];
const edWord = () => (ed.lines[ed.li] ? ed.lines[ed.li].words[ed.wi] : null);
const reduceMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

function edStatus(message, isError = false) { setStatus("ed-status", message, isError); }

function setRate(rate) {
  const pos = position();
  audio.rate = rate;
  if (audio.playing) startPlayback(pos); // recomeça do mesmo ponto na nova velocidade
}

/* ---------- dados ---------- */
function edLinesFromLyrics() {
  return lyrics.filter((l) => l.text).map((l) => {
    const tokens = l.text.split(/\s+/);
    const known = l.words && l.words.length === tokens.length ? l.words : null; // palavras já alinhadas (Whisper ou antes)
    return {
      t: l.t,
      text: l.text,
      words: tokens.map((w, k) => ({ w, s: known ? known[k].s : null, e: known ? known[k].e : null, tap: false })),
    };
  });
}

/** Ajusta a duração das palavras. Toque curto dura até a próxima; nunca invade a seguinte. */
function normalizeLine(line) {
  const ws = line.words;
  for (let k = 0; k < ws.length; k++) {
    const w = ws[k];
    if (w.s == null) continue;
    let next = null;
    for (let j = k + 1; j < ws.length; j++) {
      if (ws[j].s != null) { next = ws[j].s; break; }
    }
    if (w.tap || w.e == null) {
      w.e = next != null ? Math.min(next - 0.02, w.s + TAP_MAX_LEN) : w.s + TAP_LAST_LEN;
    } else if (next != null && w.e > next) {
      w.e = next;
    }
    if (w.e < w.s + 0.05) w.e = w.s + 0.05;
    w.s = roundMs(w.s);
    w.e = roundMs(w.e);
  }
}

/* ---------- rascunho (não perde o trabalho se fechar a aba) ---------- */
function lyricsSignature() {
  const text = lyrics.filter((l) => l.text).map((l) => `${Math.round(l.t * 1000)}|${l.text}`).join("\n");
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return `${lyrics.length}:${h}`;
}
const draftKey = () => `wordsDraft:${current.id}`;

function saveDraftNow() {
  clearTimeout(ed.draftTimer);
  if (!ed.open || !ed.dirty || !current) return;
  store.set(draftKey(), {
    sig: ed.sig,
    lines: ed.lines.map((l) => l.words.map((w) => [w.s, w.e, w.tap ? 1 : 0])),
  });
}

function applyDraft(draft) {
  if (!draft || draft.sig !== ed.sig || !Array.isArray(draft.lines) || draft.lines.length !== ed.lines.length) return false;
  for (let i = 0; i < ed.lines.length; i++) {
    const saved = draft.lines[i];
    if (!Array.isArray(saved) || saved.length !== ed.lines[i].words.length) return false;
  }
  draft.lines.forEach((saved, i) => saved.forEach(([s, e, tap], k) => {
    Object.assign(ed.lines[i].words[k], { s, e, tap: !!tap });
  }));
  return true;
}

function edTouch() {
  ed.dirty = true;
  clearTimeout(ed.draftTimer);
  ed.draftTimer = setTimeout(saveDraftNow, 400);
  edUpdateSummary();
  renderEditor(position());
}

/* ---------- abrir / fechar ---------- */
function openEditor() {
  if (!current || !audio.buffers.lead) return;
  ed.lines = edLinesFromLyrics();
  if (!ed.lines.length) {
    setStatus("player-status", "Esta música não tem letra para sincronizar.", true);
    return;
  }
  ed.sig = lyricsSignature();
  const resumed = applyDraft(store.get(draftKey(), null));
  ed.dirty = resumed;

  // começa na primeira palavra ainda sem tempo
  ed.li = 0;
  ed.wi = 0;
  outer: for (let li = 0; li < ed.lines.length; li++) {
    for (let wi = 0; wi < ed.lines[li].words.length; wi++) {
      if (!isTimed(ed.lines[li].words[wi])) { ed.li = li; ed.wi = wi; break outer; }
    }
  }

  ed.mixBefore = { mix: { ...mix }, preset: activePreset };
  setPreset("original"); // para sincronizar é preciso ouvir o cantor
  ed.voiceOn = true;
  ed.stopAt = null;
  ed.holding = false;
  ed.playingRow = -1;
  ed.open = true;

  $("editor").hidden = false;
  document.body.classList.add("stage-open"); // trava a rolagem da página de trás
  $("ed-title").textContent = `Sincronizar: ${current.title}`;
  $("ed-reaction").value = ed.reactionMs;
  $("out-reaction").textContent = `${ed.reactionMs} ms`;
  $("ed-rate").value = "1";
  setRate(1);
  updateVoiceButton();
  $("ed-discard").hidden = !resumed;
  buildEditorDom();
  edSelect(ed.li, ed.wi);
  edUpdateSummary();
  edStatus(resumed ? "Rascunho retomado (ainda não salvo)." : "");
  renderEditor(position());
}

function closeEditor(force = false) {
  if (!ed.open) return true;
  if (!force && ed.dirty
      && !confirm("Há alterações não salvas. Sair assim mesmo?\n(O rascunho fica guardado neste navegador.)")) {
    return false;
  }
  saveDraftNow();
  if (audio.playing) pausePlayback();
  ed.holding = false;
  ed.stopAt = null;
  ed.open = false;
  $("editor").hidden = true;
  document.body.classList.remove("stage-open");
  setRate(1);
  if (ed.mixBefore) {
    Object.assign(mix, ed.mixBefore.mix);
    activePreset = ed.mixBefore.preset;
    ed.mixBefore = null;
    applyMix();
  }
  return true;
}

function edDiscardDraft() {
  if (!confirm("Descartar o rascunho e voltar ao que está salvo?")) return;
  store.set(draftKey(), null);
  ed.lines = edLinesFromLyrics();
  ed.dirty = false;
  ed.li = 0;
  ed.wi = 0;
  $("ed-discard").hidden = true;
  buildEditorDom();
  edSelect(0, 0);
  edUpdateSummary();
  edStatus("Rascunho descartado.");
}

/* ---------- tela ---------- */
function buildEditorDom() {
  const list = $("ed-lines");
  list.replaceChildren();
  ed.rows = [];
  ed.chips = [];
  ed.lines.forEach((line, li) => {
    const go = el("button", {
      className: "ed-go", type: "button", title: "Tocar daqui", "aria-label": `Tocar a partir da linha ${li + 1}`,
      onclick: () => edPlayFromLine(li),
    }, `⏵ ${fmt(line.t)}`);
    const chips = line.words.map((w, wi) => el("button", {
      className: "cw", type: "button", onclick: () => edSelect(li, wi, false),
    }, w.w));
    const row = el("li", { className: "ed-line" }, go, el("div", { className: "ed-words" }, ...chips),
      el("span", { className: "ed-mark", "aria-hidden": "true" }));
    list.append(row);
    ed.rows.push(row);
    ed.chips.push(chips);
  });
  ed.lines.forEach((_, li) => edRefreshLine(li));
}

function edRefreshChip(li, wi) {
  const chip = ed.chips[li] && ed.chips[li][wi];
  if (!chip) return;
  const w = ed.lines[li].words[wi];
  const recording = ed.holding && li === ed.li && wi === ed.wi;
  chip.classList.toggle("timed", isTimed(w));
  chip.classList.toggle("untimed", !isTimed(w) && !recording);
  chip.classList.toggle("cursor", li === ed.li && wi === ed.wi);
  chip.classList.toggle("rec", recording);
  chip._st = null; // força recalcular o estado de reprodução
  chip.title = isTimed(w) ? `${w.s.toFixed(2)} s → ${w.e.toFixed(2)} s` : "sem tempo";
}

function edRefreshLine(li) {
  ed.lines[li].words.forEach((_, wi) => edRefreshChip(li, wi));
  ed.rows[li].classList.toggle("complete", ed.lines[li].words.every(isTimed));
}

function edUpdateSummary() {
  const done = ed.lines.filter((l) => l.words.every(isTimed)).length;
  $("ed-summary").textContent = `${done} de ${ed.lines.length} linhas completas${ed.dirty ? " · alterações não salvas" : ""}`;
}

function edUpdateWordInfo() {
  const w = edWord();
  $("ed-word-info").textContent = !w
    ? "—"
    : isTimed(w) ? `“${w.w}”  início ${w.s.toFixed(2)} s · fim ${w.e.toFixed(2)} s` : `“${w.w}”  sem tempo`;
  for (const b of $("ed-nudges").querySelectorAll("button")) b.disabled = !(w && isTimed(w));
}

function edSelect(li, wi, scroll = true) {
  const prev = { li: ed.li, wi: ed.wi };
  ed.li = li;
  ed.wi = wi;
  edRefreshChip(prev.li, prev.wi);
  edRefreshChip(li, wi);
  ed.rows.forEach((row, i) => row.classList.toggle("current", i === li));
  edUpdateWordInfo();
  if (scroll && ed.rows[li] && ed.rows[li].scrollIntoView) {
    ed.rows[li].scrollIntoView({ block: "center", behavior: reduceMotion() ? "auto" : "smooth" });
  }
}

function edMove(dWord, dLine) {
  if (dLine) {
    edSelect(Math.max(0, Math.min(ed.lines.length - 1, ed.li + dLine)), 0);
    return;
  }
  let li = ed.li;
  let wi = ed.wi + dWord;
  if (wi < 0) {
    if (li === 0) return;
    li--;
    wi = ed.lines[li].words.length - 1;
  } else if (wi >= ed.lines[li].words.length) {
    if (li + 1 >= ed.lines.length) return;
    li++;
    wi = 0;
  }
  edSelect(li, wi);
}

/** Acompanha a reprodução: pinta cada palavra marcada e destaca a linha que está tocando. */
function renderEditor(pos) {
  if (!ed.open) return;
  if (ed.stopAt != null && audio.playing && pos >= ed.stopAt) {
    ed.stopAt = null;
    pausePlayback();
  }
  const t = toFrame(pos);

  let active = -1;
  for (let li = 0; li < ed.lines.length; li++) {
    const line = ed.lines[li];
    const first = line.words.find(isTimed);
    const start = first ? Math.min(first.s, line.t) : line.t;
    if (start <= t) active = li; else break;
  }
  if (active !== ed.playingRow) {
    if (ed.rows[ed.playingRow]) ed.rows[ed.playingRow].classList.remove("playing");
    if (ed.rows[active]) ed.rows[active].classList.add("playing");
    ed.playingRow = active;
  }

  for (let li = 0; li < ed.lines.length; li++) {
    const words = ed.lines[li].words;
    const chips = ed.chips[li];
    for (let wi = 0; wi < words.length; wi++) {
      const w = words[wi];
      if (!isTimed(w)) continue;
      let state;
      let pct = 0;
      if (t < w.s) state = "todo";
      else if (t >= w.e) state = "done";
      else { state = "now"; pct = Math.round(((t - w.s) / (w.e - w.s)) * 100); }
      const chip = chips[wi];
      if (chip._st !== state) {
        chip.classList.remove("todo", "now", "done");
        chip.classList.add(state);
        chip._st = state;
      }
      if (state === "now" && chip._p !== pct) {
        chip.style.setProperty("--wp", `${pct}%`);
        chip._p = pct;
      }
    }
  }
}

/* ---------- captura ---------- */
function edPress() {
  if (!ed.open || ed.holding) return;
  if (!audio.playing) {
    edStatus("Dê play (tecla P) e segure Espaço enquanto a palavra é cantada.");
    return;
  }
  const w = edWord();
  if (!w) return;
  ed.holding = true;
  ed.holdTrue = position() - reactionMedia();
  w.s = roundMs(toFrame(ed.holdTrue));
  w.e = null;
  w.tap = false;
  $("ed-pad").classList.add("down");
  edRefreshChip(ed.li, ed.wi);
}

function edRelease() {
  if (!ed.holding) return;
  ed.holding = false;
  $("ed-pad").classList.remove("down");
  const w = edWord();
  const endTrue = position() - reactionMedia();
  const heldReal = (endTrue - ed.holdTrue) / audio.rate;
  if (heldReal < TAP_MAX_HELD) {
    w.tap = true;       // toque curto: a duração sai de normalizeLine
    w.e = null;
  } else {
    w.tap = false;
    w.e = roundMs(toFrame(endTrue));
  }
  normalizeLine(edLine());
  edTouch();
  edRefreshLine(ed.li);
  edStatus("");
  // avança para a próxima palavra (e para a próxima linha, ao fim desta)
  const line = edLine();
  if (ed.wi + 1 < line.words.length) edSelect(ed.li, ed.wi + 1);
  else if (ed.li + 1 < ed.lines.length) edSelect(ed.li + 1, 0);
  else edSelect(ed.li, ed.wi);
}

/* ---------- ajustes ---------- */
function edNudge(field, delta) {
  const w = edWord();
  if (!w || !isTimed(w)) return;
  if (field === "s") w.s = roundMs(Math.min(w.s + delta, w.e - 0.05));
  else w.e = roundMs(Math.max(w.e + delta, w.s + 0.05));
  w.tap = false;
  edTouch();
  edRefreshChip(ed.li, ed.wi);
  edUpdateWordInfo();
}

function edShiftLine(delta) {
  for (const w of edLine().words) {
    if (isTimed(w)) { w.s = roundMs(w.s + delta); w.e = roundMs(w.e + delta); }
  }
  edTouch();
  edRefreshLine(ed.li);
  edUpdateWordInfo();
}

function edClearLine() {
  for (const w of edLine().words) { w.s = null; w.e = null; w.tap = false; }
  edTouch();
  edRefreshLine(ed.li);
  edSelect(ed.li, 0);
}

async function edPlayAt(pos) {
  await audio.ctx.resume();
  audio.offset = Math.max(0, Math.min(audio.duration, pos));
  startPlayback(audio.offset);
}

async function edPlayFromLine(li) {
  edSelect(li, 0, false);
  const line = ed.lines[li];
  const first = line.words.find(isTimed);
  ed.stopAt = null;
  await edPlayAt(toTrue(first ? first.s : line.t) - 1.5);
}

async function edListenLine() {
  const line = edLine();
  const timed = line.words.filter(isTimed);
  const from = toTrue(timed.length ? timed[0].s : line.t);
  const to = timed.length ? toTrue(timed[timed.length - 1].e) : from + 6;
  await edPlayAt(from - 0.7);
  ed.stopAt = to + 0.4; // depois do play, que zera o controle
}

/* ---------- salvar ---------- */
/** Primeira linha com palavras fora de ordem, ou -1. */
function edProblem() {
  for (let li = 0; li < ed.lines.length; li++) {
    const timed = ed.lines[li].words.filter(isTimed);
    for (let k = 1; k < timed.length; k++) if (timed[k].s < timed[k - 1].s) return li;
  }
  return -1;
}

function edPayload() {
  for (const line of ed.lines) normalizeLine(line);
  return {
    language: store.get("wordsLang", "pt"),
    lines: ed.lines.map((l) => (l.words.every(isTimed)
      ? { t: l.t, text: l.text, aligned: true, words: l.words.map((w) => ({ w: w.w, s: roundMs(w.s), e: roundMs(w.e) })) }
      : { t: l.t, text: l.text, aligned: false })),
  };
}

async function edSave() {
  const bad = edProblem();
  if (bad >= 0) {
    edSelect(bad, 0);
    edStatus(`A linha ${bad + 1} tem palavras fora de ordem. Marque de novo, ou use “Limpar linha”.`, true);
    return;
  }
  const payload = edPayload();
  const complete = payload.lines.filter((l) => l.aligned).length;
  $("ed-save").disabled = true;
  edStatus("Salvando…");
  try {
    replaceSong(await putJson(`${API}/${current.id}/words`, payload));
    ed.dirty = false;
    store.set(draftKey(), null);
    $("ed-discard").hidden = true;
    edUpdateSummary();
    edStatus(`Salvo: ${complete} de ${payload.lines.length} linhas com palavras. As demais usam o preenchimento estimado.`);
  } catch (e) {
    edStatus(e.message || "Não foi possível salvar.", true);
  } finally {
    $("ed-save").disabled = false;
  }
}

/* ---------- ligações ---------- */
function updateVoiceButton() {
  const b = $("ed-voice");
  b.setAttribute("aria-pressed", String(ed.voiceOn));
  b.textContent = ed.voiceOn ? "Voz do cantor: ligada" : "Voz do cantor: desligada";
}

for (const [field, label] of [["s", "Início"], ["e", "Fim"]]) {
  const group = el("div", { className: "nudge" }, el("span", {}, label));
  for (const delta of [-0.1, -0.05, 0.05, 0.1]) {
    const text = `${delta > 0 ? "+" : "−"}${String(Math.abs(delta)).replace(".", ",")}`;
    group.append(el("button", { className: "chip", type: "button", onclick: () => edNudge(field, delta) }, text));
  }
  $("ed-nudges").append(group);
}

$("ed-play").addEventListener("click", () => { ed.stopAt = null; togglePlay(); });
$("ed-save").addEventListener("click", edSave);
$("ed-close").addEventListener("click", () => closeEditor());
$("ed-discard").addEventListener("click", edDiscardDraft);
$("ed-listen").addEventListener("click", edListenLine);
$("ed-shift-back").addEventListener("click", () => edShiftLine(-0.1));
$("ed-shift-fwd").addEventListener("click", () => edShiftLine(0.1));
$("ed-clear").addEventListener("click", edClearLine);
$("ed-rate").addEventListener("change", (e) => setRate(Number(e.target.value)));
$("ed-reaction").addEventListener("input", (e) => {
  ed.reactionMs = Number(e.target.value);
  $("out-reaction").textContent = `${ed.reactionMs} ms`;
  store.set("edReactionMs", ed.reactionMs);
});
$("ed-voice").addEventListener("click", () => {
  ed.voiceOn = !ed.voiceOn;
  setPreset(ed.voiceOn ? "original" : "karaoke");
  updateVoiceButton();
});

const pad = $("ed-pad");
pad.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (pad.setPointerCapture) pad.setPointerCapture(e.pointerId);
  edPress();
});
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) pad.addEventListener(type, edRelease);

document.addEventListener("keydown", (e) => {
  if (!ed.open) return;
  const tag = e.target.tagName;
  const onRange = tag === "INPUT" && e.target.type === "range";
  const onSelect = tag === "SELECT";
  if (e.code === "Space" && !onSelect) {
    e.preventDefault();
    if (!e.repeat) edPress();
  } else if (onSelect) {
    // deixa as setas e o Enter para o seletor de velocidade
  } else if (e.key === "Escape") {
    closeEditor();
  } else if (e.key === "p" || e.key === "P") {
    ed.stopAt = null;
    togglePlay();
  } else if (!onRange && e.key === "ArrowRight") { e.preventDefault(); edMove(1, 0); }
  else if (!onRange && e.key === "ArrowLeft") { e.preventDefault(); edMove(-1, 0); }
  else if (e.key === "ArrowDown") { e.preventDefault(); edMove(0, 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); edMove(0, -1); }
});
document.addEventListener("keyup", (e) => {
  if (ed.open && e.code === "Space" && e.target.tagName !== "SELECT") {
    e.preventDefault(); // evita "clicar" no botão focado ao soltar o espaço
    edRelease();
  }
});
window.addEventListener("pagehide", saveDraftNow);

/* ============================================================
   Início
   ============================================================ */
buildMixer($("mixer-slot"), true);
buildMixer($("stage-mixer-slot"), false);
applyMix();
applyDisplay();
initLibraryUi();
showQuote();
refresh();

/* ============================================================
   Compartilhar com a rede (QR code)
   ============================================================ */
function openShareDialog() {
  $("share-url").textContent = serverInfo.url;

  const container = $("qr-container");
  container.replaceChildren();

  // qrcode-generator: tipo 0 = escolhe o tamanho automaticamente; nível M de correção
  const qr = qrcode(0, "M");
  qr.addData(serverInfo.url);
  qr.make();
  container.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2 });

  $("dlg-share").showModal();
}

$("share-open").addEventListener("click", openShareDialog);
$("share-close").addEventListener("click", () => $("dlg-share").close());
