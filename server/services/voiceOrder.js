// 🎤 الطلب بالصوت: تحويل كلام العميل (نص مُفرَّغ من رسالة صوتية أو مكتوب) إلى أصناف من منيو النشاط
// المنهج: مطابقة محلية أولًا (سريعة ومجانية وبدون أي مفتاح) ثم تحليل ذكي (Groq) إن توفّر المفتاح.
import axios from 'axios';
import config from '../config.js';

// توحيد الكتابة العربية: تشكيل · همزات · ة/ه · أرقام عربية
export function normalizeAr(s) {
  return String(s || '')
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const QTY_WORDS = {
  واحد: 1, واحده: 1, حبه: 1, حبات: 1, صحن: 1, طلب: 1,
  اثنين: 2, اثنتين: 2, اثنان: 2, ثنتين: 2, تنين: 2, زوج: 2,
  ثلاث: 3, ثلاثه: 3, ثلات: 3, اربع: 4, اربعه: 4,
  خمس: 5, خمسه: 5, ست: 6, سته: 6, سبع: 7, سبعه: 7,
  ثمان: 8, ثمانيه: 8, تسع: 9, تسعه: 9, عشر: 10, عشره: 10,
  مرتين: 2, مرتان: 2, مره: 1,
};

// استخراج الكمية الملاصقة للاسم (قبله أو بعده مباشرة) — بلا خلط مع أصناف أخرى في الجملة
const clampQty = (n) => Math.max(1, Math.min(20, Number(n) || 1));
function qtyNear(t, idx, len) {
  const before = t.slice(Math.max(0, idx - 10), idx);
  const after = t.slice(idx + len, idx + len + 6);
  let m = before.match(/(\d{1,2})\s*(حبه|حبات|قطع|صحن|طلب|كوب|علب)?\s*$/);
  if (m) return clampQty(m[1]);
  m = after.match(/^\s*(\d{1,2})(?![\p{L}\p{N}])/u);
  if (m) return clampQty(m[1]);
  const bw = before.trim().split(' ').filter(Boolean).pop();
  const aw = after.trim().split(' ').filter(Boolean)[0];
  for (const w of [bw, aw]) {
    const ww = String(w || '').replace(/^و/, '');
    if (QTY_WORDS[ww]) return clampQty(QTY_WORDS[ww]);
  }
  return 1;
}

// إيجاد اسم الصنف في الكلام: مطابقة مرنة (تتجاهل أخطاء حروف العلة: شورما = شاورما) وبحدود كلمة
const escRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function fuzzyWord(w) {
  // حروف العلة الطويلة (ا و ي) اختيارية ⇒ يتحمّل «شورما» = «شاورما» والأخطاء الشائعة
  return String(w).split('').map((ch) => (/[اوي]/.test(ch) ? escRe(ch) + '?' : escRe(ch))).join('');
}
function findName(t, n) {
  const words = String(n).split(' ').filter(Boolean);
  if (!words.length) return null;
  const parts = words.map(fuzzyWord);
  try {
    const re1 = new RegExp('(?<![\\p{L}\\p{N}])و?' + parts.join('\\s+(?:و\\s*)?') + '(?![\\p{L}\\p{N}])', 'u');
    const m1 = re1.exec(t);
    if (m1) return [m1.index, m1[0].length];
    const re2 = new RegExp('(?<![\\p{L}\\p{N}])و?' + parts.join('\\s*(?:و)?\\s*') + '(?![\\p{L}\\p{N}])', 'u');
    const m2 = re2.exec(t);
    if (m2) return [m2.index, m2[0].length];
  } catch (e) { /* */ }
  return null;
}

// مطابقة محلية: أطول الأسماء أولًا + منع التداخل (مثال: «شاورما عربي عائلي» قبل «شاورما عربي»)
export function localMatch(text, items) {
  const t = normalizeAr(text);
  if (!t) return [];
  const ranked = items
    .map((it) => ({ it, n: normalizeAr(it.name) }))
    .filter((x) => x.n.length >= 2)
    .sort((a, b) => b.n.length - a.n.length);
  const used = [];
  const out = [];
  const overlap = (a, b) => used.some((r) => Math.max(r[0], a) < Math.min(r[1], b));
  for (const { it, n } of ranked) {
    const hit = findName(t, n);
    if (!hit) continue;
    const [idx, len] = hit;
    if (overlap(idx, idx + len)) continue;
    used.push([idx, idx + len]);
    out.push({ item_id: it.id, name: it.name, price: it.price, quantity: qtyNear(t, idx, len) });
  }
  return out;
}

// تحليل ذكي (Groq — نفس مفتاح قراءة صور المنيو) لإكمال ما فات المطابقة المحلية
export async function llmMatch(text, items) {
  const key = config.voice?.sttApiKey;
  if (!key || !text) return null;
  const menu = items.slice(0, 200).map((i) => ({ id: i.id, name: String(i.name).slice(0, 60) }));
  const prompt = `أنت موظف طلبات في منصة توصيل. عندك منيو المطعم (JSON) وكلام العميل (قد يكون مُفرَّغًا من رسالة صوتية فيه أخطاء إملائية).
رجّع JSON فقط بهذا الشكل:
{"items":[{"id":<رقم الصنف من المنيو>,"qty":<عدد صحيح 1-20>}],"unmatched":[{"text":"<ما قاله>","qty":<عدد>}]}
قواعد صارمة:
- لا تخترع أصنافًا غير موجودة في المنيو، ولا تُرجّع أي id غير موجود.
- إن ذُكر الصنف باسم قريب أو ناقص أو بصيغة جنسية (مثال: «شاورمتين» = شاورما بعدد ٢) اربطه بأقرب صنف في المنيو.
- الكمية: استنتجها من السياق، والافتراضي ١. تجاهل أي صنف لم يُذكر.
- لا تُرجّع أي كلام خارج JSON.
المنيو: ${JSON.stringify(menu)}
كلام العميل: "${String(text).slice(0, 600)}"`;
  const MODELS = [process.env.VOICE_ORDER_MODEL, 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'].filter(Boolean);
  for (const model of MODELS) {
    try {
      const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model,
        temperature: 0,
        max_completion_tokens: 700,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }, { headers: { Authorization: `Bearer ${key}` }, timeout: 45000 });
      const raw = r.data?.choices?.[0]?.message?.content || '';
      const data = JSON.parse(raw);
      const byId = new Map(items.map((i) => [Number(i.id), i]));
      const got = (Array.isArray(data.items) ? data.items : [])
        .map((x) => ({ it: byId.get(Number(x.id)), qty: Math.max(1, Math.min(20, Number(x.qty) || 1)) }))
        .filter((x) => x.it)
        .map((x) => ({ item_id: x.it.id, name: x.it.name, price: x.it.price, quantity: x.qty }));
      if (got.length) return got;
    } catch (e) {
      console.error('VOICE_ORDER_LLM_FAIL', model, e.response?.data?.error?.message || e.message);
    }
  }
  return null;
}

// الدالة الرئيسية: دمج المحلي مع الذكي (الذكي يكمّل ويصحّح الكميات، والمحلي يضمن الثقة)
export async function parseVoiceOrder(text, items) {
  const local = localMatch(text, items);
  let llm = null;
  try { llm = await llmMatch(text, items); } catch (e) { llm = null; }
  if (!local.length && !llm?.length) return { items: [], source: 'none' };
  const merged = new Map();
  for (const m of local) merged.set(Number(m.item_id), { ...m, src: 'local' });
  for (const m of (llm || [])) {
    const k = Number(m.item_id);
    if (merged.has(k)) { merged.get(k).quantity = m.quantity; merged.get(k).src = 'both'; }
    else merged.set(k, { ...m, src: 'llm' });
  }
  return { items: [...merged.values()], source: llm?.length ? 'local+llm' : 'local' };
}

export default { parseVoiceOrder, localMatch, llmMatch, normalizeAr };
