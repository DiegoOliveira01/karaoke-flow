"""
Serviço de separação de stems.

Recebe o caminho de um áudio e gera, na pasta de saída:
  instrumental.<fmt>  -> música sem nenhuma voz
  lead.<fmt>          -> voz principal (a do cantor original)
  backing.<fmt>       -> vozes de apoio / coro

São duas passadas, como no vídeo do Funky:
  1) STEM_MODEL      separa voz x instrumental
  2) KARAOKE_MODEL   separa a voz em principal x backing

Tanto a separação quanto o alinhamento palavra a palavra rodam em SUBPROCESSOS
Python isolados (worker.py e align_worker.py). Quando cada processo termina, o
SO limpa toda a VRAM e o estado do ROCm/HIP associado a ele — sem isso, no
Windows o ROCm acumula fragmentação (separação cai para ~17 s/it) e o Whisper
fica residente na VRAM indefinidamente.

Os nomes dos modelos são configuráveis por variável de ambiente.
Para ver os disponíveis:  audio-separator --list_models
"""
import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from aligner import parse_lrc

STEM_MODEL = os.getenv("STEM_MODEL", "model_bs_roformer_ep_317_sdr_12.9755.ckpt")
KARAOKE_MODEL = os.getenv(
    "KARAOKE_MODEL", "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
)
OUTPUT_FORMAT = os.getenv("OUTPUT_FORMAT", "FLAC")
# Modelo do Whisper usado só para alinhar palavras ("base" é mais leve; "small" erra menos).
ALIGN_MODEL = os.getenv("ALIGN_MODEL", "medium")
SCRATCH_DIR = Path(os.getenv("SCRATCH_DIR", "./scratch")).resolve()

# Caminho absoluto dos workers, ao lado deste main.py.
_WORKER = Path(__file__).resolve().parent / "worker.py"
_ALIGN_WORKER = Path(__file__).resolve().parent / "align_worker.py"

app = FastAPI(title="Karaoke separator")

# Uma GPU só: serializa separações e alinhamentos entre si.
_lock = threading.Lock()


class SeparateRequest(BaseModel):
    input_path: str
    output_dir: str


def _pick(files: list[Path], kind: str) -> Path:
    """Acha o arquivo de saída que tem '(Vocals)' ou '(Instrumental)' no nome."""
    for f in files:
        if f"({kind})" in f.name.lower():
            return f
    raise RuntimeError(
        f"Stem '{kind}' não encontrado na saída: {[f.name for f in files]}"
    )


def _run_pass(model_name: str, input_file: Path, out_dir: Path) -> tuple[Path, Path]:
    """
    Executa UMA passada de separação em um subprocesso isolado.

    O worker herda stdout/stderr do uvicorn, então o progresso do audio-separator
    (barras, "Loading model", "Separation duration") aparece no mesmo console.

    Como cada passada tem sua própria sessão ROCm, ao final ela devolve 100% da
    VRAM ao driver — que é o que evita a degradação entre músicas.
    """
    # Limpa a pasta de saída do worker antes de rodar.
    if out_dir.exists():
        for old in out_dir.iterdir():
            if old.is_file():
                old.unlink()
    else:
        out_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        sys.executable,
        str(_WORKER),
        "--model", model_name,
        "--input", str(input_file),
        "--output", str(out_dir),
        "--format", OUTPUT_FORMAT,
    ]

    print(f"[main] iniciando worker: model={model_name} input={input_file.name}", flush=True)
    # Sem capture: o worker fala direto no console do uvicorn.
    result = subprocess.run(cmd)
    if result.returncode != 0:
        raise RuntimeError(
            f"worker falhou (código {result.returncode}) para modelo {model_name}. "
            f"Veja a saída acima do worker para o motivo."
        )
    print(f"[main] worker terminou: model={model_name}", flush=True)

    files = [p for p in out_dir.iterdir() if p.is_file()]
    return _pick(files, "vocals"), _pick(files, "instrumental")


@app.get("/health")
def health():
    # Este processo NÃO abre sessão CUDA/HIP: toda a GPU fica nos subprocessos.
    return {
        "status": "ok",
        "stem_model": STEM_MODEL,
        "karaoke_model": KARAOKE_MODEL,
        "align_model": ALIGN_MODEL,
        "worker": str(_WORKER),
        "align_worker": str(_ALIGN_WORKER),
    }


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
            # ---------- Passada 1: voz x instrumental ----------
            out1 = SCRATCH_DIR / "separator_output_pass1"
            vocals, instrumental = _run_pass(STEM_MODEL, src, out1)
            shutil.move(str(instrumental), dest / f"instrumental.{ext}")

            # A voz isolada vira a entrada da segunda passada.
            tmp_vocals = SCRATCH_DIR / f"_vocals_{src.stem}{vocals.suffix}"
            shutil.move(str(vocals), tmp_vocals)

            # ---------- Passada 2: voz principal x backing ----------
            out2 = SCRATCH_DIR / "separator_output_pass2"
            lead, backing = _run_pass(KARAOKE_MODEL, tmp_vocals, out2)
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
#
# Roda em SUBPROCESSO isolado (align_worker.py), igual à separação. O Whisper
# fica residente em VRAM apenas durante o alinhamento; ao final, o processo
# morre e o SO devolve tudo ao driver. Sem isso, com "medium" você teria
# ~3 GB de VRAM presos durante toda a vida do uvicorn.
# --------------------------------------------------------------------------
class AlignRequest(BaseModel):
    audio_path: str     # voz isolada (lead.flac)
    lrc_path: str       # letra sincronizada por linha
    output_path: str    # words.json
    language: str = "pt"
    offset_ms: int = 0  # deslocamento já detectado para essa música


