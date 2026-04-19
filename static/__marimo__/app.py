"""Auto-generated marimo notebook from starimo cells."""

import marimo

__generated_with = "stardust"
app = marimo.App()

@app.cell
def __():
    """Initialize frontend signal values."""
    n = 0
    return (n,)

@app.cell
def __(n=0):
    doubled = n * 2
    return (doubled,)

@app.cell
def __(n=8):
    """One-off smoke test: returns a Figure that should render as an inline PNG."""
    rng = np.random.default_rng(0)
    theta = np.linspace(0, 2 * np.pi, max(int(n), 4) * 16)
    r = 1.0 + 0.05 * rng.standard_normal(theta.shape)
    x, y = (r * np.cos(theta), r * np.sin(theta))
    fig, ax = plt.subplots(figsize=(3.5, 3.5), dpi=110)
    ax.plot(x, y, lw=0.8, color='black')
    ax.set_aspect('equal')
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_title(f'unit ring, n*16 samples (n={n})')
    fig.tight_layout()
    smoke_plot = fig
    return (smoke_plot,)


if __name__ == "__main__":
    app.run()
