'use strict';
// Paynet protokolini soxta bazada sinash: node test.js
const assert = require('assert');
const { makeHandler } = require('./paynet');

function fakeDb(init = {}) {
  const store = JSON.parse(JSON.stringify(init));
  const snap = (path) => ({ exists: path in store, data: () => JSON.parse(JSON.stringify(store[path])), id: path.split('/').pop() });
  const doc = (path) => ({
    path,
    get: async () => snap(path),
    set: async (d) => { store[path] = JSON.parse(JSON.stringify(d)); },
  });
  return {
    store,
    doc,
    collection: (c) => {
      const filters = [];
      const q = {
        where: (f, op, v) => { filters.push([f, op, v]); return q; },
        get: async () => ({
          docs: Object.keys(store).filter(p => p.startsWith(c + '/') && p.split('/').length === 2)
            .map(snap).filter(s => filters.every(([f, op, v]) => {
              const x = s.data()[f];
              return op === '>=' ? x >= v : op === '<=' ? x <= v : op === '==' ? x === v : false;
            })),
        }),
      };
      return q;
    },
    runTransaction: async (fn) => {
      const writes = [];
      let wrote = false;
      const T = {
        get: async (r) => { if (wrote) throw new Error('read after write'); return snap(r.path); },
        set: (r, d) => { wrote = true; writes.push(() => { store[r.path] = JSON.parse(JSON.stringify(d)); }); },
        delete: (r) => { wrote = true; writes.push(() => { delete store[r.path]; }); },
      };
      const res = await fn(T);
      writes.forEach(w => w());
      return res;
    },
  };
}

const auth = (u, p) => 'Basic ' + Buffer.from(u + ':' + p).toString('base64');
const call = async (h, method, params, a = auth('paynet', 'secret123'), id = 1) => {
  const r = await h({ method: 'POST', headers: { authorization: a }, rawBody: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params })) });
  return r;
};

