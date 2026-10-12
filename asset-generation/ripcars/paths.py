"""Where each stage keeps its files."""
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
REFERENCES = REPO / "reference-collector" / "cars"
STAGE = REPO / "asset-generation"
ASSETS = STAGE / "assets" / "cars"  # what the app serves: one folder per car


def sheet(car: str) -> Path:
    return REFERENCES / car / "generated" / "reference-sheet.png"


def manifest(car: str) -> Path:
    return REFERENCES / car / "manifest.json"


def asset_dir(car: str) -> Path:
    path = ASSETS / car
    path.mkdir(parents=True, exist_ok=True)
    return path


def qa_dir(car: str) -> Path:
    """Review images (not served, not committed)."""
    path = STAGE / "qa" / car
    path.mkdir(parents=True, exist_ok=True)
    return path


def cache_dir(car: str) -> Path:
    """Segmentation mattes, keyed by sheet hash (not committed)."""
    path = STAGE / ".cache" / car
    path.mkdir(parents=True, exist_ok=True)
    return path


def cars() -> list[str]:
    """Cars that have both a reference sheet and pack-photo hints."""
    return sorted(p.parent.parent.name for p in REFERENCES.glob("*/generated/reference-sheet.png")
                  if (ASSETS / p.parent.parent.name / "hints.json").is_file())
