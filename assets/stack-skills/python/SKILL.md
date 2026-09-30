---
name: python
description: "Python type discipline: parse at the boundary (pydantic), Literal unions with assert_never, NewType brands, strict pyright or mypy, ruff, pytest behavior tests. Use when writing or reviewing Python."
---

# Python

The type checker is a proof assistant. Make illegal states unrepresentable, parse external data once where it enters, and trust the types inside. This is P4 (parse at the system boundary) from the `principles` skill, in Python idiom. Use the tools the repo already has (its schema library, its type checker, its test runner) and never add a second one.

| Rule | Summary |
|---|---|
| Parse at the boundary | External data (HTTP bodies, `json.loads`, env vars, files, queue messages, raw SQL rows) is `object` until parsed. Parse it where it enters, with pydantic (`Model.model_validate_json`, `TypeAdapter`) or the repo's existing library (msgspec, attrs with cattrs, marshmallow). `Any` stops at that parse. Inside, trust the types; don't re-validate deep in call chains. |
| Tagged unions | Model variants as a union of classes that each carry a `kind: Literal[...]` tag. No optional-field bags (`loading: bool` next to `error: str \| None` next to `data: X \| None`). With pydantic, mark the union `Field(discriminator="kind")`. |
| Exhaustiveness | `match` over the union, ending in `case _: assert_never(x)` (`typing.assert_never` on Python 3.11+, `typing_extensions` before). A new variant then fails the type check at every match that misses it. |
| Brands | `UserId = NewType("UserId", str)`. Construct one only in the parse function that validated the value. |
| Constructive modeling | Build the shape so the illegal value can't exist: non-empty as `tuple[T, *tuple[T, ...]]`, a range as `start` plus `duration: timedelta`. Strengthen a type only where the loose one forces an `assert`, a cast, or a "should never happen" raise. |
| No lying to the checker | No `cast()`, bare `# type: ignore`, or `Any` to silence an error. A suppression names its rule and links its reason: `# type: ignore[attr-defined]  # stubs lack X: <issue link>`. |
| Narrowing order | `match` class or literal patterns > `isinstance` > a `TypeIs` guard > `cast`. A lying guard is worse than a cast. |
| Strict checking | Run the repo's checker in strict mode: `[tool.pyright] typeCheckingMode = "strict"`, or `[tool.mypy] strict = true` with `enable_error_code = ["ignore-without-code"]`. |
| ruff | `ruff check` and `ruff format`. Worth enabling: `PGH` (blanket ignores), `T20` (`print`), `ANN`, `B`, `UP`, `FBT` (boolean positional arguments), `PT` (pytest style). |
| Keyword-only arguments | Several same-typed parameters or a boolean flag go keyword-only (`def open_file(*, uri: str, line: int)`), so call sites document themselves. Skip on hot paths. |
| Frozen values | Domain values are immutable: `@dataclass(frozen=True, slots=True)` inside, pydantic models with `ConfigDict(frozen=True)` at the edge. |
| Schema-derived types | Derive from the pydantic model, the ORM model, or generated code (OpenAPI, protobuf) instead of writing a parallel `TypedDict`. |
| Structured logging | `logging.getLogger(__name__)` with `extra=` fields, or structlog when the repo uses it. No `print` in shipped code. |

## Example

This passes pyright strict and mypy `--strict`. Delete the `Failed` arm and both fail at `assert_never`.

```python
from typing import Annotated, Literal, NewType, assert_never

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter


class Loading(BaseModel):
    model_config = ConfigDict(frozen=True)
    kind: Literal["loading"]


class Ready(BaseModel):
    model_config = ConfigDict(frozen=True)
    kind: Literal["ready"]
    diff: str


class Failed(BaseModel):
    model_config = ConfigDict(frozen=True)
    kind: Literal["failed"]
    error: str


DiffState = Annotated[Loading | Ready | Failed, Field(discriminator="kind")]
_DIFF_STATE: TypeAdapter[Loading | Ready | Failed] = TypeAdapter(DiffState)


def parse_diff_state(raw: bytes) -> Loading | Ready | Failed:
    return _DIFF_STATE.validate_json(raw)  # raises ValidationError: the boundary


def label(state: Loading | Ready | Failed) -> str:
    match state:
        case Loading():
            return "loading"
        case Ready(diff=diff):
            return diff
        case Failed(error=error):
            return f"failed: {error}"
        case _:
            assert_never(state)


UserId = NewType("UserId", str)


def parse_user_id(raw: str) -> UserId:
    if not raw.startswith("usr_"):
        raise ValueError(f"invalid user id: {raw!r}")
    return UserId(raw)
```

## Tests (pytest)

- Call the code the way its users do, and assert against a literal expected value: `assert slugify("Hello, World!") == "hello-world"`.
- Before you keep a test, ask whether it would still pass if every function it imports returned `None`. If yes, it observes nothing: rewrite the assertion or delete the test. Five shapes fail this check: weak assertions (`assert result`, `is not None`, `isinstance`), mock-only assertions (`mock.assert_called_once()`), self-referential expectations (`assert f(x) == f(x)`), constant pins (`assert LIMITS.max_tools == 8`), and a fixture asserting a fixture.
- Don't mock your own modules (`mock.patch("app.billing.compute_tax")` inside a billing test). Patch only at external boundaries (network, clock, randomness), and prefer passing those in. For outbound HTTP use `httpx.MockTransport` or `respx`. For the app itself, use the framework's real test client (FastAPI's `TestClient`, Django's `client`) against a real test database.
- Test the failure branch of every parser: `with pytest.raises(ValidationError): parse_diff_state(b'{"kind": "exploded"}')`.
- Use `tmp_path` for files and `monkeypatch.setenv` for environment variables. Parametrize literal input and expected pairs.

The `tdd` skill owns the test-first loop. Prove a user-facing change on the running service through the repo's verify skill, not only through tests.

To enforce package entry points and ban import cycles with import-linter, follow [BOUNDARIES.md](BOUNDARIES.md). Run it only when the user asks for boundary enforcement: it adds a dev dependency and a CI check.
