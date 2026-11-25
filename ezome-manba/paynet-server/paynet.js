'use strict';
/*
 * Paynet provider protokoli (JSON-RPC 2.0, HTTP Basic auth) — ezome uchun.
 * Paynet bizning manzilimizga murojaat qiladi:
 *   GetInformation     — buyurtma bormi, summasi qancha
 *   PerformTransaction — to'lov o'tdi: sotuv yoziladi, ombordan ayiriladi
 *   CheckTransaction   — to'lov holati
 *   CancelTransaction  — to'lov bekor: tovar omborga qaytadi, sotuv o'chadi
 *   GetStatement       — davr bo'yicha to'lovlar ro'yxati
 *   ChangePassword     — Paynet parolni almashtiradi
 * Summalar tiyinda keladi (1 so'm = 100 tiyin).
 */

const E = {
  JSON_PARSING_ERROR: -32700,
  INVALID_RPC_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  MISSING_RPC_PARAMETERS: -32602,
  SYSTEM_ERROR: 102,
  TRANSACTION_ALREADY_EXISTS: 201,
  TRANSACTION_ALREADY_CANCELLED: 202,
  TRANSACTION_NOT_FOUND: 203,
  CLIENT_NOT_FOUND: 302,
  ALREADY_PAID: 302,
  SERVICE_NOT_FOUND: 305,
  REQUIRED_PARAMETERS_MISSING: 411,
  INVALID_LOGIN_OR_PASSWORD: 412,
  INVALID_AMOUNT: 413,
  INVALID_DATE_TIME_FORMAT: 414,
};

class PaynetError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Toshkent vaqti (UTC+5, yozgi vaqt yo'q): "YYYY-MM-DD HH:MM:SS"
const fmtTime = t => new Date(t + 5 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
function parseTime(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(v)) {
    throw new PaynetError(E.INVALID_DATE_TIME_FORMAT, 'Invalid date format');
  }
  const t = Date.parse(v.replace(' ', 'T') + '+05:00');
  if (!Number.isFinite(t)) throw new PaynetError(E.INVALID_DATE_TIME_FORMAT, 'Invalid date format');
  return t;
}

function parseBasic(header) {
  const [scheme, enc] = String(header || '').split(' ');
  if (!scheme || scheme.toLowerCase() !== 'basic' || !enc) return null;
  let dec = '';
  try { dec = Buffer.from(enc.trim(), 'base64').toString('utf8'); } catch (e) { return null; }
  const i = dec.indexOf(':');
  return i < 0 ? null : [dec.slice(0, i), dec.slice(i + 1)];
}

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return require('crypto').timingSafeEqual(x, y);
}

// Mijozdagi withStock bilan bir xil: o'lchamli tovarda o'lcham qoldig'i, jami qty qayta hisoblanadi
function withStock(p, size, d) {
  const z = Array.isArray(p.sizes) && p.sizes.length ? p.sizes : null;
  if (z && size) {
    let found = false;
    const nz = z.map(x => x.s === size ? (found = true, { ...x, q: Math.max(0, (+x.q || 0) + d) }) : { ...x, q: +x.q || 0 });
    if (!found) nz.push({ s: size, q: Math.max(0, d) });
    return { ...p, sizes: nz, qty: nz.reduce((a, x) => a + x.q, 0), updatedAt: Date.now() };
  }
  return { ...p, qty: (+p.qty || 0) + d, updatedAt: Date.now() };
}

/**
 * @param {object} o
 * @param {object} o.db          firebase-admin Firestore (yoki testdagi soxtasi)
 * @param {string} o.username    Paynet bergan login
 * @param {string} o.password    Paynet bergan boshlang'ich parol
 * @param {string} [o.serviceId] Paynet service ID (bo'lsa tekshiriladi)
 * @param {Function} [o.now]
 */
