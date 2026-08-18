"""Pure path resolution for the artifact stores — a leaf module.

``registry`` needs the default artifact root but must not import ``apo.db``
(module load there creates the engine). ``apo.db`` re-exports ``DATA_DIR``
from here so existing importers are unaffected.
"""

from __future__ import annotations

import os

DATA_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))), "data"
)
