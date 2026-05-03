# Webex Multi-Agent Setup

This guide walks through setting up two isolated OpenClaw agents (`program-management` and `trainer`) on an EC2-hosted Docker deployment, each backed by its own Webex bot and reachable via 1:1 DMs or @mention in Webex rooms.

## Prerequisites

You need **two separate Webex Bot tokens** — one per agent identity.

1. Go to https://developer.webex.com/my-apps
2. Click **Create a New App** → **Create a Bot**
3. Fill in the bot name, username, and icon for each bot
4. Copy the **Bot Access Token** shown after creation

You will need:
- `<PM_BOT_TOKEN>` — token for the program-management bot
- `<TRAINER_BOT_TOKEN>` — token for the trainer bot

All commands below are run from the EC2 host and exec into the CLI container.

---

## Step 1 — Register the two Webex bot accounts

```bash
# Program-management bot (account id: "program-management")
docker exec runtime_agent-openclaw-cli-1 node dist/index.js channels add \
  --channel webex \
  --account program-management \
  --bot-token <PM_BOT_TOKEN>

# Trainer bot (account id: "trainer")
docker exec runtime_agent-openclaw-cli-1 node dist/index.js channels add \
  --channel webex \
  --account trainer \
  --bot-token <TRAINER_BOT_TOKEN>
```

## Step 2 — Create the two agents

```bash
# Create program-management agent
docker exec runtime_agent-openclaw-cli-1 node dist/index.js agents add program-management \
  --workspace /home/node/.openclaw/workspace/program-management \
  --non-interactive

# Create trainer agent
docker exec runtime_agent-openclaw-cli-1 node dist/index.js agents add trainer \
  --workspace /home/node/.openclaw/workspace/trainer \
  --non-interactive
```

## Step 3 — Bind each agent to its Webex account

```bash
# Route program-management Webex bot → program-management agent
docker exec runtime_agent-openclaw-cli-1 node dist/index.js agents bind \
  --agent program-management \
  --bind webex:program-management

# Route trainer Webex bot → trainer agent
docker exec runtime_agent-openclaw-cli-1 node dist/index.js agents bind \
  --agent trainer \
  --bind webex:trainer
```

## Step 4 — Restart the gateway

```bash
docker restart runtime_agent-openclaw-gateway-1
```

## Step 5 — Verify

```bash
# Check both agents are listed with their bindings
docker exec runtime_agent-openclaw-cli-1 node dist/index.js agents list --bindings

# Check both Webex accounts are active and reachable
docker exec runtime_agent-openclaw-cli-1 node dist/index.js channels status --probe
```

---

## How Webex interaction works

| Scenario | Behaviour |
|---|---|
| User DMs the bot 1:1 | Bot responds to every message (no @mention needed) |
| Bot added to a Webex room | Bot only responds when **@mentioned** (default `groupPolicy: mention`) |

The default group policy (`mention`) is the correct behaviour for shared rooms — users must @mention the bot name for it to respond, which allows both bots to coexist in the same room without interfering with each other.

Each bot has its own distinct display name, avatar, and Webex identity, so users always know which agent they are talking to.
