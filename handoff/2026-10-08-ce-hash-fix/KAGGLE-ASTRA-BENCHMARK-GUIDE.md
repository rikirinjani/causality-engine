# Kaggle Astra Benchmark Guide

## Overview

This guide walks through running GPT-6 Astra (or other models) on Kaggle Benchmarks to assess CE work. Based on the successful `review-ce-stack` task runs (v2-v4).

## Prerequisites

1. **Kaggle CLI installed**: `pip install kaggle` (version 2.2.3+), `pip install kaggle-benchmarks`
2. **Credentials configured**:
   ```bash
   kaggle benchmarks init -y --env-file <path>
   ```
   This generates API keys and sets `MODEL_PROXY_URL`, `LLM_DEFAULT`, etc. in `.env`.
3. **Model availability check**:
   ```bash
   kaggle benchmarks tasks models
   ```
   Look for `gpt-6-astra` in the slug list. If not present, check `kaggle auth`.

## Step 1: Build the Task File

Create a Python file with the benchmark task. Key structure:

```python
import base64, os
os.environ.setdefault("LLM_DEFAULT", "gpt-6-astra")
os.environ.setdefault("LLM_DEFAULT_JUDGE", "gpt-6-astra")
os.environ.setdefault("LLMS_AVAILABLE", "gpt-6-astra")

import kaggle_benchmarks as kbench

# Embed your content as base64 (see embed.py below)
SLICE_CONTENT = base64.b64decode("@@B64_CONTENT@@").decode("utf-8")

BASE = """You are a principal engineer... [prompt]"""

SECTIONS = [
    ("section-name", SLICE_CONTENT, "Your question here"),
]

SYNTH = """Synthesis prompt here..."""

@kbench.task(name="my-task", description="Task description")
def my_task(llm) -> dict:
    sections = {}
    errors = 0
    for key, body, ask in SECTIONS:
        try:
            with kbench.chats.new("sec_" + key):
                resp = llm.prompt(BASE + "\n\n" + body + "\n\n" + ask,
                                  extra_api_params={"max_tokens": 7000})
        except Exception as e:
            resp = "[ERROR] " + str(e)
            errors += 1
        sections[key] = resp
    
    # Synthesis
    try:
        with kbench.chats.new("synthesis"):
            verdict = llm.prompt(SYNTH + "\n\n" + digest[:15000],
                                 extra_api_params={"max_tokens": 9000})
    except Exception as e:
        verdict = "[SYNTHESIS ERROR] " + str(e)
        errors += 1
    
    # Output report
    report = build_report(sections, verdict)
    for p in ["output.md", "/kaggle/working/output.md"]:
        with open(p, "w", encoding="utf-8") as f:
            f.write(report)
        print(report)  # Logs capture stdout
    
    # Assertions (required for leaderboard)
    kbench.assertions.assert_true(errors == 0, expectation="all LLM calls succeeded")
    return {"errors": errors, "report_chars": len(report)}

_registry = getattr(kbench, "llms", None) or {}
_target = _registry.get("gpt-6-astra") or kbench.llm
run = my_task.run(llm=_target)
```

## Step 2: Embed Content (embed.py)

Use `embed.py` to base64-encode your dossier/web files into the task template:

```python
import base64, os, sys, ast

ROOT = os.path.dirname(os.path.abspath(__file__))
MAP = {
    "@@B64_CONTENT@@": ("dossier", "content.md"),
    # Add more as needed
}

tpl = open(os.path.join(ROOT, "task.template.py")).read()
for token, (sub, fname) in MAP.items():
    p = os.path.join(ROOT, sub, fname)
    data = open(p, "rb").read()
    b64 = base64.b64encode(data).decode("ascii")
    tpl = tpl.replace(token, b64)

with open(os.path.join(ROOT, "task.py"), "w") as f:
    f.write(tpl)

ast.parse(tpl)  # Verify valid Python
```

## Step 3: Push the Task

```bash
kaggle benchmarks tasks push <task-name> -f task.py
```

Example:
```bash
kaggle benchmarks tasks push review-ce-stack -f task_ce_review_v4.py
```

This creates/updates a task version. Note the task URL:
```
https://www.kaggle.com/benchmarks/tasks/<user>/<task-name>/N
```

