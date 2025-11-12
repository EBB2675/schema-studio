from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import ORJSONResponse
from extractor.graph_builder import build_graph, list_sections
from fastapi.middleware.cors import CORSMiddleware
import os, subprocess, tempfile, shutil, ast
from pathlib import Path
from pydantic import BaseModel

from .routes_git import router as git_router

app = FastAPI(title="Schema UML API", default_response_class=ORJSONResponse)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(git_router)

@app.get("/health")
def health():
    return {"ok": True}

@app.get("/")
def root():
    return {"message": "Schema UML API is running"}

@app.get("/roots")
def roots(package: str = Query(...)):
    """List available section classes for a given package."""
    try:
        return {"package": package, "sections": sorted(list_sections(package))}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"{type(e).__name__}: {e}")

@app.get("/schema")
def schema(
    package: str = Query(...),
    root: str | None = Query(None),
    include_quantities: bool = Query(True),
    include_subsections: bool = Query(True),
    allow_cross_module: bool = Query(True),                 
    base_namespace: str | None = Query(None),               
):
    data = build_graph(
        package=package,
        root=root,
        include_quantities=include_quantities,
        include_subsections=include_subsections,
        allow_cross_module=allow_cross_module,
        base_namespace=base_namespace
    )
    return data