# Deployment

English | [简体中文](../deployment.md)

The site can run locally (Python + SQLite) or be self-hosted on Docker or Cloudflare Pages + D1. Python and Docker deployments each keep their own rooms, not synced between them; the Cloudflare site keeps no rooms and no accounts, only the bound computer and the device list it signs, and paired devices read and write the computer's rooms through the relay. Wherever the site runs, agents and the runner stay on your own machine, and a hosted site connects to it through [`codiscuss local connect`](guide/remote.md).

> [!WARNING]
> Self-hosted Python sites support administrator sign-in. Room reads have no per-room access controls, so anyone who can reach the room site can read its rooms. Read the [security policy](../../.github/SECURITY.md) and put access control in front of the service before exposing it publicly.

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

Python 3.10+ with no third-party dependencies. For long-running deployments, add your own process manager and HTTPS reverse proxy, and disable response buffering for `/api/updates` so live updates work.

**Administrator** — when bound to `127.0.0.1`, every visitor is the administrator. On other addresses, register from the bottom-left corner on first visit with the setup token (`DISCUSS_ADMIN_SETUP_KEY`, or a random token printed to the startup log). Once logged in as the administrator, you can speak and manage any room as the user from other devices such as a tablet or phone. If you forget the password, run `python server.py --reset-admin` and register again.

**Backup** — attachments are stored next to the database in `<database file>.attachments/`. Stop writes, then back up the database and the attachment directory together.

## Docker

Build the image from the repository root. Before the first start, set a random setup token in your shell and keep it private. In PowerShell, use `$env:DISCUSS_ADMIN_SETUP_KEY = Read-Host "Setup token"`. In Bash, use `read -rs -p "Setup token: " DISCUSS_ADMIN_SETUP_KEY` followed by `export DISCUSS_ADMIN_SETUP_KEY`. The `-e` option below passes that variable into the container.

```sh
docker build -f deploy/Dockerfile -t ai-co-discuss .
docker volume create ai-co-discuss-data
docker run -d --name ai-co-discuss -p 127.0.0.1:8875:8765 -e DISCUSS_ADMIN_SETUP_KEY -v ai-co-discuss-data:/data ai-co-discuss
```

The image runs as a non-root user. Its named volume at `/data` stores rooms and attachments. Host port 8875 serves the Docker site, leaving the default port 8765 free for the AI computer's local service.

1. **Register an administrator.** On the Docker host, open `http://127.0.0.1:8875`. Use the account control at the bottom left and choose **Set up admin account**. Enter the setup token and choose a login name and password. The server inside the container listens on `0.0.0.0`, so registration is required even when you open it from the host's loopback address. If you omitted the environment variable, the server generates a token on first start. Read it privately on the host with `docker logs ai-co-discuss`. After registration, sign in with the account password.
2. **Connect your AI tools.** If Docker and your configured AI tools run on the same computer, run `codiscuss local connect http://127.0.0.1:8875` there. It starts the local service and opens a private connection link to the Docker site. Open that link in a browser on the AI computer, sign in to the Docker site, and create a room there with your local AI. If a browser does not open automatically, use `--no-open` and open the printed link yourself. Keep the link private because it contains the service credential.
3. **Access from your LAN.** The example port mapping accepts connections only from the host. For direct LAN browsing, publish `-p <host-LAN-IP>:8875:8765` when creating the container and allow that port only from your trusted LAN. Other computers can visit `http://<host-LAN-IP>:8875`. The site has no per-room read isolation. To **connect AI tools on another computer**, put the Docker site behind an HTTPS reverse proxy and run `codiscuss local connect https://your-site.example` on the AI computer. The connection command accepts HTTP only for `127.0.0.1` or `localhost`. Other devices should visit the ordinary site address.

## Cloudflare Pages + D1

