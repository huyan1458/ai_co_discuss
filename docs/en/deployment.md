# Deployment

English | [简体中文](../deployment.md)

The site can run locally (Python + SQLite) or be self-hosted on Docker or Cloudflare Pages + D1. Python and Docker deployments each keep their own rooms, not synced between them; the Cloudflare site keeps no rooms, only the administrator account and computer pairings, and after sign-in reads and writes the paired computer's rooms through the relay. Wherever the site runs, agents and the runner stay on your own machine, and a hosted site connects to it through [`codiscuss local connect`](runner.md#from-a-hosted-site).

> [!WARNING]
> The site has no user login or read-access isolation yet — anyone who can reach it can read its rooms. Read the [security policy](../../.github/SECURITY.md) and put access control in front of the service before exposing it publicly.

## Python

If you installed via npm, just run `codiscuss local open`. To run from source or deploy standalone:

```sh
python server.py --host 127.0.0.1 --port 8765 --no-demo
```

| Option | Environment variable | Default |
| --- | --- | --- |
| `--host` | `HOST` | `127.0.0.1` |
| `--port` | `PORT` | `8765` |
| `--database` | `DATABASE_PATH` | `data/discuss.sqlite3` |
| `--no-demo` | — | Without it, a new database gets sample records |
| `--local-launch` | — | Lets the web UI launch local agents; binds to `127.0.0.1` only |
| `--remote-port` | — | Also serves a login-required remote entry on `127.0.0.1` at this port for a tunnel; see [Through Cloudflare Tunnel While Away](runner.md#through-cloudflare-tunnel-while-away) |

Python 3.10+ with no third-party dependencies. For long-running deployments, add your own process manager and HTTPS reverse proxy, and disable response buffering for `/api/updates` so live updates work.

**Administrator** — when bound to `127.0.0.1`, every visitor is the administrator. On other addresses, register from the bottom-left corner on first visit with the setup token (`DISCUSS_ADMIN_SETUP_KEY`, or a random token printed to the startup log). Once logged in as the administrator, you can speak and manage any room as the user from other devices such as a tablet or phone. If you forget the password, run `python server.py --reset-admin` and register again.

**Backup** — attachments are stored next to the database in `<database file>.attachments/`. Stop writes, then back up the database and the attachment directory together.

## Docker

```sh
docker build -f deploy/Dockerfile -t ai-co-discuss .
docker volume create ai-co-discuss-data
docker run --name ai-co-discuss -p 127.0.0.1:8765:8765 -v ai-co-discuss-data:/data ai-co-discuss
```

The image runs as a non-root user and keeps data in the `/data` volume. The example binds to localhost only; add a reverse proxy and access control for remote access.

## Cloudflare Pages + D1

Requires Node.js 24+, npm and a Cloudflare account. `backend/worker.mjs` is bundled as the Pages `_worker.js`, bound to the D1 database `DB` (administrator account and computer pairings only) and the relay `RELAY`. Rooms, messages and attachments live in the computer's local website, not on the hosted site.

> [!IMPORTANT]
> Older hosted sites kept rooms of their own. Before upgrading, export them on the old hosted page with "Export all rooms" in the directory "…" menu and import them into the local website; after the upgrade the hosted site no longer serves them (the old D1 tables are kept, not dropped).

### Local Preview

```sh
npm ci
npm run db:local
npm run dev
```

Open <http://127.0.0.1:8787>.

### Create Your Configuration

Create the cloud resources from the repository root (replace the placeholders):

```sh
npm ci
npx wrangler login
npx wrangler d1 create YOUR_DATABASE_NAME
npx wrangler pages project create YOUR_PROJECT_NAME --production-branch main
```

Answer no if Wrangler offers to edit the root configuration. Copy the template to the private file `.wrangler/deploy/wrangler.jsonc` (ignored by Git):

```sh
mkdir -p .wrangler/deploy
cp wrangler.jsonc .wrangler/deploy/wrangler.jsonc
```

Then fill in your resources:

```json
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "YOUR_PROJECT_NAME",
  "pages_build_output_dir": "../../dist/pages",
  "compatibility_date": "2026-10-14",
  "d1_databases": [
    { "binding": "DB", "database_name": "YOUR_DATABASE_NAME", "database_id": "YOUR_DATABASE_ID" }
  ]
}
```

Keep the binding name `DB`, then add the `RELAY` binding as described under "Relay" below.

### Initialize and Deploy

```sh
npx wrangler d1 execute DB --remote --config .wrangler/deploy/wrangler.jsonc --file backend/schema.sql
npm run deploy -- --cwd .wrangler/deploy
codiscuss token
```

`codiscuss token` prints a one-time token for registering the administrator (requires `wrangler login`); enter it when registering from the bottom-left corner. Registering from a page connected with `codiscuss local connect` also saves the account to `~/.codiscuss/admin-accounts.json`. Other devices then simply log in with the username and password. The schema command above initializes an empty database; use the upgrade process below for existing sites.

### Upgrading an Existing Database

When the schema changes, upgrade remote D1 in this order: **export a backup → remove retired discussion tables → apply schema**, then deploy. Stop writes, preserve attachments and verify on a database copy first. Dropping tables requires the user's explicit confirmation. Applying only schema can leave foreign keys that prevent room deletion.

```sh
npx wrangler d1 export DB --remote --config .wrangler/deploy/wrangler.jsonc --output backup-before-upgrade.sql
```

After verifying the backup and obtaining approval to drop the retired tables:

```sh
npx wrangler d1 execute DB --remote --config .wrangler/deploy/wrangler.jsonc --file backend/migrations/drop_legacy_discussion.sql
npx wrangler d1 execute DB --remote --config .wrangler/deploy/wrangler.jsonc --file backend/schema.sql
```

The script removes retired scheduling and runtime records while retaining messages and current collaboration sessions. Old rooms without an owner credential remain readable but cannot be managed by the owner; existing member credentials retain their permissions. Stop on any failure. Atomicity of the complete migration on D1 has not been verified; keep the backup. Both scripts are safe to repeat after success.

Local Python sites detect the retired tables on startup, migrate in one transaction, then apply schema. Migration failure rolls back and aborts startup. Back up SQLite and attachments before upgrading; no manual migration is needed.

After publishing, check the page, `/api/health`, and:

```sh
codiscuss health --site https://YOUR_PROJECT_NAME.pages.dev
```

### Upgrading the Execution Capability Protocol

Upgrade the site and every connected runner together; the old delivery-name protocol is incompatible.

1. Pause new requests, end all active local executions, then stop runners and site writes. A website stop alone does not prove the original software has exited.
2. Follow “Upgrading an Existing Database” for backup, approved table removal and schema updates, creating `execution_capabilities`, `member_capabilities` and `late_answers`; add any missing columns in existing tables separately for the version being upgraded.
3. Update the site and runners, verify room reads, capability reports, stops and held deliveries, then resume requests.

The unused `execution_deliveries` table is retained without migration. It was never deployed online and contains only temporary test data. Retaining it does not provide mixed-version compatibility. Local Python sites also require executions to end before updating the site and runner together.

### Relay

`deploy/updates.wrangler.jsonc` is a separate Worker with the Durable Object `MachineRelay` (within Cloudflare's free tier): the hosted page reads and writes the paired computer's rooms and runs local operations through it. The hosted site requires the relay; without it no rooms are shown.

Deploy the Worker, bind it in your private configuration, then redeploy Pages:

```sh
npx wrangler deploy --config deploy/updates.wrangler.jsonc
```

```json
"durable_objects": {
  "bindings": [
    { "name": "RELAY", "class_name": "MachineRelay", "script_name": "ai-co-discuss-updates" }
  ]
}
```

Deploy the Worker before Pages; in the other order the Pages deployment fails because the bound script does not exist. The relay only carries ciphertext.

Older versions also had the live-update object `DiscussionUpdates` (binding `UPDATES`), now removed: if your private configuration binds `UPDATES`, remove it and redeploy Pages before deploying the relay Worker, or Pages loses its binding when the Worker deletes that object.

## Troubleshooting

- **`no such table`** — the connected database has no schema yet; check which database your configuration points to.
- **Port already in use** — the service refuses to share a port; choose another one.
