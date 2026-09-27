#!/usr/bin/env bash
# ============================================================
#  تلي هم — تشغيل/تحديث الخدمة على السيرفر
#  الاستخدام:  bash deploy/deploy.sh            (سحب أحدث كود + إعادة تشغيل)
#             bash deploy/deploy.sh --no-pull  (إعادة تشغيل فقط)
# ============================================================
set -euo pipefail
APP_ROOT="${APP_ROOT:-/srv/teleham}"
PORT="${PORT:-4000}"

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$1"; }
ok()  { printf "\033[1;32m✓ %s\033[0m\n" "$1"; }
die() { printf "\033[1;31m✗ %s\033[0m\n" "$1" >&2; exit 1; }

cd "$APP_ROOT/app"

if [ "${1:-}" != "--no-pull" ]; then
  say "١) سحب أحدث كود من main"
  git fetch --all --prune
  git checkout main
  git pull --ff-only
  ok "الكود محدّث: $(git log -1 --format='%h %s' | cut -c1-70)"
fi

say "٢) تثبيت الحزم (إن تغيّرت)"
cd server
npm install --no-audit --no-fund

say "٣) إعادة التشغيل"
pm2 restart teleham --update-env || pm2 start index.js --name teleham
pm2 save >/dev/null

say "٤) فحص الصحة"
sleep 5
HEALTH="$(curl -s "http://localhost:$PORT/api/health" || true)"
echo "$HEALTH"
echo "$HEALTH" | grep -q '"ok":true' || die "الفحص فشل — راجع: pm2 logs teleham --lines 80"
ok "الخدمة سليمة ✓"

say "٥) فحص من الإنترنت (إن كان النفق شغالًا)"
PUB="$(grep -E '^PUBLIC_URL=' .env 2>/dev/null | cut -d= -f2- || true)"
[ -n "$PUB" ] && curl -s "$PUB/api/health" && echo
