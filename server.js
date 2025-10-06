// server.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cron from 'node-cron';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import axios from 'axios';
import os from 'os';

import { db, admin } from './firebaseAdmin.js';
import {
  connectToWhatsApp,
  getLatestQR,
  getConnectionStatus,
  getSessionPhone,
  sendMessageToLead,
  sendAudioMessage,
  sendClipMessage,
  sendFullAudioAsDocument,
  scheduleSequenceForLead,
} from './whatsappService.js';
import {
  processSequences,
  generarLetraParaMusica,
  generarPromptParaMusica,
  generarMusicaConSuno,
  procesarClips,
  enviarMusicaPorWhatsApp,
  retryStuckMusic,
} from './scheduler.js';
import { cancelSequenceForLead } from './queue.js';

dotenv.config();

const bucket = admin.storage().bucket();

// Config ffmpeg
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Express
const app = express();
const port = process.env.PORT || 3001;

// Multer
const uploadsDir = path.resolve('./uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({ dest: uploadsDir });

// Middlewares
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// WhatsApp status
app.get('/api/whatsapp/status', (_req, res) => {
  res.json({ status: getConnectionStatus(), qr: getLatestQR() });
});

app.get('/api/whatsapp/number', (_req, res) => {
  const phone = getSessionPhone();
  return phone ? res.json({ phone }) : res.status(503).json({ error: 'WhatsApp no conectado' });
});

// ─────────────────────────────────────────────────────────────
// SUNO callback → sube MP3 completo y marca "Audio listo"
app.post('/api/suno/callback', async (req, res) => {
  const raw = req.body;
  const taskId = raw.taskId || raw.data?.taskId || raw.data?.task_id;
  if (!taskId) return res.sendStatus(400);

  const item = Array.isArray(raw.data?.data)
    ? raw.data.data.find(i => i.audio_url || i.source_audio_url)
    : null;
  const audioUrlPrivada = item?.audio_url || item?.source_audio_url;
  if (!audioUrlPrivada) return res.sendStatus(200);

  const snap = await db.collection('musica').where('taskId', '==', taskId).limit(1).get();
  if (snap.empty) return res.sendStatus(404);
  const docRef = snap.docs[0].ref;

  try {
    const tmpFull = path.join(os.tmpdir(), `${taskId}-full.mp3`);
    const r = await axios.get(audioUrlPrivada, { responseType: 'stream' });
    await new Promise((ok, ko) => {
      const ws = fs.createWriteStream(tmpFull);
      r.data.pipe(ws);
      ws.on('finish', ok);
      ws.on('error', ko);
    });

    const dest = `musica/full/${taskId}.mp3`;
    const [file] = await bucket.upload(tmpFull, {
      destination: dest,
      metadata: { contentType: 'audio/mpeg' },
    });

    await file.makePublic();
    const fullUrl = `https://storage.googleapis.com/${bucket.name}/${file.name}`;

    await docRef.update({
      fullUrl,
      status: 'Audio listo',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    fs.unlink(tmpFull, () => {});
    return res.sendStatus(200);
  } catch (err) {
    console.error('❌ callback Suno error:', err);
    await docRef.update({ status: 'Error música', errorMsg: err.message });
    return res.sendStatus(500);
  }
});

// ─────────────────────────────────────────────────────────────
// Botones del panel: enviar canción completa (como clip/doc) o solo clip
app.post('/api/whatsapp/send-full', async (req, res) => {
  const { leadId } = req.body;
  if (!leadId) return res.status(400).json({ error: 'Falta leadId' });

  try {
    const leadSnap = await db.collection('leads').doc(leadId).get();
    if (!leadSnap.exists) return res.status(404).json({ error: 'Lead no encontrado' });
    const telefono = String(leadSnap.data().telefono).replace(/\D/g, '');

    const musicSnap = await db.collection('musica').where('leadPhone', '==', telefono).limit(1).get();
    if (musicSnap.empty) return res.status(404).json({ error: 'No hay música para este lead' });

    const fullUrl = musicSnap.docs[0].data().fullUrl;
    if (!fullUrl) return res.status(400).json({ error: 'fullUrl no disponible' });

    // Puedes cambiar por sendFullAudioAsDocument si prefieres adjunto
    await sendClipMessage(telefono, fullUrl);

    await musicSnap.docs[0].ref.update({
      status: 'Enviada completa',
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await db.collection('leads').doc(leadId).update({ estadoProduccion: 'Canción Enviada' });

    return res.json({ success: true });
  } catch (err) {
    console.error('Error en /api/whatsapp/send-full:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/send-clip', async (req, res) => {
  const { leadId } = req.body;
  if (!leadId) return res.status(400).json({ error: 'Falta leadId' });

  try {
    const leadSnap = await db.collection('leads').doc(leadId).get();
    if (!leadSnap.exists) return res.status(404).json({ error: 'Lead no encontrado' });
    const telefono = String(leadSnap.data().telefono).replace(/\D/g, '');

    const musicSnap = await db.collection('musica').where('leadPhone', '==', telefono).limit(1).get();
    if (musicSnap.empty) return res.status(404).json({ error: 'No hay clip generado' });

    const { clipUrl } = musicSnap.docs[0].data();
    if (!clipUrl) return res.status(400).json({ error: 'Clip aún no disponible' });

    await sendClipMessage(telefono, clipUrl);

    await musicSnap.docs[0].ref.update({
      status: 'Enviado por botón',
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Error enviando clip:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Enviar mensaje manual
app.post('/api/whatsapp/send-message', async (req, res) => {
  const { leadId, message } = req.body;
  if (!leadId || !message) return res.status(400).json({ error: 'Faltan leadId o message' });

  try {
    const leadDoc = await db.collection('leads').doc(leadId).get();
    if (!leadDoc.exists) return res.status(404).json({ error: 'Lead no encontrado' });
    const { telefono } = leadDoc.data();
    if (!telefono) return res.status(400).json({ error: 'Lead sin número de teléfono' });

    const result = await sendMessageToLead(telefono, message);
    return res.json(result);
  } catch (error) {
    console.error('Error enviando mensaje de WhatsApp:', error);
    return res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Subir audio (webm/opus), convertir a M4A/AAC y enviarlo como PTT
app.post('/api/whatsapp/send-audio', upload.single('audio'), async (req, res) => {
  const { phone } = req.body;
  const uploadPath = req.file.path;
  const m4aPath = `${uploadPath}.m4a`;

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(uploadPath)
        .outputOptions(['-c:a aac', '-vn'])
        .toFormat('mp4')
        .save(m4aPath)
        .on('end', resolve)
        .on('error', reject);
    });

    await sendAudioMessage(phone, m4aPath);

    fs.unlinkSync(uploadPath);
    fs.unlinkSync(m4aPath);

    return res.json({ success: true });
  } catch (error) {
    console.error('Error enviando audio:', error);
    try { fs.unlinkSync(uploadPath); } catch {}
    try { fs.unlinkSync(m4aPath); } catch {}
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Encolar secuencia desde el panel (frontend)
app.post('/api/sequences/enqueue', async (req, res) => {
  try {
    const { leadId, trigger } = req.body; // leadId = "<e164>@s.whatsapp.net"
    if (!leadId || !trigger) {
      return res.status(400).json({ error: 'leadId y trigger son requeridos' });
    }

    const snap = await db.collection('leads').doc(leadId).get();
    const leadData = snap.exists ? snap.data() : {};

    await scheduleSequenceForLead(trigger, leadId, leadData);

    if (trigger === 'MusicaLead') {
      const n = await cancelSequenceForLead({ leadId, sequenceId: 'NuevoLead' });
      if (n > 0) {
        await db.collection('leads').doc(leadId).set({ nuevoLeadCancelled: true }, { merge: true });
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('enqueue error:', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ─────────────────────────────────────────────────────────────
// Marcar mensajes como leídos (solo contador)
app.post('/api/whatsapp/mark-read', async (req, res) => {
  const { leadId } = req.body;
  if (!leadId) return res.status(400).json({ error: 'Falta leadId' });

  try {
    await db.collection('leads').doc(leadId).update({ unreadCount: 0 });
    return res.json({ success: true });
  } catch (err) {
    console.error('Error marcando como leídos:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Healthcheck opcional
app.get('/', (_req, res) => res.send('OK'));

// ─────────────────────────────────────────────────────────────
// Start + conectar WhatsApp
app.listen(port, () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
  connectToWhatsApp().catch(err => console.error('Error al conectar WhatsApp en startup:', err));
});

// ─────────────────────────────────────────────────────────────
// CRON
cron.schedule('*/30 * * * * *', () => {
  console.log('⏱️ processSequences:', new Date().toISOString());
  processSequences().catch(err => console.error('Error en processSequences:', err));
});

cron.schedule('*/1 * * * *', generarLetraParaMusica);
cron.schedule('*/1 * * * *', generarPromptParaMusica);
cron.schedule('*/2 * * * *', generarMusicaConSuno);
cron.schedule('*/2 * * * *', procesarClips);
cron.schedule('*/1 * * * *', enviarMusicaPorWhatsApp);
cron.schedule('*/5 * * * *', () => retryStuckMusic(10));
