"""
Serviço de separação de stems.

Recebe o caminho de um áudio e gera, na pasta de saída:
  instrumental.<fmt>  -> música sem nenhuma voz
  lead.<fmt>          -> voz principal (a do cantor original)
  backing.<fmt>       -> vozes de apoio / coro

São duas passadas, como no vídeo do Funky:
  1) STEM_MODEL      separa voz x instrumental
  2) KARAOKE_MODEL   separa a voz em principal x backing

Cada passada roda em um SUBPROCESSO Python isolado (worker.py). Quando o
processo termina, o SO limpa toda a VRAM e o estado do ROCm/HIP associado
a ele — sem isso, no Windows o ROCm acumula fragmentação entre trocas de
modelo e a separação degrada para ~17 s/it depois de algumas músicas.

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

from aligner import SAMPLE_RATE, align_lines, parse_lrc

STEM_MODEL = os.getenv("STEM_MODEL", "model_bs_roformer_ep_317_sdr_12.9755.ckpt")
KARAOKE_MODEL = os.getenv(
    "KARAOKE_MODEL", "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
)
OUTPUT_FORMAT = os.getenv("OUTPUT_FORMAT", "FLAC")
# Modelo do Whisper usado só para alinhar palavras ("base" é mais leve; "small" erra menos).
ALIGN_MODEL = os.getenv("ALIGN_MODEL", "small")
SCRATCH_DIR = Path(os.getenv("SCRATCH_DIR", "./scratch")).resolve()

# Caminho absoluto do worker.py, ao lado deste main.py.
_WORKER = Path(__file__).resolve().parent / "worker.py"

app = FastAPI(title="Karaoke separator")

# Uma GPU só: serializa as separações.
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
    (barras, "Loading model", "Separation duration") aparece no mesmo console —
    exatamente como aparecia antes, quando rodávamos in-process.

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
    # Por isso não reportamos uso de GPU aqui — o log do worker mostra tudo.
    return {
        "status": "ok",
        "stem_model": STEM_MODEL,
        "karaoke_model": KARAOKE_MODEL,
        "worker": str(_WORKER),
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
# Observação: o /align ainda roda no processo principal. Ele carrega o Whisper
# e cria uma sessão CUDA/HIP no main. Como o /separate roda em subprocessos,
# essa sessão do main não interfere — mas evite rodar /align e /separate ao
# mesmo tempo. O _lock já serializa os dois.
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