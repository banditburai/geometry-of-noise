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


if __name__ == "__main__":
    app.run()
