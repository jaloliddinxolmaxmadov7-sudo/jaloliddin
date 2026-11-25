'use strict';
const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { makeHandler } = require('./paynet');

admin.initializeApp();
const db = admin.firestore();

// Paynet bergan ma'lumotlar. O'rnatish:
//   firebase functions:secrets:set PAYNET_USERNAME
//   firebase functions:secrets:set PAYNET_PASSWORD
// Service ID maxfiy emas — deploy paytida so'raladi yoki functions/.env ga yoziladi.
const PAYNET_USERNAME = defineSecret('PAYNET_USERNAME');
const PAYNET_PASSWORD = defineSecret('PAYNET_PASSWORD');
const PAYNET_SERVICE_ID = defineString('PAYNET_SERVICE_ID', { default: '' });

exports.paynet = onRequest(
  { region: 'us-central1', secrets: [PAYNET_USERNAME, PAYNET_PASSWORD], cors: false, maxInstances: 5 },
  async (req, res) => {
    const handle = makeHandler({
      db,
      username: PAYNET_USERNAME.value(),
      password: PAYNET_PASSWORD.value(),
      serviceId: PAYNET_SERVICE_ID.value(),
    });
    const out = await handle({ method: req.method, headers: req.headers, rawBody: req.rawBody || Buffer.from('') });
    res.status(out.status).json(out.body);
  }
);

// Admin xodimning login yoki kodini almashtiradi, yoki uni o'chiradi
exports.staff = onCall({ region: 'us-central1' }, async req => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Kirish kerak');
  const me = await db.doc('users/' + req.auth.uid).get();
  if (!me.exists || me.data().role !== 'admin' || me.data().disabled) throw new HttpsError('permission-denied', 'Faqat admin');
  const { action, uid, login, code } = req.data || {};
  if (typeof uid !== 'string' || !uid) throw new HttpsError('invalid-argument', 'uid kerak');
  const target = await db.doc('users/' + uid).get();
  if (!target.exists) throw new HttpsError('not-found', 'Xodim topilmadi');
  if (action === 'disable') {
    await admin.auth().updateUser(uid, { disabled: true });
    await admin.auth().revokeRefreshTokens(uid);
    return { ok: true };
  }
  if (action === 'update') {
    const upd = {};
    if (login !== undefined) {
      if (!/^[a-z0-9_.-]{3,30}$/.test(String(login))) throw new HttpsError('invalid-argument', 'Login noto\'g\'ri');
      upd.email = String(login) + '@ezome.app';
    }
    if (code) {
      const min = target.data().role === 'admin' ? 6 : 4;
      if (String(code).length < min) throw new HttpsError('invalid-argument', 'Kod juda qisqa');
      upd.password = 'ezome-' + String(code);
    }
    if (Object.keys(upd).length) await admin.auth().updateUser(uid, upd);
    if (upd.password) await admin.auth().revokeRefreshTokens(uid);
    return { ok: true };
  }
  throw new HttpsError('invalid-argument', 'Noma\'lum amal');
});
