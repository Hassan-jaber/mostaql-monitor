# 🚀 Mostaql Monitor

**AI-Powered Front-End Project Monitoring System**

Automatically monitors [Mostaql](https://mostaql.com) for Front-End freelance projects, analyzes them with AI, generates personalized proposals, and sends instant Telegram notifications — all within minutes of publication.

---

## ✨ Features

- 🔍 **Auto-monitoring** — checks Mostaql every 60 seconds for new projects
- 🎯 **Keyword filtering** — matches 50+ English and Arabic keywords
- 🤖 **AI analysis** — scores each project 0–100 and generates a classification
- ✍️ **Proposal generation** — creates personalized, human-sounding proposals
- 📱 **Telegram notifications** — rich formatted messages sent instantly
- 📊 **Dashboard** — React + TypeScript UI with charts and project management
- 🗄️ **SQLite database** — lightweight, zero-config persistence
- 🐳 **Docker support** — single command to run everything

---

## 📁 Project Structure

```
mostaql-monitor/
├── src/                        # Backend (Node.js + TypeScript)
│   ├── config/                 # App configuration
│   ├── controllers/            # Express route handlers
│   ├── database/               # SQLite setup & migrations
│   ├── integrations/           # AI provider adapters
│   ├── jobs/                   # Cron monitoring job
│   ├── middleware/             # Express middleware
│   ├── modules/                # Shared types
│   ├── repositories/           # Database access layer
│   ├── services/               # Business logic
│   └── utils/                  # Logger, helpers
├── dashboard/                  # Frontend (React + Tailwind)
│   └── src/
│       ├── pages/              # Overview, Projects, Stats, Settings, Logs
│       └── utils/              # API client
├── config/
│   ├── keywords.json           # Matching keywords (English + Arabic)
│   ├── settings.json           # Default settings
│   └── prompts.json            # AI prompt templates
├── data/                       # SQLite database (auto-created)
├── logs/                       # Rotating log files
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## ⚡ Quick Start

### 1. Clone & install

```bash
git clone https://github.com/yourname/mostaql-monitor.git
cd mostaql-monitor

# Install backend dependencies
npm install

# Install dashboard dependencies
cd dashboard && npm install && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
nano .env
```

Fill in the required values:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
TELEGRAM_CHAT_ID=-100123456789
AI_PROVIDER=claude
AI_API_KEY=sk-ant-api...
AI_MODEL=claude-haiku-4-5-20251001
```

### 3. Run locally

```bash
# Terminal 1 — Backend API + monitoring
npm run dev

# Terminal 2 — Dashboard (hot reload)
cd dashboard && npm run dev
```

- Backend API: http://localhost:3001
- Dashboard: http://localhost:5173

---

## 🐳 Docker (Recommended)

```bash
# Copy and fill .env
cp .env.example .env
nano .env

# Build and start everything
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

Dashboard + API available at **http://localhost:3001**

---

## 📱 Telegram Setup

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow instructions to create your bot
3. Copy the **Bot Token** → set as `TELEGRAM_BOT_TOKEN`
4. Add the bot to your personal chat or a group
5. Get your **Chat ID**:
   - Personal: message `@userinfobot`
   - Group: add `@getmyid_bot` to the group
6. Set as `TELEGRAM_CHAT_ID` (groups are negative numbers like `-100...`)
7. Test the connection in **Settings → Test Telegram** in the dashboard

---

## 🤖 AI Provider Configuration

| Provider | `AI_PROVIDER` value | Notes |
|---|---|---|
| Claude (Anthropic) | `claude` | Recommended. Get key at console.anthropic.com |
| OpenAI | `openai` | GPT-4o-mini works well |
| Google Gemini | `gemini` | gemini-1.5-flash |
| OpenRouter | `openrouter` | Access many models via one API |

Switch providers by changing `AI_PROVIDER` in `.env` — no code changes needed.

---

## 🚀 Deployment on VPS

```bash
# On your VPS (Ubuntu/Debian)
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git

git clone https://github.com/yourname/mostaql-monitor.git
cd mostaql-monitor
cp .env.example .env
nano .env   # Fill your credentials

docker compose up -d

# Enable auto-restart on reboot
sudo systemctl enable docker
```

Optional — reverse proxy with nginx:

```nginx
server {
    listen 80;
    server_name monitor.yourdomain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## ⚙️ Configuration

### Adding new keywords

Edit `config/keywords.json`:

```json
{
  "english": ["your", "new", "keyword"],
  "arabic": ["كلمة", "جديدة"]
}
```

Restart the service to apply changes.

### Updating AI prompts

Edit `config/prompts.json` to customize:
- `analysis.user` — how projects are analyzed
- `proposal.user` — how proposals are written
- `claude_deep_analysis.user` — the deep analysis prompt template

### Monitoring interval

Set `CHECK_INTERVAL_SECONDS` in `.env` (minimum 30 seconds recommended).

### Score threshold

Set `MIN_SCORE_THRESHOLD` in `.env`. Projects below this score won't trigger notifications (but are still saved to the database).

---

## 📊 Dashboard Pages

| Page | Description |
|---|---|
| **نظرة عامة** | Stats, activity chart, recent projects |
| **المشاريع** | Search, filter, view proposals & Claude prompts |
| **الإحصائيات** | Daily activity, classification pie, score distribution, top keywords |
| **الإعدادات** | Telegram config, AI provider, monitoring controls |
| **السجلات** | System logs filtered by category and level |

---

## 🔧 Troubleshooting

**No projects being found:**
- Mostaql may have changed their HTML structure. Check scraper logs in the dashboard.
- Try the manual check button in Settings to see errors immediately.

**AI analysis failing:**
- Verify your `AI_API_KEY` is correct and has credits.
- Check the AI logs category in the Logs page.

**Telegram not working:**
- Use "Test Telegram" in Settings to verify credentials.
- Make sure the bot was added to the chat/group.
- Groups require the Chat ID to start with `-100`.

**Database errors:**
- Ensure the `data/` directory exists and is writable.
- For Docker, check volume permissions: `docker compose exec mostaql-monitor ls -la /app/data`

---

## 📄 API Reference

```
GET  /api/projects           # List projects (paginated, filterable)
GET  /api/projects/stats     # Project statistics
GET  /api/projects/:id       # Single project

GET  /api/settings           # Get all settings
PUT  /api/settings           # Update settings
POST /api/settings/test-telegram   # Test Telegram connection
POST /api/settings/toggle-monitoring
POST /api/settings/run-check       # Manual check

GET  /api/logs               # System logs (paginated)
DELETE /api/logs             # Clear logs older than 7 days

GET  /health                 # Health check
```

---

## 📝 License

MIT — built for Hassan, Front-End Developer.
