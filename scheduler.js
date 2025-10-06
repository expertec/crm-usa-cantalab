// src/server/scheduler.js
import admin from 'firebase-admin';
import { getWhatsAppSock } from './whatsappService.js';
import { db } from './firebaseAdmin.js';
import { Configuration, OpenAIApi } from 'openai';

import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
// al inicio de src/server/scheduler.js (o donde esté tu enviarMusicaPorWhatsApp)
import { sendMessageToLead, sendAudioMessage } from './whatsappService.js';
import { sendClipMessage } from './whatsappService.js';
import { enqueueStep, processQueue } from './queue.js';





const bucket = admin.storage().bucket();

const { FieldValue } = admin.firestore;
// Asegúrate de que la API key esté definida
if (!process.env.OPENAI_API_KEY) {
  throw new Error("Falta la variable de entorno OPENAI_API_KEY");
}

// Configuración de OpenAI
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

/**
 * Reemplaza placeholders en plantillas de texto.
 * {{campo}} se sustituye por leadData.campo si existe.
 */
function replacePlaceholders(template, leadData) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, field) => {
    const value = leadData[field] || '';
    if (field === 'nombre') {
      // devolver sólo la primera palabra del nombre completo
      return value.split(' ')[0] || '';
    }
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
  const body = { model: "V4_5", customMode: true, instrumental: false,
    title, style: stylePrompt, prompt: lyrics,
    callbackUrl: process.env.CALLBACK_URL };
  console.log('🛠️ Suno request:', body);
  const res = await axios.post(url, body, {
    headers: {
      'Content-Type':'application/json',
      Authorization:`Bearer ${process.env.SUNO_API_KEY}`
    }
  });
  console.log('🛠️ Suno response:', res.status, res.data);
  if (res.data.code !== 200 || !res.data.data?.taskId)
    throw new Error(`No taskId recibido: ${JSON.stringify(res.data)}`);
  return res.data.data.taskId;
}

/**
 * Envía un mensaje de WhatsApp según su tipo.
 * Usa exactamente el número que viene en lead.telefono (sin anteponer country code).
 */
async function enviarMensaje(lead, mensaje) {
  try {
    const sock = getWhatsAppSock();
    if (!sock) return;

    const phone = (lead.telefono || '').replace(/\D/g, '');
    const jid = `${phone}@s.whatsapp.net`;

    switch (mensaje.type) {
      case 'texto': {
        const text = replacePlaceholders(mensaje.contenido, lead).trim();
        if (text) await sock.sendMessage(jid, { text });
        break;
      }
      case 'formulario': {
        const rawTemplate = mensaje.contenido || '';
        const nameVal = encodeURIComponent(lead.nombre || '');
        const text = rawTemplate
          .replace('{{telefono}}', phone)
          .replace('{{nombre}}', nameVal)
          .replace(/\r?\n/g, ' ')
          .trim();
        if (text) await sock.sendMessage(jid, { text });
        break;
      }
      case 'audio': {
        const audioUrl = replacePlaceholders(mensaje.contenido, lead);
        console.log('→ Enviando PTT desde URL:', audioUrl);
        await sock.sendMessage(jid, {
          audio: { url: audioUrl },
          ptt: true
      
        });
        break;
      }
      case 'imagen':
        await sock.sendMessage(jid, {
          image: { url: replacePlaceholders(mensaje.contenido, lead) }
        });
        break;
      case 'video':
        await sock.sendMessage(jid, {
          video: { url: replacePlaceholders(mensaje.contenido, lead) },
          // si quieres un caption, descomenta la línea siguiente y añade mensaje.contenidoCaption en tu secuencia
          // caption: replacePlaceholders(mensaje.contenidoCaption || '', lead)
        });
        break;
      default:
        console.warn(`Tipo desconocido: ${mensaje.type}`);
    }
  } catch (err) {
    console.error("Error al enviar mensaje:", err);
  }
}


/**
 * Procesa las secuencias activas de cada lead.
 */
async function processSequences() {
  try {
    const processed = await processQueue({ batchSize: 100 }); // puedes subir a 200/500 si hay más carga
    if (processed > 0) {
      console.log(`✅ processSequences: ${processed} tasks enviados`);
    }
  } catch (err) {
    console.error("Error en processSequences:", err);
  }
}



/**
 * Envía por WhatsApp los guiones generados (status 'enviarGuion'),
 * añade trigger 'GuionEnviado' al lead y marca status → 'enviado'.
 * Solo envía si han pasado al menos 15 minutos desde 'guionGeneratedAt'.
 */




