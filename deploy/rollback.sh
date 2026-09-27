#!/usr/bin/env bash
# ============================================================
#  تلي هم — خطة الرجوع الطارئة
#  يوقف الخدمة المحلية ويُعيد بوت تليجرام إلى نسخة Render خلال دقيقة
#  الاستخدام:  bash deploy/rollback.sh https://whats-ham.onrender.com
# ============================================================
set -euo pipefail
RENDER="${1:-https://whats-ham.onrender.com}"; RENDER="${RENDER%/}"

say() { printf "\n\033[1;33m==> %s\033[0m\n" "$1"; }
ok()  { printf "\033[1;32m✓ %s\033[0m\n" "$1"; }

say "١) إيقاف الخدمة المحلية (لمنع نسختين تعملان معًا)"
pm2 stop teleham || true
pm2 save >/dev/null 2>&1 || true
ok "أُوقفت محليًا"

say "٢) إعادة ويبهوك البوت إلى Render"
read -rp "بريد/جوال المشرف [admin@wassal.app]: " IDENT; IDENT="${IDENT:-admin@wassal.app}"
read -rsp "كلمة مرور المشرف: " PASS; echo
TOKEN="$(curl -s -X POST "$RENDER/api/auth/login" -H 'Content-Type: application/json' \
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
if [ -n "$TOKEN" ]; then
  curl -s -H "Authorization: Bearer $TOKEN" "$RENDER/api/telegram/setup-webhook"; echo
  ok "الويبهوك رجع إلى $RENDER"
else
  echo "✗ فشل تسجيل الدخول — افتح Render وشغّل: curl \"$RENDER/api/telegram/setup-webhook\" مع توكن المشرف"
fi

cat <<'NOTE'

⚠️ تنبيه مهم:
  • لا تشغّل النسختين معًا بعد الرجوع — أوقف الآخر دائمًا.
  • إن كانت هناك طلبات سُجّلت على الجهاز المحلي بعد آخر نسخة احتياطية،
    استعد القاعدة من المستودع الخاص (familylive/wassal-db-backup) قبل التشغيل.
  • خطة العودة:  pm2 start teleham  (بعد إعادة الويبهوك للجهاز)
NOTE
