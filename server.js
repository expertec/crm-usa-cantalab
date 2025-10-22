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

// ===================== PLANS API (ADMIN) =====================
const plansColl = db.collection('billing').doc('plans').collection('items');


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

// Helper: elimina undefined (también dentro de objetos/arrays)
function pruneUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(pruneUndefined).filter(v => v !== undefined);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const cleaned = pruneUndefined(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value === undefined ? undefined : value;
}

// Crear / Actualizar (upsert) — SIN undefined a Firestore
app.post('/api/plans', async (req, res) => {
  try {
    const body = req.body || {};

    const id = body.id || null;
    const name = String(body.name || '').trim();
    const priceMonthly = Number(body.priceMonthly);
    const priceYearly = body.priceYearly !== undefined ? Number(body.priceYearly) : undefined;
    const songsPerMonth = Number(body.songsPerMonth);
    const currency = String(body.currency || 'MXN').toUpperCase();
    const features = Array.isArray(body.features) ? body.features.map(String) : [];
    const active = !!body.active;
    const displayOrder = Number(body.displayOrder || 0);
    const yearlyDiscount = body.yearlyDiscount !== undefined ? Number(body.yearlyDiscount) : undefined;
    const description = String(body.description || '');

    // Validación básica
    if (!name) return res.status(400).json({ error: 'name requerido' });
    if (!Number.isFinite(priceMonthly)) return res.status(400).json({ error: 'priceMonthly debe ser numérico' });
    if (!Number.isFinite(songsPerMonth)) return res.status(400).json({ error: 'songsPerMonth debe ser numérico' });

    // Construye stripe SOLO si viene priceId (para no meter undefined)
    let stripe;
    const priceId = body?.stripe?.priceId ? String(body.stripe.priceId).trim() : '';
    if (priceId) {
      stripe = { priceId };
    }

    // Construye payload sin undefined
    const payloadRaw = {
      name,
      description,
      priceMonthly,
      currency,
      songsPerMonth,
      features,
      active,
      displayOrder,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      // opcionales:
      priceYearly: Number.isFinite(priceYearly) ? priceYearly : undefined,
      yearlyDiscount: Number.isFinite(yearlyDiscount) ? yearlyDiscount : undefined,
      stripe, // SOLO si existe queda, si no se purga
      ...(id ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp() })
    };

    const payload = pruneUndefined(payloadRaw);

    const ref = id ? plansColl.doc(id) : plansColl.doc();
    await ref.set(payload, { merge: true });

    const saved = await ref.get();
    return res.json({ id: ref.id, ...saved.data() });
  } catch (e) {
    console.error('POST /api/plans error:', e?.message, e);
    return res.status(500).json({ error: e?.message || 'internal_error' });
  }
});


