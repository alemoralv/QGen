from qgen.question_generator import (
    _gateway_rejects_temperature_param,
    _openai_rejects_temperature_param,  # backwards-compat alias
)


class _Fake400Temperature:
    status_code = 400
    body = {
        "error": {
            "message": "Unsupported parameter: 'temperature' is not supported with this model.",
            "param": "temperature",
            "type": "invalid_request_error",
        }
    }


class _Fake400Other:
    status_code = 400
    body = {"error": {"message": "Something else", "param": "model"}}


def test_rejects_temperature_param_detects_known_error() -> None:
    assert _gateway_rejects_temperature_param(_Fake400Temperature())


def test_rejects_temperature_param_false_for_other_400() -> None:
    assert not _gateway_rejects_temperature_param(_Fake400Other())


def test_backwards_compat_alias_still_works() -> None:
    assert _openai_rejects_temperature_param is _gateway_rejects_temperature_param
