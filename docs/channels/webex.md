---
summary: "Webex channel: setup, file workspaces, DM project selector, and state directory layout"
read_when:
  - You want to understand the Webex channel's on-disk directory structure
  - You are setting up or troubleshooting the Webex plugin
  - You want to know where uploaded files, session transcripts, or agent memory are stored
title: "Webex channel"
sidebarTitle: "Webex channel"
---

## State directory layout

All runtime state lives under `~/.openclaw/` (or the path set by `OPENCLAW_CONFIG_DIR`).
The tree below shows a two-agent deployment where both agents are active in separate
Webex rooms.

```
~/.openclaw/
│
├── openclaw.json                        # gateway config — agents, channels, session scope
│
├── identity/
│   ├── device.json                      # this gateway's device identity
│   └── device-auth.json
│
├── devices/
│   ├── paired.json                      # paired companion apps (iOS / Android / Mac)
│   └── pending.json
│
├── memory/
│   └── main.sqlite                      # FTS / vector search index (rebuilt from workspace memory files)
│
├── cron/
│   └── jobs.json
│
├── logs/
│   └── config-audit.jsonl
│
├── agents/
│   ├── main/                            # first agent ("main")
│   │   ├── agent/
│   │   │   ├── auth-profiles.json       # model provider credentials
│   │   │   └── models.json              # per-agent model overrides
│   │   └── sessions/
│   │       ├── sessions.json            # session state, one key per conversation
│   │       └── <uuid>.jsonl             # conversation transcript (one file per session)
│   │
│   └── agent2/                          # second agent ("agent2")
│       ├── agent/
│       │   ├── auth-profiles.json
│       │   └── models.json
│       └── sessions/
│           ├── sessions.json
│           └── <uuid>.jsonl
│
├── workspace/                           # first agent's file workspace
│   ├── SOUL.md                          # persona / system prompt
│   ├── IDENTITY.md
│   ├── USER.md
│   ├── AGENTS.md
│   ├── BOOTSTRAP.md
│   ├── HEARTBEAT.md
│   ├── TOOLS.md
│   ├── MEMORY.md                        # long-term memory index (human-readable)
│   ├── memory/
│   │   └── *.md                         # individual long-term memory entries
│   └── skills/
│       └── <skill-name>/
│           └── SKILL.md
│
├── workspace-agent2/                    # second agent's file workspace
│   ├── SOUL.md
│   ├── IDENTITY.md
│   ├── USER.md
│   ├── MEMORY.md                        # agent2's own long-term memory (separate from agent1)
│   ├── memory/
│   │   └── *.md
│   └── skills/
│
├── rooms/                               # Webex per-room workspaces (group spaces and DMs)
│   ├── <webex-roomId-A>/                # one directory per Webex space or DM room
│   │   ├── manifest.json                # file index: name, MIME type, sender, date, size
│   │   ├── files/
│   │   │   ├── project-plan.docx
│   │   │   └── budget.xlsx
│   │   └── memory/                      # room-scoped long-term memory (isolated per room)
│   │       └── 2026-05-06-project-kickoff.md
│   │
│   └── <webex-roomId-B>/
│       ├── manifest.json
│       ├── files/
│       │   └── requirements.pdf
│       └── memory/
│           └── 2026-05-07-requirements-review.md
│
└── media/
    └── inbound/                         # short-lived inbound file staging (2-minute TTL)
        └── <uuid>-filename.docx
```

## Key concepts

### Session keys

Each Webex conversation maps to a session key stored in
`agents/<agentId>/sessions/sessions.json`. The format is:

- Direct message: `agent:main:webex:direct:<roomId>`
- Group space: `agent:main:webex:group:<roomId>`

### Per-agent workspaces

Each agent has its own workspace directory containing its `SOUL.md`, `MEMORY.md`,
memory files, and skills. Two agents never share a workspace, so their personas and
long-term memories are fully isolated.

The `memory/main.sqlite` search index is built by scanning the workspace memory files.
Each agent's workspace is the authoritative source; the SQLite file is a derived index.

### Per-room file workspaces (`rooms/`)

When a file is shared in a Webex group space, it is saved to
`rooms/<roomId>/files/` using a latest-wins-per-filename policy. A
`manifest.json` alongside the files records metadata for every file ever shared
in that room.

At the start of each agent turn the manifest is injected into the agent's context
so it knows which project files are available and where they are on disk.

This workspace belongs to the **room**, not the agent. If two agents are both
members of the same Webex space they share the same `rooms/<roomId>/` directory.

### Room-scoped memory (`rooms/<roomId>/memory/`)

Long-term memory is scoped to each room (both group spaces and DMs). When a user
triggers `/new` or `/reset`, the session-memory hook writes the conversation
summary to `rooms/<roomId>/memory/` instead of the shared agent workspace.

At the start of each turn, any existing room memory files are read and injected
into the agent's context as untrusted background notes — the same format as
agent workspace startup context.

This means:

- A user's DM conversation history never appears in another user's DM.
- Group space A's accumulated knowledge never bleeds into group space B.
- The agent's `workspace/memory/` is never written to or read from during
  Webex turns; it remains available only for non-Webex sessions.

### DM project selector

When a user sends a direct message, the channel checks whether the bot and the
user share any group spaces that have a non-empty file workspace. If exactly one
shared workspace is found it is selected automatically. If multiple are found the
user is asked to choose by number, and the selection is held in memory for five
minutes while the conversation continues.

### Inbound file staging (`media/inbound/`)

Files attached to any inbound message are first downloaded here with a
content-type resolved from the filename extension (Webex reports all file types
as `text/plain`). These staged copies have a two-minute TTL and are used only
for the current agent turn. Persistent storage uses the `rooms/` workspace
described above.
