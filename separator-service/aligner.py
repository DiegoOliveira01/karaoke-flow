"""
Alinhamento palavra a palavra.

Em vez de entregar a letra inteira ao Whisper (que "perde o fio" em trechos
instrumentais e pula palavras), usamos o LRC como mapa: cada linha só é
procurada dentro da janela de tempo dela na voz isolada do cantor.

  janela da linha i = [ max(fim da linha anterior, t_i - 1 s) ,  t_(i+1) + folga ]

O alinhador de verdade (stable-ts) entra por uma função `align_fn`, o que deixa
toda a lógica abaixo testável sem GPU nem modelo (veja test_aligner.py).

Linhas que não passam na validação ficam com aligned=False e SEM palavras:
o player cai no preenchimento estimado por linha, em vez de mostrar tempo errado.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Callable, Optional, Sequence

SAMPLE_RATE = 16000

LEAD_IN = 1.0             # quanto a linha pode começar antes do tempo do LRC
TAIL_AFTER_BLANK = 0.4    # folga depois de um marcador "♪" (ele marca o fim do canto)
TAIL_AFTER_LINE = 0.8     # folga quando a próxima linha tem texto
LAST_LINE_SPAN = 12.0     # janela da última linha do arquivo
MIN_WINDOW = 1.0          # janelas menores que isso não valem o alinhamento
MIN_SPAN_PER_WORD = 0.1   # a linha inteira precisa durar pelo menos isto por palavra
MIN_WORD_DUR = 0.04

STAMP = re.compile(r"\[(\d{1,3}):(\d{2}(?:[.:]\d{1,3})?)\]")
WORD_TAG = re.compile(r"<\d+:\d+(?:[.:]\d+)?>")

# (trecho de áudio, texto) -> [(início, fim), ...] relativos ao trecho, uma tupla por palavra
AlignFn = Callable[[object, str], Optional[Sequence[tuple[float, float]]]]


@dataclass
class LrcLine:
    t: float
    text: str  # vazio = marcador de pausa instrumental


def parse_lrc(text: str) -> list[LrcLine]:
    """Mesma regra do parseLrc do app.js (as linhas precisam bater uma a uma)."""
    out: list[LrcLine] = []
    for raw in text.splitlines():
        times: list[float] = []
        last = 0
        for m in STAMP.finditer(raw):
            times.append(int(m.group(1)) * 60 + float(m.group(2).replace(":", ".")))
            last = m.end()
        if not times:
            continue  # tags [ar:], [ti:]... e linhas soltas
        content = WORD_TAG.sub("", raw[last:]).strip()
        out.extend(LrcLine(t, content) for t in times)
    out.sort(key=lambda line: line.t)
    # tira as linhas em branco repetidas e as do começo
    return [line for i, line in enumerate(out) if line.text or (i > 0 and out[i - 1].text)]


def _build_words(tokens: list[str], spans, lower: float, upper: float):
    """Valida o resultado do alinhador. Devolve a lista de palavras, ou None se não for confiável."""
    if not spans or len(spans) != len(tokens):
        return None

    raw = []
    for token, (s, e) in zip(tokens, spans):
        s, e = lower + float(s), lower + float(e)
        if not (math.isfinite(s) and math.isfinite(e)) or e < s:
            return None
        raw.append([token, s, e])

    # tudo dentro da janela
    if raw[0][1] < lower - 0.05 or raw[-1][2] > upper + 0.05:
        return None
    # palavras em ordem
    if any(raw[k][1] < raw[k - 1][1] - 0.01 for k in range(1, len(raw))):
        return None
    # colapso: tudo espremido no mesmo instante
    if raw[-1][2] - raw[0][1] < MIN_SPAN_PER_WORD * len(raw):
        return None
    if sum(1 for _, s, e in raw if e - s < 0.03) > len(raw) / 2:
        return None

    words = []
    prev_end = None
    for token, s, e in raw:
        if prev_end is not None and s < prev_end:
            s = prev_end  # sem sobreposição
        e = max(e, s + MIN_WORD_DUR)
        words.append({"w": token, "s": round(s, 3), "e": round(e, 3)})
        prev_end = e
    return words


def align_lines(audio, duration: float, lines: list[LrcLine], align_fn: AlignFn, on_progress=None) -> list[dict]:
    """
    audio:    vetor com a voz isolada em 16 kHz mono
    duration: duração do áudio em segundos
    Devolve uma entrada por linha COM texto: {t, text, aligned, words?}.
    """
    results: list[dict] = []
    prev_end = 0.0
    total = sum(1 for line in lines if line.text)
    done = 0

    for i, line in enumerate(lines):
        if not line.text:
            continue
        nxt = lines[i + 1] if i + 1 < len(lines) else None
        lower = max(prev_end - 0.05, line.t - LEAD_IN, 0.0)
        if nxt is None:
            upper = line.t + LAST_LINE_SPAN
        else:
            upper = nxt.t + (TAIL_AFTER_BLANK if not nxt.text else TAIL_AFTER_LINE)
        upper = min(upper, duration)

        entry = {"t": line.t, "text": line.text, "aligned": False}
        if upper - lower >= MIN_WINDOW:
            chunk = audio[int(lower * SAMPLE_RATE): int(upper * SAMPLE_RATE)]
            try:
                spans = align_fn(chunk, line.text)
            except Exception:  # noqa: BLE001 - uma linha ruim não derruba a música
                spans = None
            words = _build_words(line.text.split(), spans, lower, upper)
            if words:
                entry["aligned"] = True
                entry["words"] = words
                prev_end = words[-1]["e"]
        results.append(entry)

        done += 1
        if on_progress:
            on_progress(done, total)
    return results
