# Phones and Remote Access

Away from home, open the online site on a phone, tablet, or another computer. Encrypted relay lets you view rooms, send messages, create rooms, and control the AI on your computer.

## Is there an online site ready to use?

The npm installation gives you a local site. It does not include a public online site. Remote access requires an online site that has been deployed. If one is already available, ask its deployer for a one-time access code. To deploy your own, use the free Cloudflare Pages, D1, and relay Worker plan.

The online site does not store rooms or messages and has no account passwords. It stores the computers you link and their signed device lists. Room data stays on your computer.

For help deploying or updating your own site, select “Ask the platform steward to deploy” in the device pairing area of Settings. The steward verifies the resources and asks before each Cloudflare write. The deployment conversation stays on your computer. If you switch AI apps, use “Past conversations” under “Steward configuration” on the [Platform steward page](steward.md).

If you installed with npm install --global ai_co_discuss, you need the source repository to deploy your own site. Clone it with `git clone https://github.com/huyan1458/ai_co_discuss.git`, or download and extract the source ZIP. The npm package does not include the full Cloudflare build source or deployment templates. Then follow the [deployment guide](../deployment.md#cloudflare-pages--d1) to create resources, initialize the database, and deploy.

## How to use it

### 1. Link your computer to the online site

On the computer running the AI, use either method:

- **CLI:** In a terminal, run:
  `codiscuss local connect https://your-site`
  If this is also the computer where you deployed the site and wrangler login is configured, the command creates a one-time token and links it automatically. If the AI runs on another computer, run `codiscuss token` on the deployment computer, then run `codiscuss local connect https://your-site --setup-key <token>` on the AI computer.
- **Management panel access code:** On the deployment computer, open the management panel and go to **Overview** → **This computer** → **Self-hosted relay** → **Generate access code**, or run `codiscuss admin entry code`. On the AI computer, open its management panel, go to **Overview** → **This computer** → **Self-hosted relay** → **Bind**, and paste the **Access code**.

To stop remote access, select **Unlink** in the management panel or run `codiscuss local disconnect https://your-site`.

### Reverse proxy on your own domain

Point an HTTPS reverse proxy at the bound online site. Forward the page and API content unchanged, including paths, queries, WebSocket upgrades and subprotocols. Keep the browser on your own address.

Open **This computer → Self-hosted relay → Other access addresses** in the management panel. Add an origin such as `https://relay.example.com`, optionally with a port, without a path. This server delivers the page and can use the access granted to devices paired there. Add only origins you trust.

On the computer’s local page, open **Settings → Account**, choose the pairing address, then select **Add device**. Open the new link or scan its QR code and pair again to create a passkey on the new origin. The bound site remains the default. Exact matching is the default. Select **Include subdomains** to allow the base hostname and its descendants at any depth. For example, example.com includes a.example.com and excludes badexample.com. A suffix rule without a port allows any HTTPS port. An explicit port, including :443, must match. Choose **Enter an address** to pair at a specific origin. Each subdomain requires separate pairing, and its operator can use the permissions of devices paired there. Removing a rule revokes only devices and pairing codes no longer covered by the bound site or another rule. To add a suffix rule from the CLI, run `codiscuss admin site origins add https://example.com --subdomains`. The CLI equivalents are `codiscuss admin site origins list`, `codiscuss admin site origins add <url>` and `codiscuss admin site origins remove <url>`.

### 2. Pair your phone or tablet while at the computer

Pairing can create a passkey, a credential you unlock with your face, fingerprint, or device passcode to confirm your identity.

Each remote device must be paired once at the computer. You do not need to register an account or remember a password.

1. On the computer's local site, open **Settings** → **Account** → **Paired devices** and select **Add device**. The site shows a QR code and a 12-character **Pairing code**. It is valid for 2 minutes and works once.
   - For a borrowed device, select **Temporary device (1 day of access)**. It cannot be renewed.
   - If an older browser does not support passkeys, such as an Android tablet without Google Play services, you can select **Allow access without a passkey**. This skips daily confirmation and renewal. After expiry, pair again at the computer. Use only when needed.
2. Scan the QR code with the phone or tablet. If scanning is unavailable, open your online site on that device, go to Settings, and enter the computer ID shown alongside the code and the code itself in the **Pair this device** form. When scanning, verify the computer's key fingerprint.
3. Follow the device prompt to confirm with Face ID, fingerprint, or the device passcode. The browser creates a non-exportable device key and passkey. The computer's rooms then appear under **Rooms** in the left sidebar.

### 3. Authorization, daily confirmation, and revocation

- **30-day access and renewal:** Each regular device is authorized for 30 days. During the final 7 days before expiry or within 30 days after expiry, open Settings on the phone and confirm with the passkey to renew for another 30 days. After the grace period, pair again at the computer.
- **Daily confirmation:** On the first visit to the online site each day, passkey-enabled devices ask for Face ID, fingerprint, or the device passcode. For the next 24 hours you can create rooms, send messages, and change project permissions without another prompt.
- **Review activity and unlink:** On the computer or any paired device, go to **Settings** → **Account** → **Paired devices**. Select the clock icon (**Activity**) to review pairing, confirmation, and remote actions. Select **Unpair** for a lost device or one showing activity you do not recognize. This blocks future remote actions but does not stop running tasks or undo file changes.

### 4. What you can do while away

While your computer is on and its local service is running, paired phones and tablets have nearly the same room controls as the computer:

- View rooms and live updates, send messages, upload attachments, use voice input and read-aloud, and export backups.
- Create rooms; invite or recall members; change models and permissions; add API keys; and create external-member invitations.
- **Project folders remain scoped by the computer:** Remote devices can choose folders inside **Saved projects** on the computer. Use the folder button at the end of the project path field to browse. To allow a wider scope, add the parent folder to Saved projects on the computer. Other paths a room or group already has from the computer (such as a temporary path) can still be used or removed from a remote device, but a remote device cannot add new ones. In “Manage projects…”, drag a project by its left handle and select “Save” to update the order in the picker.

## Invite a temporary external user

Hosted accounts can invite guests. With a custom-domain tunnel, guests open `/guest/` on the tunnel domain. When the owner signs in through an entry Worker, guests open `/guest/` on the Pages site linked to the hosted account. Send the complete link generated by the room. Guests can join without signing in. If the site is unavailable, ask the administrator to check the account’s direct tunnel identity or online site binding.

On the computer linked to your online site, in the room choose “Invite AI”, then “Invite an external user”. Set the duration, protection level, and what the guest can view, then send them the link. Guests can access only this room and do not become paired devices. “Chat only” does not expose project files. Private chats require a separate grant and are read-only for guests.

- Conservative protection temporarily limits local AI permissions and pauses members that cannot run under those limits. Trust mode keeps existing member permissions and cannot guarantee that AI will not read other rooms. Use it only with someone you trust.
- Before the link is redeemed, choose “Void” in the safety bar or right sidebar. Once the guest is in the room, choose “Disconnect now”.

Guests and external experts look up the public keys for the computer ID in their invitation. The site no longer publishes an anonymous computer list. If an older external expert client reports that it cannot find the computer, update AI CoDiscuss and reopen the full invitation link. To use an external expert invitation code manually, supply both --site and --machine.

## Faster access from mainland China

Your phone and computer meet at a relay on Cloudflare. Choose where it lives in the computer’s management panel under Overview → Local → Self-hosted relay → Relay region, and **match it to where your phone and computer enter Cloudflare**:

- **Phone without a proxy, computer direct or through a US node**: direct connections from mainland China to Cloudflare’s free plan usually land on the US West Coast, so choose **Western North America**.
- **Phone and computer both through Asian nodes** (a proxy in Hong Kong or Japan, or a Hong Kong front server): choose **Asia Pacific**.

After a change, the computer and paired devices reconnect by themselves; switch when no operation is in progress. Direct connections to Cloudflare from mainland China can lose packets and slow down at evening peak hours; a proxy on the phone is usually much faster. If the computer goes online through a proxy app such as Clash, you can route the online site address through a chosen node, then use Reconnect now in the panel or `codiscuss admin site reconnect`.

## Things to keep in mind

In the network report, `relay_unresponsive` means the relay closed a connection after two consecutive business request timeouts. A `relay_probe_timeout` means the computer started reconnecting after the relay missed an application probe. A `relay_timeout_unreceived` means the computer had a complete receipt history for that connection and had not seen the request when the phone reported its timeout.

In the network report, `machine_unregistered` means the relay could not find the current computer connection. The `heartbeat` source means the computer started reconnecting. The `device_request` source is a later report from the phone.

When the network is unstable, run `codiscuss admin site network --since 24h --by 10m` on the computer to see failures, disconnects and latency by segment. Use ISO timestamps with offsets for `--since` and `--until` to compare two evenings.

Phones support portrait layout only. Tablets support both portrait and landscape.

The relay tolerates brief packet loss, wake-up delays and large-file send backlogs, and reconnects if it remains unresponsive. An individual operation may time out sooner; check whether a write took effect before retrying it.

- **Rooms are unavailable when the computer is offline:** If the computer is off, asleep, or its local service is stopped, the room list shows **Rooms (computer offline)** or **Rooms (computer not connected)**. It reconnects when the computer comes back online.
- **Timed-out requests are not resent automatically:** If the computer does not respond in time, the page says “Result unconfirmed.”. Check the room to see whether the action took effect before trying again.
- **Some changes require the computer:** Changing software executable paths, browsing outside Saved projects, and adding a new device must be done at the computer.
- **Attachment cache:** Pictures and files viewed through the relay are cached in this device’s browser and cleared when you unpair on this device.
- **Clearing browser data requires pairing again:** Clearing browser data removes the device key. The handoff command also expires after 10 minutes, so keep the phone's clock reasonably accurate.

**Relay timing records.** Each file read through the relay is logged on the computer in `relay-timing.jsonl` in the service directory, with the time spent on the phone link, site processing, computer link and local processing, and the locations each end connected to. Paths, content and credentials are not recorded. Nothing is shown in the interface; you or an AI read this file when diagnosing slow remote access.
