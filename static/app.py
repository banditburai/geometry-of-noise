"""Pipeline + plot smoke test.

Verifies:
  1. Pyodide reactivity (Python ``@cell`` -> DOM via Datastar signal).
  2. micropip auto-dispatches numpy + matplotlib to prebuilt Pyodide wheels.
  3. ``@cell`` returning a matplotlib Figure renders inline as an image.

Once green, this scaffold becomes the home for the real notebook cells.
"""

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from starhtml import Div, H1, H2, Input, P, Script, star_app
from starhtml.datastar import Signal
from starimo import cell

app, rt = star_app(
    title="Geometry of Noise",
    hdrs=(Script(src="https://cdn.tailwindcss.com"),),
)

n_sig = Signal("n", 8)
doubled_sig = Signal("doubled", 16)


@cell
def doubled(n: int = 0):
    return n * 2


@cell
def smoke_plot(n: int = 8):
    """One-off smoke test: returns a Figure that should render as an inline PNG."""
    rng = np.random.default_rng(0)
    theta = np.linspace(0, 2 * np.pi, max(int(n), 4) * 16)
    r = 1.0 + 0.05 * rng.standard_normal(theta.shape)
    x, y = r * np.cos(theta), r * np.sin(theta)
    fig, ax = plt.subplots(figsize=(3.5, 3.5), dpi=110)
    ax.plot(x, y, lw=0.8, color="black")
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_title(f"unit ring, n*16 samples (n={n})")
    fig.tight_layout()
    return fig


@rt("/")
def home():
    return Div(
        H1("Geometry of Noise", cls="text-3xl font-bold mb-2"),
        H2("Plot pipeline smoke test", cls="text-xl text-gray-600 mb-6"),
        P(
            "Two cells run in Pyodide: ",
            "``doubled`` (scalar) and ``smoke_plot`` (matplotlib Figure). ",
            "Change ``n`` to drive both.",
            cls="mb-4",
        ),
        Div(
            Input(type="number", data_bind=n_sig, cls="border px-2 py-1 rounded"),
            Div("doubled = ", Div(data_text=doubled_sig, cls="inline font-mono"),
                cls="mt-2"),
            cls="p-4 border rounded bg-gray-50 mb-4",
        ),
        Div(id="output-content-smoke_plot", cls="p-4 border rounded bg-white min-h-[300px]"),
        n_sig,
        doubled_sig,
        cls="max-w-2xl mx-auto p-8",
    )
