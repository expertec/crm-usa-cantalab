// server.js
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
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
const bucket = admin.storage().bucket();

// ffmpeg binario
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ⚠️ IMPORTS de WhatsApp (una sola vez)
import {
  connectToWhatsApp,
  getLatestQR,
  getConnectionStatus,
  getSessionPhone,
  sendMessageToLead,
  sendAudioMessage,
  sendClipMessage,
  sendFullAudioAsDocument
} from './whatsappService.js';

// Secuencias (programar/cancelar) → desde queue.js
import { scheduleSequenceForLead, cancelSequences } from './queue.js';

// Tareas programadas
import {
  processSequences,
  generarLetraParaMusica,
  generarPromptParaMusica,
  generarMusicaConSuno,
  procesarClips,
  enviarMusicaPorWhatsApp,
  retryStuckMusic
} from './scheduler.js';

// 🔹 OpenAI para el mensaje de empatía
import OpenAI from 'openai';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});


const app = express();
const port = process.env.PORT || 3001;
const upload = multer({ dest: path.resolve('./uploads') });

app.use(cors());
app.use(bodyParser.json());

/* ----------------------- WhatsApp status / número ----------------------- */
app.get('/api/whatsapp/status', (_req, res) => {
  res.json({ status: getConnectionStatus(), qr: getLatestQR() });
});

app.get('/api/whatsapp/number', (_req, res) => {
  const phone = getSessionPhone();
  if (phone) return res.json({ phone });
  return res.status(503).json({ error: 'WhatsApp no conectado' });
});

