from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import ORJSONResponse
from extractor.graph_builder import build_graph, list_sections
from fastapi.middleware.cors import CORSMiddleware


app = FastAPI(title="Schema UML API", default_response_class=ORJSONResponse)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # dev-friendly
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    allow_cross_module: bool = Query(True),                 # NEW
    base_namespace: str | None = Query(None),               # NEW
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