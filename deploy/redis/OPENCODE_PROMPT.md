# Task: dedicated Redis 7 (TLS + ACL) in Docker for Chaos Whiteboard

You are on a Debian 10 server (OVH Gravelines, public IP 51.75.204.60) with Docker installed.
Set up a NEW, dedicated Redis container for the Chaos Whiteboard web app. The app runs on Vercel
and connects to this Redis over the internet. Do not touch or reuse any other Redis on this machine.

## Requirements (all must hold at the end)
1. Container name `chaos-redis`, image `redis:7.4-alpine`, `--restart unless-stopped`, memory limit 400m.
2. Redis listens ONLY with TLS, on host port **6380**. The plaintext port is disabled (`port 0`).
3. TLS certificate from Let's Encrypt for the hostname **`thevps.estragos.org`** (it already resolves to 51.75.204.60).
   - Use the `certbot/certbot` Docker image, so nothing old from Debian 10 is involved.
   - Check first which process owns port 80 (`ss -ltnp | grep ':80 '`).
     - If port 80 is free: use `--standalone` with `-p 80:80`.
     - If a web server owns it and serves that hostname: use `--webroot` with its document root.
     - Otherwise: stop and ask me.
   - Copy `fullchain.pem` and `privkey.pem` to `/opt/chaos-redis/tls/` as `cert.pem` and `key.pem`. Set owner `999:999` (the redis user in the image) and mode 0600.
   - Set up automatic renewal: a weekly cron or systemd timer that runs certbot renew, copies the files again with the same owner and mode, then runs `docker restart chaos-redis`.
4. Config file `/opt/chaos-redis/redis.conf` (owner 999:999, mode 0600), mounted read-only. Use exactly these settings, with two fresh random passwords (`openssl rand -hex 32` each):
   ```
   port 0
   tls-port 6380
   bind 0.0.0.0
   tls-cert-file /tls/cert.pem
   tls-key-file /tls/key.pem
   tls-auth-clients no
   tls-protocols "TLSv1.2 TLSv1.3"
   protected-mode yes
   dir /data
   appendonly yes
   appendfsync everysec
   maxmemory 256mb
   maxmemory-policy noeviction
   tcp-keepalive 60
   user default off
   user wb on >WB_PASSWORD ~wb:* &wb:* +@all -@dangerous +info
   user admin on >ADMIN_PASSWORD ~* &* +@all
   ```
   - The `wb` user is the one the app uses. It must keep exactly these rules. The app was tested with them: it needs EVAL, streams, pub/sub and INFO.
   - Data goes in a named volume `chaos-redis-data` mounted at `/data`.
5. Run command, adapting only the paths if needed:
   ```
   docker run -d --name chaos-redis --restart unless-stopped --memory 400m \
     -p 6380:6380 \
     -v /opt/chaos-redis/redis.conf:/usr/local/etc/redis/redis.conf:ro \
     -v /opt/chaos-redis/tls:/tls:ro \
     -v chaos-redis-data:/data \
     redis:7.4-alpine redis-server /usr/local/etc/redis/redis.conf
   ```
6. Firewall: TCP 6380 must be reachable from the internet. Check iptables/nftables/ufw on the host, and remember Docker manages its own iptables rules. Do NOT open 6379.
7. Save the secrets to `/root/chaos-whiteboard-redis.txt` (mode 0600) in this format, then show me that file's content:
   ```
   REDIS_URL=rediss://wb:WB_PASSWORD@thevps.estragos.org:6380
   ADMIN_URL=rediss://admin:ADMIN_PASSWORD@thevps.estragos.org:6380
   ```

## Acceptance tests (run them all and show the output)
```
# TLS + wb user works from the outside name
docker run --rm redis:7.4-alpine redis-cli --tls -h thevps.estragos.org -p 6380 --user wb --pass "$WB_PASSWORD" --no-auth-warning ping            # PONG
# wb user is fenced in
docker run --rm redis:7.4-alpine redis-cli --tls -h thevps.estragos.org -p 6380 --user wb --pass "$WB_PASSWORD" --no-auth-warning set other:x 1   # NOPERM
docker run --rm redis:7.4-alpine redis-cli --tls -h thevps.estragos.org -p 6380 --user wb --pass "$WB_PASSWORD" --no-auth-warning flushall       # NOPERM
# no plaintext and no anonymous access
redis-cli -h thevps.estragos.org -p 6380 ping 2>&1 | head -1                                                                                       # error / connection reset, NOT PONG
nc -zv 51.75.204.60 6379                                                                                                                        # must fail
# persistence on
docker exec chaos-redis redis-cli --tls -p 6380 --insecure --user admin --pass "$ADMIN_PASSWORD" --no-auth-warning config get appendonly           # yes
# certificate is valid for the hostname
echo | openssl s_client -connect thevps.estragos.org:6380 -servername thevps.estragos.org 2>/dev/null | openssl x509 -noout -subject -dates
```
If `redis-cli` is not installed on the host, run the plaintext test from a container too.

## Do not
- Do not print passwords anywhere except the final secrets file I asked for.
- Do not modify or delete other containers, networks or Redis instances unless I ask.
- Do not use `--network host`. Do not disable TLS "to make it work". If something blocks you, stop and report.
