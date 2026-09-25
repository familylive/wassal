// ---------- قراءة صور الأصناف / المنيو بالذكاء الاصطناعي (Groq Vision) ----------
// يستخدم نفس مفتاح Groq المستخدم لتفريغ الصوتيات — لا يحتاج إعداد جديد.
import axios from 'axios';
import config from '../config.js';

// Groq يدعم حالياً qwen/qwen3.8-27b للصور — ونحتفظ ببدائل لو تغيّرت القائمة
const MODELS = [process.env.VISION_MODEL, 'qwen/qwen3.8-27b', 'meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct'].filter(Boolean);

const PROMPT = `أنت تقرأ صورة قائمة طعام أو قائمة أصناف متجر مكتوبة بالعربية (أو إنجليزية).
استخرج كل الأصناف مع أسعارها.
أرجع JSON فقط بهذا الشكل بدون أي كلام أو شرح إضافي:
{"items":[{"name":"اسم الصنف","price":12.5,"category":"القسم أو null"}]}

قواعد مهمة:
- name كما هو مكتوب بالعربية (نظّفه من الرموز الغريبة والأرقام الزائدة).
- price رقم بالريال فقط (بدون رمز العملة). إذا لم يوجد سعر واضح اكتب 0.
- category = اسم القسم أو الجدول الذي يظهر فوق الصنف (مثل: مشروبات، ألبان، مقبلات، أطباق رئيسية)، وإلا null.
- لا تدمج صنفين في عنصر واحد، ولا تكرر الصنف نفسه.
- تجاهل أرقام الهواتف والعناوين والصور والشعارات.
- إذا لم تجد أي صنف واضح أرجع {"items":[]}.`;

// تحويل نص النموذج إلى مصفوفة أصناف (أسعار بالهللات)
export function parseVisionItems(text) {
  const s = String(text || '');
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return [];
  let obj = null;
  try { obj = JSON.parse(s.slice(i, j + 1)); } catch { return []; }
  const arr = Array.isArray(obj?.items) ? obj.items : (Array.isArray(obj) ? obj : []);
  const out = [];
  const seen = new Set();
  for (const it of arr) {
    let name = String(it?.name ?? it?.item ?? it?.الصنف ?? '').replace(/[\u200e\u200f]/g, '').replace(/\s+/g, ' ').trim();
    name = name.replace(/^[-•*\d.\s]+/, '').slice(0, 80);
    if (name.length < 2 || !/[\p{L}]/u.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let price = Number(String(it?.price ?? it?.سعر ?? 0).toString().replace(/[^\d.]/g, '')) || 0;
    if (!Number.isFinite(price) || price < 0) price = 0;
    let category = it?.category ?? it?.القسم ?? null;
    category = category && String(category).toLowerCase() !== 'null' ? String(category).replace(/\s+/g, ' ').trim().slice(0, 40) : null;
    out.push({ name, price: Math.round(price * 100), category });
    if (out.length >= 300) break;
  }
  return out;
}

// تنزيل ملف من ميتا (صورة/مستند) عبر معرّفه
export async function downloadMedia(mediaId) {
  const { token, apiUrl } = config.whatsapp;
  const meta = await axios.get(`${apiUrl}/${mediaId}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 });
  const url = meta.data?.url;
  const mime = meta.data?.mime_type || 'image/jpeg';
  if (!url) return null;
  const file = await axios.get(`${url}?access_token=${token}`, { responseType: 'arraybuffer', timeout: 90000 });
  return { buffer: Buffer.from(file.data), mime };
}

// قراءة أصناف من صورة (media_id) — ترجع [] إذا تعذّرت القراءة
export async function readItemsFromImage(mediaId) {
  const { sttApiKey } = config.voice;
  if (!sttApiKey || !mediaId) return null;
  const media = await downloadMedia(mediaId);
  if (!media?.buffer?.length) return null;
  const b64 = media.buffer.toString('base64');
  const mime = String(media.mime || 'image/jpeg').split(';')[0];
  let lastErr = null;
  for (const model of MODELS) {
    try {
      const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model,
        temperature: 0,
        max_completion_tokens: 4000,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
          ]
        }]
      }, { headers: { Authorization: `Bearer ${sttApiKey}` }, timeout: 120000 });
      const text = r.data?.choices?.[0]?.message?.content || '';
      const items = parseVisionItems(text);
      console.log('VISION_READ', { model, mediaId, chars: text.length, items: items.length });
      if (items.length) return items;
      if (!lastErr) lastErr = 'no-items';       // الموديل ردّ لكن ما فيه أصناف — نجرّب البديل
    } catch (e) {
      lastErr = e.response?.data?.error?.message || e.message;
      console.error('VISION_MODEL_FAIL', model, lastErr);
    }
  }
  console.log('VISION_READ_NONE', { mediaId, lastErr });
  return [];
}