/* ----------------------------- Suno callback ---------------------------- */
app.post('/api/suno/callback', express.json(), async (req, res) => {
  const raw    = req.body;
  const taskId = raw.taskId || raw.data?.taskId || raw.data?.task_id;
  if (!taskId) return res.sendStatus(400);

  const item = Array.isArray(raw.data?.data)
    ? raw.data.data.find(i => i.audio_url || i.source_audio_url)
    : null;
  const audioUrlPrivada = item?.audio_url || item?.source_audio_url;
  if (!audioUrlPrivada) return res.sendStatus(200);

  const snap = await db.collection('musica')
    .where('taskId', '==', taskId)
    .limit(1)
    .get();
  if (snap.empty) return res.sendStatus(404);
  const docRef = snap.docs[0].ref;

  try {
    // Descargar MP3 completo
    const tmpFull = path.join(os.tmpdir(), `${taskId}-full.mp3`);
    const r = await axios.get(audioUrlPrivada, { responseType: 'stream' });
    await new Promise((ok, ko) => {
      const ws = fs.createWriteStream(tmpFull);
      r.data.pipe(ws);
      ws.on('finish', ok);
      ws.on('error', ko);
    });

    // Subir a Storage (público)
    const dest = `musica/full/${taskId}.mp3`;
    const [file] = await bucket.upload(tmpFull, {
      destination: dest,
      metadata: { contentType: 'audio/mpeg' }
    });
    await file.makePublic();
    const fullUrl = `https://storage.googleapis.com/${bucket.name}/${file.name}`;

    // Actualizar doc
    await docRef.update({
      fullUrl,
      status: 'Audio listo',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    fs.unlink(tmpFull, () => {});
    return res.sendStatus(200);
  } catch (err) {
    console.error('❌ callback Suno error:', err);
    await docRef.update({ status: 'Error música', errorMsg: err.message });
    return res.sendStatus(500);
  }
});

/* ---------------- Envíos manuales (full / clip / texto / audio) --------- */
app.post('/api/whatsapp/send-full', async (req, res) => {
  const { leadId } = req.body;
  if (!leadId) return res.status(400).json({ error: 'Falta leadId en el body' });

  try {
    const leadSnap = await db.collection('leads').doc(leadId).get();
    if (!leadSnap.exists) return res.status(404).json({ error: 'Lead no encontrado' });
    const telefono = String(leadSnap.data().telefono).replace(/\D/g, '');

    const musicSnap = await db.collection('musica')
      .where('leadPhone', '==', telefono)
      .limit(1)
      .get();
    if (musicSnap.empty) return res.status(404).json({ error: 'No hay música para este lead' });

    const fullUrl = musicSnap.docs[0].data().fullUrl;
    if (!fullUrl) return res.status(400).json({ error: 'fullUrl no disponible' });

    await sendClipMessage(telefono, fullUrl); // o sendFullAudioAsDocument(telefono, fullUrl)

    await musicSnap.docs[0].ref.update({
      status: 'Enviada completa',
      sentAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await db.collection('leads').doc(leadId).update({
      estadoProduccion: 'Canción Enviada'
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Error en /api/whatsapp/send-full:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/send-clip', async (req, res) => {
  const { leadId } = req.body;
  if (!leadId) return res.status(400).json({ error: 'Falta leadId en el body' });

  try {
    const leadSnap = await db.collection('leads').doc(leadId).get();
    if (!leadSnap.exists) return res.status(404).json({ error: 'Lead no encontrado' });
    const telefono = String(leadSnap.data().telefono).replace(/\D/g, '');

    const musicSnap = await db.collection('musica')
      .where('leadPhone', '==', telefono)
      .limit(1)
      .get();
    if (musicSnap.empty) return res.status(404).json({ error: 'No hay clip generado para este lead' });

    const { clipUrl } = musicSnap.docs[0].data();
    if (!clipUrl) return res.status(400).json({ error: 'Clip aún no disponible' });

    await sendClipMessage(telefono, clipUrl);

    await musicSnap.docs[0].ref.update({
      status: 'Enviado por botón',
      sentAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Error enviando clip:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/send-message', async (req, res) => {
  const { leadId, message } = req.body;
  if (!leadId || !message) {
    return res.status(400).json({ error: 'Faltan leadId o message en el body' });
  }

  try {
    const leadSnap = await db.collection('leads').doc(leadId).get();
    if (!leadSnap.exists) return res.status(404).json({ error: 'Lead no encontrado' });

    const { telefono } = leadSnap.data();
    if (!telefono) return res.status(400).json({ error: 'Lead sin número de teléfono' });

    const result = await sendMessageToLead(telefono, message);
    return res.json(result);
  } catch (error) {
    console.error('Error enviando mensaje de WhatsApp:', error);
    return res.status(500).json({ error: error.message });
  }
});

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

/* ---------------------- API para encolar secuencias --------------------- */
app.post('/api/sequences/enqueue', async (req, res) => {
  try {
    const { leadId, trigger } = req.body; // leadId = "<e164>@s.whatsapp.net"
    if (!leadId || !trigger) {
      return res.status(400).json({ error: 'leadId y trigger son requeridos' });
    }

    await scheduleSequenceForLead(leadId, trigger, new Date());

    // Si es MusicaLead, cancela recordatorios de captación
    if (trigger === 'MusicaLead') {
      const n = await cancelSequences(leadId, ['NuevoLead']);
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

/* --------------------- POST formulario → flujo completo ----------------- */
// Corta "NuevoLead", genera/manda empatía (GPT) y encola "MusicaLead"
app.post('/api/lead/after-form', async (req, res) => {
  try {
    const { leadId, summary } = req.body; // summary: { nombre, proposito, genero, artista, anecdotas, requesterName }
    if (!leadId || !summary) {
      return res.status(400).json({ error: 'leadId y summary son requeridos' });
    }

    // traer lead (teléfono)
    const leadSnap = await db.collection('leads').doc(leadId).get();
    if (!leadSnap.exists) return res.status(404).json({ error: 'Lead no encontrado' });
    const lead = leadSnap.data();
    const phone = String(lead.telefono || '').replace(/\D/g, '');
    if (!phone) return res.status(400).json({ error: 'Lead sin teléfono' });

    // 1) Cancelar recordatorios de captación
    await cancelSequences(leadId, ['NuevoLead']);
    await db.collection('leads').doc(leadId).set({ nuevoLeadCancelled: true }, { merge: true });

    // 2) Mensaje de empatía con GPT
    const prompt = `
Eres un asistente empático que escribe un mensaje breve (máx 2 frases),
en español informal, para WhatsApp. Habla en segunda persona y nombra por su
primer nombre si está disponible. Contexto:

- Nombre del cliente: ${summary?.nombre || lead?.nombre || ''}
- Propósito: ${summary?.proposito || ''}
- Género musical deseado: ${summary?.genero || ''}
- Artista de referencia: ${summary?.artista || ''}
- Anécdotas: ${summary?.anecdotas || ''}

Objetivo: inspirar confianza y avisar que ya estamos creando la canción y se la
mandaremos enseguida. Evita promesas de tiempo exacto. No uses comillas.
    `.trim();

    let textoEmpatia = '¡Gracias por la info! Estamos creando tu canción y en breve te la enviamos.';
try {
  const gpt = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Eres conciso, cálido y natural.' },
      { role: 'user', content: prompt }
    ],
    max_tokens: 120,
    temperature: 0.7
  });
  textoEmpatia = (gpt.choices?.[0]?.message?.content || textoEmpatia).trim();
} catch (e) {
  console.warn('GPT empatía falló, usando fallback:', e?.message);
}

    // 3) Enviar mensaje de empatía
    await sendMessageToLead(phone, textoEmpatia);

    // 4) Encolar MusicaLead (editable desde tu panel)
    await scheduleSequenceForLead(leadId, 'MusicaLead', new Date());

    return res.json({ ok: true });
  } catch (e) {
    console.error('/api/lead/after-form error:', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ----------------------- Marcar como leídos (UI) ------------------------ */
app.post('/api/whatsapp/mark-read', async (req, res) => {
  const { leadId } = req.body;
  if (!leadId) return res.status(400).json({ error: 'Falta leadId en el body' });

  try {
    await db.collection('leads').doc(leadId).update({ unreadCount: 0 });
    return res.json({ success: true });
  } catch (err) {
    console.error('Error marcando como leídos:', err);
    return res.status(500).json({ error: err.message });
  }
});

/* ------------------- Arranque + conexión WhatsApp ----------------------- */
app.listen(port, () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
  connectToWhatsApp().catch(err =>
    console.error('Error al conectar WhatsApp en startup:', err)
  );
});

/* ----------------------------- CRON JOBS -------------------------------- */
cron.schedule('*/30 * * * * *', () => {
  console.log('⏱️ processSequences:', new Date().toISOString());
  processSequences().catch(err => console.error('Error en processSequences:', err));
});

// Música
cron.schedule('*/1 * * * *', generarLetraParaMusica);
cron.schedule('*/1 * * * *', generarPromptParaMusica);
cron.schedule('*/2 * * * *', generarMusicaConSuno);
cron.schedule('*/2 * * * *', procesarClips);
cron.schedule('*/1 * * * *', enviarMusicaPorWhatsApp);
cron.schedule('*/5 * * * *', () => retryStuckMusic(10));