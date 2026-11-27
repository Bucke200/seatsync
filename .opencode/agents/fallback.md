---
description: Retries tasks that coder or reviewer failed on
mode: subagent
model: opencode-go/minimax-m3#thinking
permissions:
  - action: edit
    resource: "*"
    effect: allow
  - action: shell
    resource: "*"
    effect: allow
---

Complete the task from scratch using the notes on why the earlier attempt failed, reading any referenced .opencode/context/ files yourself.
