// src/server/scheduler.js
import admin from 'firebase-admin';
import { db } from './firebaseAdmin.js';
import { Configuration, OpenAIApi } from 'openai';

import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';

import { processQueue, cancelSequences } from './queue.js';
import { sendMessageToLead, sendClipMessage } from './whatsappService.js';

const bucket = admin.storage().bucket();
const { FieldValue } = admin.firestore;

/* ========================= OpenAI ========================= */
if (!process.env.OPENAI_API_KEY) {
  throw new Error('Falta la variable de entorno OPENAI_API_KEY');
}
const configuration = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
const openai = new OpenAIApi(configuration);

/* ========================= Utils ========================= */
function replacePlaceholders(template, leadData) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, field) => {
    const value = leadData?.[field] || '';
    if (field === 'nombre') return String(value).split(' ')[0] || '';
    return value;
  });
}

async function downloadStream(url, destPath) {
  const res = await axios.get(url, { responseType: 'stream' });
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    res.data.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
}

async function lanzarTareaSuno({ title, stylePrompt, lyrics }) {
  const url = 'https://apibox.erweima.ai/api/v1/generate';
  const body = {
    model: 'V4_5',
    customMode: true,
    instrumental: false,
    title,
    style: stylePrompt,
    prompt: lyrics,
    callbackUrl: process.env.CALLBACK_URL
  };
  console.log('🛠️ Suno request:', body);
  const res = await axios.post(url, body, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.SUNO_API_KEY}`
    }
  });
  console.log('🛠️ Suno response:', res.status, res.data);
  if (res.data.code !== 200 || !res.data.data?.taskId) {
    throw new Error(`No taskId recibido: ${JSON.stringify(res.data)}`);
  }
  return res.data.data.taskId;
}

/* ========== Cancelación automática de NuevoLead cuando ya es MusicaLead ========== */
async function cancelNuevoLeadForFormLeads({ limit = 300 }) {
  const snap = await db
    .collection('leads')
    .where('etiquetas', 'array-contains', 'MusicaLead')
    .limit(limit)
    .get();

  if (snap.empty) return 0;

  let cancelled = 0;
  for (const d of snap.docs) {
    const lead = { id: d.id, ...d.data() };
    if (lead.nuevoLeadCancelled) continue;

    const n = await cancelSequences(lead.id, ['NuevoLead']);
    if (n > 0) cancelled += n;

    await db.collection('leads').doc(lead.id).set(
      { nuevoLeadCancelled: true },
      { merge: true }
    );
  }
  return cancelled;
}

/* ========================= Cron principal (cola) ========================= */
async function processSequences() {
  try {
    const c = await cancelNuevoLeadForFormLeads({ limit: 300 });
    if (c) console.log(`🛑 cancelNuevoLeadForFormLeads: ${c} tareas canceladas`);

    const processed = await processQueue({ batchSize: 100 }); // sube a 200/500 si necesitas
    if (processed > 0) {
      console.log(`✅ processSequences: ${processed} tasks enviados`);
    }
  } catch (err) {
    console.error('Error en processSequences:', err);
  }
}

/* ========================= Flujos de música ========================= */
// 1) Generar letra
async function generarLetraParaMusica() {
  const snap = await db.collection('musica')
    .where('status', '==', 'Sin letra')
    .limit(1)
    .get();

  if (snap.empty) return;

  const docSnap = snap.docs[0];
  const d = docSnap.data();

  const prompt = `
Escribe una letra de canción con lenguaje simple siguiendo esta estructura:
verso 1, verso 2, coro, verso 3, verso 4 y coro.
Agrega título en negritas.
Propósito: ${d.purpose}.
Nombre: ${d.includeName}.
Anecdotas: ${d.anecdotes}.
  `.trim();

  const resp = await openai.createChatCompletion({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'Eres un compositor creativo.' },
      { role: 'user', content: prompt }
    ],
    max_tokens: 400
  });

  const letra = resp.data.choices?.[0]?.message?.content?.trim();
  if (!letra) throw new Error(`No letra para ${docSnap.id}`);

  await docSnap.ref.update({
    lyrics: letra,
    status: 'Sin prompt',
    lyricsGeneratedAt: FieldValue.serverTimestamp()
  });
  console.log(`✅ generarLetraParaMusica: letra generada para ${docSnap.id}`);

  if (d.leadId) {
    await db.collection('leads').doc(d.leadId).update({
      letra: letra,
      letraIds: FieldValue.arrayUnion(docSnap.id)
    });
    console.log(`✅ letra guardada en lead ${d.leadId}`);
  }
}

// 2) Generar prompt
async function generarPromptParaMusica() {
  const snap = await db.collection('musica')
    .where('status', '==', 'Sin prompt')
    .limit(1)
    .get();

  if (snap.empty) return;

  const docSnap = snap.docs[0];
  const { artist, genre, voiceType } = docSnap.data();

  const draft = `
Crea un prompt para pedir a Suno una canción con elementos de ${artist} (sin nombrarlo),
género ${genre} y tipo de voz ${voiceType}. Máx 120 caracteres, usa comas para separar elementos.
Ejemplo: "rock pop con influencias blues, guitarra eléctrica, batería enérgica".
  `.trim();

  const gptRes = await openai.createChatCompletion({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'Eres un redactor creativo de prompts musicales.' },
      { role: 'user', content: `Refina para <120 chars y separa por comas: "${draft}"` }
    ]
  });

  const stylePrompt = gptRes.data.choices[0].message.content.trim();
  await docSnap.ref.update({ stylePrompt, status: 'Sin música' });
  console.log(`✅ generarPromptParaMusica: ${docSnap.id} → "${stylePrompt}"`);
}

// 3) Lanzar Suno
async function generarMusicaConSuno() {
  const snap = await db.collection('musica')
    .where('status', '==', 'Sin música')
    .limit(1)
    .get();

  if (snap.empty) return;

  const docSnap = snap.docs[0];
  const data = docSnap.data();

  await docSnap.ref.update({
    status: 'Procesando música',
    generatedAt: FieldValue.serverTimestamp()
  });

  try {
    const taskId = await lanzarTareaSuno({
      title: (data.purpose || '').slice(0, 30),
      stylePrompt: data.stylePrompt,
      lyrics: data.lyrics
    });

    await docSnap.ref.update({ taskId });
    console.log(`🔔 generarMusicaConSuno: task ${taskId} lanzado para ${docSnap.id}`);
  } catch (err) {
    console.error(`❌ generarMusicaConSuno(${docSnap.id}):`, err.message);
    await docSnap.ref.update({
      status: 'Error música',
      errorMsg: err.message,
      updatedAt: FieldValue.serverTimestamp()
    });
  }
}

// 4) Generar clip (60s + watermark) y subirlo público
async function procesarClips() {
  const snap = await db.collection('musica')
    .where('status', '==', 'Audio listo')
    .get();

  if (snap.empty) return;

  for (const doc of snap.docs) {
    const ref = doc.ref;
    const { fullUrl } = doc.data();
    const id = doc.id;

    if (!fullUrl) {
      console.error(`[${id}] falta fullUrl`);
      continue;
    }
    await ref.update({ status: 'Generando clip' });

    const tmpFull = path.join(os.tmpdir(), `${id}-full.mp3`);
    const tmpClip = path.join(os.tmpdir(), `${id}-clip.m4a`);
    const watermarkUrl = 'https://cantalab.com/wp-content/uploads/2025/05/marca-de-agua-1-minuto.mp3';
    const tmpWatermark = path.join(os.tmpdir(), 'watermark.mp3');
    const tmpFinal = path.join(os.tmpdir(), `${id}-watermarked.m4a`);

    // 1) Descargar full
    await downloadStream(fullUrl, tmpFull);

    // 2) Recortar a 60s AAC/M4A
    try {
      await new Promise((res, rej) => {
        ffmpeg(tmpFull)
          .setStartTime(0)
          .setDuration(60)
          .audioCodec('aac')
          .format('ipod')
          .output(tmpClip)
          .on('end', res)
          .on('error', rej)
          .run();
      });
    } catch (err) {
      console.error(`[${id}] error al generar clip AAC:`, err);
      await ref.update({ status: 'Error clip' });
      continue;
    }

    // 3) Mezclar watermark → final M4A
    await downloadStream(watermarkUrl, tmpWatermark);
    try {
      await new Promise((res, rej) => {
        ffmpeg()
          .input(tmpClip)
          .input(tmpWatermark)
          .complexFilter([
            '[1]adelay=1000|1000,volume=0.3[wm];[0][wm]amix=inputs=2:duration=first'
          ])
          .audioCodec('aac')
          .format('ipod')
          .output(tmpFinal)
          .on('end', res)
          .on('error', rej)
          .run();
      });
    } catch (err) {
      console.error(`[${id}] error al mezclar watermark AAC:`, err);
      await ref.update({ status: 'Error watermark' });
      continue;
    }

    // 4) Subir final
    try {
      const dest = `musica/clip/${id}-clip.m4a`;
      const [file] = await bucket.upload(tmpFinal, {
        destination: dest,
        metadata: { contentType: 'audio/mp4' }
      });
      await file.makePublic();
      const clipUrl = `https://storage.googleapis.com/${bucket.name}/${file.name}`;

      await ref.update({ clipUrl, status: 'Enviar música' });
      console.log(`[${id}] clip AAC listo → Enviar música`);
    } catch (err) {
      console.error(`[${id}] error upload clip AAC:`, err);
      await ref.update({ status: 'Error upload clip' });
    }

    // 5) Limpieza
    [tmpFull, tmpClip, tmpWatermark, tmpFinal].forEach(f => {
      try { fs.unlinkSync(f); } catch {}
    });
  }
}

