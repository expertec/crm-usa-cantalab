// queue.js (mismo folder que scheduler.js)
import admin from 'firebase-admin';
import { sendMessageToLead, sendClipMessage } from './whatsappService.js';

const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

// Encola un paso de secuencia
export async function enqueueStep({ leadId, sequenceId, step, payload = {}, delaySec = 0, shard = null }) {
  const dueAt = Timestamp.fromMillis(Date.now() + delaySec * 1000);
  const _shard = Number.isInteger(shard) ? shard : Math.floor(Math.random() * 10);

  await db.collection('sequenceQueue').add({
    leadId,
    sequenceId,
    step,
    payload,
    dueAt,
    status: 'pending',
    processedAt: null,
    shard: _shard,
    createdAt: FieldValue.serverTimestamp(),
  });

  await db.collection('leads').doc(leadId).set(
    { hasActiveSequences: true, nextActionAt: dueAt },
    { merge: true }
  );
}

// Entrega el payload usando tus helpers actuales
async function deliverPayload(leadId, payload) {
  const leadSnap = await db.collection('leads').doc(leadId).get();
  if (!leadSnap.exists) throw new Error(`Lead no existe: ${leadId}`);

  const phone = String(leadSnap.data().telefono || '').replace(/\D/g, '');
  if (!phone) throw new Error(`Lead sin telefono: ${leadId}`);

  switch (payload?.type) {
    case 'texto':
      if (payload.text) await sendMessageToLead(phone, String(payload.text));
      break;
    case 'clip':
    case 'audio':
      if (payload.url) await sendClipMessage(phone, String(payload.url));
      break;
    case 'imagen':
    case 'video':
      // placeholders: si tienes helpers específicos, cámbialos
      if (payload.url) await sendMessageToLead(phone, String(payload.url));
      break;
    default:
      if (payload?.text) await sendMessageToLead(phone, String(payload.text));
  }
}

// Procesa tasks pendientes
export async function processQueue({ batchSize = 100, shard = null }) {
  let q = db
    .collection('sequenceQueue')
    .where('status', '==', 'pending')
    .where('dueAt', '<=', new Date())
    .orderBy('dueAt', 'asc')
    .limit(batchSize);

  if (shard !== null) q = q.where('shard', '==', shard);

  const snap = await q.get();
  if (snap.empty) return 0;

  await Promise.all(
    snap.docs.map(async (d) => {
      const t = { id: d.id, ...d.data() };
      try {
        await deliverPayload(t.leadId, t.payload);
        await db.collection('sequenceQueue').doc(t.id).update({
          status: 'sent',
          processedAt: FieldValue.serverTimestamp(),
        });
        await db.collection('leads').doc(t.leadId).set(
          { hasActiveSequences: true, lastMessageAt: FieldValue.serverTimestamp() },
          { merge: true }
        );
      } catch (err) {
        await db.collection('sequenceQueue').doc(t.id).update({
          status: 'error',
          processedAt: FieldValue.serverTimestamp(),
          error: String(err?.message || err),
        });
      }
    })
  );

  return snap.size;
}
