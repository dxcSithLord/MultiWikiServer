# Operations

How to run this fork as a long-lived self-hosted service (the reference deployment is a
Raspberry Pi behind Tailscale, but the steps are host-agnostic). Build/dev basics are in
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) §10; the family task-list content + seeding live in
the separate `moving-house-app` repo (`DEPLOY-PI.md`).

## 1. Listener configuration

`npm start` binds IPv6 loopback `[::1]:8080` by default. Override the listener by creating the
git-ignored `dev/mws.dev.json` — an array of listen-arg objects:

```json
[
  { "host": "127.0.0.1", "port": 8080, "secure": true }
]
```

- **`host`** — pin it explicitly for a deployment (e.g. loopback when fronted by a proxy).
- **`secure: true`** — set this when a TLS-terminating proxy sits in front (e.g. Tailscale
  Serve). It maps to `expectSecure`, which adds the `Secure` attribute to the session cookie
  even though MWS itself speaks plain HTTP to the proxy. The proxy must preserve the `Host`
  header (Tailscale Serve does) so the CSRF referer-host check passes.
- `key` / `cert` — set these instead if MWS should terminate TLS itself.

## 2. systemd service

Run MWS under systemd so it restarts on boot and on failure. Example unit
(`/etc/systemd/system/mws.service` — adjust `User`, paths, and Node location):

```ini
[Unit]
Description=MultiWikiServer (HTMX fork)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/src/movinghouse/mws-fork
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now mws.service
sudo systemctl status mws.service
journalctl -u mws.service -f          # follow logs
```

After deploying new code: `git pull && npx --yes npm@10 install && npm run build &&
sudo systemctl restart mws.service`.

## 3. Tailscale Serve (in-tailnet HTTPS)

With the listener on loopback, expose it inside your tailnet over HTTPS:

```sh
tailscale serve --bg 8080
tailscale serve status            # shows the https://<host>.<tailnet>.ts.net URL
```

Tailscale provisions the TLS certificate and preserves the `Host` header. Pair this with
`secure: true` in the listener so cookies are marked `Secure`. This keeps the service
**tailnet-only** — it is not published to the public internet.

## 4. First-run hardening

```sh
npm start init-store                              # creates admin / 1234
npm start reset-password admin <new-password>     # ROTATE the default immediately
```

Protect `passwords.key` (the password master salt): if it changes, every stored password must
be reset. See [`security.md`](security.md) for the full posture.

## 5. Backups

Back up the **entire data folder**, not just `store`:

- **Always** back up the whole `store` folder — every file is a data file; never delete any.
- Back up `package.json` / `package-lock.json` (records the exact MWS version) and
  `passwords.key`.
- The `cache` folder is regenerated on each start and can be excluded.

A backup of the entire `store` folder plus `package-lock.json` is enough for a Node developer
to reconstruct the running site.

## 6. Optional pre-push gate

If you push from the deployment host, the opt-in `dev/hooks/pre-push` gate runs build, tests,
the cutover/openapi skills, an audit, and the headless admin smoke before each push. See
[`testing.md`](testing.md). Use `SKIP_SMOKE=1 git push` on hosts without Chromium.
