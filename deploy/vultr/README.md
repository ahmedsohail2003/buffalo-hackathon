# Deploy STARHAND on Vultr

STARHAND runs on one small Vultr VPS: Caddy serves HTTPS and passes everything to the Node server
(`server/index.mjs`), which serves the built app and holds the Gemini and ElevenLabs keys. The
browser never sees a key. HTTPS is required, because browsers only allow the webcam and the
microphone on secure pages.

`cloud-init.yaml` does the whole install on first boot: firewall, Node 22, Caddy, a `starhand`
system user, a clone of the repository, `npm ci`, `npm run build`, a systemd service, and a
Caddyfile for your domain plus a free `<ip-with-dashes>.sslip.io` name.

## What you need

- A Vultr account with a payment card on file. Vultr asks for a card even when you use credits.
- About 15 minutes.
- Optional: a domain name, for example a free one from the MLH partner registrars.
- Your Gemini API key and your ElevenLabs API key. They go on the server only, never in the repository.

## Steps in the Vultr dashboard

1. **Claim the MLH credits.** Open <https://discover.vultr.com/mlh> and follow the MLH offer to
   create your account (or sign in). The credit is applied to that account.
2. **Add a payment method.** Go to **Billing**, add a card, and confirm that the MLH credit shows
   in your balance.
3. **Add your SSH key** (recommended). Go to **Account > SSH Keys > Add SSH Key** and paste your
   public key, for example the contents of `~/.ssh/id_ed25519.pub`.
4. **Deploy the server.** Choose **Deploy +** > **Deploy New Server**, then:
   1. Type: **Cloud Compute - Shared CPU**.
   2. Location: **New Jersey (ewr)** or **Toronto (yto)**. Both are close to Buffalo.
   3. Image: **Ubuntu 24.04 LTS x64**.
   4. Plan: **vc2-2c-4gb** (2 vCPU, 4 GB memory).
   5. Open **Additional Features**, turn on **Cloud-Init User-Data**, and paste the whole of
      `deploy/vultr/cloud-init.yaml`. It deploys `claude/pensive-johnson-mek8ib`, where the
      project lives until it is merged into `main`; after that merge, change `BRANCH=` to `main`
      in the pasted text (or run `starhand-update main` on the server). You can set `DOMAIN=`
      now or later.
   6. Select your SSH key, set the hostname and the label to `starhand`, and choose **Deploy Now**.
5. **Wait for the install.** It takes about 5 to 8 minutes after the server shows **Running**.
   Copy the server's IPv4 address from the dashboard, then check progress:

   ```bash
   ssh root@SERVER_IP 'cloud-init status --wait; cat /root/STARHAND.txt'
   ```

   The last command prints the app's address, for example `https://45-76-1-2.sslip.io`.
6. **Add the keys.**

   ```bash
   ssh root@SERVER_IP
   nano /etc/starhand.env        # fill GEMINI_API_KEY and ELEVENLABS_API_KEY
   systemctl restart starhand
   curl -s https://45-76-1-2.sslip.io/api/health
   ```

   The health check should say `"gemini":true` and `"elevenlabs":true`. For the designed voices,
   also set `ELEVENLABS_VOICE_MISSION` and `ELEVENLABS_VOICE_COWORKER` (see "Voices and sounds").
   Without them the server uses a premade ElevenLabs voice.
7. **Point your domain at the server** (optional). At your domain's DNS provider, add an
   **A record**: name `@` for the bare domain (or a subdomain such as `starhand`), value
   `SERVER_IP`, TTL 300. Then tell Caddy about it:

   ```bash
   ssh root@SERVER_IP
   nano /etc/starhand/deploy.env  # set DOMAIN=starhand.example.tech.study
   starhand-caddy                 # rewrites the Caddyfile and reloads Caddy
   ```

   Caddy gets a Let's Encrypt certificate as soon as the name resolves to the server. Check with
   `dig +short starhand.example.tech.study`. The sslip.io address keeps working.
8. **Open the app** at your domain or the sslip.io address, allow the camera and the microphone,
   and run the demo.

## Day-to-day