function makeHandler(o) {
  const db = o.db, now = o.now || (() => Date.now());

  async function currentPassword() {
    const d = await db.doc('private/paynet').get();
    const p = d.exists ? d.data().password : '';
    return p || o.password || '';
  }

  async function settings() {
    const d = await db.doc('settings/main').get();
    return (d.exists && d.data().paynet) || {};
  }

  async function orderIdFrom(params) {
    const f = params.fields || params.account;
    if (!f || typeof f !== 'object') throw new PaynetError(E.REQUIRED_PARAMETERS_MISSING, 'fields is required');
    const key = (await settings()).field || 'order_id';
    let v = f[key];
    if (v == null || v === '') v = Object.values(f).find(x => x != null && x !== '');
    v = String(v == null ? '' : v).trim();
    if (!v) throw new PaynetError(E.REQUIRED_PARAMETERS_MISSING, `${key} is required`);
    if (!/^[\w-]{1,64}$/.test(v)) throw new PaynetError(E.CLIENT_NOT_FOUND, 'Клиент не найден');
    return { key, id: v };
  }

  function checkService(params) {
    const sid = params.serviceId;
    if (o.serviceId && sid != null && sid !== '' && String(sid) !== String(o.serviceId)) {
      throw new PaynetError(E.SERVICE_NOT_FOUND, `Service ${sid} not found`);
    }
  }

  function parseAmount(raw) {
    const a = Number(raw);
    if (!Number.isFinite(a) || a <= 0) throw new PaynetError(E.INVALID_AMOUNT, 'Incorrect amount');
    return Math.round(a);
  }

  const methods = {
    async GetInformation(params) {
      checkService(params);
      const { key, id } = await orderIdFrom(params);
      const d = await db.doc('paynet_orders/' + id).get();
      if (!d.exists || d.data().status === 'cancelled') throw new PaynetError(E.CLIENT_NOT_FOUND, 'Клиент не найден');
      const ord = d.data();
      if (ord.status === 'paid') throw new PaynetError(E.ALREADY_PAID, 'Already paid');
      return { status: '0', timestamp: fmtTime(now()), fields: { [key]: id, summa: String(Math.round(ord.amount)) } };
    },

    async PerformTransaction(params) {
      checkService(params);
      const tx = String(params.transactionId || '').trim();
      if (!tx || !/^[\w-]{1,64}$/.test(tx)) throw new PaynetError(E.REQUIRED_PARAMETERS_MISSING, 'transactionId is required');
      const amount = parseAmount(params.amount);
      const { key, id } = await orderIdFrom(params);
      const t = now();
      const result = await db.runTransaction(async T => {
        const payRef = db.doc('payments/' + tx), ordRef = db.doc('paynet_orders/' + id), cntRef = db.doc('meta/counter');
        const [pay, ord, cnt] = await Promise.all([T.get(payRef), T.get(ordRef), T.get(cntRef)]);
        if (pay.exists) throw new PaynetError(E.TRANSACTION_ALREADY_EXISTS, 'Transaction already exists');
        if (!ord.exists || ord.data().status === 'cancelled') throw new PaynetError(E.CLIENT_NOT_FOUND, 'Клиент не найден');
        const o2 = ord.data();
        if (o2.status === 'paid') throw new PaynetError(E.ALREADY_PAID, 'Already paid');
        if (Math.round(o2.amount * 100) !== amount) throw new PaynetError(E.INVALID_AMOUNT, 'Incorrect amount');
        const items = Array.isArray(o2.items) ? o2.items : [];
        const prodRefs = [...new Set(items.map(i => i.id))].map(pid => db.doc('products/' + pid));
        const prods = await Promise.all(prodRefs.map(r => T.get(r)));
        const no = (cnt.exists ? (+cnt.data().no || 1000) : 1000) + 1;
        const saleId = 'p' + tx;
        // --- yozish ---
        const pmap = {};
        prods.forEach((d, i) => { if (d.exists) pmap[prodRefs[i].path.split('/')[1]] = d.data(); });
        for (const it of items) { const p = pmap[it.id]; if (p) pmap[it.id] = withStock(p, it.size, -(+it.qty || 0)); }
        Object.entries(pmap).forEach(([pid, p]) => T.set(db.doc('products/' + pid), p));
        T.set(cntRef, { no });
        T.set(db.doc('sales/' + saleId), {
          no, items, subtotal: o2.subtotal || o2.amount, discount: o2.discount || 0, total: o2.amount,
          method: 'Paynet', received: o2.amount, change: 0, customer: o2.customer || '',
          seller: o2.seller || '', sellerUid: o2.by || '', sellerRole: o2.sellerRole || '',
          createdAt: t, orderId: id,
          paynet: { tx, amount: amount / 100, time: params.transactionTime || params.time || fmtTime(t), serviceId: params.serviceId || '' },
          ok: { by: 'Paynet', t },
        });
        T.set(payRef, { tx, orderId: id, saleId, no, amount: amount / 100, state: 'paid', t, raw: { serviceId: params.serviceId || '', time: params.transactionTime || params.time || '' } });
        T.set(ordRef, { ...o2, status: 'paid', paidAt: t, saleId, tx });
        return { no, saleId };
      });
      return { providerTrnId: result.no, timestamp: fmtTime(t), fields: { [key]: id } };
    },

    async CheckTransaction(params) {
      checkService(params);
      const tx = String(params.transactionId || '').trim();
      const d = tx && /^[\w-]{1,64}$/.test(tx) ? await db.doc('payments/' + tx).get() : { exists: false };
      if (!d.exists) return { transactionState: 3, providerTrnId: 0, timestamp: fmtTime(now()) };
      const p = d.data();
      return { transactionState: p.state === 'cancelled' ? 2 : 1, providerTrnId: p.no, timestamp: fmtTime(p.cancelledAt || p.t) };
    },

    async CancelTransaction(params) {
      checkService(params);
      const tx = String(params.transactionId || '').trim();
      if (!tx || !/^[\w-]{1,64}$/.test(tx)) throw new PaynetError(E.REQUIRED_PARAMETERS_MISSING, 'transactionId is required');
      const t = now();
      const no = await db.runTransaction(async T => {
        const payRef = db.doc('payments/' + tx);
        const pay = await T.get(payRef);
        if (!pay.exists) throw new PaynetError(E.TRANSACTION_NOT_FOUND, 'Transaction not found');
        const p = pay.data();
        if (p.state === 'cancelled') throw new PaynetError(E.TRANSACTION_ALREADY_CANCELLED, 'Transaction already cancelled');
        const saleRef = db.doc('sales/' + p.saleId);
        const sale = await T.get(saleRef);
        const items = sale.exists ? (sale.data().items || []) : [];
        const prodRefs = [...new Set(items.map(i => i.id))].map(pid => db.doc('products/' + pid));
        const prods = await Promise.all(prodRefs.map(r => T.get(r)));
        const pmap = {};
        prods.forEach((d, i) => { if (d.exists) pmap[prodRefs[i].path.split('/')[1]] = d.data(); });
        for (const it of items) { const pr = pmap[it.id]; if (pr) pmap[it.id] = withStock(pr, it.size, +it.qty || 0); }
        Object.entries(pmap).forEach(([pid, pr]) => T.set(db.doc('products/' + pid), pr));
        if (sale.exists) T.delete(saleRef);
        T.set(payRef, { ...p, state: 'cancelled', cancelledAt: t });
        T.set(db.doc('log/pc' + tx), {
          t, type: 'refund', no: p.no, amount: p.amount, qty: items.reduce((a, i) => a + (+i.qty || 0), 0),
          profit: p.amount - items.reduce((a, i) => a + (+i.cost || 0) * (+i.qty || 0), 0),
          by: 'Paynet', uid: '', role: 'system', paynet: true,
        });
        return p.no;
      });
      return { providerTrnId: no, timestamp: fmtTime(t), transactionState: 2 };
    },

    async GetStatement(params) {
      checkService(params);
      const a = parseTime(params.dateFrom), b = parseTime(params.dateTo);
      const snap = await db.collection('payments').where('t', '>=', a).where('t', '<=', b).get();
      const list = snap.docs.map(d => d.data()).filter(p => p.state === 'paid').sort((x, y) => x.t - y.t);
      return {
        statements: list.map(p => ({
          amount: Math.round(p.amount * 100), providerTrnId: p.no,
          transactionId: /^\d+$/.test(p.tx) ? Number(p.tx) : p.tx, timestamp: fmtTime(p.t),
        })),
      };
    },

    async ChangePassword(params) {
      checkService(params);
      const np = String(params.newPassword || '');
      if (np.length < 8) throw new PaynetError(E.REQUIRED_PARAMETERS_MISSING, 'newPassword is required');
      await db.doc('private/paynet').set({ password: np, changedAt: now() });
      return 'success';
    },
  };

  /** HTTP so'rovni qayta ishlaydi: {status, body} qaytaradi */
  return async function handle({ method, headers, rawBody }) {
    let rpcId = null;
    const reply = (status, body) => ({ status, body: { jsonrpc: '2.0', id: rpcId, ...body } });
    const err = (code, message, status = 200) => reply(status, { error: { code, message } });
    try {
      if (method !== 'POST') return err(-32300, 'Method must be POST');
      const cred = parseBasic(headers.authorization);
      const pass = await currentPassword();
      if (!o.username || !pass || !cred || !safeEq(cred[0], o.username) || !safeEq(cred[1], pass)) {
        return err(E.INVALID_LOGIN_OR_PASSWORD, 'Invalid login or password', 401);
      }
      let data;
      try { data = JSON.parse(rawBody.toString('utf8')); } catch (e) { return err(E.JSON_PARSING_ERROR, 'Error parsing JSON.'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return err(E.INVALID_RPC_REQUEST, 'Invalid RPC Request');
      rpcId = data.id === undefined ? null : data.id;
      if (!['jsonrpc', 'method', 'id', 'params'].every(k => k in data)) return err(E.INVALID_RPC_REQUEST, 'Missing required fields');
      const params = data.params || {};
      if (typeof params !== 'object' || Array.isArray(params)) return err(E.MISSING_RPC_PARAMETERS, 'Invalid params');
      const fn = Object.prototype.hasOwnProperty.call(methods, data.method) ? methods[data.method] : null;
      if (!fn) return err(E.METHOD_NOT_FOUND, `method ${data.method} is not supported`);
      const result = await fn(params);
      return reply(200, { result });
    } catch (e) {
      if (e instanceof PaynetError) return err(e.code, e.message);
      console.error('Paynet xatosi', e);
      return err(E.SYSTEM_ERROR, 'System error');
    }
  };
}

module.exports = { makeHandler, withStock, fmtTime, E };
