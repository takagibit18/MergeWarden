"""Tool-layer exceptions with structured metadata."""

from __future__ import annotations

from typing import Any


class ToolError(Exception):
    """Base error for all tool failures."""

    def __init__(
        self,
        message: str,
        *,
        tool_name: str = "",
        path: str = "",
    ) -> None:
        super().__init__(message)
        self.tool_name = tool_name
        self.path = path


class FileNotFoundToolError(ToolError):
    """Target file or directory does not exist."""


class PathNotAllowedError(ToolError):
    """Path violates sandbox or allowed-root constraints."""


class PatternError(ToolError):
    """Regex or glob pattern is invalid."""


class FileReadError(ToolError):
    """I/O failure while reading file content."""


class CommandExecutionToolError(ToolError):
    """Command failed during sandboxed execution."""


class CommandTimeoutToolError(ToolError):
    """Command exceeded execution timeout."""


class CommandNotAllowedError(ToolError):
    """Command rejected by the exec policy (allowlist, argv validation, etc.)."""


def classify_tool_failure(
    error: BaseException,
    *,
    tool_name: str = "",
    message: str = "",
) -> dict[str, Any]:
    """Return a bounded recovery classification for a tool exception.

    A bad model path/pattern is recoverable because the model can inspect and
    correct it.  Workspace escape, permission and command-policy failures are
    deliberately non-bypassable even when a retry is technically possible.
    """

    text = (message or str(error)).lower()
    if isinstance(error, PathNotAllowedError) or "outside the allowed workspace" in text:
        return {
            "error_type": "path_not_allowed",
            "failure_class": "workspace_scope",
            "recoverable": False,
            "recommended_next_step": "Keep the request inside the approved workspace; do not bypass the path policy.",
        }
    if isinstance(error, (CommandNotAllowedError,)):
        return {
            "error_type": "command_not_allowed",
            "failure_class": "permission_policy",
            "recoverable": False,
            "recommended_next_step": "Use an allowed read-only operation or ask the user to authorize a different action.",
        }
    if "permission denied" in text or "access is denied" in text:
        return {
            "error_type": "permission_denied",
            "failure_class": "permission",
            "recoverable": False,
            "recommended_next_step": "The path is not readable under the current workspace permissions; preserve the evidence gap.",
        }
    if isinstance(error, PatternError):
        return {
            "error_type": "invalid_pattern",
            "failure_class": "parameter_error",
            "recoverable": True,
            "recommended_next_step": "Correct the regex/glob syntax and retry once.",
        }
    if isinstance(error, FileNotFoundToolError):
        return {
            "error_type": "invalid_path",
            "failure_class": "parameter_error",
            "recoverable": True,
            "recommended_next_step": "Use list_dir on the parent directory and retry with the exact workspace-relative path or directory.",
        }
    if isinstance(error, FileReadError):
        return {
            "error_type": "file_read_failed",
            "failure_class": "io_error",
            "recoverable": True,
            "recommended_next_step": "Retry with a smaller exact range or inspect the parent path before continuing.",
        }
    if isinstance(error, CommandTimeoutToolError):
        return {
            "error_type": "tool_timeout",
            "failure_class": "timeout",
            "recoverable": True,
            "recommended_next_step": "Retry with a narrower, bounded request; repeated timeouts stop the run.",
        }
    if isinstance(error, ToolError):
        return {
            "error_type": "tool_execution_failed",
            "failure_class": "tool_error",
            "recoverable": True,
            "recommended_next_step": "Inspect the structured error and correct the tool arguments before retrying.",
        }
    return {
        "error_type": "tool_execution_failed",
        "failure_class": "execution_error",
        "recoverable": False,
        "recommended_next_step": "Preserve the failure and return a partial result; no automatic bypass is allowed.",
    }