@app.post("/align")
def align(req: AlignRequest):
    audio_path, lrc_path = Path(req.audio_path), Path(req.lrc_path)
    for p in (audio_path, lrc_path):
        if not p.is_file():
            raise HTTPException(404, f"Arquivo não encontrado: {p}")

    # Validação barata aqui no main, antes de gastar um subprocesso com input inválido.
    lines = parse_lrc(lrc_path.read_text(encoding="utf-8"))
    if not any(line.text for line in lines):
        raise HTTPException(422, "A letra não tem nenhuma linha com texto")

    cmd = [
        sys.executable,
        str(_ALIGN_WORKER),
        "--audio", str(audio_path),
        "--lrc", str(lrc_path),
        "--output", str(req.output_path),
        "--language", req.language,
        "--model", ALIGN_MODEL,
        "--offset-ms", str(req.offset_ms),
    ]
    print(
        f"[main] iniciando align_worker: model={ALIGN_MODEL} lang={req.language} "
        f"audio={audio_path.name}",
        flush=True,
    )
    try:
        with _lock:  # a GPU é uma só: não roda junto com a separação
            # Sem capture: o worker fala direto no console do uvicorn (barras VAD/Align).
            result = subprocess.run(cmd)
        if result.returncode != 0:
            raise HTTPException(
                500,
                f"Falha no alinhamento (align_worker código {result.returncode}). "
                f"Veja a saída acima do align_worker para o motivo.",
            )
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Falha no alinhamento: {e}") from e
    print("[main] align_worker terminou", flush=True)

    # Conta o resultado lendo o words.json que o worker acabou de escrever.
    out = Path(req.output_path)
    try:
        payload = json.loads(out.read_text(encoding="utf-8"))
        results = payload.get("lines", [])
        aligned = sum(1 for r in results if r.get("aligned"))
    except (OSError, ValueError) as e:
        raise HTTPException(500, f"words.json ilegível após o alinhamento: {e}") from e
    return {"lines": len(results), "aligned": aligned}

class DetectOffsetRequest(BaseModel):
    audio_path: str     # lead.flac
    lrc_path: str       # lyrics.lrc


def _detect_first_onset_ms(audio_path: Path) -> int:
    """
    Instante (ms) em que a voz começa a soar no arquivo.

    Estratégia: RMS em janelas de 20 ms, limiar adaptativo a -35 dB do pico,
    exigindo ~150 ms contínuos acima do limiar para valer como "voz começou".
    Robusto para o lead.flac (que é só voz) e rápido (sem GPU).
    """
    import numpy as np
    import whisper

    audio = whisper.load_audio(str(audio_path))  # float32, 16 kHz, mono
    if audio.size == 0:
        return 0

    sr = 16000
    hop = int(sr * 0.02)   # 20 ms
    win = hop * 2          # 40 ms por janela

    n = (len(audio) - win) // hop + 1
    if n <= 0:
        return 0

    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    frames = audio[idx]
    rms = np.sqrt((frames ** 2).mean(axis=1) + 1e-12)

    peak = float(rms.max())
    if peak <= 1e-9:
        return 0

    threshold = peak * (10 ** (-35 / 20))  # -35 dB abaixo do pico
    min_run = int(0.15 / 0.02)             # 150 ms acima do limiar = começou

    run = 0
    start = -1
    for i, v in enumerate(rms):
        if v >= threshold:
            if run == 0:
                start = i
            run += 1
            if run >= min_run:
                return int(start * hop / sr * 1000)
        else:
            run = 0
    return 0


@app.post("/detect-offset")
def detect_offset(req: DetectOffsetRequest):
    audio_path, lrc_path = Path(req.audio_path), Path(req.lrc_path)
    for p in (audio_path, lrc_path):
        if not p.is_file():
            raise HTTPException(404, f"Arquivo não encontrado: {p}")

    lines = parse_lrc(lrc_path.read_text(encoding="utf-8"))
    first_sung = next((l for l in lines if l.text), None)
    if first_sung is None:
        raise HTTPException(422, "A letra não tem nenhuma linha com texto")

    try:
        # Não usa GPU: não precisa do _lock.
        onset_ms = _detect_first_onset_ms(audio_path)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Falha ao analisar o áudio: {e}") from e

    first_lyric_ms = int(first_sung.t * 1000)
    offset_ms = onset_ms - first_lyric_ms

    # Sanidade: se o desvio for maior que 30 s, é provavelmente outra versão
    # (não um problema de intro). Não sugerimos nada para não quebrar a música.
    if abs(offset_ms) > 30_000:
        return {"detected": False, "offsetMs": 0,
                "onsetMs": onset_ms, "firstLyricMs": first_lyric_ms}

    return {"detected": True, "offsetMs": offset_ms,
            "onsetMs": onset_ms, "firstLyricMs": first_lyric_ms}