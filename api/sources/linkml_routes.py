"""HTTP responses for the LinkML download, shared by Light Mode and Dev Mode."""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from extractor.contract import ContractError

from ..light_mode.schema_source import SchemaUnavailable, schema_profile_for_package
from . import editing
from .legacy import ExtractionFailed
from .snapshots import LinkMLUnavailable, get_snapshot
from .to_linkml import ConversionError


def edit_error(exc: Exception) -> HTTPException:
    """An edit that cannot be made, as a 400 response naming the reason."""
    reason = getattr(exc, "reason", "unsupported")
    return HTTPException(status_code=400, detail=f"{getattr(exc, 'detail', None) or exc} ({reason})")


async def _snapshot(package: str) -> dict:
    profile = schema_profile_for_package(package)
    return await _converted(package, get_snapshot, profile, package)


async def _converted(package: str, function, *args) -> Any:
    try:
        return await run_in_threadpool(function, *args)
    except LinkMLUnavailable as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except SchemaUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except ModuleNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"No schema module named {package!r}: {exc}")
    except (ImportError, ExtractionFailed, ContractError, ConversionError) as exc:
        raise HTTPException(status_code=500, detail=f"LinkML conversion of {package!r} failed: {exc}")


async def linkml_download(
    package: str, stored: Sequence[Mapping[str, Any]] = (), source: editing.Source | None = None,
) -> Response:
    """The module's LinkML schema as a YAML file download, with the stored edits replayed onto it.

    With a `source` (Dev Mode branch) the schema is the branch's.
    """
    content = await _converted(package, lambda: editing.linkml_yaml(package, stored, source=source))
    filename = f"{package}.linkml.yaml"
    return Response(
        content=content,
        media_type="application/yaml",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


async def linkml_report(package: str) -> dict:
    """What did not convert cleanly, in the extraction contract's report shape."""
    snapshot = await _snapshot(package)
    return {
        "package": package,
        "profile": snapshot["profile"],
        "source": snapshot["source"],
        "report": snapshot["report"],
    }
