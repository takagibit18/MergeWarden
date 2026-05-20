"""Tests for provider matrix config parsing."""

from pathlib import Path

from eval.provider_matrix import load_provider_matrix


def test_load_provider_matrix_defaults(tmp_path: Path) -> None:
    path = tmp_path / "providers.json"
    path.write_text(
        '{"providers":[{"name":"local","model":"model-a"}]}',
        encoding="utf-8",
    )

    matrix = load_provider_matrix(path)

    assert matrix.providers[0].name == "local"
    assert matrix.providers[0].base_url_label == "openai-compatible"
    assert matrix.providers[0].temperature == 0.0
    assert matrix.providers[0].samples == 1