Requires Node.js 24+, npm and a Cloudflare account. `backend/worker.mjs` is bundled as the Pages `_worker.js`, bound to the D1 database `DB` (only the bound computer, its device list and display name) and the relay `RELAY`. Rooms, messages and attachments live in the computer's local website, not on the hosted site.

Select “Ask the platform steward to deploy” in the device pairing area of Settings, or run `codiscuss steward ask cloudflare-deploy --confirm`. Before first use, choose an app on the “Platform steward” page. If source is missing, the steward asks before cloning the tag matching your installed version. It shows the resources and commands and waits for approval before each Cloudflare write. It backs up D1 before an update. After switching apps, find “Past conversations” under “Steward configuration” on the right of the Platform steward page. See the [steward guide](guide/steward.md).

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
codiscuss local connect https://YOUR_PROJECT_NAME.pages.dev
```

On the machine that deployed the site (after `wrangler login`), `codiscuss local connect` creates a one-time binding token, binds this computer to the site and opens the local device settings, where phones and other devices pair. If agents run on another computer, run `codiscuss token` on the deploying machine and add `--setup-key TOKEN` there. Each token works once. The schema command above initializes an empty database; use the upgrade process below for existing sites.

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

The hosted site no longer has an administrator account. Upgrade the site and codiscuss together, run `codiscuss local connect https://your-site` once to bind again with a new token, then pair each device again in front of the computer. The `--remote-port` entry of the local site is retired. A self-hosted Python site still signs in with an administrator account and its requests are not device-signed, so the computer trusts that site's administrator as you.

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

### Entry for Hosted Accounts (Optional)

If you use hosting and want hosted accounts' users to sign in from outside without your own domain, also deploy the entry Worker (after the relay, since it uses the relay's Durable Object):

```sh
node scripts/entry_config.mjs
npx wrangler deploy --dry-run --config .wrangler/entry.json
npx wrangler deploy --config .wrangler/entry.json
```

The generator copies the Pages DB binding, including its required database_id, from `.wrangler/deploy/wrangler.jsonc` into the private `.wrangler/entry.json`. Check that the dry run lists the same DB and the RELAY binding before deploying.

It gets its own `workers.dev` address (such as `https://codiscuss-entry.<account-subdomain>.workers.dev`), on a different origin from the online site, so hosted accounts' pages can't reach your paired devices' keys. Put this address in the `vars` of your private configuration and redeploy Pages; the online site then hands it to hosted computers that connect:

```json
"vars": { "ENTRY_URL": "https://codiscuss-entry.<account-subdomain>.workers.dev" }
```

To connect a hosted computer: in the admin panel of your computer (the one that deployed the online site), go to **Overview → This computer → Self-hosted relay**, choose **Generate access code**, fill in the deployment config path and online site address, and generate it (wrangler must be signed in; the code is single-use, and generating a new one voids unused ones). Send it to the hosted computer, paste it under **Overview → This computer → Self-hosted relay → Bind** there, then turn on **Self-hosted relay** under **Sign-in entry → Hosted account entry**; it fetches the entry address and starts what it needs (an enabled Cloudflare Tunnel is unaffected and both can be on; `codiscuss admin entry join <code>` does all of this in one step). Hosted accounts can invite external experts by default: through your own domain when it is on, otherwise the panel binds each account to the online site for you; no access code is needed. The link the panel shows carries the computer's ID (`?m=…`); send it to the users. Their requests reach this computer's sign-in entry through the entry Worker and the relay, while sign-in, sessions and entry protection all stay on the computer. Cloudflare can see this traffic (as with a tunnel on your own domain), and every page request counts against the free Workers quota.

## Troubleshooting

- **`no such table`** — the connected database has no schema yet; check which database your configuration points to.
- **Port already in use** — the service refuses to share a port; choose another one.

## Official share site and website hosting (operators)

Online share links (`share.codiscuss.com`) and “Deploy as website” (`*.bimcanvas.com`) are provided by the operator's official services; neither visitors nor publishers deploy anything. The code and deployment notes for these services are not in this repository.
