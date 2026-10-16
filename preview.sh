#!/usr/bin/env bash
# preview.sh — a private, password-protected copy of the site (projections included),
# served by nginx on the droplet at its own subdomain. Never touches the live site,
# Vercel, GitHub or /var/www/pasttheeyetest.com.
#
#   sudo ./preview.sh setup   [domain]   one time: nginx site + password + HTTPS
#   sudo ./preview.sh publish            build ~/ptet-proj and put it live (rerun after any change)
#   sudo ./preview.sh off                take it offline (keeps everything for later)
#   sudo ./preview.sh on                 bring it back
#   sudo ./preview.sh passwd  [user]     add a viewer / change a password
#   sudo ./preview.sh remove             delete it completely (site, files, password, certificate)
#   sudo ./preview.sh status
#
# Run it from ~/ptet-proj (the private copy). Default domain: preview.pasttheeyetest.com
set -euo pipefail

PROJ="$(cd "$(dirname "$0")" && pwd)"
STATE=/etc/ptet-preview.domain
DOMAIN="${2:-$(cat "$STATE" 2>/dev/null || echo preview.pasttheeyetest.com)}"
WEBROOT=/var/www/ptet-preview
CONF=/etc/nginx/sites-available/ptet-preview.conf
LINK=/etc/nginx/sites-enabled/ptet-preview.conf
HTPASSWD=/etc/nginx/ptet-preview.htpasswd

die() { echo "✗ $*" >&2; exit 1; }
need_root() { [ "$(id -u)" = 0 ] || die "run with sudo (or as root)"; }

