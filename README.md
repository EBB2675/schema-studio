# Schema UML Viewer

Interactive UML-style viewer. The scope may change along the way:D

Visualizes sections as UML cards with attributes, subsections, and relationships.  
Backend: FastAPI • Frontend: React + Cytoscape + ELK layout

---

## 🚀 Quick Start

```bash
# 1. Create environment
conda create -n schema-uml python=3.11
conda activate schema-uml

# 2. Backend setup
cd api
pip install -r requirements.txt
pip install -e /path/to/nomad-simulations
uvicorn main:app --reload --port 5179

# 3. Frontend setup
cd ../web
npm install
npm run dev
```

Then open: [http://localhost:5173](http://localhost:5173)

---

## 🧭 How to Use

(i ll make this user-friendlier after the heavy dev phase ends)

1. API base → `http://localhost:5179`  
2. Package → e.g. `nomad_simulations.schema_packages.model_method`  
3. Load roots → select root → **Build graph**

Tips:
- Click a class → shows its subsections  
- Right-click → collapses them  
- Export JSON → downloads the current graph

---

## 📁 Structure

```text
schema-uml/
├─ api/   # FastAPI backend
├─ web/   # React frontend
```

---

