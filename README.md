# 🚢 Elbe Radar Wedel

AIS-Schiffsradar für Wedel/Elbe mit Echtzeit-Karte, ETA-Prognose und Telegram-Alerts.

## Schnellstart

### 1. Konfiguration
```bash
cp .env.example .env
nano .env   # Keys eintragen
```

### 2. Traefik-Netzwerk anlegen (einmalig)
```bash
docker network create traefik
```

### 3. Container starten
```bash
docker compose up -d
```

### 4. Logs prüfen
```bash
docker compose logs -f
```

## Konfiguration (.env)

| Variable | Beschreibung |
|---|---|
| `AIS_API_KEY` | aisstream.io API Key (kostenlos) |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token (von @BotFather) |
| `TELEGRAM_CHAT_ID` | Deine Telegram Chat-ID (von @userinfobot) |
| `DOMAIN` | Deine DynDNS-Domain (z.B. `elbe.deinedomain.de`) |
| `ALERT_MIN_LENGTH` | Mindestlänge für Telegram-Alerts in Meter (Standard: 200) |

## Telegram Bot einrichten
1. Schreibe @BotFather auf Telegram → `/newbot`
2. Bot-Token in `.env` eintragen
3. Schreibe deinen Bot an → @userinfobot schreibt dir deine Chat-ID
4. Chat-ID in `.env` eintragen

## Ohne API Key
Ohne `AIS_API_KEY` startet die App im **Demo-Modus** mit 6 simulierten Schiffen.

## Voraussetzungen
- Docker + Docker Compose
- Traefik als Reverse Proxy mit Let's Encrypt Resolver `letsencrypt`
