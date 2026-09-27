#!/usr/bin/env bash
# ============================================================
#  تلي هم — تجهيز سيرفر Ubuntu لتشغيل المنصة (خطوة واحدة)
#  الاستخدام:  bash deploy/setup-server.sh
# ============================================================
set -euo pipefail

APP_ROOT="${APP_ROOT:-/srv/teleham}"
REPO_URL="${REPO_URL:-https://github.com/familylive/wassal.git}"

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$1"; }
ok()  { printf "\033[1;32m✓ %s\033[0m\n" "$1"; }
die() { printf "\033[1;31m✗ %s\033[0m\n" "$1" >&2; exit 1; }

say "١) تثبيت الأدوات الأساسية (تحتاج صلاحية sudo)"
sudo apt update -y
sudo apt install -y curl git build-essential python3 ca-certificates ufw unattended-upgrades

say "٢) جدار ناري: نسمح SSH فقط (لا نفتح منفذ التطبيق للإنترنت)"
sudo ufw allow OpenSSH || true
sudo ufw --force enable || true

say "٣) تثبيت Node.js 20 LTS"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi
NODE_V="$(node -v || true)"
[[ "$NODE_V" == v20* || "$NODE_V" == v22* ]] || echo "⚠️ نسخة Node الحالية $NODE_V — المستحسن v20 أو v22"
ok "Node $NODE_V"

say "٤) تهيئة المجلدات"
sudo mkdir -p "$APP_ROOT" "$APP_ROOT/data" "$APP_ROOT/backups"
sudo chown -R "$USER:$USER" "$APP_ROOT"
ok "$APP_ROOT"

say "٥) جلب الكود"
if [ -d "$APP_ROOT/app/.git" ]; then
  cd "$APP_ROOT/app" && git pull --ff-only || true
else
  git clone "$REPO_URL" "$APP_ROOT/app" || die "فشل الجلب — تأكد من صلاحية الوصول للمستودع (Deploy Key أو PAT)"
fi
ok "الكود جاهز في $APP_ROOT/app"

say "٦) تثبيت حزم التطبيق (تحتاج ترجمة مكوّنات أصليّة)"
cd "$APP_ROOT/app/server"
npm install --no-audit --no-fund
ok "الحزم مثبّتة"

say "٧) ملف الإعدادات .env"
if [ ! -f .env ]; then
  cp "$APP_ROOT/app/deploy/.env.example" .env
  chmod 600 .env
  SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${SECRET}|" .env
  ok "أُنشئ .env (مع JWT_SECRET عشوائي)"
else
  ok "‎.env موجود مسبقًا — لم يُلمس"
fi
echo "👉 لا تنسَ تعديل: PUBLIC_URL · DB_PATH · ADMIN_PHONE · GH_BACKUP_TOKEN  (nano $APP_ROOT/app/server/.env)"

say "٨) تشغيل دائم عبر pm2"
sudo npm i -g pm2 --silent
pm2 delete teleham >/dev/null 2>&1 || true
pm2 start index.js --name teleham
pm2 save
sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null 2>&1 || true
ok "الخدمة تعمل باسم teleham"

say "٩) فحص الصحة محليًا"
sleep 4
HEALTH="$(curl -s "http://localhost:${PORT:-4000}/api/health" || true)"
echo "$HEALTH"
echo "$HEALTH" | grep -q '"ok":true' && ok "التطبيق سليم ✓" || echo "⚠️ راجع السجل:  pm2 logs teleham --lines 60"

cat <<'NEXT'

────────────────────────────────────────────
 الخطوات التالية:
  1) عدّل server/.env  (PUBLIC_URL + DB_PATH + GH_BACKUP_TOKEN)
  2) انقل قاعدة البيانات:   bash deploy/migrate-db.sh
  3) ثبّت النفق:            cloudflared (انظر deploy/README.md الخطوة ٦)
  4) عند القص:              bash deploy/set-webhook.sh https://<دومينك>
────────────────────────────────────────────
NEXT
