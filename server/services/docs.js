// 📎 حفظ مستندات التسجيل (رخصة بلدية · سجل تجاري · شهادات صحية · رخصة قيادة · خلو سوابق)
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';

const DOC_DIR = 'uploads/docs';

// يحفظ ملفاً وارِداً من ميتا ويعيد { url, name } — url نسبي للتخزين، وpublicUrl للعرض/الإرسال
export async function saveRegDoc(mediaId, prefix = 'doc') {
  try {
    const { downloadMedia } = await import('./vision.js');
    const media = await downloadMedia(mediaId);
    if (!media?.buffer?.length) return null;
    fs.mkdirSync(DOC_DIR, { recursive: true });
    const mime = String(media.mime || 'image/jpeg');
    const ext = mime.includes('pdf') ? 'pdf' : mime.includes('png') ? 'png' : 'jpg';
    const base = `${String(prefix).replace(/[^\w-]/g, '').slice(0, 30)}-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(DOC_DIR, base), media.buffer);
    return { file: base, url: `/uploads/docs/${base}`, ext, isPdf: ext === 'pdf' };
  } catch (e) { console.error('DOC_SAVE_FAIL', e.message); return null; }
}

export const docUrl = (rel) => (rel ? `${config.publicUrl || ''}${rel.startsWith('/') ? rel : '/' + rel}` : null);
