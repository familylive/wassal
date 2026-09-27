#!/usr/bin/env bash
# ============================================================
#  تلي هم — نقل قاعدة البيانات الحيّة من الموقع الحالي إلى هذا الجهاز
#  الاستخدام:  bash deploy/migrate-db.sh [رابط-الموقع-الحالي]
#  ملاحظة: يحتاج بريد وكلمة مرور المشرف (لا تُحفظ ولا تُرسل لأي أحد)
# ============================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/teleham/app/server}"
DATA_DIR="${DATA_DIR:-$(dirname "${DB_PATH:-/srv/teleham/data/wassal.db}")}"
TARGET_DB="${DB_PATH:-$DATA_DIR/wassal.db}"
PORT="${PORT:-4000}"

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$1"; }
ok()  { printf "\033[1;32m✓ %s\033[0m\n" "$1"; }
die() { printf "\033[1;31m✗ %s\033[0m\n" "$1" >&2; exit 1; }

SITE="${1:-}"
[ -z "$SITE" ] && read -rp "رابط الموقع الحالي (مثال: https://whats-ham.onrender.com): " SITE
SITE="${SITE%/}"
[[ "$SITE" =~ ^https?:// ]] || die "الرابط يجب أن يبدأ بـ http(s)://"

read -rp "بريد/جوال المشرف [admin@wassal.app]: " IDENT
IDENT="${IDENT:-admin@wassal.app}"
read -rsp "كلمة مرور المشرف: " PASS; echo
[ -n "$PASS" ] || die "كلمة المرور مطلوبة"

say "١) تسجيل الدخول وطلب نسخة مباشرة من قاعدة البيانات الحيّة"
TOKEN="$(curl -s -X POST "$SITE/api/auth/login" -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"identifier":sys.argv[1],"password":sys.argv[2]}))' "$IDENT" "$PASS")" \
  | python3 -c '
import sys, json
try: d=json.load(sys.stdin)
except Exception: print(""); raise SystemExit
def find(o):
    if isinstance(o, dict):
        for k,v in o.items():
            if k in ("token","access_token","accessToken") and isinstance(v,str) and v: return v
        for v in o.values():
            r=find(v)
            if r: return r
    if isinstance(o, list):
        for v in o:
            r=find(v)
            if r: return r
    return ""
print(find(d))')"
[ -n "$TOKEN" ] || die "فشل تسجيل الدخول (راجع البريد/كلمة المرور)"
ok "تم الدخول"

mkdir -p "$DATA_DIR"
TMP="$DATA_DIR/wassal.incoming.db"
say "٢) تنزيل القاعدة"
curl -s -H "Authorization: Bearer $TOKEN" -o "$TMP" "$SITE/api/dbadmin/export"
SIZE="$(stat -c%s "$TMP" 2>/dev/null || echo 0)"
echo "الحجم: $SIZE بايت"
[ "$SIZE" -gt 60000 ] || die "الملف صغير جدًا — قد يكون التنزيل فشل"
head -c 16 "$TMP" | grep -q "SQLite format 3" || die "الملف ليس قاعدة SQLite صحيحة"

say "٣) إيقاف الخدمة وتبديل الملف (لا نبدّل ملفًا مفتوحًا أبدًا)"
pm2 stop teleham >/dev/null 2>&1 || true
if [ -f "$TARGET_DB" ]; then
  cp -a "$TARGET_DB" "$TARGET_DB.bak-$(date +%Y%m%d%H%M%S)"
  ok "حُفظت نسخة من القاعدة السابقة"
fi
mv -f "$TMP" "$TARGET_DB"
ok "القاعدة في: $TARGET_DB  ($(stat -c%s "$TARGET_DB") بايت)"

say "٤) إعادة التشغيل والفحص"
pm2 start teleham >/dev/null 2>&1 || pm2 restart teleham >/dev/null 2>&1 || true
sleep 5
curl -s "http://localhost:$PORT/api/health"; echo

cat <<NEXT

────────────────────────────────────────────
 التالي:
  • تأكد أن الفحص أعلاه يظهر  "db":"sane"
  • في اللوحة: الإعدادات → تأكد من توكن البوت ورقم المشرف
  • عند القص:  bash deploy/set-webhook.sh https://<دومينك>
────────────────────────────────────────────
NEXT
