"""Run chosen sections of a Colab notebook as a plain script.

The NHL notebooks stay the single source of the model code. This module executes
their code cells in order, in one shared namespace, with four changes only:

  * Colab-only lines are dropped (Drive mount, `!pip`, `%magics`).
  * The Drive folder ('/content/drive/MyDrive') becomes the server's data folder.
  * Named top-level settings can be overridden (`overrides={"N_TRIALS": 5}`).
  * A cell's last expression is printed, as Jupyter would show it.

Sections are the notebook's own numbered headings ("## 8. Hyperparameter tuning").
Asking for a section the notebook does not have, or overriding a setting that is not
there, is an error: it means the notebook's layout changed and nhl/run.py must follow.
"""
import ast
import json
import linecache
import re
import time
import traceback
from pathlib import Path

DRIVE = "/content/drive/MyDrive"
HEADING = re.compile(r"\s*##\s+(\d+)\.\s*(.*)")


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def _show(value):
    """Print a value the way a notebook would display it."""
    if value is None:
        return
    try:
        import pandas as pd
        if isinstance(value, pd.DataFrame):
            print(value.to_string(max_rows=40, max_cols=30))
            return
        if isinstance(value, pd.Series):
            print(value.to_string(max_rows=40))
            return
    except ImportError:
        pass
    print(repr(value))


def sections(nb_path):
    """[(number, title, [(cell_index, source), ...]), ...] in notebook order."""
    nb = json.loads(Path(nb_path).read_text())
    out, cur = [], None
    for i, cell in enumerate(nb["cells"]):
        src = "".join(cell["source"])
        if cell["cell_type"] == "markdown":
            m = HEADING.match(src)
            if m:
                cur = (int(m.group(1)), m.group(2).strip(), [])
                out.append(cur)
        elif cell["cell_type"] == "code" and cur is not None:
            cur[2].append((i, src))
    return out


def _clean(src, data_dir):
    """Blank out Colab-only lines (line numbers are kept) and point DATA_DIR at the server."""
    if src.lstrip().startswith("%%"):
        return ""                                   # a whole-cell magic such as %%writefile
    lines = []
    for line in src.split("\n"):
        s = line.lstrip()
        colab = s.startswith(("!", "%")) or "google.colab" in line or "drive.mount(" in line
        lines.append("" if colab else line)
    return "\n".join(lines).replace(DRIVE, str(data_dir))


def _target_key(node):
    """'H' for `H = 1`; 'CURRENT, SEASON_START' for a tuple assignment; None otherwise."""
    if not (isinstance(node, ast.Assign) and len(node.targets) == 1):
        return None
    t = node.targets[0]
    if isinstance(t, ast.Name):
        return t.id
    if isinstance(t, ast.Tuple) and all(isinstance(e, ast.Name) for e in t.elts):
        return ", ".join(e.id for e in t.elts)
    return None


def _apply_overrides(src, overrides, used):
    """Replace top-level `NAME = ...` statements whose name is in `overrides`."""
    if not overrides:
        return src
    lines = src.split("\n")
    for node in reversed(ast.parse(src).body):       # bottom-up keeps earlier line numbers valid
        key = _target_key(node)
        if key in overrides:
            span = node.end_lineno - node.lineno + 1
            lines[node.lineno - 1:node.end_lineno] = [f"{key} = {overrides[key]!r}"] + [""] * (span - 1)
            used.add(key)
    return "\n".join(lines)


def _exec_cell(src, name, ns):
    """Run one cell; print the value of a trailing expression."""
    linecache.cache[name] = (len(src), None, src.splitlines(True), name)   # so tracebacks show the line
    tree = ast.parse(src, filename=name)
    last = tree.body[-1] if tree.body and isinstance(tree.body[-1], ast.Expr) else None
    if last is not None:
        tree.body = tree.body[:-1]
    exec(compile(tree, name, "exec"), ns)
    if last is not None:
        _show(eval(compile(ast.Expression(last.value), name, "eval"), ns))


def run(nb_path, want, data_dir, overrides=None, hooks=None, tolerant=(), ns=None):
    """Execute the code cells of the sections in `want`, in notebook order.

    overrides  {"NAME": value} for top-level settings anywhere in the sections run.
    hooks      {("before" | "after", section): fn(ns)}.
    tolerant   sections whose errors are logged and skipped (diagnostics only).
    Returns the namespace, so callers can use what the notebook defined.
    """
    nb_path, overrides, hooks = Path(nb_path), dict(overrides or {}), hooks or {}
    ns = {"__name__": "__nb__", "display": _show} if ns is None else ns
    try:                                             # wide tables print whole in the log, as they do in Colab
        import pandas as pd
        pd.set_option("display.width", 250, "display.max_columns", 60, "display.max_rows", 200)
    except ImportError:
        pass
    have = {num: (title, cells) for num, title, cells in sections(nb_path)}
    missing = [s for s in want if s not in have]
    if missing:
        raise SystemExit(f"{nb_path.name}: no section(s) {missing}. The notebook's headings changed; "
                         f"update the section lists in nhl/run.py.")
    used = set()
    for num in sorted(set(want)):
        title, cells = have[num]
        log(f"--- {nb_path.stem} section {num}: {title}")
        t0 = time.time()
        if ("before", num) in hooks:
            hooks[("before", num)](ns)
        for idx, raw in cells:
            src = _apply_overrides(_clean(raw, data_dir), overrides, used)
            if not src.strip():
                continue
            name = f"<{nb_path.stem} section {num}, cell {idx}>"
            try:
                _exec_cell(src, name, ns)
            except Exception:
                if num not in tolerant:
                    raise
                log(f"section {num} cell {idx} failed (diagnostic only, continuing):")
                traceback.print_exc()
        if ("after", num) in hooks:
            hooks[("after", num)](ns)
        log(f"    section {num} done in {time.time() - t0:.0f}s")
    unused = set(overrides) - used
    if unused:
        raise SystemExit(f"{nb_path.name}: setting(s) {sorted(unused)} not found in sections {sorted(set(want))}. "
                         f"Check the name; it must be a top-level `NAME = value` line.")
    return ns
