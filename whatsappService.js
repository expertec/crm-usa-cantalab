// whatsappService.js
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from 'baileys';
import QRCode from 'qrcode-terminal';
import Pino from 'pino';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import admin from 'firebase-admin';
import { db } from './firebaseAdmin.js';

// Cola de secuencias (versión nueva en queue.js)
import { scheduleSequenceForLead, cancelSequences } from './queue.js';

let latestQR = null;
let connectionStatus = 'Desconectado';
let whatsappSock = null;
let sessionPhone = null;

const localAuthFolder = '/var/data';
const { FieldValue } = admin.firestore;
const bucket = admin.storage().bucket();

/* ------------------------------ helpers ------------------------------ */
function normalizePhoneNumber(phone) {
  // Eliminar todo lo que no sea dígito
  let num = String(phone).replace(/\D/g, '');
  
  // Si tiene 10 dígitos, agregar 521 (celular México)
  if (num.length === 10) {
    return '521' + num;
  }
  
  // Si tiene 12 dígitos y empieza con 52, convertir a 521
  if (num.length === 12 && num.startsWith('52')) {
    return '521' + num.substring(2);
  }
  
  // Si tiene 13 dígitos y empieza con 521, dejarlo así
  if (num.length === 13 && num.startsWith('521')) {
    return num;
  }
  
  // Para cualquier otro caso, retornar tal cual
  return num;
}

function firstName(n = '') {
  return String(n).trim().split(/\s+/)[0] || '';
}

function tpl(str, lead) {
  return String(str || '').replace(/\{\{(\w+)\}\}/g, (_, f) => {
    if (f === 'nombre') return firstName(lead?.nombre || '');
    if (f === 'telefono') return String(lead?.telefono || '').replace(/\D/g, '');
    return lead?.[f] ?? '';
  });
}