(async () => {
  const db = fakeDb({
    'settings/main': { paynet: { merchantId: 'm1', field: 'order_id' } },
    'meta/counter': { no: 1005 },
    'products/p1': { name: 'Futbolka', price: 150000, cost: 70000, qty: 5, sizes: [{ s: 'M', q: 3 }, { s: 'L', q: 2 }] },
    'products/p2': { name: 'Sumka', price: 50000, cost: 20000, qty: 4 },
    'paynet_orders/12345678': {
      status: 'pending', amount: 340000, subtotal: 350000, discount: 10000, by: 'u-w', seller: 'Ishchi', sellerRole: 'worker', t: 1,
      items: [{ id: 'p1', name: 'Futbolka', size: 'M', price: 150000, list: 150000, cost: 70000, qty: 2 }, { id: 'p2', name: 'Sumka', price: 50000, list: 50000, cost: 20000, qty: 1 }],
    },
  });
  let T = Date.parse('2026-11-25T10:00:00Z');
  const h = makeHandler({ db, username: 'paynet', password: 'secret123', serviceId: '777', now: () => T });

  // noto'g'ri parol
  let r = await call(h, 'GetInformation', { fields: { order_id: '12345678' } }, auth('paynet', 'xato'));
  assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error.code, 412);

  // ma'lumot
  r = await call(h, 'GetInformation', { serviceId: 777, fields: { order_id: '12345678' } });
  assert.deepStrictEqual(r.body.result.fields, { order_id: '12345678', summa: '340000' });
  assert.strictEqual(r.body.result.timestamp, '2026-11-25 15:00:00');

  // boshqa service
  r = await call(h, 'GetInformation', { serviceId: 1, fields: { order_id: '12345678' } });
  assert.strictEqual(r.body.error.code, 305);

  // yo'q buyurtma
  r = await call(h, 'GetInformation', { fields: { order_id: '99999999' } });
  assert.strictEqual(r.body.error.code, 302);

  // noto'g'ri summa
  r = await call(h, 'PerformTransaction', { transactionId: 555, amount: 100, fields: { order_id: '12345678' } });
  assert.strictEqual(r.body.error.code, 413);

  // to'lov
  r = await call(h, 'PerformTransaction', { serviceId: 777, transactionId: 555, amount: 34000000, transactionTime: '2026-11-25 15:00:00', fields: { order_id: '12345678' } });
  assert.ok(r.body.result, JSON.stringify(r.body));
  assert.strictEqual(r.body.result.providerTrnId, 1006);
  const sale = db.store['sales/p555'];
  assert.strictEqual(sale.method, 'Paynet'); assert.strictEqual(sale.total, 340000); assert.strictEqual(sale.no, 1006);
  assert.strictEqual(sale.sellerUid, 'u-w'); assert.strictEqual(sale.ok.by, 'Paynet');
  assert.deepStrictEqual(db.store['products/p1'].sizes, [{ s: 'M', q: 1 }, { s: 'L', q: 2 }]);
  assert.strictEqual(db.store['products/p1'].qty, 3); assert.strictEqual(db.store['products/p2'].qty, 3);
  assert.strictEqual(db.store['paynet_orders/12345678'].status, 'paid');
  assert.strictEqual(db.store['meta/counter'].no, 1006);

  // takror tranzaksiya va takror to'lov
  r = await call(h, 'PerformTransaction', { transactionId: 555, amount: 34000000, fields: { order_id: '12345678' } });
  assert.strictEqual(r.body.error.code, 201);
  r = await call(h, 'PerformTransaction', { transactionId: 556, amount: 34000000, fields: { order_id: '12345678' } });
  assert.strictEqual(r.body.error.code, 302);

  // holat
  r = await call(h, 'CheckTransaction', { transactionId: 555 });
  assert.strictEqual(r.body.result.transactionState, 1);
  r = await call(h, 'CheckTransaction', { transactionId: 1 });
  assert.strictEqual(r.body.result.transactionState, 3);

  // ko'chirma
  r = await call(h, 'GetStatement', { dateFrom: '2026-11-25 00:00:00', dateTo: '2026-11-25 23:59:59' });
  assert.deepStrictEqual(r.body.result.statements, [{ amount: 34000000, providerTrnId: 1006, transactionId: 555, timestamp: '2026-11-25 15:00:00' }]);
  r = await call(h, 'GetStatement', { dateFrom: 'bad', dateTo: 'x' });
  assert.strictEqual(r.body.error.code, 414);

  // bekor qilish: tovar qaytadi, sotuv o'chadi
  T += 60000;
  r = await call(h, 'CancelTransaction', { transactionId: 555 });
  assert.strictEqual(r.body.result.transactionState, 2);
  assert.ok(!('sales/p555' in db.store));
  assert.deepStrictEqual(db.store['products/p1'].sizes, [{ s: 'M', q: 3 }, { s: 'L', q: 2 }]);
  assert.strictEqual(db.store['products/p2'].qty, 4);
  assert.strictEqual(db.store['log/pc555'].type, 'refund');
  r = await call(h, 'CancelTransaction', { transactionId: 555 });
  assert.strictEqual(r.body.error.code, 202);
  r = await call(h, 'CheckTransaction', { transactionId: 555 });
  assert.strictEqual(r.body.result.transactionState, 2);
  r = await call(h, 'GetStatement', { dateFrom: '2026-11-25 00:00:00', dateTo: '2026-11-25 23:59:59' });
  assert.deepStrictEqual(r.body.result.statements, []);

  // parol almashtirish
  r = await call(h, 'ChangePassword', { newPassword: 'yangiParol99' });
  assert.strictEqual(r.body.result, 'success');
  r = await call(h, 'CheckTransaction', { transactionId: 555 });
  assert.strictEqual(r.status, 401);
  r = await call(h, 'CheckTransaction', { transactionId: 555 }, auth('paynet', 'yangiParol99'));
  assert.strictEqual(r.body.result.transactionState, 2);

  // noma'lum metod va buzilgan JSON
  r = await call(h, 'Hack', {}, auth('paynet', 'yangiParol99'));
  assert.strictEqual(r.body.error.code, -32601);
  r = await h({ method: 'POST', headers: { authorization: auth('paynet', 'yangiParol99') }, rawBody: Buffer.from('{bad') });
  assert.strictEqual(r.body.error.code, -32700);

  console.log('Paynet: barcha sinovlar o\'tdi ✓');
})().catch(e => { console.error(e); process.exit(1); });
