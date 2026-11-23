# Running the planner on the Synology (Portainer)

The server stores the plan on the NAS, so every device (laptop, phone, your partner's computer) opens the same plan and changes sync within about 10 seconds. `wedding-planner.html` still works on its own when opened as a file.

## 1. Copy the files to the NAS

In DSM **File Station**, inside the `docker` shared folder, create:

```
docker/wedding-planner/app
docker/wedding-planner/data
```

Upload **`wedding-planner.html`** and **`server.js`** into `app`. Leave `data` empty — the server fills it.

> No `docker` shared folder? Create one in *Control Panel → Shared Folder*, or use any folder and change the `/volume1/docker/...` paths in `docker-compose.yml`.

## 2. Create the stack in Portainer

1. **Stacks → Add stack**, name it `wedding-planner`.
2. Choose **Web editor** and paste the contents of `docker-compose.yml`.
3. Optional: uncomment `AUTH_USER` / `AUTH_PASS` to require a login.
4. **Deploy the stack.**

The container should turn *healthy* within a minute. Its log shows `Wedding planner running on port 8080`.

## 3. Open it

`http://<your-nas-ip>:8095` (for example `http://192.168.1.20:8095`).

The header shows **synced to server** when it's working.

### Bring over your existing plan

A plan you made in the standalone file stays in that browser; the server version starts fresh. To move it:

1. In the old file: **Save / Load → Export plan to file**
2. On the server version: **Save / Load → Open plan from file…**

## Updating

- **New `wedding-planner.html`:** replace the file in `app` and reload the page. No restart needed.
- **New `server.js`:** replace the file, then restart the container in Portainer.

## Backups

Everything lives in `docker/wedding-planner/data`:

| Path | What it is |
|---|---|
| `current.json` | the live plan |
| `saves/` | named configurations from Save / Load |
| `backups/` | an automatic snapshot of the live plan at most once an hour (newest 200 kept) |

Add that folder to **Hyper Backup** if you want it off the NAS too. To roll back, stop the container, copy a file from `backups/` over `current.json`, and start it again.

## Using it outside your home network

Don't forward port 8095 on your router. Instead:

1. Turn on the login (`AUTH_USER` / `AUTH_PASS`).
2. In DSM: **Control Panel → Login Portal → Advanced → Reverse Proxy**, add a rule from `https://wedding.<your-ddns>.synology.me` to `http://localhost:8095`.
3. Use the HTTPS address. Without HTTPS, the password travels in plain text.

Alternatively, use Tailscale or the Synology VPN and keep the planner reachable only on your home network.

## Two people editing at once

Each device saves about a second after a change and checks for other devices' changes every 10 seconds. If two devices change the plan at the same moment, the second one is asked whether to load the other version or keep its own. Whichever you discard stays available with **Undo** on that device.
