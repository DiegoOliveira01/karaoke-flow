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
import os
import shutil
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

STEM_MODEL = os.getenv("STEM_MODEL", "model_bs_roformer_ep_317_sdr_12.9755.ckpt")
KARAOKE_MODEL = os.getenv(
    "KARAOKE_MODEL", "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
)
OUTPUT_FORMAT = os.getenv("OUTPUT_FORMAT", "FLAC")
SCRATCH_DIR = Path(os.getenv("SCRATCH_DIR", "./scratch")).resolve()
MODEL_DIR = Path(os.getenv("MODEL_DIR", "./models")).resolve()

app = FastAPI(title="Karaoke separator")

# Uma GPU só: serializa as separações e reaproveita os modelos já carregados.
_lock = threading.Lock()
_separators: dict = {}


class SeparateRequest(BaseModel):
    input_path: str
    output_dir: str


def _get_separator(model_name: str):
    if model_name not in _separators:
        from audio_separator.separator import Separator

        out = SCRATCH_DIR / model_name.replace("/", "_")
        out.mkdir(parents=True, exist_ok=True)

        sep = Separator(
            model_file_dir=str(MODEL_DIR),
            output_dir=str(out),
            output_format=OUTPUT_FORMAT,
        )

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
