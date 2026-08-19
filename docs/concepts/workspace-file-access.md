---
summary: "Workspace file access: which files each sender role can ask the agent to read or edit, and how context (DM vs group) affects those rules"
read_when:
  - You want to understand which workspace files a user can ask the agent to edit
  - You are setting up owner vs non-owner file editing rules
  - You want to know how DM (1:1) access differs from group space access for workspace files
title: "Workspace file access by role"
sidebarTitle: "Workspace file access"
---

This page explains which workspace files each type of sender can ask the agent to read or write, and how the DM (1:1) vs group context changes what is allowed.

## Sender roles

OpenClaw recognises three sender roles, evaluated in order:

| Role                    | How it is set                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Owner**               | Sender matches `commands.ownerAllowFrom` (or channel-native owner identity). Owner-only commands and tools are enabled. |
| **Authorized sender**   | Sender is in the channel `allowFrom` list. Standard commands and tools are enabled.                                     |
| **Unauthorized sender** | Everyone else. Commands are silently dropped or return a rejection reply depending on the surface.                      |

Owner status is opt-in and fail-closed. An unknown or unresolved sender is never treated as an owner.

## Workspace files and who can edit them

The workspace contains several standard files. Their editing rules differ by role and context:

| File                   | Purpose                                               | Who should edit it                                                |
| ---------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| `AGENTS.md`            | Operating instructions, routing logic, behavior rules | **Owner only** — in a DM with the bot                             |
| `SOUL.md`              | Persona, tone, and boundaries                         | **Owner only** — in a DM with the bot                             |
| `IDENTITY.md`          | Agent name, vibe, emoji                               | **Owner only** — created/updated during bootstrap                 |
| `TOOLS.md`             | Local tool conventions and notes                      | **Owner only**                                                    |
| `HEARTBEAT.md`         | Heartbeat checklist                                   | **Owner only**                                                    |
| `USER.md`              | Who the user is and how to address them               | **Any authorized sender** — in a DM with the bot                  |
| `memory/YYYY-MM-DD.md` | Daily memory log                                      | Written automatically by the agent each session                   |
| `MEMORY.md`            | Curated long-term memory                              | Written automatically by the agent; load only in private sessions |
| `skills/`              | Workspace-scoped skills                               | **Owner only** — install via ZIP upload or `/skills`              |

<Note>
These rules are behavioral conventions enforced through the agent's AGENTS.md instructions and the `commands.ownerAllowFrom` config. The platform does not hard-block individual file writes at the OS level — the agent is expected to follow these rules as part of its operating instructions.
</Note>

## DM (1:1) vs group context

The context of the conversation determines what editing is appropriate:

### Direct message (1:1 with the bot)

- **Owner in a DM**: full access. The owner can ask the agent to read or rewrite any workspace file — `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `TOOLS.md`, `HEARTBEAT.md`, `USER.md`, and skills. This is the intended path for configuring the agent.
- **Non-owner authorized sender in a DM**: can ask the agent to update `USER.md` with information about themselves. Should not be able to modify `AGENTS.md`, `SOUL.md`, or other agent-identity files.

### Group space

- **Owner in a group**: owner-only tools (`cron`, `gateway`, `nodes`) and commands (`/config`, `/allowlist`, `/diagnostics`, `/export-trajectory`) are available. Workspace file edits should still be done via a DM, not in a shared group space, to avoid accidental exposure of agent-identity files.
- **Non-owner authorized sender in a group**: no workspace file editing. Group sessions use the room-scoped workspace (`rooms/<roomId>/`) for file uploads and memory, not the agent's main workspace. Regular users interact with the agent through chat — they do not get access to agent configuration files.
- **Unauthorized sender in a group**: commands are dropped silently. No file access.

## Owner-only tools

Beyond file access, owner status gates several platform tools entirely. Non-owners never see these tools in the agent's tool list:

| Tool group | What it controls                                    |
| ---------- | --------------------------------------------------- |
| `cron`     | Create, edit, delete, and run scheduled jobs        |
| `gateway`  | Reload config, restart the gateway, run diagnostics |
| `nodes`    | Invoke connected iOS/Android/Mac nodes              |

These are filtered at the tool-policy layer (`applyOwnerOnlyToolPolicy`) before the agent turn runs. A non-owner sender physically cannot trigger these tools even if they ask.

## Owner-only slash commands

The following commands require `senderIsOwner` to be true, regardless of channel:

- `/config` — view or patch `openclaw.json`
- `/allowlist add|remove` — edit channel authorization lists
- `/diagnostics` — export a support bundle
- `/export-trajectory` — export session trajectory
- `/mcp` — manage MCP server connections

Commands gated only by authorized sender (not owner-only):

- `/btw` — add a note to the session
- `/bash` — run a shell command (exec approval still required)
- `/models` — view or switch models
- `/stop` / `/abort` — stop the current run

## Configuring the owner

Set `commands.ownerAllowFrom` in `~/.openclaw/openclaw.json`:

```json5
{
  commands: {
    ownerAllowFrom: ["telegram:123456789", "webex:user@example.com"],
  },
}
```

Per-channel owner restriction (requires explicit owner identity, not just allowlist membership):

```json5
{
  commands: {
    requireOwnerIdentityForOwnerCommands: true,
  },
}
```

## Enforcing file rules in AGENTS.md

Because file-write restrictions are behavioral (not OS-enforced), state them explicitly in the agent's `AGENTS.md` so the agent refuses inappropriate requests:

```markdown
## File Access Rules

- Only the owner (in a 1:1 DM) may ask you to edit AGENTS.md, SOUL.md,
  IDENTITY.md, TOOLS.md, HEARTBEAT.md, or the skills/ directory.
- Any authorized user in a 1:1 DM may ask you to update USER.md with
  information about themselves.
- In a group space, do not edit any workspace files unless the sender is
  the owner and the change is clearly scoped to shared project files.
- Never mix data or memory between different users or rooms.
```

## Related

- [Agent workspace](https://github.com/sntilak1/runtime_agent/blob/main/docs/concepts/agent-workspace.md) — workspace file layout and backup
- [Slash commands](https://github.com/sntilak1/runtime_agent/blob/main/docs/tools/slash-commands.md) — full command reference with owner/authorized gates
- [Groups](https://github.com/sntilak1/runtime_agent/blob/main/docs/channels/groups.md) — group access control, tool restrictions by sender
- [Sandboxing](https://github.com/sntilak1/runtime_agent/blob/main/docs/gateway/sandboxing.md) — hard OS-level workspace isolation for untrusted sessions
- [Gateway configuration](https://github.com/sntilak1/runtime_agent/blob/main/docs/gateway/config-agents.md) — `agents.defaults` and tool policy config
