# 🖥️ تشغيل «تلي هم» على سيرفر في البيت — دليل كامل

> منصّة تلي هم = Node.js + SQLite. خفيفة جدًا: أي جهاز حديث (i7 + 8GB) **أكثر من كافٍ**.
> كل البرامج المستخدمة **مجانية** — لا تراخيص ولا ويندوز سيرفر.

---

## 0) المواصفات المطلوبة
| البند | الحد الأدنى | المستحسن |
|---|---|---|
| المعالج | أي ثنائي النواة | i7 / N100 ✓ (عندك i7 = مبالغة ✓) |
| الرام | 2 جيجا | 8–16 جيجا ✓ |
| التخزين | 20 جيجا | SSD 256GB+ ✓ |
| النظام | Ubuntu Server 22.04/24.04 LTS | 24.04 LTS ✓ |
| الكهرباء | **UPS صغير** (مهم: يمنع تلف القاعدة عند الانقطاع) | 600–800VA |
| الشبكة | كيبل شبكة (أفضل من واي فاي) | ≥ 20Mbps رفع ✓ |

---

## 1) تجهيز النظام (15 دقيقة)
```bash
# أدوات أساسية (build-essential لازم لترجمة better-sqlite3 / @napi-rs/canvas)
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git build-essential python3 ufw unattended-upgrades

# جدار ناري: لا نفتح أي منفذ للإنترنت (النفق يتولى ذلك)
sudo ufw allow OpenSSH && sudo ufw --force enable

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # يجب أن يظهر v20.x
```

## 2) جلب الكود
```bash
sudo mkdir -p /srv/teleham && sudo chown -R $USER:$USER /srv/teleham
cd /srv/teleham
git clone https://github.com/familylive/wassal.git app
cd app/server && npm install
```
> المستودع خاص: استخدم **Deploy Key** (مفتاح SSH للنشر) أو PAT — لا تشارك المفتاح مع أحد.

## 3) ملف الإعدادات `.env`
```bash
cd /srv/teleham/app/server
cp ../../deploy/.env.example .env     # أو أنشئه يدويًا
nano .env          # املأ القيم
chmod 600 .env     # لا يقرأه إلا أنت
```
**أهم المتغيرات:**
| المتغير | القيمة | لماذا |
|---|---|---|
| `PORT` | `4000` | منفذ التطبيق (افتراضي) |
| `PUBLIC_URL` | `https://teleham.com` | **حرج**: عليه تُبنى روابط الفواتير |
| `DB_PATH` | `/srv/teleham/data/wassal.db` | خارج مجلد الكود = لا يضيع مع `git pull` |
| `JWT_SECRET` | نص عشوائي طويل | أمان الجلسات |
| `ADMIN_PHONE` | `966540029999` | إشعارات الإدارة |
| `WHATSAPP_PROVIDER` | `telegram` | القناة الحالية |
| `TELEGRAM_WEBHOOK_SECRET` | `wassal-tg` | سرّ الويبهوك |
| `GH_BACKUP_TOKEN` | PAT خاص بمستودع النسخ | النسخ الاحتياطي كل دقيقتين |
| `PAYMENT_MODE` | `mock` (تجربة) / `moyasar` + `MOYASAR_SECRET_KEY` | الدفع |
| `TZ` | `Asia/Riyadh` | التقارير بالتوقيت المحلي |
> **توكن بوت تليجرام محفوظ داخل قاعدة البيانات** (`app_settings`) → ينقل مع النسخة ✓

## 4) التعرّف على قاعدة البيانات (نقل البيانات الحالية)
```bash
bash ../../deploy/migrate-db.sh
```
*(يسألك عن رابط الموقع الحالي وبيانات المشرف، ثم ينزّل قاعدة الإنتاج الحيّة ويضعها في `DB_PATH`.)*

## 5) التشغيل الدائم (pm2)
```bash
sudo npm i -g pm2
cd /srv/teleham/app/server
mkdir -p /srv/teleham/data
pm2 start index.js --name teleham
pm2 save
sudo env PATH=$PATH pm2 startup systemd -u $USER --hp $HOME   # يشتغل تلقائيًا بعد إعادة التشغيل
pm2 logs teleham --lines 50     # راقب الإقلاع
```
**افحص محليًا:**
```bash
curl -s http://localhost:4000/api/health
# المطلوب: {"ok":true,"db":"sane",...}
```

## 6) النشر على الإنترنت — Cloudflare Tunnel (مجاني، بلا IP ثابت)
```bash
# تثبيت
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cf.deb
sudo dpkg -i cf.deb

# الدخول وربط الدومين (يفتح رابطًا تفتحه من المتصفح)
cloudflared tunnel login
cloudflared tunnel create teleham
cloudflared tunnel route dns teleham teleham.com
```
أنشئ `/etc/cloudflared/config.yml`:
```yaml
tunnel: teleham
credentials-file: /root/.cloudflared/<TUNNEL-ID>.json
ingress:
  - hostname: teleham.com
    service: http://localhost:4000
  - service: http_status:404
```
```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```
> لا تفتح أي منفذ في الراوتر ✓ — النفق يُنشئ اتصالًا **صادرًا** فقط.

## 7) توجيه البوت للدومين الجديد (لحظة القص)
```bash
# 1) أوقف النسخة القديمة على Render (Suspend) — مهم: منع نسختين يكتبان في النسخ الاحتياطي
# 2) من الجهاز الجديد:
bash ../../deploy/set-webhook.sh https://teleham.com
# 3) تأكد
curl -s https://teleham.com/api/health
curl -s https://teleham.com/api/telegram/status
```
⏱️ التوقف المتوقع: **1–3 دقائق** (رسائل تليجرام تُعاد تلقائيًا فلا يضيع شيء).

## 8) المراقبة والصيانة
```bash
pm2 status                    # حالة الخدمة
pm2 logs teleham --lines 100  # السجل
bash ../../deploy/deploy.sh   # تحديث الكود (git pull + install + restart + فحص)
bash ../../deploy/rollback.sh # رجوع طارئ: يوقف المحلي ويعيد البوت لـ Render
```
- **النسخ الاحتياطي:** تلقائي كل دقيقتين + بعد كل طلب (يُرفع للمستودع الخاص) ✓
- **الفحص الخارجي:** مراقبة دورية على `/api/health` و `/api/telegram/status` ✓

---

## ⚠️ قواعد ذهبية
1. **لا تشغّل نسختين معًا** (البيت + Render) — الويبهوك يوصل لواحد، والنسخ الاحتياطي يتعارض.
2. **`DB_PATH` خارج مجلد الكود** — وإلا يضيع مع التحديثات.
3. **أوقف الخدمة قبل تبديل ملف القاعدة** (`pm2 stop` → نسخ → `pm2 start`).
4. **UPS** — الانقطاع المفاجئ قد يُتلف ملف SQLite.
5. **لا تنشر مباشرة على `main`** — فرع + PR (Render ينشر من main، والجهاز يسحب من main).
6. بعد أي تغيير في **PUBLIC_URL** أعد ضبط الويبهوك.

---

## 🔐 نقاط النهاية الحساسة (للمشرف فقط)
`/api/telegram/setup-webhook` · `/api/whatsapp/debug` · `/api/whatsapp/selftest` · `/api/dbadmin/*`
→ تحتاج تسجيل دخول المشرف. العام فقط: `/api/health` و `/api/telegram/status` (بأرقام مُقنّعة).
