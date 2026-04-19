"""Hello-world spike: verify stardust+starimo+Pyodide reactivity before real notebook work.

Pipeline check:
  1. `uv run stardust build ./app.py -o dist`
  2. `python -m http.server -d dist 8000`
  3. Open http://localhost:8000 — change the input, see the doubled value update live.

If reactivity flows (Python `@cell` computes in Pyodide, Datastar signal patch lands in DOM),
the infra is ready for real paper content. If not, bug-hunt from here.
"""

from starhtml import Div, H1, H2, Input, P, Script, star_app
from starhtml.datastar import Signal
from starimo import cell

app, rt = star_app(
    title="Geometry of Noise — spike",
    hdrs=(Script(src="https://cdn.tailwindcss.com"),),
)

n_sig = Signal("n", 0)
doubled_sig = Signal("doubled", 0)


@cell
def doubled(n: int = 0):
    return n * 2


@rt("/")
def home():
    return Div(
        H1("Geometry of Noise", cls="text-3xl font-bold mb-2"),
        H2("Pipeline spike", cls="text-xl text-gray-600 mb-6"),
        P(
            "Infrastructure check before notebook content. ",
            "The value below is computed by a Python ",
            "``@cell`` running in Pyodide.",
            cls="mb-4",
        ),
        Div(
            Input(
                type="number",
                data_bind=n_sig,
                cls="border px-2 py-1 rounded",
            ),
            Div(
                "doubled = ",
                Div(data_text=doubled_sig, cls="inline font-mono"),
                cls="mt-2",
            ),
            cls="p-4 border rounded bg-gray-50",
        ),
        # Signal declarations go on any containing element — starhtml collects
        # all referenced Signal() usages and emits `data-signals:NAME__ifmissing`
        # attributes per the working starimo examples.
        n_sig,
        doubled_sig,
        cls="max-w-2xl mx-auto p-8",
    )