/* ---------------------------- conexión WA ---------------------------- */
export async function connectToWhatsApp() {
  try {
    if (!fs.existsSync(localAuthFolder)) {
      fs.mkdirSync(localAuthFolder, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(localAuthFolder);
    if (state.creds.me?.id) sessionPhone = state.creds.me.id.split('@')[0];

    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      auth: state,
      logger: Pino({ level: 'info' }),
      printQRInTerminal: true,
      version,
    });
    whatsappSock = sock;

    // ── eventos de conexión
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        latestQR = qr;
        connectionStatus = 'QR disponible. Escanéalo.';
        QRCode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        connectionStatus = 'Conectado';
        latestQR = null;
        if (sock.user?.id) sessionPhone = sock.user.id.split('@')[0];
      }
      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        connectionStatus = 'Desconectado';
        if (reason === DisconnectReason.loggedOut) {
          // limpiar sesión local y forzar re-login
          for (const f of fs.readdirSync(localAuthFolder)) {
            fs.rmSync(path.join(localAuthFolder, f), { force: true, recursive: true });
          }
          sessionPhone = null;
        }
        // reintento automático
        connectToWhatsApp();
      }
    });

    sock.ev.on('creds.update', saveCreds);

    /* -------------------- recepción de mensajes -------------------- */
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        try {
          if (!msg.key) continue;
          const jid = msg.key.remoteJid;
          if (!jid || jid.endsWith('@g.us')) continue; // ignorar grupos

          const rawPhone = jid.split('@')[0];
          const phone = normalizePhoneNumber(rawPhone); // 🔧 Normalizar a 521 + 10 dígitos
          const leadId = jid;
          const sender = msg.key.fromMe ? 'business' : 'lead';

          // contenido / media
          let content = '';
          let mediaType = null;
          let mediaUrl = null;

          // --- parseo de tipos ---
          if (msg.message?.videoMessage) {
            mediaType = 'video';
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: Pino() });
            const fileRef = bucket.file(`videos/${phone}-${Date.now()}.mp4`);
            await fileRef.save(buffer, { contentType: 'video/mp4' });
            const [url] = await fileRef.getSignedUrl({ action: 'read', expires: '03-01-2500' });
            mediaUrl = url;
          } else if (msg.message?.imageMessage) {
            mediaType = 'image';
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: Pino() });
            const fileRef = bucket.file(`images/${phone}-${Date.now()}.jpg`);
            await fileRef.save(buffer, { contentType: 'image/jpeg' });
            const [url] = await fileRef.getSignedUrl({ action: 'read', expires: '03-01-2500' });
            mediaUrl = url;
          } else if (msg.message?.audioMessage) {
            mediaType = 'audio';
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: Pino() });
            const fileRef = bucket.file(`audios/${phone}-${Date.now()}.ogg`);
            await fileRef.save(buffer, { contentType: 'audio/ogg' });
            const [url] = await fileRef.getSignedUrl({ action: 'read', expires: '03-01-2500' });
            mediaUrl = url;
          } else if (msg.message?.documentMessage) {
            mediaType = 'document';
            const { mimetype, fileName: origName } = msg.message.documentMessage;
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: Pino() });
            const ext = path.extname(origName || '') || '';
            const fileRef = bucket.file(`docs/${phone}-${Date.now()}${ext}`);
            await fileRef.save(buffer, { contentType: mimetype || 'application/octet-stream' });
            const [url] = await fileRef.getSignedUrl({ action: 'read', expires: '03-01-2500' });
            mediaUrl = url;
          } else if (msg.message?.conversation) {
            mediaType = 'text';
            content = msg.message.conversation.trim();
          } else if (msg.message?.extendedTextMessage?.text) {
            mediaType = 'text';
            content = msg.message.extendedTextMessage.text.trim();
          } else {
            continue; // otros tipos los ignoramos por ahora
          }

          // ------- buscar/crear LEAD (docId = jid) -------
          const leadRef = db.collection('leads').doc(leadId);
          const leadSnap = await leadRef.get();

          // config global para defaultTrigger
          const cfgSnap = await db.collection('config').doc('appConfig').get();
          const cfg = cfgSnap.exists ? cfgSnap.data() : {};
          let trigger =
            content.includes('#webPro1490')
              ? 'LeadWeb1490'
              : (cfg.defaultTrigger || 'NuevoLead');

          const baseLead = {
            telefono: phone,                // 🔧 almacenamos 521 + 10 dígitos
            nombre: msg.pushName || '',
            source: 'WhatsApp',
          };

          if (!leadSnap.exists) {
            // crear lead (sin guardar secuencias en el doc; usamos la cola)
            await leadRef.set({
              ...baseLead,
              fecha_creacion: new Date(),
              estado: 'nuevo',
              etiquetas: [trigger],
              unreadCount: 0,
              lastMessageAt: new Date(),
            });

            // programa secuencia inicial
            await scheduleSequenceForLead(leadId, trigger);

            // si el trigger inicial fuera MusicaLead, cancela recordatorios
            if (trigger === 'MusicaLead') {
              const cancelled = await cancelSequences(leadId, ['NuevoLead']);
              if (cancelled) {
                await leadRef.set({ nuevoLeadCancelled: true }, { merge: true });
              }
            }
          } else {
            const cur = leadSnap.data() || {};
            const hadTag =
              Array.isArray(cur.etiquetas) && cur.etiquetas.includes(trigger);

            // etiqueta + meta
            await leadRef.update({
              etiquetas: FieldValue.arrayUnion(trigger),
              lastMessageAt: new Date(),
            });

            // si no tenía esa etiqueta, programa secuencia
            if (!hadTag) {
              await scheduleSequenceForLead(leadId, trigger);
            }

            // si ahora es MusicaLead, cancela captación
            if (trigger === 'MusicaLead' && !cur.nuevoLeadCancelled) {
              const cancelled = await cancelSequences(leadId, ['NuevoLead']);
              if (cancelled) {
                await leadRef.set({ nuevoLeadCancelled: true }, { merge: true });
              }
            }
          }

          // guardar mensaje en subcolección
          const msgData = {
            content,
            mediaType,
            mediaUrl,
            sender,
            timestamp: new Date(),
          };
          await db.collection('leads').doc(leadId).collection('messages').add(msgData);

          // actualizar counters
          const upd = { lastMessageAt: msgData.timestamp };
          if (sender === 'lead') upd.unreadCount = FieldValue.increment(1);
          await db.collection('leads').doc(leadId).update(upd);
        } catch (err) {
          console.error('messages.upsert error:', err);
        }
      }
    });

    return sock;
  } catch (error) {
    console.error('Error al conectar con WhatsApp:', error);
    throw error;
  }
}

