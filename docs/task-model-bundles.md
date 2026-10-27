# Portable task models

A task-specific classifier ships as a `.zip`, a ZIP container renamed to `.understudy-model`, or an unpacked directory ending in `.understudy-model`. The Understudy Desktop drag-and-drop installer (which extracted, verified, and installed packages under `~/.understudy/models/task-models/`) was retired with the app; see [`desktop-deprecation.md`](desktop-deprecation.md). The bundle format below is unchanged, and the CLI consumes an unpacked bundle directly by path: queue a run with `orchestra runs queue --benchmark <dir> --local-arm <label>=<path>` and run it with `orchestra runs execute --benchmark <dir>`.

The package contains the small task-specific parts, not another copy of the base model:

```text
example.understudy-model/
├── manifest.json
├── taxonomy.json
└── model/
    ├── adapter/
    │   ├── adapter_config.json
    │   └── adapters.safetensors
    └── classifier-head.safetensors
```

`manifest.json` uses `understudy.task_model.v1`. It identifies the required MLX-VLM base model, the adapter and classifier head, accepted input columns, the prompt used during training, the taxonomy scorer, and a SHA-256 plus byte count for every member. Paths must be relative and symlinks are rejected.

## Test a model

1. Open **Trained models** and drag in the downloaded `.understudy-model` or `.zip`; no manual extraction is required.
2. If its base model is not on the Mac yet, leave Understudy open while the resumable download completes.
3. Choose the installed package, enter an example, and run it locally.
4. For repeatable scoring, import a CSV or JSONL eval. Each row needs an input and expected answer; the expected answer may be either the detailed taxonomy label id or its exact label text.

The runner loads the local base, applies the adapter and classifier head, returns the top choices, and stores each right or wrong answer in the normal evaluation results. Model packages are data artifacts; they do not carry executable Python or shell code.
