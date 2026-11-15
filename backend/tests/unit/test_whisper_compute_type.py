import sys
from types import SimpleNamespace

from src.media import transcription


def _fake_ct2(monkeypatch, supported):
    monkeypatch.setitem(
        sys.modules,
        "ctranslate2",
        SimpleNamespace(get_supported_compute_types=lambda device: set(supported)),
    )


def test_prefers_float16_when_the_gpu_supports_it(monkeypatch):
    monkeypatch.delenv("WHISPER_COMPUTE_TYPE", raising=False)
    _fake_ct2(monkeypatch, {"float32", "int8", "int8_float16", "float16"})
    assert transcription._whisper_compute_type(cuda=True) == "float16"


def test_pascal_gpu_without_fast_float16_gets_int8(monkeypatch):
    # GTX 1050 Ti (compute capability 6.1): no float16, int8 works.
    monkeypatch.delenv("WHISPER_COMPUTE_TYPE", raising=False)
    _fake_ct2(monkeypatch, {"float32", "int8", "int8_float32"})
    assert transcription._whisper_compute_type(cuda=True) == "int8_float32"


def test_env_override_and_cpu(monkeypatch):
    monkeypatch.setenv("WHISPER_COMPUTE_TYPE", "float32")
    assert transcription._whisper_compute_type(cuda=True) == "float32"
    monkeypatch.delenv("WHISPER_COMPUTE_TYPE")
    assert transcription._whisper_compute_type(cuda=False) == "int8"
