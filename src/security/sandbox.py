"""Sandbox execution entry point.

Dispatches execute-class commands to the configured backend
(subprocess / docker) and returns a structured :class:`SandboxResult`.

The command is expected to be a string; it is parsed/validated by
``src.security.exec_policy.resolve_command`` before dispatch. Shell
interpretation is never used in the backend.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from pydantic import BaseModel, Field


@dataclass(frozen=True)
class ExecutionScope:
    """Resolved execution boundaries shared by all sandbox backends."""

    workspace_root: Path
    cwd: Path


class SandboxResult(BaseModel):
    """Structured result from one sandboxed command run."""

    command: str
    cwd: str
    backend: str = Field(default="")
    workspace_root: str = Field(default="")
    container_cwd: str | None = Field(default=None)
    exit_code: int = Field(default=-1)
    stdout: str = Field(default="")
    stderr: str = Field(default="")
    timed_out: bool = Field(default=False)
    duration_ms: int = Field(default=0, ge=0)
    stdout_truncated: bool = Field(default=False)
    stderr_truncated: bool = Field(default=False)


def _resolve_execution_scope(*, cwd: Path | str) -> tuple[ExecutionScope | None, str]:
    from src.tools.path_utils import get_tool_workspace_root

    resolved_cwd = Path(cwd).resolve()
    workspace_root = (get_tool_workspace_root() or resolved_cwd).resolve()
    if not resolved_cwd.exists():
        return None, f"Working directory does not exist: {resolved_cwd}"
    if not resolved_cwd.is_dir():
        return None, f"Working directory is not a directory: {resolved_cwd}"
    if not resolved_cwd.is_relative_to(workspace_root):
        return None, f"Working directory is outside the allowed workspace: {resolved_cwd}"
    return ExecutionScope(workspace_root=workspace_root, cwd=resolved_cwd), ""


def _scope_error_result(
    *,
    argv: list[str],
    cwd: Path | str,
    backend: str,
    message: str,
) -> SandboxResult:
    from src.tools.path_utils import get_tool_workspace_root

    resolved_cwd = Path(cwd).resolve()
    workspace_root = (get_tool_workspace_root() or resolved_cwd).resolve()
    return SandboxResult(
        command=" ".join(argv),
        cwd=str(resolved_cwd),
        backend=backend,
        workspace_root=str(workspace_root),
        exit_code=126,
        stderr=message,
    )


def run_sandboxed_command(
    *,
    argv: list[str],
    cwd: Path | str,
    timeout_ms: int,
    backend: str | None = None,
    max_output_bytes: int | None = None,
    env: dict[str, str] | None = None,
) -> SandboxResult:
    """Run a validated argv through the configured backend.

    Callers are expected to have already validated ``argv`` via
    :func:`src.security.exec_policy.resolve_command`.
    """
    from src.config import get_settings
    from src.security.backends import build_scrubbed_env, get_backend

    settings = get_settings()
    backend_name = backend if backend is not None else settings.execute_backend
    effective_limit = (
        max_output_bytes
        if max_output_bytes is not None
        else settings.execute_max_output_bytes
    )
    effective_env = env if env is not None else build_scrubbed_env()

    scope, scope_error = _resolve_execution_scope(cwd=cwd)
    if scope is None:
        return _scope_error_result(
            argv=list(argv),
            cwd=cwd,
            backend=backend_name,
            message=scope_error,
        )

    impl = get_backend(backend_name)
    return impl.run(
        argv=list(argv),
        cwd=scope.cwd,
        workspace_root=scope.workspace_root,
        timeout_ms=timeout_ms,
        env=effective_env,
        max_output_bytes=effective_limit,
    )
