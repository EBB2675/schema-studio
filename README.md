# Schema UML Viewer

Interactive UML-style viewer. The scope may change along the way:D

Visualizes sections as UML cards with attributes, subsections, and relationships.  
Backend: FastAPI • Frontend: React + Cytoscape + ELK layout


---

## 🚀 Quick Start

### 1️⃣ Clone the repository
git clone https://github.com/EBB2675/schema-uml.git
cd schema-uml

### 2️⃣ Create and activate a Conda environment
conda create -n schema-uml python=3.11 -y
conda activate schema-uml
pip install -r requirements.txt

### 3️⃣ Point to your `nomad-simulations` clone
Set an environment variable that tells the backend where to find the repo.

export NOMAD_SIM_REPO=/home/<user>/DEVELOP/nomad-distro-dev/packages/nomad-simulations

💡 You can make this permanent by adding the line above to your `~/.bashrc` or `~/.zshrc`.

Verify that it’s set:
echo $NOMAD_SIM_REPO

### 4️⃣ Start the backend
uvicorn api.main:app --reload --port 5179

Test that it works:
curl http://127.0.0.1:5179/git/branches

✅ You should see a list of branches such as:
{"branches":["develop","sprint-dft-qchem", ...]}

### 5️⃣ Start the frontend
cd web
npm install
npm run dev

Then open your browser at:
http://localhost:5173

---

## 🧠 Usage Notes

- Temporary worktrees are created under:
  api/_data/
  These are auto-generated and should **not** be committed.
  
- If the branch dropdown is empty:
  1. Check that `$NOMAD_SIM_REPO` points to a valid repo containing a `.git` folder.
  2. If `_data/nomad-simulations.bare` is missing or corrupted, delete `api/_data/` and restart the backend — it will rebuild automatically.

- Visual cues:
  - 🟩 Added classes → green border  
  - 🟨 Changed classes → amber border  
  - Removed elements → appear in the diff summary list in the sidebar

---

## 🧩 Example Workflow

1. Select a package, e.g. `nomad_simulations.schema_packages.model_method`
2. Click **Load roots** → choose a root section (e.g. `ModelMethod`).
3. Click **Build graph** to render the UML structure.
4. Select two branches (e.g. `develop` and `sprint-dft-qchem`) and click **Compare** to visualize schema differences between branches.

---


## 🧰 Tech Stack

- Frontend: React + TypeScript + Cytoscape + ELK layout  
- Backend: FastAPI + GitPython  
- Language: Python 3.11  
- Visualization: UML-style expandable class diagrams  

---

## 🧑‍💻 Authors & Maintainers

**Dr. Esma Birsen Boydaş**  
Humboldt-Universität zu Berlin — FAIRmat / NOMAD Lab  
---

⚙️ Work in progress — expect frequent updates as the project evolves.
