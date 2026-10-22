# 0029. Reviewer always uses the installed autoreview skill through a dedicated P2 tool

## Status

Accepted at the user's request. Extends [0027](0027-standing-agents.md) and
[0028](0028-remote-machines-over-ssh.md). Existing persisted names and protocol remain unchanged; the new extension,
tool and kit name `autoreview` are additive and frozen.

## Context

The user wants every Reviewer's code review to use their `/autoreview` skill, always through P2. The host does not
autoload ordinary Pi skills. Reviewer currently has read/browser tools, with no way to invoke the skill's helper.
Granting the coding kit would also grant arbitrary commands and file edits; the user chose a dedicated tool instead.

## Decision

- Add the `autoreview` kit to the default Reviewer. Its role text, and its subs', require reading the installed skill
  and using the tool for every code review. Custom instructions do not remove this policy. Custom rosters still
  replace the default and must explicitly include the kit.
- The tool invokes only the user's installed skill helper, not a copied or repository-owned version. It accepts
  explicit Git scope and evidence/context, but no commands, raw flags, output paths, priority or isolation overrides.
  Every invocation fixes `--max-priority P2` (P0–P2).
- Start with Codex and explicitly pin `~/.local/share/autoreview/codex-cli/bin/codex`, rather than inheriting an older
  extension's `CODEX_BIN`. Pi is the only selectable availability fallback, after a diagnosed and reported Codex
  failure; never switch to evade isolation, safety, rate limits, slow progress or findings. This fallback rule is a
  role/tool instruction, not an automatic retry or an availability classifier.
- Reuse the existing guarded bash implementation internally. Reviewer receives neither the `bash` tool nor editing
  tools. With machine routing, the same fixed command goes to the session's pinned machine through the existing
  connector grant, intent and result ledger. It never executes on the server instead of a workstation. No wire
  operation or protocol version change is needed.
- Treat the kit as local: `--no-tools` and `/tools off` remove it, including from old sessions and subs. A browser
  paired with `autoreview` is local-only, since the helper reads repository files. Messaging confinement remains as
  before: no coding kit means no messages to Coder or other teams.
- Preserve the canonical helper's Git capture, isolation, authentication controls, validation, output and exit codes.
  No automatic rerun after interruption (`replay: 'unsafe'`), no manual clean substitute for a missing, failed,
  filtered or incomplete review, and no protection bypass for credentials. The skill and its prerequisites must be
  installed on each execution machine; this change neither installs them nor deploys/restarts a host.

## Consequences

- The priority threshold is enforced by the tool; the requirement to use it for every code review is a persistent
  role instruction, not a semantic gate on arbitrary model replies.
- Reviewer retains its own model/effort. The installed helper chooses its review model and handles reviewer cleanup.
- Tests use faux models, fake helper invocations and a recording remote dispatcher; they make no paid reviewer calls.
- The host continues not to autoload other Pi resources. This is one explicit skill integration, not a general shell
  escape or a general skill loader.