// 5) Enviar letra + clip a WhatsApp y marcar Enviada
// 5) Enviar letra + link de escucha a WhatsApp y marcar Enviada
async function enviarMusicaPorWhatsApp() {
  const snap = await db.collection('musica').where('status', '==', 'Enviar música').get();
  if (snap.empty) return;

  for (const doc of snap.docs) {
    const { leadId, leadPhone, lyrics } = doc.data();
    const ref = doc.ref;

    if (!leadPhone || !lyrics) {
      console.warn(`[${doc.id}] faltan datos, status sigue 'Enviar música'`);
      continue;
    }

    try {
      // 1) Texto con letra
      const leadDoc = await db.collection('leads').doc(leadId).get();
      const name = leadDoc.exists ? (leadDoc.data().nombre || '').split(' ')[0] : '';
      const saludo = name
        ? `Hola ${name}, esta es la letra:\n\n${lyrics}`
        : `Esta es la letra:\n\n${lyrics}`;
      await sendMessageToLead(leadPhone, saludo);

      // 2) Generar link de escucha
      const listenUrl = `https://cantalab.com/escuchar/${leadPhone}`;

      // 3) Enviar mensaje con link
      await sendMessageToLead(
        leadPhone,
        `🎧 Ya tenemos tu canción lista.\n\nEscúchala aquí:\n${listenUrl}\n\n⚠️ El acceso es limitado, guárdalo bien.`
      );

      // 4) Marcar como enviada en Firestore
      await ref.update({
        status: 'Enviada',
        listenUrl,
        sentAt: FieldValue.serverTimestamp()
      });

      // (opcional) Etiqueta informativa
      if (leadId) {
        await db.collection('leads').doc(leadId).set(
          { etiquetas: admin.firestore.FieldValue.arrayUnion('CancionEnviada') },
          { merge: true }
        );
      }

      console.log(`✅ Música enviada a ${leadPhone} (doc ${doc.id})`);
    } catch (err) {
      console.error(`❌ Error en ${doc.id}:`, err);
      await ref.update({ status: 'Error música', errorMsg: err.message });
    }
  }
}


// 6) Reintento de stuck (Suno)
async function retryStuckMusic(thresholdMin = 10) {
  const cutoff = Date.now() - thresholdMin * 60_000;
  const snap = await db.collection('musica')
    .where('status', '==', 'Procesando música')
    .where('generatedAt', '<=', new Date(cutoff))
    .get();

  for (const docSnap of snap.docs) {
    await docSnap.ref.update({
      status: 'Sin música',
      taskId: FieldValue.delete(),
      errorMsg: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp()
    });
  }
}

export {
  processSequences,
  generarLetraParaMusica,
  generarPromptParaMusica,
  generarMusicaConSuno,
  procesarClips,
  enviarMusicaPorWhatsApp,
  retryStuckMusic
};