## Step 4: Check Task Status

```bash
kaggle benchmarks tasks status <task-name>
```

Wait for status to change from `Running` → `Completed` (source processing).

## Step 5: Run with Astra

```bash
kaggle benchmarks tasks run <task-name> -m gpt-6-astra
```

The run is scheduled and executes server-side. Poll status:

```bash
kaggle benchmarks tasks status <task-name>
```

Look for `gpt-6-astra` row with status `Completed`.

## Step 6: Fetch Results

```bash
kaggle benchmarks tasks download <task-name> -m gpt-6-astra -o <output-dir> -f
```

Key files:
- `*_output.md` — the full review report
- `*_result.json` — structured result with tokens, cost, errors
- `*_run.json` — run metadata

## Common Issues & Fixes

### Issue: `Task is not ready to run (status: RUNNING)`
**Cause**: Task source is still processing after push.
**Fix**: Wait 30-60 seconds, then retry. Check status until `Completed`.

### Issue: `gpt-6-astra` not in model list
**Cause**: Proxy doesn't have the model registered.
**Fix**: 
```bash
kaggle benchmarks init -y --env-file .env
```
Then check `kaggle benchmarks tasks models` again.

### Issue: `FileNotFoundError: '/kaggle/src/...'`
**Cause**: Kaggle script kernels only upload `code_file`, not sibling files.
**Fix**: Base64-embed ALL supporting files (dossier slices, web snapshots) into `kernel.py`. Use `SESSIONS_DIR = "/kaggle/src"` for file resolution.

### Issue: `subprocess.Popen() got unexpected keyword argument 'timeout'`
**Cause**: `Popen` doesn't accept `timeout`; that's `subprocess.run`.
**Fix**: In streaming wrappers, use `p.wait()` without timeout, or implement timeout via thread/kill.

### Issue: UTF-16 patch encoding
**Cause**: Windows PowerShell `>` redirection writes UTF-16LE.
**Fix**: Always use UTF-8 for patches and text files. Convert with Python:
```python
text = open("file.patch", encoding="utf-16-le").read()
open("file.patch", "w", encoding="utf-8").write(text)
```

### Issue: `.env` proxy key expired
**Cause**: `MODEL_PROXY_EXPIRY_TIME` in `.env` has passed.
**Fix**: Re-run `kaggle benchmarks init -y --env-file .env` to refresh credentials.

## Persistence Test Example

For testing persistence/reload equivalence (Astra top fix #1):

```python
# In test file
from core.persistence import createCheckpoint, serializeCheckpoint, deserializeCheckpoint, restoreCheckpoint
from core.world import attachEngine

# 1. Create world, advance N ticks
world = createWorld(makeConfig({seed}), engine)
advance(world, engine, N)

# 2. Checkpoint
env = createCheckpoint(world, "test")
serialized = serializeCheckpoint(env)

# 3. Deserialize and restore
result = deserializeCheckpoint(serialized)
restore_result = restoreCheckpoint(result.value)
loaded_world = restore_result.value.world

# 4. Rebind engine (critical for RNG)
engine2 = createEngine()
attachEngine(loaded_world, engine2)

# 5. Continue and compare
advance(loaded_world, engine2, M)
assert stateHash(world) == stateHash(loaded_world)
assert traceHash(world) == traceHash(loaded_world)
```

## Cost Tracking

Monitor token usage and cost:
```json
{
  "agent_info": {
    "n_input_tokens": 51975,
    "n_output_tokens": 14213,
    "cost_usd": 1.2304
  }
}
```

GPT-6 Astra typically costs $0.70-1.50 per full review run (6-7 sections).

## Quick Reference Commands

```bash
# Initialize
kaggle benchmarks init -y --env-file .env

# List available models
kaggle benchmarks tasks models

# Push task
kaggle benchmarks tasks push <name> -f task.py

# Check status
kaggle benchmarks tasks status <name>

# Run with specific model
kaggle benchmarks tasks run <name> -m gpt-6-astra

# Download results
kaggle benchmarks tasks download <name> -m gpt-6-astra -o ./out -f

# View logs
kaggle benchmarks tasks log <name> -m gpt-6-astra
```
