---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: example-project
  required_labels:
    - codex
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Canceled
polling:
  interval_ms: 30000
workspace:
  root: ./workspaces
hooks:
  after_create: |
    git clone https://github.com/example/example.git .
  before_run: |
    git fetch --all --prune
  timeout_ms: 60000
agent:
  max_concurrent_agents: 2
  max_turns: 20
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    in progress: 1
codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: danger-full-access
  turn_sandbox_policy:
    type: dangerFullAccess
---

You are the coding agent assigned to {{ issue.identifier }}: {{ issue.title }}.

Issue description:
{{ issue.description | default: "(No description provided)" }}

Work only in the assigned workspace. Inspect the repository before editing, implement the issue, run focused validation, and use the issue tracker tools available in your environment for status updates and handoff.