write_conf() {
  cat > "$CONF" <<EOF
# PastTheEyeTest private preview — managed by $PROJ/preview.sh
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    root $WEBROOT;
    index index.html;

    auth_basic "PastTheEyeTest preview";
    auth_basic_user_file $HTPASSWD;
    add_header X-Robots-Tag "noindex, nofollow" always;

    # Same proxies as vercel.json / vite.config.js. Hosts are resolved per request
    # (resolver + variable), so an unreachable upstream can never stop nginx from
    # loading — the API and any other sites on this nginx are unaffected.
    resolver 1.1.1.1 8.8.8.8 valid=300s ipv6=off;
    resolver_timeout 5s;
    location /mlb-api/ { set \$up statsapi.mlb.com; rewrite ^/mlb-api/(.*)\$ /\$1 break; proxy_pass https://\$up; proxy_set_header Host \$up; proxy_ssl_server_name on; proxy_ssl_name \$up; }
    location /mlb-photos/ { set \$up img.mlbstatic.com; rewrite ^/mlb-photos/(.*)\$ /\$1 break; proxy_pass https://\$up; proxy_set_header Host \$up; proxy_ssl_server_name on; proxy_ssl_name \$up; }
    location /mlb-logos/ { set \$up midfield.mlbstatic.com; rewrite ^/mlb-logos/(.*)\$ /\$1 break; proxy_pass https://\$up; proxy_set_header Host \$up; proxy_ssl_server_name on; proxy_ssl_name \$up; }
    location /savant-api/ { set \$up baseballsavant.mlb.com; rewrite ^/savant-api/(.*)\$ /\$1 break; proxy_pass https://\$up; proxy_set_header Host \$up; proxy_ssl_server_name on; proxy_ssl_name \$up; }
    location /nhl-api/ { set \$up api-web.nhle.com; rewrite ^/nhl-api/(.*)\$ /\$1 break; proxy_pass https://\$up; proxy_set_header Host \$up; proxy_ssl_server_name on; proxy_ssl_name \$up; }
    location /nhl-assets/ { set \$up assets.nhle.com; rewrite ^/nhl-assets/(.*)\$ /\$1 break; proxy_pass https://\$up; proxy_set_header Host \$up; proxy_ssl_server_name on; proxy_ssl_name \$up; }
    location /flag-assets/ { set \$up flagcdn.com; rewrite ^/flag-assets/(.*)\$ /\$1 break; proxy_pass https://\$up; proxy_set_header Host \$up; proxy_ssl_server_name on; proxy_ssl_name \$up; }
    location /bzzoiro/ { set \$up sports.bzzoiro.com; rewrite ^/bzzoiro/(.*)\$ /\$1 break; proxy_pass https://\$up; proxy_set_header Host \$up; proxy_ssl_server_name on; proxy_ssl_name \$up; }

    # Single-page app: unknown paths load the app
    location / { try_files \$uri \$uri/ /index.html; }
}
EOF
}

case "${1:-}" in
  setup)
    need_root
    # Don't fight whatever already serves this droplet's web ports (e.g. the API)
    owners=$(ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -o 'users:(("[^"]*' | sed 's/users:(("//' | sort -u | tr '\n' ' ')
    if [ -n "$owners" ] && ! echo "$owners" | grep -qw nginx; then
      die "ports 80/443 are served by: $owners— not nginx. Stopping without changes; send this line to Claude."
    fi
    command -v nginx >/dev/null || { apt-get update -q && apt-get install -y nginx; }
    command -v htpasswd >/dev/null || apt-get install -y apache2-utils
    command -v certbot >/dev/null || apt-get install -y certbot python3-certbot-nginx

    echo "Domain: $DOMAIN"
    echo "  DNS currently points it to: $(getent hosts "$DOMAIN" | awk '{print $1}' | tr '\n' ' ' || true)"
    echo "  (needs an A record to this droplet before HTTPS can be issued)"
    echo "$DOMAIN" > "$STATE"

    if [ ! -s "$HTPASSWD" ]; then
      read -rp "Viewer username: " u
      htpasswd -c "$HTPASSWD" "$u"
    fi
    chown root:www-data "$HTPASSWD" && chmod 640 "$HTPASSWD"     # nginx can read it; other users can't
    mkdir -p "$WEBROOT"
    [ -f "$WEBROOT/index.html" ] || echo "<p>Preview not published yet — run: sudo ./preview.sh publish</p>" > "$WEBROOT/index.html"
    write_conf
    ln -sf "$CONF" "$LINK"
    nginx -t && systemctl reload nginx
    echo "Requesting HTTPS certificate…"
    certbot --nginx -d "$DOMAIN" --redirect || echo "⚠ HTTPS not issued yet (DNS not pointing here?). Fix DNS, then rerun: sudo ./preview.sh setup"
    echo "✓ Set up. Next: sudo ./preview.sh publish"
    ;;

  publish)
    need_root
    [ -f "$PROJ/package.json" ] || die "run this from ~/ptet-proj"
    cd "$PROJ"
    echo "Building $PROJ → $WEBROOT …"
    npx vite build --outDir "$WEBROOT" --emptyOutDir
    echo "✓ Published to https://$DOMAIN (projection files included: $(ls public/*_2027P.json 2>/dev/null | wc -l))"
    ;;

  off)
    need_root
    rm -f "$LINK" && nginx -t && systemctl reload nginx
    echo "✓ Offline. Everything is kept — bring it back with: sudo ./preview.sh on"
    ;;

  on)
    need_root
    [ -f "$CONF" ] || die "not set up — run: sudo ./preview.sh setup"
    ln -sf "$CONF" "$LINK" && nginx -t && systemctl reload nginx
    echo "✓ Online at https://$DOMAIN"
    ;;

  passwd)
    need_root
    u="${2:-}"; [ -n "$u" ] || read -rp "Username: " u
    htpasswd "$HTPASSWD" "$u"
    chown root:www-data "$HTPASSWD" && chmod 640 "$HTPASSWD"
    echo "✓ Saved. Remove someone with: sudo htpasswd -D $HTPASSWD <user>"
    ;;

  remove)
    need_root
    read -rp "Delete the preview site, its files, passwords and certificate for $DOMAIN? [y/N] " a
    [ "$a" = y ] || [ "$a" = Y ] || die "cancelled"
    rm -f "$LINK" "$CONF" "$HTPASSWD"
    nginx -t && systemctl reload nginx
    rm -rf "$WEBROOT"
    certbot delete --cert-name "$DOMAIN" 2>/dev/null || true
    rm -f "$STATE"
    echo "✓ Removed. (Delete the DNS record for $DOMAIN too if you won't reuse it.)"
    ;;

  status)
    echo "Domain:     $DOMAIN"
    echo "Configured: $([ -f "$CONF" ] && echo yes || echo no)"
    echo "Online:     $([ -L "$LINK" ] && echo yes || echo no)"
    echo "Published:  $([ -f "$WEBROOT/index.html" ] && stat -c '%y' "$WEBROOT/index.html" | cut -d. -f1 || echo never)"
    echo "Viewers:    $([ -f "$HTPASSWD" ] && cut -d: -f1 "$HTPASSWD" | tr '\n' ' ' || echo none)"
    ;;

  *)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
