# Deploying OpenClaw on Amazon Linux EC2 via Docker (SSM-only)

This guide deploys the OpenClaw gateway in Docker on an Amazon Linux EC2 instance that is accessible only via AWS SSM (no SSH). You will use SSM port forwarding to reach the web UI from your laptop.

## Prerequisites

**EC2 instance**

- Amazon Linux 2023 (or Amazon Linux 2)
- Instance profile with the following policies attached:
  - `AmazonSSMManagedInstanceCore` (for SSM access)
  - `AmazonBedrockFullAccess` (or a custom policy — see Step 5)
- At least 4 GB RAM (build step) and 20 GB disk
- Outbound internet access via NAT gateway (required for Bedrock API calls and package downloads)
- IMDSv2 hop limit set to **2** (required for Docker containers to reach the instance metadata service — see Step 5)

**Your laptop**

- AWS CLI v2 installed and configured (`aws configure`)
- AWS Session Manager plugin installed: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html

---

## Step 1 — Install Docker and Git on the EC2

Connect via SSM:

```bash
aws ssm start-session --target <instance-id>
```

Then install dependencies:

```bash
# Amazon Linux 2023
sudo dnf install -y docker git

# Amazon Linux 2 (use yum instead)
# sudo yum install -y docker git

sudo systemctl enable --now docker
sudo usermod -aG docker $USER

# Re-attach your session so the group change takes effect
exit
```

Reconnect and verify:

```bash
aws ssm start-session --target <instance-id>
docker info
```

---

## Step 2 — Clone the repo

```bash
git clone https://github.com/sntilak1/runtime_agent.git
cd runtime_agent
```

---

## Step 3 — Configure environment

Generate a strong gateway token:

```bash
openssl rand -hex 32
```

Create a `.env` file in the repo root:

```bash
cat > .env << 'EOF'
# Gateway shared secret — paste the token from the openssl command above
OPENCLAW_GATEWAY_TOKEN=your-generated-token-here

# Bind to all interfaces so Docker bridge networking can reach the gateway
OPENCLAW_GATEWAY_BIND=lan

# AWS region for Bedrock (must match where Claude Sonnet 4.6 is available)
AWS_REGION=us-east-1

# Timezone (optional)
OPENCLAW_TZ=UTC
EOF
```

Then add `AWS_REGION` to the `environment` block in `docker-compose.yml` so the container inherits it:

```yaml
environment:
  AWS_REGION: ${AWS_REGION:-us-east-1}
```

> **Security note:** The gateway binds to `0.0.0.0` inside the container, but the EC2 security group should block port 18789 from the internet. Access is only via SSM port forwarding from your laptop.

---

## Step 4 — Build and start the container

The first build downloads Node.js packages and compiles the TypeScript source. On a `t3.medium` this takes around 10–15 minutes.

```bash
# Build the Docker image from source
docker build -t openclaw:local .

# Run onboarding (creates ~/.openclaw config inside the container volume)
docker compose run --rm --no-deps --entrypoint node openclaw-gateway \
  dist/index.js onboard --mode local --no-install-daemon

# Apply required gateway config for LAN binding
docker compose run --rm --no-deps --entrypoint node openclaw-gateway \
  dist/index.js config set --batch-json \
  '[{"path":"gateway.bind","value":"lan"},{"path":"gateway.mode","value":"local"}]'

# Start the gateway
docker compose up -d openclaw-gateway
```

Confirm it is healthy:

```bash
docker compose ps
docker compose logs openclaw-gateway --tail 30
```

You should see a line like:

```
openclaw: gateway listening on 0.0.0.0:18789
```

---

## Step 5 — Configure AWS Bedrock as the AI provider

The EC2 instance role is used for authentication — no API keys are needed. The
AWS SDK inside the container fetches short-lived credentials from the instance
metadata service (IMDS) automatically.

### 5a — Allow Docker containers to reach IMDS

By default, IMDSv2 on newer EC2 instances has a hop limit of 1, which blocks
Docker bridge-networked containers. Run this **once** from your laptop:

```bash
aws ec2 modify-instance-metadata-options \
  --instance-id <instance-id> \
  --http-put-response-hop-limit 2 \
  --http-endpoint enabled
```

### 5b — IAM permissions

The instance role needs at minimum:

```json
{
  "Effect": "Allow",
  "Action": [
    "bedrock:InvokeModel",
    "bedrock:InvokeModelWithResponseStream",
    "bedrock:ListFoundationModels",
    "bedrock:ListInferenceProfiles"
  ],
  "Resource": "*"
}
```

Or attach the AWS-managed policy `AmazonBedrockFullAccess` to the instance role.

### 5c — Enable Bedrock discovery in OpenClaw config

Run the following **after** `docker compose up -d openclaw-gateway`:

