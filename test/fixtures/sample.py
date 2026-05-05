import os
import json
import hashlib
from typing import Optional, List, Dict, Any


def load_config(config_path: str) -> Dict[str, Any]:
    """Load configuration from a JSON file."""
    with open(config_path, 'r') as f:
        return json.load(f)


def hash_content(content: str, algorithm: str = 'sha256') -> str:
    """Hash string content using specified algorithm."""
    h = hashlib.new(algorithm)
    h.update(content.encode('utf-8'))
    return h.hexdigest()


def find_files(root: str, extensions: List[str], exclude: Optional[List[str]] = None) -> List[str]:
    """Recursively find files matching given extensions."""
    exclude = exclude or []
    results = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in exclude]
        for fname in filenames:
            ext = os.path.splitext(fname)[1].lower()
            if ext in extensions:
                results.append(os.path.join(dirpath, fname))
    return results


class DataPipeline:
    """Simple data transformation pipeline."""

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self._stages: List[Any] = []
        self._cache: Dict[str, Any] = {}

    def add_stage(self, fn: Any) -> 'DataPipeline':
        self._stages.append(fn)
        return self

    def run(self, data: Any) -> Any:
        cache_key = hash_content(str(data))
        if cache_key in self._cache:
            return self._cache[cache_key]

        result = data
        for stage in self._stages:
            try:
                result = stage(result)
            except Exception as e:
                if self.config.get('strict', False):
                    raise
                result = None
                break

        self._cache[cache_key] = result
        return result

    def clear(self) -> None:
        self._cache.clear()


def normalize(value: Any) -> Any:
    """Normalize a value for indexing."""
    if isinstance(value, str):
        return value.strip().lower()
    if isinstance(value, list):
        return [normalize(v) for v in value]
    if isinstance(value, dict):
        return {k: normalize(v) for k, v in value.items()}
    return value
