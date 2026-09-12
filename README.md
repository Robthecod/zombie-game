# 🧟 Zombie Chase

Survive on the map while zombies chase your real-time location. Collect powerups to stay alive.

## Screenshots

*(Coming soon — add screenshots after your first build)*

## Features

- **Real-time GPS location** — uses your device's actual location
- **Zombies chase you** — they spawn and move toward your position
- **Powerups** — appear randomly on the map, collect by reaching them
- **Inventory system** — use collected powerups to survive longer
- **4 powerup types:**
  - ⚡ **Speed Boost** — move faster for a few seconds
  - 🛡️ **Shield** — temporary protection from zombies
  - ❤️ **Heal** — respawn if caught
  - 💣 **Bomb** — destroy nearby zombies

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | React + Leaflet + Socket.io Client |
| Backend | Node.js + Express + Socket.io |
| Maps | Leaflet + OpenStreetMap (free, no API key) |
| Real-time | WebSockets via Socket.io |
| Mobile | Capacitor (APK build) |

## Quick Start (Local)

### Prerequisites

- Node.js 18+

### Run locally

```bash
# Terminal 1 — start server
cd server
npm install
npm start

# Terminal 2 — start client
cd client
npm install
npm start
```

Open `http://localhost:3000` in your browser. On mobile, use your PC's local IP (e.g., `http://192.168.1.5:3000`) while on the same WiFi.

### Build APK (Android)

```bash
cd client
npm run build

# Install Capacitor (one-time)
npm install -D @capacitor/cli
npm install @capacitor/android

npx cap add android
npx cap sync android

# Build debug APK
cd android
./gradlew assembleDebug

# APK at: android/app/build/outputs/apk/debug/app-debug.apk
```

## Deployment

### Zeabur (recommended — browser only, no CLI)

1. Push this repo to GitHub
2. Go to [zeabur.com](https://zeabur.com) → sign up
3. Create New Service → connect your GitHub repo
4. Zeabur auto-detects Node.js and deploys
5. Copy the generated URL

Then update the client to use the deployed URL:

```bash
# In client/.env
REACT_APP_SOCKET_URL=https://your-zeabur-url.zeabur.app
```

Rebuild the client and redeploy (or rebuild the APK).

### Fly.io

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Login
fly auth login

# Deploy from server/ directory
cd server
fly launch --no-deploy
fly deploy
```

## Environment Variables

### Client (`client/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `REACT_APP_SOCKET_URL` | *(none)* | Backend Socket.io server URL. The server listens on port **8080** by default (see `server/index.js`). Note: the current client build plays fully offline and doesn't use this variable yet. |

## Project Structure

```
zombie-chase/
├── server/
│   ├── index.js          # Express + Socket.io multiplayer game server (currently unused by the client)
│   ├── Dockerfile        # For container deployment
│   ├── fly.toml          # Fly.io config
│   └── package.json
├── client/
│   ├── src/
│   │   └── App.js        # React game component (standalone, plays offline)
│   ├── public/
│   │   ├── index.html
│   │   └── styles.css    # Mobile-first styles
│   ├── android/          # Capacitor Android project
│   ├── capacitor.config.json
│   └── package.json
└── package.json          # Root helper scripts
```

## License

MIT
