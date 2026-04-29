# pi-247 Telegram Gateway

Bridge messages from Telegram (and optionally Email) to your pi-247 agent.

## Quick Start

```bash
# 1. Set your Telegram bot token
export TELEGRAM_BOT_TOKEN="your_bot_token_from_@BotFather"

# 2. Run from the monorepo
bun packages/telegram-gateway/src/index.ts
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | - | Bot token from @BotFather |
| `GATEWAY_ALLOWED_USERS` | No | `*` | Comma-separated Telegram user IDs |
| `GATEWAY_AGENT_CWD` | No | `cwd` | Working directory for pi-247 |
| `GATEWAY_SESSION_DIR` | No | auto | Session persistence directory |

### Email (optional)

Set `EMAIL_IMAP_HOST` to enable email listener.

| Variable | Description |
|---|---|
| `EMAIL_IMAP_HOST` | IMAP server hostname |
| `EMAIL_IMAP_USER` / `EMAIL_IMAP_PASS` | IMAP credentials |
| `EMAIL_SMTP_HOST` | SMTP server for replies |
| `EMAIL_SMTP_USER` / `EMAIL_SMTP_PASS` | SMTP credentials |
| `EMAIL_ALLOWED_DOMAINS` | Sender domains to accept |

## How It Works

```
Telegram message → grammy bot → pi-247 SDK (createAgentSession)
                                       ↓
                              Agent processes with full tool access
                                       ↓
                              Response captured via session.subscribe()
                                       ↓
                              Sent back to Telegram
```

Each message goes through the same agent pipeline as a terminal session — bash, edit, write, web search, etc. All tools work.

## Architecture

- **Separate process**: Runs independently from the TUI. Can run as systemd service.
- **Shared session**: Maintains conversation context across messages.
- **Full tool access**: The agent can run bash commands, edit files, browse web, etc.
- **Message splitting**: Long responses split into multiple Telegram messages (4096 char limit).
