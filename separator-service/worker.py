"""
Worker de separação: roda UMA passada de separação e sai.

Este processo é criado como subprocesso pelo main.py. Como ele nasce, carrega
um único modelo, processa e morre, o SO garante que toda a VRAM e o estado do
ROCm/HIP associados sejam liberados ao final. É isso que evita a degradação
entre músicas no Windows.

Uso (chamado pelo main.py, não precisa rodar à mão):
    python worker.py --model <modelo.ckpt> --input <audio> --output <pasta> --format FLAC
"""
import argparse
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Uma passada de separação de stems.")
    parser.add_argument("--model", required=True, help="Nome do arquivo do modelo (.ckpt)")
    parser.add_argument("--input", required=True, help="Caminho do áudio de entrada")
    parser.add_argument("--output", required=True, help="Pasta onde salvar os stems")
    parser.add_argument("--format", default="FLAC", help="Formato de saída (FLAC, WAV, ...)")
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    output_dir = Path(args.output).resolve()
    if not input_path.is_file():
        print(f"[worker] entrada não encontrada: {input_path}", file=sys.stderr)
        return 2
    output_dir.mkdir(parents=True, exist_ok=True)

    # Import tardio: só o worker (que é descartável) paga o custo do torch.
    from audio_separator.separator import Separator

    sep = Separator(
        output_dir=str(output_dir),
        output_format=args.format,
    )
    sep.load_model(model_filename=args.model)
    sep.separate(str(input_path))

    # O processo termina aqui e o SO limpa tudo relacionado à GPU.
    return 0


if __name__ == "__main__":
    sys.exit(main())