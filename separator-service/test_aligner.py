"""Testes da lógica de alinhamento (sem GPU nem modelo). Rode:  python test_aligner.py"""
import numpy as np

from aligner import SAMPLE_RATE, align_lines, parse_lrc

LRC = """[ar:Fulano]
[ti:Teste]
[00:00.00]
[00:10.00]Mama told me when
[00:14.00]I was young
[00:18.00]
[00:30.00]Come sit beside me
[00:34.00][01:00.00]my only son
[00:38.00]
"""
DURATION = 70.0
AUDIO = np.zeros(int(DURATION * SAMPLE_RATE), dtype=np.float32)


def even_fn(chunk, text):
    """Alinhador falso bom: espalha as palavras no começo do trecho, 0,5 s cada, após 1 s de silêncio."""
    n = len(text.split())
    return [(1.0 + 0.5 * k, 1.0 + 0.5 * (k + 1)) for k in range(n)]


def test_parse():
    lines = parse_lrc(LRC)
    assert [l.t for l in lines][:3] == [10.0, 14.0, 18.0]      # tags e o [00:00.00] vazio do início somem
    assert lines[2].text == ""                                  # o marcador ♪ fica (ele marca o fim do canto)
    assert [l.t for l in lines if l.text == "my only son"] == [34.0, 60.0]   # várias marcas na mesma linha
    assert [l.t for l in lines] == sorted(l.t for l in lines)


def test_all_aligned_and_inside_windows():
    lines = parse_lrc(LRC)
    out = align_lines(AUDIO, DURATION, lines, even_fn)
    assert len(out) == sum(1 for l in lines if l.text)          # uma entrada por linha com texto
    assert all(e["aligned"] for e in out)
    prev = 0
    for e in out:
        ws = e["words"]
        assert [w["w"] for w in ws] == e["text"].split()        # palavras = tokens da letra, com pontuação original
        assert all(w["e"] > w["s"] for w in ws)
        assert all(ws[k]["s"] >= ws[k - 1]["e"] - 1e-6 for k in range(1, len(ws)))
        assert ws[0]["s"] >= prev - 0.06                        # linhas em ordem, sem voltar no tempo
        prev = ws[-1]["e"]
    first = out[0]["words"][0]
    assert 9.0 <= first["s"] <= 12.5                            # perto do tempo do LRC (10 s)


def test_collapsed_alignment_falls_back():
    """O defeito do seu JSON: tudo espremido no mesmo instante."""
    lines = parse_lrc(LRC)

    def collapsed(chunk, text):
        return [(2.0, 2.0)] * len(text.split())

    out = align_lines(AUDIO, DURATION, lines, collapsed)
    assert all(not e["aligned"] and "words" not in e for e in out)


def test_wrong_word_count_none_and_exception_fall_back():
    lines = parse_lrc(LRC)
    assert not any(e["aligned"] for e in align_lines(AUDIO, DURATION, lines, lambda c, t: even_fn(c, t)[:-1]))
    assert not any(e["aligned"] for e in align_lines(AUDIO, DURATION, lines, lambda c, t: None))

    def boom(c, t):
        raise RuntimeError("falhou")

    assert not any(e["aligned"] for e in align_lines(AUDIO, DURATION, lines, boom))


def test_one_bad_line_does_not_break_the_next():
    lines = parse_lrc(LRC)

    def fn(chunk, text):
        return [(2.0, 2.0)] * len(text.split()) if text == "I was young" else even_fn(chunk, text)

    out = {e["text"]: e for e in align_lines(AUDIO, DURATION, lines, fn)}
    assert not out["I was young"]["aligned"]
    assert out["Come sit beside me"]["aligned"] and out["my only son"]["aligned"]


def test_window_never_reaches_into_previous_line():
    lines = parse_lrc(LRC)
    seen = []

    def spy(chunk, text):
        seen.append((text, len(chunk) / SAMPLE_RATE))
        return even_fn(chunk, text)

    align_lines(AUDIO, DURATION, lines, spy)
    assert all(1.0 <= d <= 13.0 for _, d in seen)               # nenhuma janela gigante como a letra inteira


def test_last_line_and_short_window():
    out = align_lines(AUDIO[: int(10.2 * SAMPLE_RATE)], 10.2, parse_lrc("[00:10.50]fim"), even_fn)
    assert out[0]["aligned"] is False                           # janela de 0,7 s (< 1 s): nem tenta
    out = align_lines(AUDIO, DURATION, parse_lrc("[00:10.50]fim de tudo"), even_fn)
    assert out[0]["aligned"] is True                            # última linha usa a janela de 12 s


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok  ", name)
