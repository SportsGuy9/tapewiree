import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(scope="session")
def data_dir(tmp_path_factory):
    d = tmp_path_factory.mktemp("scangap_data")
    os.environ["SCANGAP_DATA"] = str(d)
    os.environ["SCANGAP_OFFLINE"] = "1"
    return d


@pytest.fixture(scope="session")
def synthetic(data_dir):
    """Build the synthetic demo once (simulates ~3M points; ~20 s)."""
    from scangap import demo, project

    res = demo.build_synthetic()
    return {"results": res, "project": project.load(demo.SYNTH_ID), "pid": demo.SYNTH_ID}


@pytest.fixture(scope="session")
def synthetic_after(synthetic):
    """The simulated "after re-scan" twin (S7 + S9 shot), built by build_synthetic."""
    from scangap import demo, project

    return {"results": project.results(demo.SYNTH_AFTER_ID), "project": project.load(demo.SYNTH_AFTER_ID),
            "pid": demo.SYNTH_AFTER_ID}