// Obtener un plan por id
app.get('/api/plans/:id', async (req, res) => {
  try {
    const doc = await plansColl.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'not_found' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (e) {
    console.error('GET /api/plans/:id', e);
    res.status(500).json({ error: 'internal_error' });
  }
});



// Eliminar un plan
app.delete('/api/plans/:id', async (req, res) => {
  try {
    await plansColl.doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/plans/:id', e);
    res.status(500).json({ error: 'internal_error' });
  }
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
// Corta "NuevoLead", genera empatía (GPT) con retraso y NO inicia MusicaLead aquí
app.post('/api/lead/after-form', async (req, res) => {
  try {
    const { leadId, summary } = req.body; // summary: { nombre, proposito, genero, artista, anecdotas/anecdotes, requesterName }
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

    // 2) Mensaje de empatía (HECHO por GPT: interpretación + tono humano, sin “:”, 1 frase + cierre)
    const requesterName = (summary?.requesterName || '').toString().trim(); // quien recibirá el WhatsApp
    const firstName     = requesterName.split(/\s+/)[0] || '';
    const anecdotes     = (summary?.anecdotes || summary?.anecdotas || '').toString().trim();
    const genre         = (summary?.genre || '').toString().trim();
    const artist        = (summary?.artist || '').toString().trim();

    const CIERRE_FIJO   = 'Voy a poner todo de mí para hacer esta canción; enseguida te la envío.';

    function clean(s) {
      return String(s || '').replace(/[“”"']/g, '').replace(/\s+/g, ' ').trim();
    }
    function forceClose(text) {
      // Asegura 1 frase principal + cierre fijo (sin “:”)
      const t = clean(text).replace(/\s*:\s*/g, ', ');
      // toma solo la primera oración/segmento razonable
      const primera = t.split(/(?<=[.!?])\s+/)[0] || t;
      return clean(`${primera} ${CIERRE_FIJO}`);
    }

    let textoEmpatia = `${firstName ? firstName + ', ' : ''}gracias por tu mensaje. ${CIERRE_FIJO}`;

    try {
      const reglas = `
Escribe un mensaje de WhatsApp en español como si fueras el autor de la canción.
Objetivo: interpretar con empatía lo que la persona contó en su anécdota y agradecer con calidez.

Requisitos MUY importantes:
- Empieza saludando por el primer nombre: "${firstName}" si existe.
- 1 sola frase natural (sin dos puntos ":"), que suene a comentario personal (me conmueve / qué bonita historia / me gusta…).
- Usa SOLO datos provistos (no inventes nombres ni hechos).
- Si hay artista o género, puedes mencionarlos brevemente SOLO si ayudan, sin exagerar.
- Prohibido comillas, emojis y hashtags.
- No pongas tiempos específicos.
- NO incluyas la frase de cierre; yo la agregaré después.
- Longitud preferida: 18–35 palabras.

Ejemplo de estilo (solo referencia de tono, no copiar literalmente):
"Sergio, me conmovió lo que cuentas de tu tocayo Sergio Pérez, perderle la pista de niños y verlo llegar a F1 con Red Bull; qué historia tan especial."
`.trim();

      const contexto = `
Datos:
- Nombre (para saludo): ${firstName || '(no disponible)'}
- Anécdota: ${anecdotes || '(no disponible)'}
- Género: ${genre || '(no especificado)'}
- Artista: ${artist || '(no especificado)'}
`.trim();

      const { text } = await chatCompletionCompat({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Eres conciso, cálido y natural. No inventas información.' },
          { role: 'user', content: `${reglas}\n\n${contexto}\n\nRedacta SOLO la frase principal (sin el cierre).` }
        ],
        max_tokens: 120,
        temperature: 0.35
      });

      const principal = text ? clean(text) : '';
      if (principal) {
        textoEmpatia = forceClose(principal);
      } else {
        // Fallback mini
        const base = firstName ? `${firstName}, ` : '';
        const apunte = anecdotes
          ? 'me conmueve lo que compartes; es una historia especial'
          : 'gracias por la información';
        textoEmpatia = `${base}${apunte}. ${CIERRE_FIJO}`;
      }

      console.log('[GPT empatía] →', textoEmpatia);
    } catch (e) {
      console.warn('GPT empatía falló, usando fallback:', e?.message);
      const base = firstName ? `${firstName}, ` : '';
      textoEmpatia = `${base}gracias por confiarme tu historia. ${CIERRE_FIJO}`;
    }

    // 3) Enviar mensaje de empatía con retraso (1–2 minutos)
    const delayMs = 60_000 + Math.floor(Math.random() * 60_000); // 60–120s
    setTimeout(() => {
      sendMessageToLead(phone, textoEmpatia).catch(err =>
        console.error('Error enviando empatía diferida:', err)
      );
    }, delayMs);

    // ❌ YA NO iniciar MusicaLead aquí; se hará tras enviar el link en scheduler.js

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

/* ===================== Reproductor con token (HTML simple) ===================== */
app.get('/escuchar/:token', async (req, res) => {
  try {
    const { token } = req.params;
    // localizar doc musica por token
    const snap = await db.collection('musica').where('listen.token', '==', token).limit(1).get();
    if (snap.empty) return res.status(404).send('Link inválido o expirado');

    const d = snap.docs[0].data();
    if (d.listen?.disabled) return res.status(410).send('Este enlace ya no está disponible.');

    // Página mínima con reproductor (usa stream protegido y progreso)
    const html = `
<!doctype html>
<html lang="es">
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Escuchar tu canción</title>
<style>
  body { font-family: system-ui, Arial; padding: 20px; max-width: 520px; margin: auto; }
  .wrap { border: 1px solid #ddd; border-radius: 14px; padding: 16px; }
  .warn { color: #9a3412; font-size: 14px; margin-top: 8px; }
  audio { width: 100%; margin-top: 10px; }
  .muted { color: #666; font-size: 13px; }
</style>
<div class="wrap">
  <h2>🎧 Tu canción</h2>
  <p class="muted">Este enlace permite hasta 2 reproducciones.</p>
  <audio id="player" controls controlsList="nodownload noplaybackrate">
    <source src="/api/music/stream/${token}" type="audio/mp4"/>
    Tu navegador no soporta audio.
  </audio>
  <p class="warn">No cierres esta ventana mientras escuchas.</p>
</div>
<script>
  (function(){
    const audio = document.getElementById('player');
    let sent50 = false;
    let duration = 0;

    audio.addEventListener('loadedmetadata', () => {
      duration = audio.duration || 0;
    });

    // Reporta 50% una sola vez
    setInterval(() => {
      if (sent50) return;
      if (!duration || !isFinite(duration)) return;
      const cur = audio.currentTime || 0;
      const pct = cur / duration;
      if (pct >= 0.5) {
        sent50 = true;
        fetch('/api/music/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: '${token}', pct: 0.5 })
        }).catch(() => {});
      }
    }, 2000);
  })();
</script>
`;
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(html);
  } catch (e) {
    console.error('GET /escuchar error:', e);
    return res.status(500).send('Error de servidor');
  }
});

/* ===================== Stream protegido con contador de plays ===================== */
app.get('/api/music/stream/:token', async (req, res) => {
  try {
    const { token } = req.params;

    // localizar doc musica
    const qs = await db.collection('musica').where('listen.token', '==', token).limit(1).get();
    if (qs.empty) return res.status(404).send('No encontrado');

    const doc = qs.docs[0];
    const data = doc.data();

    if (data.listen?.disabled) return res.status(410).send('Enlace deshabilitado');
    const playCount = Number(data.listen?.playCount || 0);
    const maxPlays  = Number(data.listen?.maxPlays || 2);
    if (playCount >= maxPlays) {
      return res.status(403).send('Has alcanzado el límite de reproducciones');
    }

    // Incrementar playCount de forma atómica (una vez por “play”)
    await doc.ref.update({ 'listen.playCount': admin.firestore.FieldValue.increment(1) });

    // Si quieres deshabilitar al llegar justo al máximo, descomenta:
    // if (playCount + 1 >= maxPlays) {
    //   await doc.ref.update({ 'listen.disabled': true });
    // }

    // Proxy del archivo (usa clipUrl si es el que quieres limitar)
    const fileUrl = data.clipUrl || data.fullUrl;
    if (!fileUrl) return res.status(404).send('Archivo no disponible');

    // Descargar por streaming y reenviar (sin descarga)
    const upstream = await axios.get(fileUrl, { responseType: 'stream' });

    res.setHeader('Content-Type', upstream.headers['content-type'] || 'audio/mp4');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Content-Disposition', 'inline; filename="escucha.m4a"');
    // Nota: impedir descarga al 100% es imposible en la web; esto la dificulta.

    upstream.data.pipe(res);
    upstream.data.on('error', err => {
      console.error('Stream proxy error:', err);
      try { res.destroy(err); } catch {}
    });
  } catch (e) {
    console.error('GET /api/music/stream error:', e);
    return res.status(500).send('Error de servidor');
  }
});

/* ===================== Progreso: 50% → parar MusicaLead, iniciar LeadSeguimiento ===================== */
app.post('/api/music/progress', async (req, res) => {
  try {
    const { token, pct } = req.body || {};
    if (!token) return res.status(400).json({ ok: false });

    const qs = await db.collection('musica').where('listen.token', '==', token).limit(1).get();
    if (qs.empty) return res.status(404).json({ ok: false });

    const doc = qs.docs[0];
    const data = doc.data();

    // marca “>=50% escuchado”
    await doc.ref.set({ 'listen.halfHeard': true }, { merge: true });

    if (data.leadId) {
      // 1) Desactivar MusicaLead
      await cancelSequences(data.leadId, ['MusicaLead']);
      // 2) Activar LeadSeguimiento
      await scheduleSequenceForLead(data.leadId, 'LeadSeguimiento', new Date());
      console.log(`🔁 Secuencias: MusicaLead cancelada → LeadSeguimiento iniciada para ${data.leadId}`);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/music/progress error:', e);
    return res.status(500).json({ ok: false });
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