/* ----------------------------- helpers envío ---------------------------- */
export function getLatestQR() {
  return latestQR;
}
export function getConnectionStatus() {
  return connectionStatus;
}
export function getWhatsAppSock() {
  return whatsappSock;
}
export function getSessionPhone() {
  return sessionPhone;
}

export async function sendMessageToLead(phone, messageContent) {
  if (!whatsappSock) throw new Error('No hay conexión activa con WhatsApp');
  const num = normalizePhoneNumber(phone); // 🔧 Normalizar
  const jid = `${num}@s.whatsapp.net`;

  await whatsappSock.sendMessage(
    jid,
    { text: messageContent, linkPreview: false },
    { timeoutMs: 60_000 }
  );

  // persistir en Firestore si existe el lead
  const q = await db.collection('leads').where('telefono', '==', num).limit(1).get();
  if (!q.empty) {
    const leadId = q.docs[0].id;
    const outMsg = { content: messageContent, sender: 'business', timestamp: new Date() };
    await db.collection('leads').doc(leadId).collection('messages').add(outMsg);
    await db.collection('leads').doc(leadId).update({ lastMessageAt: outMsg.timestamp });
  }
  return { success: true };
}

export async function sendFullAudioAsDocument(phone, fileUrl) {
  const sock = getWhatsAppSock();
  if (!sock) throw new Error('No hay conexión activa con WhatsApp');

  const num = normalizePhoneNumber(phone); // 🔧 Normalizar
  const jid = `${num}@s.whatsapp.net`;

  const res = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(res.data);

  await sock.sendMessage(jid, {
    document: buffer,
    mimetype: 'audio/mpeg',
    fileName: 'cancion_completa.mp3',
    caption: '¡Te comparto tu canción completa!',
  });
  console.log(`✅ Canción completa enviada como adjunto a ${jid}`);
}

export async function sendAudioMessage(phone, filePath) {
  const sock = getWhatsAppSock();
  if (!sock) throw new Error('Socket de WhatsApp no está conectado');

  const num = normalizePhoneNumber(phone); // 🔧 Normalizar
  const jid = `${num}@s.whatsapp.net`;

  const audioBuffer = fs.readFileSync(filePath);
  await sock.sendMessage(jid, { audio: audioBuffer, mimetype: 'audio/mp4', ptt: true });

  // subir a Storage y guardar en mensajes
  const dest = `audios/${num}-${Date.now()}.m4a`;
  const file = bucket.file(dest);
  await file.save(audioBuffer, { contentType: 'audio/mp4' });
  const [mediaUrl] = await file.getSignedUrl({ action: 'read', expires: '03-01-2500' });

  const q = await db.collection('leads').where('telefono', '==', num).limit(1).get();
  if (!q.empty) {
    const leadId = q.docs[0].id;
    const msgData = { content: '', mediaType: 'audio', mediaUrl, sender: 'business', timestamp: new Date() };
    await db.collection('leads').doc(leadId).collection('messages').add(msgData);
    await db.collection('leads').doc(leadId).update({ lastMessageAt: msgData.timestamp });
  }
}

export async function sendClipMessage(phone, clipUrl) {
  const sock = getWhatsAppSock();
  if (!sock) throw new Error('No hay conexión activa con WhatsApp');

  const num = normalizePhoneNumber(phone); // 🔧 Normalizar
  const jid = `${num}@s.whatsapp.net`;

  const payload = { audio: { url: clipUrl }, mimetype: 'audio/mp4', ptt: false };
  const opts = { timeoutMs: 120_000, sendSeen: false };

  for (let i = 1; i <= 3; i++) {
    try {
      await sock.sendMessage(jid, payload, opts);
      console.log(`✅ clip enviado (intento ${i}) a ${jid}`);
      return;
    } catch (err) {
      const isTO = err?.message?.includes('Timed Out');
      console.warn(`⚠️ fallo envío clip intento ${i}${isTO ? ' (Timeout)' : ''}`);
      if (!isTO || i === 3) throw err;
      await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
}