// 1) Generar letra
async function generarLetraParaMusica() {
  const snap = await db.collection('musica').where('status','==','Sin letra').limit(1).get();
  if (snap.empty) return;
  const docSnap = snap.docs[0], d = docSnap.data();
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
      { role: 'user',   content: prompt }
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
  const snap = await db.collection('musica').where('status','==','Sin prompt').limit(1).get();
  if (snap.empty) return;
  const docSnap = snap.docs[0];
  const { artist, genre, voiceType } = docSnap.data();
  const draft = `
  Crea un promt para decirle a suno que haga una canción estilo exitos de  ${artist} genero 
   ${genre} con tipo de voz ${voiceType}. Sin mencionar al artista en cuestion u otras palabras
    que puedan causar conflictos de derecho de autor, centrate en los elementos musicales como ritmo, instrumentos,
     generos. Suno requiere que sean maximo 120 caracteres y que le pases los elementos separados por coma, 
     mira este ejemplo ( rock pop con influencias en blues, guitarra electrica, ritmo de bateria energico)
      genera algo similar para cancion que quiero.
  `.trim();

  const gptRes = await openai.createChatCompletion({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'Eres un redactor creativo de prompts musicales.' },
      { role: 'user',   content: `Refina para <120 chars: "${draft}"` }
    ]
  });
  const stylePrompt = gptRes.data.choices[0].message.content.trim();

  await docSnap.ref.update({
    stylePrompt,
    status: 'Sin música'
  });
  console.log(`✅ generarPromptParaMusica: ${docSnap.id} → "${stylePrompt}"`);
}

// 3) Lanzar Suno
 async function generarMusicaConSuno() {
  const snap = await db.collection('musica').where('status','==','Sin música').limit(1).get();
  if (snap.empty) return;
  const docSnap = snap.docs[0], data = docSnap.data();
  await docSnap.ref.update({
    status: 'Procesando música',
    generatedAt: FieldValue.serverTimestamp()
  });

  try {
    const taskId = await lanzarTareaSuno({
      title:      data.purpose.slice(0,30),
      stylePrompt: data.stylePrompt,
      lyrics:      data.lyrics
    });
    await docSnap.ref.update({ taskId });
    console.log(`🔔 generarMusicaConSuno: task ${taskId} lanzado para ${docSnap.id}`);
  } catch (err) {
    console.error(`❌ generarMusicaConSuno(${docSnap.id}):`, err.message);
    await docSnap.ref.update({
      status:   'Error música',
      errorMsg: err.message,
      updatedAt: FieldValue.serverTimestamp()
    });
  }
}

async function procesarClips() {
  const snap = await db.collection('musica').where('status','==','Audio listo').get();
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

    const tmpFull       = path.join(os.tmpdir(), `${id}-full.mp3`);
    const tmpClip       = path.join(os.tmpdir(), `${id}-clip.m4a`);
    const watermarkUrl  = 'https://cantalab.com/wp-content/uploads/2025/05/marca-de-agua-1-minuto.mp3';
    const tmpWatermark  = path.join(os.tmpdir(), 'watermark.mp3');
    const tmpFinal      = path.join(os.tmpdir(), `${id}-watermarked.m4a`);

    // 1) Descargar full
    await downloadStream(fullUrl, tmpFull);

    // 2) Crear clip de 60s → M4A/AAC
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

    // 3) Mezclar watermark → M4A final
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

    // 4) Subir .m4a público
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

/**
 * Lee todos los docs de 'musica' con status 'Enviar música',
 * envía letra y clip **una sola vez**, y actualiza a 'Enviada'.
 */
async function enviarMusicaPorWhatsApp() {
  const snap = await db.collection('musica')
    .where('status', '==', 'Enviar música')
    .get();
  if (snap.empty) return;

  for (const doc of snap.docs) {
    const { leadId, leadPhone, lyrics, clipUrl } = doc.data();
    const ref = doc.ref;

    // Validaciones
    if (!leadPhone || !lyrics || !clipUrl) {
      console.warn(`[${doc.id}] faltan datos, status sigue 'Enviar música'`);
      continue;
    }

    try {
      // 1) Texto con letra
      const leadDoc = await db.collection('leads').doc(leadId).get();
      const name = leadDoc.exists
        ? leadDoc.data().nombre.split(' ')[0]
        : '';
      const saludo = name
        ? `Hola ${name}, esta es la letra:\n\n${lyrics}`
        : `Esta es la letra:\n\n${lyrics}`;
      await sendMessageToLead(leadPhone, saludo);

      // 2) Texto de preámbulo
      await sendMessageToLead(leadPhone, '¿Cómo la ves? Ahora escucha el clip.');

      // 3) Audio inline desde URL
      await sendClipMessage(leadPhone, clipUrl);

      // 4) Marcar como enviado (ya no volverá a entrar en este cron)
      await ref.update({
        status: 'Enviada',
        sentAt: FieldValue.serverTimestamp()
      });

      // 5) (Opcional) Disparar siguiente secuencia
      await db.collection('leads').doc(leadId).update({
        secuenciasActivas: FieldValue.arrayUnion({
          trigger: 'CancionEnviada',
          startTime: new Date().toISOString(),
          index: 0
        })
      });

      console.log(`✅ Música enviada a ${leadPhone} (doc ${doc.id})`);
    } catch (err) {
      console.error(`❌ Error en ${doc.id}:`, err);
      // Actualizar a error para no reintentar infinitamente
      await ref.update({
        status: 'Error música',
        errorMsg: err.message
      });
    }
  }
}



// 6) Reintento de stuck
async function retryStuckMusic(thresholdMin = 10) {
  const cutoff = Date.now() - thresholdMin*60_000;
  const snap = await db.collection('musica')
    .where('status','==','Procesando música')
    .where('generatedAt','<=',new Date(cutoff))
    .get();
  for (const docSnap of snap.docs) {
    await docSnap.ref.update({
      status:'Sin música',
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


