"""HTTP responses for the LinkML download, shared by Light Mode and Dev Mode."""
from __future__ import annotations

from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from extractor.contract import ContractError

from ..light_mode.schema_source import SchemaUnavailable, schema_profile_for_package
from .legacy import ExtractionFailed
from .snapshots import LinkMLUnavailable, get_snapshot, snapshot_yaml
from .to_linkml import ConversionError


async def _snapshot(package: str) -> dict:
    profile = schema_profile_for_package(package)
    try:
        return await run_in_threadpool(get_snapshot, profile, package)
    except LinkMLUnavailable as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except SchemaUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except ModuleNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"No schema module named {package!r}: {exc}")
    except (ImportError, ExtractionFailed, ContractError, ConversionError) as exc:
        raise HTTPException(status_code=500, detail=f"LinkML conversion of {package!r} failed: {exc}")


async def linkml_download(package: str) -> Response:
    """The module's LinkML schema as a YAML file download."""
    snapshot = await _snapshot(package)
    filename = f"{package}.linkml.yaml"
    return Response(
        content=snapshot_yaml(snapshot),
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
