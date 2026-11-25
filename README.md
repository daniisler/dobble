# MatchMe

A multiplayer symbol-matching card game for the browser, with rooms, join codes and a server built for fast clicking.
Every card shows a handful of symbols, and any two cards share **exactly one** symbol. Click the symbol on your own card
that also appears on the card in the middle; the first player to get rid of all their cards wins.

- Runs in any modern browser, phone or desktop. Nothing to install for players.
- Rooms with 4-letter codes, any number of players per room (the lobby shows a warning above 6), any number of rooms at the same time.
- 10 deck sizes from 7 to 273 cards and a configurable number of cards per player.
- Accounts for custom images: upload your own pictures and use them as the symbols.
- Win tally per room, detailed results after every game.
- A crude admin overview with usage statistics.
- One small Node.js server, SQLite for storage, one Docker container.

The name is a setting (`APP_NAME`, see below); "MatchMe" is just the default.

---

## Contents

- [MatchMe](#matchme)
  - [Contents](#contents)
  - [Quick start](#quick-start)
  - [Configuration (.env)](#configuration-env)
  - [Deploying with Docker and nginx](#deploying-with-docker-and-nginx)
  - [How to play](#how-to-play)
  - [Room settings](#room-settings)
  - [Accounts and custom images](#accounts-and-custom-images)
    - [Default images](#default-images)
  - [Which images a player downloads](#which-images-a-player-downloads)
  - [Security of uploads and requests](#security-of-uploads-and-requests)
  - [Admin overview and usage statistics](#admin-overview-and-usage-statistics)
  - [Connection handling](#connection-handling)
  - [Why it is fast](#why-it-is-fast)
  - [Project layout and protocol](#project-layout-and-protocol)
  - [Tests](#tests)
  - [Troubleshooting](#troubleshooting)
  - [Credits and licence](#credits-and-licence)

---

## Quick start

Requires **Node.js 22.13 or newer** (the Docker image uses Node 24).

```
npm install
cp .env.example .env     # optional: name, admin login, timeouts, ... (see below)
npm start                # http://localhost:8003
```

Open the address in two browser windows, create a room in one and join it with the 4-letter code in the other.

With Docker:

```
cp .env.example .env     # optional
docker compose up -d --build     # http://localhost:8054
```

## Configuration (.env)

All settings are environment variables. They can be put in a `.env` file in the project folder (copy
[`.env.example`](.env.example)); the server loads it on start. `.env` is ignored by git and kept out of the Docker image.
With `docker compose` the same file is passed to the container through `env_file` (it is optional).
Real environment variables always win over the file. Changing `.env` needs a restart (`docker compose up -d` recreates
the container).

| Variable                     | Default                       | Meaning                                                                                                                                                                          |
| ---------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_NAME`                   | `MatchMe`                     | Name shown in the page title, the headings, the 404 page and the admin page.                                                                                                     |
| `PORT`                       | `8003` (Docker image: `8054`) | Port the server listens on.                                                                                                                                                      |
| `ADMIN_USER`                 | *(empty)*                     | User name for the [admin overview](#admin-overview-and-usage-statistics).                                                                                                        |
| `ADMIN_PASSWORD`             | *(empty)*                     | Password for the admin overview. If user **or** password is empty, `/admin` does not exist (404).                                                                                |
| `CONNECTION_TIMEOUT_SECONDS` | `5`                           | How long a player's connection may be silent before the browser shows "Connection lost". Range 2 to 120. See [Connection handling](#connection-handling).                        |
| `TRUST_PROXY`                | *(unset)*                     | Set to `1` behind a reverse proxy so the rate limiter uses the client address from `X-Forwarded-For`. Leave unset when the app is exposed directly (the header could be forged). |
| `DATA_DIR`                   | `./data` (Docker: `/data`)    | Folder for the SQLite database (`matchme.sqlite`) and the uploaded images.                                                                                                       |

## Deploying with Docker and nginx

```
docker compose up -d --build
```

- The container (service `matchme`) listens on **port 8054**, published as `8054:8054`.
- Accounts, statistics and uploaded images live in a Docker volume mounted at `/data` and survive rebuilds. Back up that
  volume, or the files `matchme.sqlite*` and `uploads/` in it. `docker-compose.yml` points at the volume that earlier
  versions of the project already used, so nothing is lost when upgrading. An old database file `dobble.sqlite` is renamed
  to `matchme.sqlite` automatically on the first start.
- The container runs as the non-root `node` user and has a health check.
- TLS is not handled by the app: put a reverse proxy in front. WebSockets **must** be proxied, otherwise the game cannot
  connect. Example nginx location:

```
location / {
    proxy_pass http://127.0.0.1:8054;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   # with TRUST_PROXY=1 in .env
    proxy_read_timeout 1h;       # idle lobbies must not be cut off
    proxy_buffering off;
    client_max_body_size 10m;    # uploads of up to 8 MB are accepted and shrunk
}
```

If nginx runs in another container, use `proxy_pass http://matchme:8054;` and put both containers on one Docker network.
Serve the site over HTTPS: the admin page uses HTTP Basic authentication, which sends the password with every request.

## How to play

1. One player clicks **Create room** and shares the 4-letter code. The others type it in and click **Join room**.
2. Everybody clicks **Ready**. When all players are ready a 3 second countdown starts.
3. Every player has a stack of cards. In the middle lies one card that everybody can see. Click the symbol on **your
   card** that also appears on the **centre card**: your card now becomes the new centre card.
4. The first player who has played all their cards wins.

What you see while playing:

- Your own card has a bold ring and a label; the centre card is ringed in the **colour of the player who played it**, with
  a label saying who that was. The symbol that matched gets a thin ring in the same colour.
- The bar at the top shows every player's colour and the number of cards they have left.
- **Wrong symbol:** a 3 second pause ("Wrong symbol!" for the first two seconds), counted as a miss.
- **"Alice was faster!":** if your symbol was right a moment ago but another player has just covered that card (within one
  second), a big banner at the top says so. There is no penalty, no pause and no miss: just play on.
- The room creator can **cancel** a countdown or a running game; everybody returns to the lobby.
- At the end a results screen shows the winner, the total time and, for every player, cards left, cards played, average
  time per card, fastest card and misses, plus a few awards. *Play again* returns to the lobby and readies you.
- **Win tally:** once at least two games have been finished in a room, the lobby shows 🏆 and the number of wins next to
  every player, and the results table gets a "Wins in room" column. Cancelled games do not count; a player's wins are
  forgotten when they leave the room.

The server alone decides what every click was, so a modified client cannot skip a penalty.

## Room settings

The room creator (marked with a star in the lobby) chooses:

- **Deck size.** A deck where *any two cards share exactly one symbol* only exists for certain sizes: a finite projective
  plane of prime-power order `q` gives `q² + q + 1` cards with `q + 1` symbols each. The dropdown offers
  7, 13, 21, 31, 57, 73, 91, 133, 183 and 273 cards (3, 4, 5, 6, 8, 9, 10, 12, 14 and 17 symbols per card). The lobby
  states how many symbols every card gets and how many different images the deck needs.
- **Cards per player.** How long the game is (default 15). A deck deals one card to the middle, so
  `players × cards per player` must not exceed `deck size − 1`. The dropdown lists every possible number for small decks and
  presets for large ones. If the setting is too high for the number of players the game does not start and the lobby says
  what to change. Choosing a smaller deck lowers the number automatically.

Changing the deck size, the images or the cards per player makes everybody click **Ready** again.

## Accounts and custom images

Playing needs only a **nickname**. An **account** is only needed to use your own images, so it is offered where it
matters: when you click **Create room**, a dialog lets you log in, register, or continue as a guest with the default images.

As room creator with an account, the lobby shows an image editor:

1. **Upload images.** Any PNG, JPEG or WebP is fine; large pictures are **downscaled automatically** (see below).
   They appear in *Your library*.
2. Click an image in the library, then click the slot(s) it should replace. Click a replaced slot with nothing picked to
   restore the default image, or use *Reset all*.
3. Each image can be used **only once per deck**. Used images are dimmed in the library with a badge showing their slot.
4. Your picks are **saved on your account** and applied automatically to every room you create.
5. Deleting an image from the library also removes it from your saved picks and from open rooms.

Other things to know:

- **Images are downscaled.** The server decodes every upload and stores it as a WebP that fits in 256 × 256 pixels
  (typically a few KB; smaller pictures are not enlarged, animations keep their first frame). Uploads of up to 8 MB and about
  6000 × 6000 pixels are accepted. The browser also shrinks pictures before uploading, to save bandwidth.
- Passwords are stored as salted scrypt hashes. Sessions are random tokens kept in the browser's local storage.
- A limit of 300 images per account (enough for a complete 273-card deck).
- Uploading many pictures at once is fine: three are uploaded in parallel, a progress bar shows how far it is, and a
  summary lists any pictures that failed. If a limit is hit, the rest is skipped with a clear message.
- **Delete account** (home screen, needs the password) removes the account, all uploaded images and the saved picks.
- Only the room creator edits images, and only with images from their own library. Everybody in the room sees the result.

### Default images

273 emoji from [Twemoji](https://github.com/jdecked/twemoji), graphics © Twitter, Inc. and other contributors,
licensed under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) (credited on the home page). They were pre-rendered
to 192 px WebP files in `public/img/` (`0.webp` to `272.webp`; slot *n* uses image *n*). The hand-picked images of the first
version of the game are kept in `assets/original-images/` (they are not served).

## Which images a player downloads

1. **When the page opens:** the 57 default images of the standard deck, before the app starts (a progress bar shows it).
   The browser caches them, so later visits cost nothing.
2. **When joining or creating a room:** exactly the images that room's deck needs: the custom images the creator has
   chosen (from the creator's uploads) and, for decks bigger than 57 cards, the extra default images. Nothing else is
   downloaded, in particular not the default images of decks nobody plays.
3. **Whenever the creator changes something** (deck size, an image, reset), every player in the room gets the new image
   list immediately and downloads whatever is new, on any screen, including the results screen. The *Ready* button stays
   disabled until everything is downloaded and decoded, and the server asks everybody to click *Ready* again after a
   change, so a game never starts while somebody is still waiting for a picture.

## Security of uploads and requests

What was checked and how it is handled:

- **Content, not names, decides.** The type is detected from the file's own bytes; the stored file name is generated by the
  server (`<24 random hex>.webp`), never taken from the upload.
- **Everything is re-encoded.** Every upload is decoded, shrunk and written as a fresh WebP, so nothing a user sends is ever
  stored or served as it came in: extra data hidden in a file, EXIF metadata (GPS positions) and polyglot files are gone.
  Only PNG, JPEG and WebP are accepted; **SVG** (can contain scripts), GIF, TIFF, HTML and everything else are refused.
- **Decompression bombs.** Uploads over 8 MB are refused with `413`; pictures over 40 megapixels are refused before decoding.
  Stored pictures are tiny, so other players' browsers never decode a huge bitmap.
- **Served as pictures only.** Uploaded files are sent with their exact type plus `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox` and `Cross-Origin-Resource-Policy: same-origin`. Only the exact generated
  names are served from `/u/`; anything else, including `..` tricks, gets the 404 page.
- **Access.** Uploading, listing, deleting and using images requires a login and works only with the user's own images. The
  image addresses contain 96 random bits and are never listed publicly, but anyone who has an address (every player in the
  room) can open it by design. Browsers may keep a cached copy after an image was deleted.
- **Abuse.** Rate limits (per IP address, or per user where logged in): 10 registrations per hour, 20 logins per 10 minutes,
  400 uploads per 10 minutes, 5 account deletions per 10 minutes; limits are 300 images per account and 8 MB per upload.
  Too many requests get `429`. Behind a reverse proxy set `TRUST_PROXY=1`.
- **Robustness.** A malformed URL no longer crashes the server (it gets `400`). All pages carry `nosniff`, `X-Frame-Options:
  DENY` and `Referrer-Policy: no-referrer`. Passwords use scrypt with a random salt and constant-time comparison. All user
  text (nicknames, names) is inserted into pages as plain text, never as HTML.
- **Not covered:** the app does not scan pictures for content (use your own moderation if the site is public), and without a
  reverse proxy there is no TLS. A strict Content-Security-Policy for the whole app would be a possible further hardening.

## Admin overview and usage statistics

Set `ADMIN_USER` and `ADMIN_PASSWORD` in `.env` and restart. Then open **`/admin`** and log in (browser login prompt).
The page is intentionally crude (server-rendered tables, no JavaScript, one small file: `server/admin.js`) but styled, with
automatic light and dark mode.

It shows:

- **Right now:** open rooms and connected players.
- **Totals:** page views, connections, rooms created and joined, games started, finished and cancelled, accounts,
  registrations, logins, deleted accounts, uploaded images and their size.
- **Finished games:** count, average players, average duration, total misses, and a breakdown per deck size.
- **Last 14 days** per day (UTC) and the **last 20 finished games**.

Statistics are stored in the same SQLite database (`DATA_DIR/matchme.sqlite`):

- table `events(ts, type)`: one row per event, with `type` one of `page_view`, `connection`, `room_created`, `room_joined`,
  `game_started`, `game_finished`, `game_cancelled`, `register`, `login`, `account_deleted`, `image_uploaded`;
- table `games(ts, cards, players, stack, duration_ms, misses, custom_images)`: one row per finished game.

They are **anonymous**: no nicknames, user names, IP addresses or room codes are stored. A failure while writing statistics
never affects a game. To look further, query the file with `sqlite3`, for example
`SELECT date(ts/1000,'unixepoch'), COUNT(*) FROM events WHERE type='game_finished' GROUP BY 1;`.
To start over, delete the rows (`DELETE FROM events; DELETE FROM games;`).

## Connection handling

**In the game.** The browser pings the server several times per timeout period. If **nothing has come back for
`CONNECTION_TIMEOUT_SECONDS`** (default 5), or a card you played has not been answered for that long, a *Connection lost*
box appears ("The server is not responding"). It disappears by itself if the server answers again; its button returns to the
start screen. If the connection actually closes, the box says you were disconnected from the room. A player who
disconnects is removed from the room (if the room creator leaves, the next player becomes creator), and the game goes on for
the others. To change the allowed silence, edit `CONNECTION_TIMEOUT_SECONDS` in `.env` and restart.

**While loading.** The start screen cannot hang:

- every image request has a 4 second timeout and is retried (up to 3 attempts, with a cache-busting query);
- the WebSocket connection attempt has a timeout and is retried;
- the app opens after at most 10 seconds even if something is still missing. Missing images keep loading and the *Ready*
  button waits for them; clicking *Create* or *Join* before the connection is up shows a message instead of doing nothing;
- after 5 seconds a "taking longer than usual" hint with a **Reload** button appears, and if the app still has not started
  after 15 seconds the page reloads itself once (which is what a manual reload would do).

## Why it is fast

- The standard deck's images are fetched and decoded **before the app opens**, a room's other images are fetched as soon as
  the room needs them, and *Ready* waits for them. A card change never waits on the network.
- Clicks are applied locally **immediately** (client-side prediction) and sent to the server, which is authoritative. If two
  players click the same centre card, the server accepts the first and rejects the other; that client rolls back.
- Each player receives their whole stack at game start, so the next card is already in the browser. (A determined player
  could peek via the developer tools; acceptable for a casual game.)
- WebSockets with `TCP_NODELAY`, no compression, tiny JSON messages, all game state in memory. Image processing runs off the
  main thread, so uploads never slow a running game.
- Card layouts (random sizes, rotations and positions, packed to fill the card) are computed in about a millisecond and
  cached, so the card you click looks the same in your hand and in the centre.
- The game screen is sized to the viewport: both cards are made as large as possible, side by side or stacked, whichever
  fits better, on phones, tablets and desktops.

## Project layout and protocol

```
server/server.js     HTTP (static files, JSON API, /admin, 404), WebSocket rooms, game rules, rate limiter
server/deck.js       deck generator: projective planes over GF(q) for q = 2, 3, 4, 5, 7, 8, 9, 11, 13, 16
server/db.js         SQLite: accounts (scrypt), sessions, image library and processing (sharp), saved picks, statistics
server/admin.js      the admin page and its Basic-auth check
server/env.js        loads .env
server/*.test.js     tests
public/              the browser client: index.html, app.js, style.css, 404.html, img/ (default images)
assets/              original images of the first version (not served)
data/                database and uploads at runtime (created automatically, git-ignored)
Dockerfile, docker-compose.yml, .env.example
```

**HTTP API** (JSON; `Authorization: Bearer <token>` where a login is needed)

| Endpoint                                         | Purpose                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `GET /api/config`                                | App name, deck sizes and the connection timeout for the browser. |
| `POST /api/register`, `POST /api/login`          | Create an account / log in; return a token.                      |
| `GET /api/me`, `POST /api/logout`                | Who am I / end the session.                                      |
| `GET/POST /api/images`, `DELETE /api/images/:id` | The user's image library (POST body = the image file).           |
| `POST /api/delete-account`                       | Delete the account and its images (body: password).              |
| `GET /admin`                                     | Admin overview (Basic auth).                                     |
| `GET /u/<id>.webp`                               | Uploaded images (random, unguessable ids).                       |

**WebSocket messages** (JSON, field `t` is the type). Browser to server: `create`, `join`, `ready`, `leave`, `setdeck`,
`setstack`, `setimage`, `resetimages`, `play`, `cancel`, `ping`. Server to browser: `joined`, `lobby`, `count`, `start`,
`play`, `rej` (with `why: "wrong"` or `"late"` for a penalised or too-slow click), `prog`, `end`, `cancelled`, `notice`,
`error`, `editerr`, `pong`.

## Tests

```
npm test
```

Runs the server tests: all deck sizes are verified as perfect decks (every pair of cards shares exactly one symbol), full
games over real WebSockets including race conditions, room settings, cancel, results and win tally, accounts, the image
library rules, account deletion, upload processing and security (downscaling, refused formats, decompression bombs, served
headers, path tricks, malformed URLs), rate limiting, the penalty rules with a controlled clock, the admin page and the
statistics.

## Troubleshooting

- **The page loads but "Create"/"Join" says it is not connected:** the WebSocket is blocked. With nginx check the
  `Upgrade`/`Connection` headers shown above.
- **"Connection lost" appears for players on poor networks:** raise `CONNECTION_TIMEOUT_SECONDS`.
- **`/admin` shows "Page not found":** `ADMIN_USER` or `ADMIN_PASSWORD` is not set (or the container was not restarted after
  editing `.env`).
- **Uploads fail with "Too many attempts":** the rate limiter. Behind nginx make sure `TRUST_PROXY=1` is set, otherwise all
  users share the proxy's address.
- **Uploads fail with a 413 or by nginx:** raise `client_max_body_size` (8 MB are accepted by the app).
- **An old version keeps showing after an update:** rebuild with `docker compose up -d --build` and hard-refresh the browser.
- **Node warns "SQLite is an experimental feature":** harmless; the Docker image hides it.

## Credits and licence

Game code: see [LICENSE](LICENSE). Default images: Twemoji, © Twitter, Inc. and other contributors, CC-BY 4.0.
Image processing by [sharp](https://sharp.pixelplumbing.com/) (Apache-2.0).
