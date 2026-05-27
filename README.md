# Hermes Convos Adapter

Convos/XMTP platform adapter for [Hermes Agent](https://github.com/NousResearch/hermes-agent).

This plugin lets a local or self-hosted Hermes runtime join a Convos group and
reply through Hermes' normal gateway layer. It is meant to behave like the
Telegram, Discord, Slack, or other Hermes gateway adapters: Convos messages
become Hermes `MessageEvent`s, and Hermes responses are sent back into the
same group.

```text
Convos/XMTP group
  -> Node XMTP sidecar
  -> Hermes platform plugin
  -> Hermes GatewayRunner
  -> AIAgent / tools / approvals / slash commands
  -> Convos/XMTP group
```

## What You Get

- Convos/XMTP group invite creation and reuse
- Text chat with Hermes from Convos
- Hermes gateway sessions and slash command routing
- Gateway approval handling for `/approve`, `/deny`, `/always`, and `/cancel`
- Optional allowlist by XMTP inbox ID
- Local control API for listing and creating Convos groups
- Works with local Hermes or a cloud-hosted Hermes runtime

## Requirements

- Hermes Agent installed and configured
- Node.js 20+ and npm
- A Convos app/client that can open XMTP group invite links

The installer can generate an XMTP wallet for the Hermes agent. This wallet
belongs to the agent identity on XMTP/Convos, not to the human user. Keep that
private key secret.

## Quick Install

Clone this repository and run the installer:

```bash
git clone https://github.com/openagentmarket/hermes-convos-adapter.git
cd hermes-convos-adapter
./install.sh
```

The installer:

1. Installs and builds the Node sidecar.
2. Copies the plugin into `~/.hermes/plugins/platforms/convos`.
3. Enables the plugin with `hermes plugins enable platforms/convos`.
4. Creates missing Convos env settings in `~/.hermes/.env`, including an
   agent XMTP wallet and local DB encryption key.

For quick local testing, the installer also writes `CONVOS_ALLOW_ALL_USERS=true`
when neither `CONVOS_ALLOWED_USERS` nor `CONVOS_ALLOW_ALL_USERS` already exists.
This makes the first Convos group work immediately.

For a private agent, replace that line with an owner allowlist:

```bash
CONVOS_ALLOWED_USERS=<your-xmtp-inbox-id>
```

You can also set the values yourself before running the installer. Existing
settings are preserved:

```bash
CONVOS_XMTP_WALLET_KEY=0x...
CONVOS_XMTP_DB_ENCRYPTION_KEY=...
CONVOS_XMTP_ENV=production
CONVOS_AGENT_NAME=Hermes Agent
CONVOS_GROUP_NAME=Hermes Agent
CONVOS_ALLOW_ALL_USERS=true
```

Do not use `CONVOS_ALLOW_ALL_USERS=true` for a private agent with access to
files, shell commands, secrets, or paid APIs.

## Manual Install

If you do not want to run the installer:

```bash
git clone https://github.com/openagentmarket/hermes-convos-adapter.git
cd hermes-convos-adapter/sidecar
npm install
npm run build

mkdir -p ~/.hermes/plugins/platforms
cp -R ../ ~/.hermes/plugins/platforms/convos

hermes plugins enable platforms/convos
```

Check that Hermes sees it:

```bash
hermes plugins list
```

You should see `platforms/convos` enabled.

## Run Hermes

Start the Hermes gateway:

```bash
hermes gateway
```

On first startup, the sidecar creates a Convos group and prints an invite URL
in the gateway logs. It also writes runtime info here:

```bash
cat ~/.hermes/convos/info.json
```

The file includes:

```json
{
  "status": "running",
  "runtime": "hermes",
  "address": "0x...",
  "inboxId": "...",
  "inviteUrl": "https://popup.convos.org/v2?i=...",
  "conversationId": "..."
}
```

Open the `inviteUrl` on your phone, or scan/share it from your mobile app, and
join the group. Messages sent in that Convos group will be delivered to Hermes.

## Creating More Groups

The sidecar starts a local control server on `127.0.0.1:8787` by default.

List active groups:

```bash
curl http://127.0.0.1:8787/conversations
```

Create another Convos group:

```bash
curl -X POST http://127.0.0.1:8787/conversations \
  -H 'Content-Type: application/json' \
  -d '{"name":"Hermes Project Chat"}'
```

The response contains an `inviteUrl` that can be opened on mobile.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `CONVOS_XMTP_WALLET_KEY` | yes | Agent XMTP wallet private key. |
| `CONVOS_XMTP_DB_ENCRYPTION_KEY` | no | XMTP local DB encryption key. |
| `CONVOS_XMTP_ENV` | no | `production`, `dev`, or `local`. Defaults to `production`. |
| `CONVOS_DATA_DIR` | no | Sidecar state directory. Defaults to `$HERMES_HOME/convos`. |
| `CONVOS_INFO_FILE` | no | JSON status file path. Defaults to `$CONVOS_DATA_DIR/info.json`. |
| `CONVOS_AGENT_NAME` | no | Bot display name. Defaults to `Hermes`. |
| `CONVOS_GROUP_NAME` | no | Default group name. Defaults to `CONVOS_AGENT_NAME`. |
| `CONVOS_ALLOWED_USERS` | recommended | Comma-separated XMTP inbox IDs allowed to talk to the agent. |
| `CONVOS_ALLOW_ALL_USERS` | no | Set `true` to allow any sender. Use carefully. |
| `CONVOS_HOME_CHANNEL` | no | Conversation ID for cron/background delivery. |
| `CONVOS_CONVERSATION_POOL_SIZE` | no | Number of pre-created pooled groups. Defaults to `1`. |
| `CONVOS_CONTROL_HOST` | no | Control API host. Defaults to `127.0.0.1`. |
| `CONVOS_CONTROL_PORT` | no | Control API port. Defaults to `8787`. |
| `CONVOS_SEND_ACK_TIMEOUT_MS` | no | Send timeout before optimistic ack. Defaults to `12000`. |
| `CONVOS_SIDECAR_COMMAND` | no | Override command used to start the Node sidecar. |

## Security Notes

Convos is a chat surface. Treat messages from public groups as untrusted user
input. Hermes approvals still protect dangerous actions, but you should also:

- Prefer `CONVOS_ALLOWED_USERS` for private agents.
- Avoid `CONVOS_ALLOW_ALL_USERS=true` unless the agent is intentionally public.
- Keep the XMTP wallet private key out of git and logs.
- Use Hermes' normal approval flow for shell/file/network actions.
- Be careful with public agents that have access to paid APIs or private files.

## Development

Build the sidecar:

```bash
cd sidecar
npm install
npm run build
```

During development you can symlink the plugin:

```bash
mkdir -p ~/.hermes/plugins/platforms
ln -s "$PWD/.." ~/.hermes/plugins/platforms/convos
hermes plugins enable platforms/convos
```

Then restart `hermes gateway`.

## License

MIT
