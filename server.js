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

// 🔹 OpenAI (lazy + compat v3/v4 + responses API)
import OpenAIImport from 'openai';

dotenv.config();

/* ========================= OpenAI helpers robustos ========================= */
function assertOpenAIKey() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Falta la variable de entorno OPENAI_API_KEY');
  }
}

// En algunas instalaciones, el paquete exporta { OpenAI }, en otras el ctor por default
const OpenAICtor = OpenAIImport?.OpenAI || OpenAIImport;

/** Devuelve un cliente y el “modo” detectado */
async function getOpenAI() {
  assertOpenAIKey();
  try {
    const client = new OpenAICtor({ apiKey: process.env.OPENAI_API_KEY });

    // Detectar capacidades presentes
    const hasChatCompletions = !!client?.chat?.completions?.create;
    const hasResponses = !!client?.responses?.create;

    if (hasChatCompletions) return { client, mode: 'v4-chat' };
    if (hasResponses) return { client, mode: 'v4-responses' };
  } catch {
    // cae a v3
  }

  // Fallback v3 (openai@3)
  const { Configuration, OpenAIApi } = await import('openai');
  const configuration = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
  const client = new OpenAIApi(configuration);
  return { client, mode: 'v3' };
}

/** Extrae texto de respuesta para cualquier modo */
function extractTextFromAny(resp, mode) {
  try {
    if (mode === 'v4-chat') {
      return resp?.choices?.[0]?.message?.content?.trim() || '';
    }
    if (mode === 'v4-responses') {
      // Algunas versiones traen .output_text, otras hay que juntar los items
      if (resp?.output_text) return String(resp.output_text).trim();
      // fallback: juntar fragmentos
      const parts = [];
      const content = resp?.output || resp?.content || [];
      for (const item of content) {
        if (typeof item === 'string') parts.push(item);
        else if (Array.isArray(item?.content)) {
          for (const c of item.content) {
            if (c?.text?.value) parts.push(c.text.value);
          }
        } else if (item?.text?.value) {
          parts.push(item.text.value);
        }
      }
      return parts.join(' ').trim();
    }
    // v3
    return resp?.data?.choices?.[0]?.message?.content?.trim() || '';
  } catch {
    return '';
  }
}

/** Wrapper unificado para pedir una completion estilo chat */
async function chatCompletionCompat({ model, messages, max_tokens = 200, temperature = 0.7 }) {
  const { client, mode } = await getOpenAI();

  if (mode === 'v4-chat') {
    const resp = await client.chat.completions.create({ model, messages, max_tokens, temperature });
    return { text: extractTextFromAny(resp, mode), raw: resp, mode };
  }

  if (mode === 'v4-responses') {
    // responses.create usa un esquema distinto: input como “contenido”
    const resp = await client.responses.create({
      model,
      input: messages?.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')
    });
    return { text: extractTextFromAny(resp, mode), raw: resp, mode };
  }

  // v3
  const resp = await client.createChatCompletion({ model, messages, max_tokens, temperature });
  return { text: extractTextFromAny(resp, 'v3'), raw: resp, mode: 'v3' };
}
/* ======================================================================== */

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
    const { leadId, trigger } = req.body; // leadId = "<e164>@s.whatsapp.net" o "521..."
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

   // 2) Mensaje de empatía (centrado en anecdotes) + cierre fijo
const nombre      = (summary?.nombre || lead?.nombre || '').toString().trim();
const firstName   = (nombre || '').split(/\s+/)[0] || '';
const anecdotes   = (summary?.anecdotes || '').toString().trim();  // <— del formulario real
const genre       = (summary?.genre || '').toString().trim();      // <— del formulario real
const artist      = (summary?.artist || '').toString().trim();     // <— del formulario real

const hayAnecdota = anecdotes.length > 0;

const reglas = `
Escribe un mensaje de WhatsApp en español, de 1 o 2 frases, cálido y natural.
1) Saluda por el primer nombre si existe ("${firstName}").
2) Comenta empáticamente SOBRE LA ANÉCDOTA exactamente como está (no inventes).
3) Puedes mencionar el género "${genre}" de forma breve, solo si ayuda.
4) Menciona un artista SOLO si viene explícito ("${artist}"); si no, no lo inventes.
5) Sin comillas, emojis ni hashtags.
6) La segunda frase debe ser EXACTAMENTE: "Voy a poner todo de mí para hacer esta canción; enseguida te la envío."
`.trim();

const contexto = `
Nombre: ${firstName || '(sin nombre)'}
Anécdota: ${hayAnecdota ? anecdotes : '(sin anécdota)'}
Género: ${genre || '(sin género)'}
Artista: ${artist || '(sin artista)'}
`.trim();

const promptEmpatia = `
${reglas}

Objetivo: confirmar que recibimos su información y reflejar la anécdota con empatía.

Contexto del cliente:
${contexto}

Redacta el mensaje final (sin comillas).
`.trim();

let textoEmpatia =
  '¡Gracias por tu información! Ya estoy trabajando en tu canción. ' +
  'Voy a poner todo de mí para hacer esta canción; enseguida te la envío.';

function sanitize(txt) {
  const cierreFijo = 'Voy a poner todo de mí para hacer esta canción; enseguida te la envío.';
  let out = String(txt || '')
    .replace(/[“”"]+/g, '')     // sin comillas
    .replace(/\s+/g, ' ')
    .trim();

  // Fuerza cierre fijo como segunda frase
  if (out) {
    const primera = out.split(/(?<=[.!?])\s+/)[0] || out;
    out = `${primera} ${cierreFijo}`;
  } else {
    out = cierreFijo;
  }

  // Si no hay anécdota, evita frases que finjan detalles
  if (!hayAnecdota) {
    out = out.replace(/\b(inspirad[oa]\s+en|basad[oa]\s+en|sobre\s+la\s+historia\s+de)\b.*?(?=[.!]|$)/gi, '').trim();
    if (!out.endsWith(cierreFijo)) out = `${out} ${cierreFijo}`;
  }

  return out.length > 280 ? out.slice(0, 280).trim() : out;
}

try {
  const { text } = await chatCompletionCompat({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Eres conciso, cálido y natural. Cumple estrictamente las reglas.' },
      { role: 'user', content: promptEmpatia }
    ],
    max_tokens: 140,
    temperature: 0.4
  });
  const limpio = sanitize(text);
  if (limpio) textoEmpatia = limpio;
  console.log('[GPT empatía] →', textoEmpatia);
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
