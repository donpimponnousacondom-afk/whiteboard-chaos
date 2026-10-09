#!/usr/bin/env bash
# Redis for Chaos Whiteboard on Debian 12 (bookworm). Run as root.
#
# What you get:
#   - Redis reachable ONLY over TLS on port 6380 (plaintext port disabled)
#   - a Let's Encrypt certificate, renewed automatically
#   - user "wb" that can touch only wb:* keys and channels, no dangerous commands
#   - user "admin" for you, default user disabled
#   - append-only persistence, no eviction (boards must never be dropped)
#
# Before you run it:
#   1. Point a DNS A record (for example redis.yourdomain.net) at this server.
#   2. Make sure port 80 is free for a minute (Let's Encrypt check). If a web
#      server owns port 80, see the WEBROOT note below.
#
# Usage:  DOMAIN=redis.yourdomain.net EMAIL=you@example.com bash setup-redis-debian.sh
set -euo pipefail

: "${DOMAIN:?set DOMAIN=redis.yourdomain.net}"
: "${EMAIL:?set EMAIL=you@example.com}"
PORT="${PORT:-6380}"
MAXMEM="${MAXMEM:-1gb}"

apt-get update
apt-get install -y redis-server certbot openssl

# --- TLS certificate ---------------------------------------------------------
# WEBROOT note: if nginx/apache already serves port 80, replace "--standalone" with
#   --webroot -w /var/www/html     (the folder your web server serves for $DOMAIN)
certbot certonly --standalone -d "$DOMAIN" -m "$EMAIL" --agree-tos -n --keep-until-expiring

install -d -o redis -g redis -m 750 /etc/redis/tls
cat > /etc/letsencrypt/renewal-hooks/deploy/redis-tls.sh <<EOF
#!/bin/sh
install -o redis -g redis -m 640 /etc/letsencrypt/live/$DOMAIN/fullchain.pem /etc/redis/tls/cert.pem
install -o redis -g redis -m 640 /etc/letsencrypt/live/$DOMAIN/privkey.pem /etc/redis/tls/key.pem
systemctl restart redis-server
EOF
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/redis-tls.sh
install -o redis -g redis -m 640 "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" /etc/redis/tls/cert.pem
install -o redis -g redis -m 640 "/etc/letsencrypt/live/$DOMAIN/privkey.pem" /etc/redis/tls/key.pem

# --- passwords -----------------------------------------------------------------
WB_PASS="$(openssl rand -hex 32)"
ADMIN_PASS="$(openssl rand -hex 32)"

# --- config (later lines override the Debian defaults above them) --------------
CONF=/etc/redis/redis.conf
sed -i '/^# >>> chaos-whiteboard/,/^# <<< chaos-whiteboard/d' "$CONF"
cat >> "$CONF" <<EOF
# >>> chaos-whiteboard
port 0
tls-port $PORT
bind 0.0.0.0 ::
tls-cert-file /etc/redis/tls/cert.pem
tls-key-file /etc/redis/tls/key.pem
tls-auth-clients no
tls-protocols "TLSv1.2 TLSv1.3"
protected-mode yes
appendonly yes
appendfsync everysec
maxmemory $MAXMEM
maxmemory-policy noeviction
tcp-keepalive 60
timeout 0
user default off
user wb on >$WB_PASS ~wb:* &wb:* +@all -@dangerous +info
user admin on >$ADMIN_PASS ~* &* +@all
# <<< chaos-whiteboard
EOF
chmod 640 "$CONF"; chown redis:redis "$CONF"

systemctl enable redis-server
systemctl restart redis-server
sleep 1

# --- firewall (only if ufw is installed) ----------------------------------------
if command -v ufw >/dev/null 2>&1; then ufw allow "$PORT"/tcp comment "redis tls (chaos whiteboard)"; fi

# --- check ---------------------------------------------------------------------
redis-cli --tls -h "$DOMAIN" -p "$PORT" --user wb --pass "$WB_PASS" --no-auth-warning ping

umask 077
cat > /root/chaos-whiteboard-redis.txt <<EOF
REDIS_URL for Vercel (Settings > Environment Variables, then redeploy):
rediss://wb:$WB_PASS@$DOMAIN:$PORT

Admin access from this server:
redis-cli --tls -h $DOMAIN -p $PORT --user admin --pass $ADMIN_PASS --no-auth-warning
EOF
echo
echo "Done. Your REDIS_URL and admin login are in /root/chaos-whiteboard-redis.txt (readable by root only)."
