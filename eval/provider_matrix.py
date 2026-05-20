"""Offline provider matrix configuration for eval comparisons."""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, Field


class ProviderMatrixEntry(BaseModel):
    """One provider/model eval configuration."""

    name: str = Field(..., min_length=1)
    base_url_label: str = Field(default="openai-compatible")
    model: str = Field(..., min_length=1)
    temperature: float = Field(default=0.0, ge=0.0)
    samples: int = Field(default=1, ge=1)
    notes: str = ""


class ProviderMatrix(BaseModel):
    """Named list of provider eval configurations."""

    providers: list[ProviderMatrixEntry] = Field(default_factory=list)


def load_provider_matrix(path: str | Path) -> ProviderMatrix:
    return ProviderMatrix.model_validate_json(Path(path).read_text(encoding="utf-8"))


def provider_matrix_example() -> dict[str, object]:
    return {
        "providers": [
            {
                "name": "openai-default",
                "base_url_label": "openai",
                "model": "gpt-4o",
                "temperature": 0.0,
                "samples": 1,
                "notes": "Default CI-compatible baseline.",
            },
            {
                "name": "compatible-provider",
                "base_url_label": "openai-compatible",
                "model": "provider-model-name",
                "temperature": 0.0,
                "samples": 1,
                "notes": "Fill with local provider settings before live runs.",
            },
        ]
    }


def write_provider_matrix_example(path: str | Path) -> Path:
    target = Path(path)
    target.write_text(
        json.dumps(provider_matrix_example(), indent=2) + "\n",
        encoding="utf-8",
    )
    return target
