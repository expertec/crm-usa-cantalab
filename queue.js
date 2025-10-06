// queue.js
import { db, admin } from './firebaseAdmin.js';
import {
  sendMessageToLead,
  sendClipMessage,
  getWhatsAppSock
} from './whatsappService.js';

const { FieldValue } = admin.firestore;

/* ----------------------------- utilidades ------------------------------ */

function firstName(full = '') {
  return String(full).trim().split(/\s+/)[0] || '';
}

function replacePlaceholders(template, lead) {
  if (!template) return '';
  const tel = String(lead.telefono || '').replace(/\D/g, '');
  const nameFirst = firstName(lead.nombre || '');
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (key === 'telefono') return tel;
    if (key === 'nombre') return nameFirst;
    return lead[key] ?? '';
  });
}

/* -------------------- programar / cancelar secuencias ------------------- */

/**
 * Programa todos los mensajes de la secuencia "trigger" para un lead.
 * Prioriza doc id = trigger. Si no existe, hace fallback a where('trigger'==trigger).
 * Espera un doc con shape: { active: true, messages: [{ type, contenido, delay }, ...] }
 */
export async function scheduleSequenceForLead(leadId, trigger, startAt = new Date()) {
  // 1) intenta doc por id
  let seqDoc = await db.collection('secuencias').doc(trigger).get();

  // 2) fallback a where trigger==...
  if (!seqDoc.exists) {
    const q = await db.collection('secuencias')
      .where('trigger', '==', trigger)
      .limit(1)
      .get();
    if (!q.empty) seqDoc = q.docs[0];
  }

  if (!seqDoc.exists) {
    console.warn(`[scheduleSequenceForLead] No existe secuencias/${trigger}`);
    return 0;
  }

  const data = seqDoc.data() || {};
  const active = data.active !== false;
  const messages = Array.isArray(data.messages) ? data.messages : [];

  if (!active || messages.length === 0) return 0;

  const batch = db.batch();
  const startMs = new Date(startAt).getTime();

  messages.forEach((m, idx) => {
    const delayMin = Number(m.delay || 0);
    const dueAt = new Date(startMs + delayMin * 60_000);
    const ref = db.collection('sequenceQueue').doc();
    batch.set(ref, {
      leadId,
      trigger,
      idx,
      payload: {
        type: m.type || 'texto',
        contenido: m.contenido || ''
      },
      dueAt,
      status: 'pending',
      shard: Math.floor(Math.random() * 10),
      createdAt: FieldValue.serverTimestamp()
    });
  });

  await batch.commit();
  // hint en el lead (opcional)
  await db.collection('leads').doc(leadId).set({
    hasActiveSequences: true
  }, { merge: true });

  return messages.length;
}

/**
 * Cancela (borra) tareas pendientes de ciertos triggers para un lead.
 */
export async function cancelSequences(leadId, triggers = []) {
  if (!leadId || !Array.isArray(triggers) || triggers.length === 0) return 0;

  const snap = await db.collection('sequenceQueue')
    .where('leadId', '==', leadId)
    .where('status', '==', 'pending')
    .get();

  if (snap.empty) return 0;

  const batch = db.batch();
  let n = 0;
  for (const d of snap.docs) {
    const t = d.data();
    if (triggers.includes(t.trigger)) {
      batch.delete(d.ref);
      n++;
    }
  }
  if (n) await batch.commit();
  return n;
}

/* -------------------------- entrega de mensajes ------------------------- */

async function deliverPayload(leadId, payload) {
  const leadSnap = await db.collection('leads').doc(leadId).get();
  if (!leadSnap.exists) throw new Error(`Lead no existe: ${leadId}`);

  const lead = { id: leadSnap.id, ...leadSnap.data() };
  const phone = String(lead.telefono || '').replace(/\D/g, '');
  if (!phone) throw new Error(`Lead sin telefono: ${leadId}`);

  const type = payload?.type || 'texto';
  const contenido = payload?.contenido || '';

  // acceso al socket por si mandamos multimedia
  const sock = getWhatsAppSock();

  switch (type) {
    case 'texto': {
      const text = replacePlaceholders(contenido, lead).trim();
      if (text) await sendMessageToLead(phone, text);
      break;
    }

    case 'formulario': {
      // Ejemplo plantilla: "Completa aquí: https://cantalab.com/{{telefono}}?nombre={{nombre}}"
      const text = replacePlaceholders(contenido, lead).trim();
      if (text) await sendMessageToLead(phone, text);
      break;
    }

    case 'audio':
    case 'clip': {
      // pensado para .m4a/.mp4 (AAC) – usamos helper que envía inline por URL
      const url = replacePlaceholders(contenido, lead).trim();
      if (url) await sendClipMessage(phone, url);
      break;
    }

    case 'imagen': {
      const url = replacePlaceholders(contenido, lead).trim();
      if (url && sock) {
        const jid = `${phone}@s.whatsapp.net`;
        await sock.sendMessage(jid, { image: { url } });
      } else if (url) {
        // fallback: manda el link como texto
        await sendMessageToLead(phone, url);
      }
      break;
    }

    case 'video': {
      const url = replacePlaceholders(contenido, lead).trim();
      if (url && sock) {
        const jid = `${phone}@s.whatsapp.net`;
        await sock.sendMessage(jid, { video: { url } });
      } else if (url) {
        await sendMessageToLead(phone, url);
      }
      break;
    }

    default: {
      const text = replacePlaceholders(contenido, lead).trim();
      if (text) await sendMessageToLead(phone, text);
    }
  }
}

/* ----------------------------- procesar cola ---------------------------- */

/**
 * Procesa jobs pendientes cuya dueAt <= ahora.
 * Usa índice: status ASC, dueAt ASC
 */
export async function processQueue({ batchSize = 100, shard = null } = {}) {
  const now = new Date();

  let q = db.collection('sequenceQueue')
    .where('status', '==', 'pending')
    .where('dueAt', '<=', now)
    .orderBy('dueAt', 'asc')
    .limit(batchSize);

  if (shard !== null) q = q.where('shard', '==', shard);

  const snap = await q.get();
  if (snap.empty) return 0;

  await Promise.all(snap.docs.map(async (d) => {
    const job = { id: d.id, ...d.data() };
    try {
      await deliverPayload(job.leadId, job.payload);
      await d.ref.update({
        status: 'sent',
        processedAt: FieldValue.serverTimestamp()
      });

      // opcional: pisa lastMessageAt
      await db.collection('leads').doc(job.leadId).set({
        lastMessageAt: FieldValue.serverTimestamp()
      }, { merge: true });

    } catch (err) {
      await d.ref.update({
        status: 'error',
        processedAt: FieldValue.serverTimestamp(),
        error: String(err?.message || err)
      });
    }
  }));

  return snap.size;
}