| Task | Command (on the server, as root) |
| --- | --- |
| Deploy the latest commit | `starhand-update` (or `starhand-update some-branch`) |
| Follow the app log | `journalctl -u starhand -f` |
| Follow the HTTPS log | `journalctl -u caddy -f` |
| Restart after editing keys | `systemctl restart starhand` |
| Show the addresses again | `cat /root/STARHAND.txt` |

The server logs one line per request (method, path, status, time). It never logs keys, query
strings, headers or bodies.

**After judging, destroy the server** (Vultr dashboard: the server's menu > **Destroy**) so it
stops using credit.

## The same with vultr-cli

Install [vultr-cli](https://github.com/vultr/vultr-cli), then create an API key in
**Account > API** (allow your current IP address there). Flag names can change between
versions; check them with `vultr-cli instance create --help`.

```bash
export VULTR_API_KEY=your-api-key
vultr-cli regions list | grep -E 'ewr|yto'
vultr-cli plans list | grep vc2-2c-4gb
vultr-cli os list | grep -i '24.04'                # Ubuntu 24.04 LTS x64 is os id 2284
vultr-cli ssh-key create --name laptop --key "$(cat ~/.ssh/id_ed25519.pub)"
vultr-cli ssh-key list                             # note the key id

vultr-cli instance create --region ewr --plan vc2-2c-4gb --os 2284 \
  --label starhand --host starhand --ssh-keys SSH_KEY_ID \
  --userdata "$(cat deploy/vultr/cloud-init.yaml)"
vultr-cli instance list                            # note the id and main_ip

# Only if the domain's DNS is hosted at Vultr; otherwise add the A record at your registrar:
vultr-cli dns domain create --domain example.tech.study --ip SERVER_IP
vultr-cli dns record create example.tech.study --type A --name starhand --data SERVER_IP --ttl 300

vultr-cli instance delete INSTANCE_ID              # after the event
```

Or with the HTTP API directly (`user_data` must be base64):

```bash
curl -s https://api.vultr.com/v2/instances \
  -H "Authorization: Bearer $VULTR_API_KEY" -H 'Content-Type: application/json' \
  -d "{\"region\":\"ewr\",\"plan\":\"vc2-2c-4gb\",\"os_id\":2284,\"label\":\"starhand\",\"hostname\":\"starhand\",
       \"sshkey_id\":[\"SSH_KEY_ID\"],\"user_data\":\"$(base64 -w0 deploy/vultr/cloud-init.yaml)\"}"
```

## Voices and sounds (ElevenLabs, run once on your laptop)

```bash
ELEVENLABS_API_KEY=... node scripts/el-assets.mjs voice mission     # previews in private/
ELEVENLABS_API_KEY=... node scripts/el-assets.mjs save mission GENERATED_VOICE_ID
ELEVENLABS_API_KEY=... node scripts/el-assets.mjs voice coworker
ELEVENLABS_API_KEY=... node scripts/el-assets.mjs save coworker GENERATED_VOICE_ID
ELEVENLABS_API_KEY=... node scripts/el-assets.mjs sfx               # public/sfx/*.mp3, then commit
```

The `save` commands print the `ELEVENLABS_VOICE_*` lines for `/etc/starhand.env`.

## Smoke tests with real keys

```bash
scripts/smoke-tts.sh https://45-76-1-2.sslip.io      # speech through the deployed server
node scripts/smoke-gemini.mjs --server https://45-76-1-2.sslip.io
GEMINI_API_KEY=... node scripts/smoke-gemini.mjs     # or straight to Gemini from your laptop
```

## What runs where

| Piece | Where | Notes |
| --- | --- | --- |
| Caddy | ports 80 and 443 | Automatic HTTPS for the domain and the sslip.io name. `flush_interval -1` streams speech and server-sent events without buffering. API responses are not compressed. |
| `starhand.service` | 127.0.0.1:8787, user `starhand` | `node server/index.mjs` in `/opt/starhand/app`, keys from `/etc/starhand.env` (root only, mode 600) |
| Firewall (ufw) | | Allows SSH, 80/tcp, 443/tcp and 443/udp only |
