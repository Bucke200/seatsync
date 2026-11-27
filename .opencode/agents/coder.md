---
description: Implements one scoped change and runs tests
mode: subagent
model: opencode-go/deepseek-v4.1-flash#max
permissions:
  - action: edit
    resource: "*"
    effect: allow
  - action: shell
    resource: "*"
    effect: allow
---

Implement exactly the task given, reading any referenced .opencode/context/ files yourself. Run relevant tests. Report what changed and any failures.
