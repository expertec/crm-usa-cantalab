// queue.js
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const db = getFirestore();

// Encolar un paso de secuencia (barato y atómico)
async function enqueueStep({ leadId, sequenceId, step, payload = {}, delaySec = 0, shard = null }) {
  const dueAt = Timestamp.fromMillis(Date.now() + delaySec * 1000);
  const _shard = Number.isInteger(shard) ? shard : Math.floor(Math.random() * 10);
  await db.collection('sequenceQueue').add({
    leadId, sequenceId, step, payload,
    dueAt, status: 'pending', processedAt: null, shard: _shard,
    createdAt: FieldValue.serverTimestamp(),
  });
  // hint para dashboards (no imprescindible)
  await db.collection('leads').doc(leadId).set({
    hasActiveSequences: true,
    nextActionAt: dueAt,
  }, { merge: true });
}

// Procesar cola (minuto a minuto)
async function processQueue({ batchSize = 100, shard = null }) {
  let q = db.collection('sequenceQueue')
    .where('status', '==', 'pending')
    .where('dueAt', '<=', new Date())
    .orderBy('dueAt', 'asc')
    .limit(batchSize);
  if (shard !== null) q = q.where('shard', '==', shard);

  const snap = await q.get();
  if (snap.empty) return 0;

  // Procesa en paralelo pero con límites razonables si Render es pequeño.
  await Promise.all(snap.docs.map(async d => {
    const t = { id: d.id, ...d.data() };
    try {
      // Aquí llamas a tus helpers actuales (NO cambiamos tu envío):
      // p.ej. await sendTextToLead(t.leadId, t.payload.text)
      // o await sendClipToLead(t.leadId, t.payload.clipUrl)
      // Puedes rutear por t.sequenceId/t.step si necesitas.

      await db.collection('sequenceQueue').doc(t.id).update({
        status: 'sent',
        processedAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      await db.collection('sequenceQueue').doc(t.id).update({
        status: 'error',
        processedAt: FieldValue.serverTimestamp(),
        error: String(err?.message || err),
      });
    }
  }));

  return snap.size;
}

module.exports = { enqueueStep, processQueue };
