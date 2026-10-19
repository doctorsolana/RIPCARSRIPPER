# Hosting the game server (Fly.io)

The site stays on Vercel (https://racecars.fun); the game server runs on Fly.io at `wss://play.racecars.fun`. The files: `Dockerfile`, `.dockerignore` and `fly.toml` at the repo root. Fly builds the image on its own remote builders (`fly deploy` builds remotely by default), so Docker is never needed on your machine. Run every command from the repo root.

## First time

1. Install flyctl (`brew install flyctl`) and sign in: `fly auth login`.
2. Create the app from `fly.toml` without deploying:
   `fly launch --copy-config --no-deploy --name racecars-server --region ams`
   (`ams` is a placeholder: pick the region nearest most players, see `fly platform regions`, and put the same one in `fly.toml`'s `primary_region`. If the name is taken, pick another and put it in `fly.toml`'s `app`.)
3. Create the data volume (the store and the race logs), in the same region:
   `fly volumes create racecars_data --region ams --size 1`
   (Answer yes to the warning about a single volume: the server is one machine on purpose.)
4. Make two secrets, and save both in your password manager (Fly can't show them again):
   `openssl rand -base64 48` → AUTH_SECRET, `openssl rand -hex 24` → STATS_KEY. Then set them, with the Helius RPC URL from `app/server/.env`:
   `fly secrets set AUTH_SECRET='…' STATS_KEY='…' HELIUS_RPC_URL='…'`
5. Deploy: `fly deploy`.
6. Check it's up: `curl https://racecars-server.fly.dev/health` should answer `{"ok":true,"version":"…","draining":false}`.
7. Set up the domain: `fly certs add play.racecars.fun`. At the DNS for racecars.fun, add a `CNAME` record from `play` to `racecars-server.fly.dev` (on Cloudflare, set it to DNS only, the grey cloud). Then run `fly certs check play.racecars.fun` until it says the certificate is issued.
8. Check it on the domain:
   - `curl https://play.racecars.fun/health` returns 200.
   - `curl -H "Authorization: Bearer $STATS_KEY" https://play.racecars.fun/stats` returns the stats JSON. Without the key it's a 404.
9. On Vercel, open the project's Settings, then Environment Variables, and add `VITE_GAME_SERVER` = `wss://play.racecars.fun` for Production (and Preview if you want). Then go to Deployments and Redeploy the latest one: the variable is baked in at build time.
10. Open https://racecars.fun/online. You should see the room list (no "Game server offline", no "A new version is out"). Connect a wallet and race a time trial.

## Every update

- **The server** (`app/server`, or the shared sim code): `fly deploy`. The running server gets SIGTERM. It stops taking joins and starting races, tells the players, and exits once the race on now ends (at most 3 minutes). Then the new one starts. Expect up to ~3 minutes of "Game server offline" during a deploy.
- **The sim** (anything under `app/src/drive/vehicles`, `tracks`, `input.ts`, `net/{contact,protocol,codec,race}.ts`, or a car's `model.json` / `meta.json`): deploy **both** the server (`fly deploy`) and the site (push to Vercel). Until both are out, pages say "A new version is out" with a Reload button. To compare versions, `node app/server/build-id.ts` prints the id for your checkout, and `curl https://play.racecars.fun/version` prints the server's.
- Logs: `fly logs`. Stats: `curl -H "Authorization: Bearer $STATS_KEY" https://play.racecars.fun/stats`; `curl -X POST -H "Authorization: Bearer $STATS_KEY" https://play.racecars.fun/reset-stats` zeroes them.
- Fly snapshots the volume daily. For a copy of the store: `fly ssh sftp get /data/store.sqlite` (and `/data/store.sqlite-wal`, which holds the newest writes).
- To let another site sign in too (e.g. `https://www.racecars.fun`), add it to `ALLOWED_ORIGINS` in `fly.toml` (comma-separated) and `fly deploy`.
