"""The closed improvement loop (07-improvement-loop.md) — read-only research-on-the-research.

Two pieces, both observation-side, neither able to touch a live config:

* :mod:`.postmortem` — post-mortems the run artifacts we already produce (desk-telemetry JSONs)
  into cross-run findings and **bounded, evidence-cited knob suggestions** that land in an
  operator-gated queue (``data/postmortem/queue.jsonl``). Accepting a suggestion records a
  decision; a human applies it by hand in the next run's flags. Knob moves only, inside declared
  bands — mechanism changes remain human work (§07 constraint 1).
* :mod:`.trial` — the trial-runner discipline: incumbent vs challenger on ONE knob, same dataset /
  seed / budget, with the keep/revert criterion **pre-registered in the spec** and applied
  mechanically to both arms' outputs. The verdict is a recommendation record
  (``data/postmortem/trials.jsonl``), never an auto-apply.

Deliberately no re-exports: both modules are CLI entry points (``python -m ...``), and importing
them here would shadow ``runpy``'s module initialization (the double-import RuntimeWarning).
"""
