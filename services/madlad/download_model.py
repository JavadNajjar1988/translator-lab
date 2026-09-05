from __future__ import annotations

import argparse
from pathlib import Path

from huggingface_hub import snapshot_download


def main() -> None:
    parser = argparse.ArgumentParser(description="Download the official MADLAD-400 model files.")
    parser.add_argument("--model-id", default="google/madlad400-3b-mt")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=args.model_id,
        local_dir=output,
        allow_patterns=[
            "config.json",
            "generation_config.json",
            "model.safetensors",
            "added_tokens.json",
            "special_tokens_map.json",
            "spiece.model",
            "tokenizer.json",
            "tokenizer_config.json",
        ],
    )
    print(output)


if __name__ == "__main__":
    main()