```bash
# Enable the Bedrock plugin and opt in to IMDS-based discovery
docker compose run --rm openclaw-cli config set --batch-json '[
  {"path":"plugins.entries.amazon-bedrock.enabled","value":true},
  {"path":"plugins.entries.amazon-bedrock.config.discovery.enabled","value":true},
  {"path":"plugins.entries.amazon-bedrock.config.discovery.region","value":"us-east-1"}
]'

# Set the default model to Claude Sonnet 4.6 via the global inference profile
docker compose run --rm openclaw-cli config set \
  agents.defaults.model \
  "amazon-bedrock/us.anthropic.claude-sonnet-4-6-20250514-v1:0"

docker compose restart openclaw-gateway
```

> **Global inference profile ID:** `us.anthropic.claude-sonnet-4-6-20250514-v1:0` is the
> US cross-region (global) inference profile. AWS routes calls across US regions
> automatically for higher availability and throughput. If AWS has issued a
> different ID in your account you can verify with:
>
> ```bash
> aws bedrock list-inference-profiles --query \
>   "inferenceProfileSummaries[?contains(inferenceProfileId,'claude-sonnet-4-6')]"
> ```

### 5d — Verify model discovery

```bash
docker compose run --rm openclaw-cli models list | grep sonnet-4-6
```

You should see `amazon-bedrock/us.anthropic.claude-sonnet-4-6-20250514-v1:0` in the list.

---

## Step 6 — SSM port forwarding from your laptop

Run this on your **laptop** (not the EC2):

```bash
aws ssm start-session \
  --target <instance-id> \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["18789"],"localPortNumber":["18789"]}'
```

Keep this terminal open. The tunnel stays active as long as the command runs.

---

## Step 7 — Open the web UI

Open your browser to:

```
http://localhost:18789
```

In the login form enter:

| Field       | Value                                 |
| ----------- | ------------------------------------- |
| Gateway URL | `ws://127.0.0.1:18789`                |
| Token       | _(the token you generated in Step 3)_ |

Click **Connect**.

---

## Day-2 operations

**View logs**

```bash
docker compose logs -f openclaw-gateway
```

**Restart after a config change**

```bash
docker compose restart openclaw-gateway
```

**Stop everything**

```bash
docker compose down
```

**Upgrade to a newer version**

```bash
git pull
docker build -t openclaw:local .
docker compose up -d openclaw-gateway
```

**Get the dashboard URL (with token pre-filled)**

```bash
docker compose run --rm openclaw-cli dashboard --no-open
```

---

## Enabling the Webex channel (optional)

When you are ready to enable the Webex bot, add your bot token to `.env`:

```bash
WEBEX_BOT_TOKEN=your-webex-bot-access-token
```

Then edit `docker-compose.yml` to pass it through:

```yaml
environment:
  WEBEX_BOT_TOKEN: ${WEBEX_BOT_TOKEN:-}
```

And restart:

```bash
docker compose restart openclaw-gateway
```

The Webex extension connects outbound via WebSocket — no inbound firewall rule or port is needed.

---

## Troubleshooting

**Bedrock calls fail with `CredentialsProviderError` or `UnrecognizedClientException`**
The container cannot reach IMDS. Confirm the hop limit fix from Step 5a was applied and restart the container. You can test IMDS reachability from inside the container:

```bash
docker compose exec openclaw-gateway \
  curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600"
```

A non-empty token string means IMDS is reachable.

**Model not found after `models list`**
Confirm the inference profile exists in your account and region:

```bash
aws bedrock list-inference-profiles --region us-east-1 \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId,'sonnet-4-6')].inferenceProfileId"
```

If you see a different ID, update `agents.defaults.model` accordingly.

**`AccessDeniedException` on Bedrock calls**
The instance role is missing permissions. Attach `AmazonBedrockFullAccess` or add the four `bedrock:*` actions listed in Step 5b.

**`docker compose up` fails with exit 137 (OOM)**
Increase instance size to at least `t3.medium` (4 GB RAM) or add swap:

```bash
sudo dd if=/dev/zero of=/swapfile bs=128M count=32
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

**Port forwarding drops immediately**
The SSM plugin requires an active session. If your laptop idles, the tunnel may close — re-run the `aws ssm start-session` command.

**`unauthorized: gateway token mismatch`**
The token in the login form must exactly match `OPENCLAW_GATEWAY_TOKEN` in `.env`. Check for trailing whitespace or newlines.

**Gateway binds to loopback only**
Ensure `OPENCLAW_GATEWAY_BIND=lan` is set in `.env` before starting. Confirm with:

```bash
docker compose exec openclaw-gateway ss -tlnp | grep 18789
```

You should see `0.0.0.0:18789`, not `127.0.0.1:18789`.
