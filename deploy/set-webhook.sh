#!/usr/bin/env bash
# ============================================================
#  تلي هم — ضبط ويبهوك بوت تليجرام على الدومين الجديد
#  الاستخدام:  bash deploy/set-webhook.sh https://teleham.com
# ============================================================
set -euo pipefail
BASE="${1:-}"; [ -z "$BASE" ] && read -rp "رابط الموقع (https://...): " BASE
BASE="${BASE%/}"
[[ "$BASE" =~ ^https:// ]] || { echo "✗ يجب أن يكون الرابط https"; exit 1; }

read -rp "بريد/جوال المشرف [admin@wassal.app]: " IDENT; IDENT="${IDENT:-admin@wassal.app}"
read -rsp "كلمة مرور المشرف: " PASS; echo

TOKEN="$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
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
[ -n "$TOKEN" ] || { echo "✗ فشل تسجيل الدخول"; exit 1; }

echo "==> ضبط الويبهوك على $BASE"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/telegram/setup-webhook"; echo
echo "==> الحالة:"
curl -s "$BASE/api/telegram/status"; echo
