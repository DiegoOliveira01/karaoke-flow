"""
Worker de alinhamento palavra a palavra.

Roda UMA passada de alinhamento em subprocesso isolado (chamado pelo main.py).
Como o processo nasce, carrega o Whisper, alinha, escreve o words.json e morre,
o SO garante que a VRAM e o estado ROCm/HIP do Whisper sejam liberados ao final.
Sem isso, o modelo (com "medium", ~3 GB) ficaria residente durante toda a
sessão do uvicorn.

Uso (chamado pelo main.py, não precisa rodar à mão):
    python align_worker.py --audio <lead.flac> --lrc <lyrics.lrc> \\
        --output <words.json> --language pt --model medium
"""
import argparse
import json
import sys
from pathlib import Path

from aligner import SAMPLE_RATE, align_lines, parse_lrc


def _make_align_fn(model, language: str):
    def align_fn(chunk, text):
        try:
            # cantores seguram notas por vários segundos; o padrão (3 s) encurtaria a palavra
            result = model.align(
                chunk, text,
                language=language,
                max_word_dur=10.0,    # nota sustentada: 10s cobre a maioria
                q_levels=20,          # granularidade da quantização de energia
                k_size=5,             # suavização da curva de energia
                vad=True,             # voice activity detection: ignora silêncio
            )
        except TypeError:  # versão do stable-ts sem esses parâmetros
            result = model.align(chunk, text, language=language)
        if result is None:
            return None
        return [(w.start, w.end) for seg in result.segments for w in seg.words]

    return align_fn


def main() -> int:
    parser = argparse.ArgumentParser(description="Uma passada de alinhamento de palavras.")
    parser.add_argument("--audio", required=True, help="Voz isolada (lead.flac)")
    parser.add_argument("--lrc", required=True, help="Letra sincronizada por linha")
    parser.add_argument("--output", required=True, help="Onde gravar o words.json")
    parser.add_argument("--language", default="pt", help="Idioma da letra (ISO 639-1)")
    parser.add_argument("--model", default="medium", help="Modelo do Whisper")
    args = parser.parse_args()

    audio_path = Path(args.audio).resolve()
    lrc_path = Path(args.lrc).resolve()
    output_path = Path(args.output).resolve()

    if not audio_path.is_file():
        print(f"[align_worker] áudio não encontrado: {audio_path}", file=sys.stderr)
        return 2
    if not lrc_path.is_file():
        print(f"[align_worker] LRC não encontrado: {lrc_path}", file=sys.stderr)
        return 2

    lines = parse_lrc(lrc_path.read_text(encoding="utf-8"))
    if not any(line.text for line in lines):
        print("[align_worker] a letra não tem nenhuma linha com texto", file=sys.stderr)
        return 3

    # Imports tardios: só o worker (que é descartável) paga o custo do torch.
    import whisper                    # instalado junto com o stable-ts
    import stable_whisper
    import torch

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = stable_whisper.load_model(args.model, device=device)
    audio = whisper.load_audio(str(audio_path))  # float32, 16 kHz, mono
    results = align_lines(
        audio, len(audio) / SAMPLE_RATE, lines, _make_align_fn(model, args.language)
    )

    payload = {
        "version": 1,
        "language": args.language,
        "model": args.model,
        "lines": results,
    }

    # troca atômica: o player nunca lê um arquivo pela metade
    tmp = output_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(output_path)

    # O processo termina aqui e o SO limpa tudo relacionado à GPU.
    return 0


if __name__ == "__main__":
    sys.exit(main())