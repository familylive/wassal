import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { initRealtime } from './services/realtime.js';
import apiRouter from './routes/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/sim', express.static(path.join(__dirname, 'public/sim')));
app.use('/api', apiRouter);

const server = http.createServer(app);
initRealtime(server);

// production: serve client build
const clientDist = path.join(__dirname, '../client/dist');
app.use(express.static(clientDist));
app.get(/^\/(?!api|sim|uploads).*/, (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'), err => {
    if (err) res.send('خادم وصل يعمل ✅ — شغّل الواجهة عبر `npm run dev` في مجلد client');
  });
});

server.listen(config.port, () => console.log(`🚀 منصة وصل تعمل على http://localhost:${config.port} (دفع: ${config.paymentMode} | واتساب: ${config.whatsapp.provider})`));

// نسخ احتياطي دوري كل 4 دقائق (إضافة للنسخ الفوري بعد الطلبات)
import('./services/backup.js').then(({ scheduleBackup }) => {
  setInterval(scheduleBackup, 4 * 60 * 1000);
  console.log('🔄 النسخ الاحتياطي التلقائي مفعّل');
});
