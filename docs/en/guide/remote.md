# Phones and Remote Access

Away from home, open the online site on a phone, tablet, or another computer. Encrypted relay lets you view rooms, send messages, create rooms, and control the AI on your computer.

## Is there an online site ready to use?

The npm installation gives you a local site. It does not include a public online site. Remote access requires an online site that has been deployed. If one is already available, ask its deployer for a one-time access code. To deploy your own, use the free Cloudflare Pages, D1, and relay Worker plan.

The online site does not store rooms or messages and has no account passwords. It stores the computers you link and their signed device lists. Room data stays on your computer.

If you installed with npm install --global ai_co_discuss, you need the source repository to deploy your own site. Clone it with `git clone https://github.com/huyan1458/ai_co_discuss.git`, or download and extract the source ZIP. The npm package does not include the full Cloudflare build source or deployment templates. Then follow the [deployment guide](../deployment.md#cloudflare-pages--d1) to create resources, initialize the database, and deploy.

## How to use it

### 1. Link your computer to the online site

On the computer running the AI, use either method:

- **CLI:** In a terminal, run:
  `codiscuss local connect https://your-site`
  If this is also the computer where you deployed the site and wrangler login is configured, the command creates a one-time token and links it automatically. If the AI runs on another computer, run `codiscuss token` on the deployment computer, then run `codiscuss local connect https://your-site --setup-key <token>` on the AI computer.
- **Management panel access code:** On the deployment computer, open the management panel and go to **Overview** → **This computer** → **Online site** → **Generate access code**, or run `codiscuss admin entry code`. On the AI computer, open its management panel, go to **Overview** → **This computer** → **Online site** → **Bind**, and paste the **Access code**.

To stop remote access, select **Unlink** in the management panel or run `codiscuss local disconnect https://your-site`.

### 2. Pair your phone or tablet while at the computer

Pairing can create a passkey, a credential you unlock with your face, fingerprint, or device passcode to confirm your identity.

Each remote device must be paired once at the computer. You do not need to register an account or remember a password.

1. On the computer's local site, open **Settings** → **Account** → **Paired devices** and select **Add device**. The site shows a QR code and a 12-character **Pairing code**. It is valid for 2 minutes and works once.
   - For a borrowed device, select **Temporary device (1 day of access)**. It cannot be renewed.
   - If an older browser does not support passkeys, such as an Android tablet without Google Play services, you can select **Allow access without a passkey**. This skips daily confirmation and renewal. After expiry, pair again at the computer. Use only when needed.
2. Scan the QR code with the phone or tablet. If scanning is unavailable, open your online site on that device, go to Settings, and enter the code in the **Pair this device** form. When scanning, verify the computer's key fingerprint.
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

## Things to keep in mind

Phones support portrait layout only. Tablets support both portrait and landscape.

- **Rooms are unavailable when the computer is offline:** If the computer is off, asleep, or its local service is stopped, the room list shows **Rooms (computer offline)** or **Rooms (computer not connected)**. It reconnects when the computer comes back online.
- **Timed-out requests are not resent automatically:** If the computer does not respond in time, the page says “Result unconfirmed.”. Check the room to see whether the action took effect before trying again.
- **Some changes require the computer:** Changing software executable paths, browsing outside Saved projects, and adding a new device must be done at the computer.
- **Clearing browser data requires pairing again:** Clearing browser data removes the device key. The handoff command also expires after 10 minutes, so keep the phone's clock reasonably accurate.
