# rss-aggregator

Selbst-gehosteter RSS/Atom-Aggregator — mehrere Feeds abonnieren, ein zusammengeführter,
deduplizierter Artikel-Stream. Komplett **ohne npm-Dependencies** (nur Node-Builtins),
inklusive eigenem Mini-XML-Parser für RSS 2.0 und Atom.

## Problem

Wer News aus mehreren Quellen verfolgt, klickt sich durch zig Seiten oder hängt an einem
Cloud-Reader. Dieses Tool läuft auf dem eigenen Server, holt die Feeds selbst und liefert
einen Stream — per Web-UI oder als JSON-API für eigene Frontends.

## Features

- Feeds verwalten (hinzufügen/entfernen) über Web-UI oder API
- Parst **RSS 2.0 und Atom** mit eigenem, dependency-freiem Parser
- Zusammengeführter Stream: nach Datum sortiert, dedupliziert (per Link)
- Automatischer Refresh alle 10 Minuten + manueller Refresh
- Fehler-tolerant: ein kaputter Feed crasht nie den Gesamt-Refresh (Fehler wird pro Feed angezeigt)
- Persistenz als JSON-Datei — kein Datenbank-Setup nötig

## Stack

- Node.js (nur Builtins: `node:http`, `node:https`, `node:fs/promises`) — **kein `npm install`**
- Vanilla-JS-Frontend, Dark-Theme
- JSON-File-Store unter `data/`

## Setup & Start

```bash
node server.js            # Standard-Port 8220
PORT=9000 node server.js  # eigener Port
```

Dann `http://localhost:8220` öffnen und einen Feed hinzufügen,
z. B. `https://hnrss.org/frontpage`.

## API

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/feeds` | Alle Feeds mit Status (letzter Abruf, Fehler, Artikelzahl) |
| `POST` | `/api/feeds` | Feed hinzufügen — Body: `{"url": "...", "name": "optional"}` |
| `DELETE` | `/api/feeds/:id` | Feed und seine Artikel entfernen |
| `GET` | `/api/items?source=&limit=` | Zusammengeführter Artikel-Stream (max. 500) |
| `POST` | `/api/refresh` | Alle Feeds sofort neu abrufen |

## Screenshot

_(Screenshot folgt)_

## Lizenz

MIT
