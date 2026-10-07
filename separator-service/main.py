"""
Serviço de separação de stems.

Recebe o caminho de um áudio e gera, na pasta de saída:
  instrumental.<fmt>  -> música sem nenhuma voz
  lead.<fmt>          -> voz principal (a do cantor original)
  backing.<fmt>       -> vozes de apoio / coro

São duas passadas, como no vídeo do Funky:
  1) STEM_MODEL      separa voz x instrumental
  2) KARAOKE_MODEL   separa a voz em principal x backing

Os nomes dos modelos são configuráveis por variável de ambiente.
Para ver os disponíveis:  audio-separator --list_models
"""
import json
import os
import shutil
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from aligner import SAMPLE_RATE, align_lines, parse_lrc

STEM_MODEL = os.getenv("STEM_MODEL", "model_bs_roformer_ep_317_sdr_12.9755.ckpt")
KARAOKE_MODEL = os.getenv(
    "KARAOKE_MODEL", "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
)
OUTPUT_FORMAT = os.getenv("OUTPUT_FORMAT", "FLAC")
# Modelo do Whisper usado só para alinhar palavras ("base" é mais leve; "small" erra menos).
ALIGN_MODEL = os.getenv("ALIGN_MODEL", "small")
SCRATCH_DIR = Path(os.getenv("SCRATCH_DIR", "./scratch")).resolve()

app = FastAPI(title="Karaoke separator")

# Uma GPU só: serializa as separações e reaproveita os modelos já carregados.
_lock = threading.Lock()
_separators: dict = {}


class SeparateRequest(BaseModel):
    input_path: str
    output_dir: str


def _get_separator(model_name: str):
    if model_name not in _separators:
        from audio_separator.separator import Separator  # import tardio: demora

        out = SCRATCH_DIR / model_name.replace("/", "_")
        out.mkdir(parents=True, exist_ok=True)
        sep = Separator(output_dir=str(out), output_format=OUTPUT_FORMAT)
        sep.load_model(model_filename=model_name)
        _separators[model_name] = (sep, out)
    return _separators[model_name]


def _pick(files: list[Path], kind: str) -> Path:
    """Acha o arquivo de saída que tem '(Vocals)' ou '(Instrumental)' no nome."""
    for f in files:
        if f"({kind})" in f.name.lower():
            return f
    raise RuntimeError(
        f"Stem '{kind}' não encontrado na saída: {[f.name for f in files]}"
    )


def _run_pass(model_name: str, input_file: Path) -> tuple[Path, Path]:
    """Roda um modelo e devolve (vocals, instrumental)."""
    sep, out_dir = _get_separator(model_name)
    for old in out_dir.iterdir():  # limpa resto de execuções anteriores
        old.unlink()
    sep.separate(str(input_file))
    files = [p for p in out_dir.iterdir() if p.is_file()]
    return _pick(files, "vocals"), _pick(files, "instrumental")


@app.get("/health")
def health():
    info = {"status": "ok", "stem_model": STEM_MODEL, "karaoke_model": KARAOKE_MODEL}
    try:
        import torch

        info["gpu"] = torch.cuda.is_available()  # ROCm também aparece como "cuda"
        if info["gpu"]:
            info["gpu_name"] = torch.cuda.get_device_name(0)
    except ImportError:
        info["gpu"] = False
    return info


@app.post("/separate")
def separate(req: SeparateRequest):
    src = Path(req.input_path)
    dest = Path(req.output_dir)
    if not src.is_file():
        raise HTTPException(404, f"Arquivo não encontrado: {src}")
    dest.mkdir(parents=True, exist_ok=True)

    ext = OUTPUT_FORMAT.lower()
    try:
        with _lock:
            vocals, instrumental = _run_pass(STEM_MODEL, src)
            shutil.move(str(instrumental), dest / f"instrumental.{ext}")
            # a voz isolada vira a entrada da segunda passada
            tmp_vocals = SCRATCH_DIR / f"_vocals_{src.stem}{vocals.suffix}"
            shutil.move(str(vocals), tmp_vocals)
            lead, backing = _run_pass(KARAOKE_MODEL, tmp_vocals)
            shutil.move(str(lead), dest / f"lead.{ext}")
            shutil.move(str(backing), dest / f"backing.{ext}")
            tmp_vocals.unlink(missing_ok=True)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Falha na separação: {e}") from e

    return {
        "instrumental": f"instrumental.{ext}",
        "lead": f"lead.{ext}",
        "backing": f"backing.{ext}",
    }


# --------------------------------------------------------------------------
# Alinhamento palavra a palavra (stable-ts + LRC como mapa de janelas)
# --------------------------------------------------------------------------
_align_models: dict = {}


class AlignRequest(BaseModel):
    audio_path: str     # voz isolada (lead.flac)
    lrc_path: str       # letra sincronizada por linha
    output_path: str    # words.json
    language: str = "pt"


def _get_align_model():
    if ALIGN_MODEL not in _align_models:
        import stable_whisper  # import tardio: só quem usa palavras paga o custo
        import torch

        device = "cuda" if torch.cuda.is_available() else "cpu"
        _align_models[ALIGN_MODEL] = stable_whisper.load_model(ALIGN_MODEL, device=device)
    return _align_models[ALIGN_MODEL]


def _make_align_fn(model, language: str):
    def align_fn(chunk, text):
        try:
            # cantores seguram notas por vários segundos; o padrão (3 s) encurtaria a palavra
            result = model.align(chunk, text, language=language, max_word_dur=10.0)
        except TypeError:  # versão do stable-ts sem esse parâmetro
            result = model.align(chunk, text, language=language)
        if result is None:
            return None
        return [(w.start, w.end) for seg in result.segments for w in seg.words]

    return align_fn


@app.post("/align")
def align(req: AlignRequest):
    audio_path, lrc_path = Path(req.audio_path), Path(req.lrc_path)
    for p in (audio_path, lrc_path):
        if not p.is_file():
            raise HTTPException(404, f"Arquivo não encontrado: {p}")

    lines = parse_lrc(lrc_path.read_text(encoding="utf-8"))
    if not any(line.text for line in lines):
        raise HTTPException(422, "A letra não tem nenhuma linha com texto")

    try:
        with _lock:  # a GPU é uma só: não roda junto com a separação
            import whisper  # instalado junto com o stable-ts

            audio = whisper.load_audio(str(audio_path))  # float32, 16 kHz, mono
            model = _get_align_model()
            results = align_lines(
                audio, len(audio) / SAMPLE_RATE, lines, _make_align_fn(model, req.language)
            )
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except ImportError:
                pass
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Falha no alinhamento: {e}") from e

    aligned = sum(1 for r in results if r["aligned"])
    payload = {"version": 1, "language": req.language, "model": ALIGN_MODEL, "lines": results}
    out = Path(req.output_path)
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(out)  # troca atômica: o player nunca lê um arquivo pela metade
    return {"lines": len(results), "aligned": aligned}
