// ============================================================
//  /api/index.js — API cho tab "Note", chạy như một serverless function.
//  vercel.json chuyển mọi đường dẫn /api/* về đây kèm tham số ?path=
//  Note lưu ở MongoDB. Chỉ khi bấm "Đồng bộ" thì các món trong note mới được
//  gửi tới Apps Script gắn trong Google Sheet để ghi vào tab tuần.
//
//  Các đường dẫn:
//    GET    /api/health            kiểm tra kết nối, có cần mã truy cập không
//    GET    /api/members           danh sách người
//    PUT    /api/members/:id       thêm hoặc sửa một người   { name }
//    DELETE /api/members/:id       xoá một người (không được nếu còn trong hạng mục)
//    GET    /api/items             danh sách hạng mục, mới nhất trước
//    PUT    /api/items/:id         thêm hoặc sửa một hạng mục
//    DELETE /api/items/:id         xoá một hạng mục
//    POST   /api/items/:id/sync    ghi các món của note lên sheet  { sheet, force? }
//    GET    /api/sheet/tabs        danh sách tab trong Google Sheet (qua Apps Script)
//
//  Biến môi trường trên Vercel:
//    MONGODB_URI  chuỗi kết nối. Integration MongoDB Atlas của Vercel tự thêm biến
//                 này khi bạn nối database vào project. Nếu nó có tiền tố
//                 (ví dụ STORAGE_MONGODB_URI) thì API vẫn tự tìm ra.
//    APP_TOKEN    tuỳ chọn. Có đặt thì mọi lệnh gọi phải gửi kèm mã này,
//                 người dùng nhập một lần trên máy rồi app tự nhớ.
//    SHEET_SCRIPT_URL     link ứng dụng web của Apps Script (kết thúc bằng /exec)
//    SHEET_SCRIPT_SECRET  mã bí mật, trùng với biến SECRET trong Code.gs
// ============================================================

const { MongoClient } = require("mongodb");
const crypto = require("crypto");

const DB_NAME = process.env.MONGODB_DB || "apartment_expenses";

let cached = global._aptExpMongo;
if (!cached) cached = global._aptExpMongo = { client: null, promise: null };

function mongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  const key = Object.keys(process.env).find((k) => /MONGODB_URI$/.test(k) && process.env[k]);
  return key ? process.env[key] : "";
}

async function getDb() {
  if (cached.client) return cached.client.db(DB_NAME);
  if (!cached.promise) {
    const uri = mongoUri();
    if (!uri) throw Object.assign(new Error("missing MONGODB_URI"), { code: "no_db" });
    cached.promise = new MongoClient(uri, { maxPoolSize: 5 }).connect()
      .catch((e) => { cached.promise = null; throw e; });
  }
  cached.client = await cached.promise;
  return cached.client.db(DB_NAME);
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  return {};
}

function pathParts(req) {
  let raw = [].concat((req.query && req.query.path) || []);
  if (raw.length === 1 && String(raw[0]).indexOf("/") !== -1) raw = String(raw[0]).split("/");
  if (!raw.length) {
    const p = String(req.url || "").split("?")[0].replace(/^\/+/, "").replace(/^api\/?/, "");
    raw = p ? p.split("/") : [];
  }
  return raw.map((s) => decodeURIComponent(String(s))).filter(Boolean);
}

const out = (doc) => { const { _id, ...rest } = doc; return { id: _id, ...rest }; };
const send = (res, status, body) => { res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(body)); };
const bad = (res, msg) => send(res, 400, { error: msg });

const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (s, max) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max);

/* Số tiền gõ kiểu sheet: "24000", "35k", "6*4000", "185000+195000".
   Trả về { amount, formula } — formula là biểu thức để ghi "=..." vào cột E. */
function parseAmount(raw) {
  let s = String(raw == null ? "" : raw).replace(/\s+/g, "").replace(/^=/, "");
  if (!s) return { amount: null, formula: null };
  s = s.replace(/[.,](?=\d{3}(\D|$))/g, "").replace(/(\d+)k(\d)(?!\d)/gi, (m, n, d) => String(Number(n) * 1000 + Number(d) * 100))
       .replace(/(\d+(?:\.\d+)?)k/gi, (m, n) => String(Math.round(Number(n) * 1000)));
  if (!/^[\d+\-*/().]{1,60}$/.test(s)) return { error: true };
  let i = 0;
  const num = () => { const m = /^\d+(\.\d+)?/.exec(s.slice(i)); if (!m) throw 0; i += m[0].length; return Number(m[0]); };
  const atom = () => {
    if (s[i] === "(") { i++; const v = expr(); if (s[i] !== ")") throw 0; i++; return v; }
    if (s[i] === "-") { i++; return -atom(); }
    return num();
  };
  const term = () => { let v = atom(); while (s[i] === "*" || s[i] === "/") { const op = s[i++]; const r = atom(); v = op === "*" ? v * r : v / r; } return v; };
  const expr = () => { let v = term(); while (s[i] === "+" || s[i] === "-") { const op = s[i++]; const r = term(); v = op === "+" ? v + r : v - r; } return v; };
  try {
    const v = expr();
    if (i !== s.length || !isFinite(v) || v < 0 || v > 1e10) return { error: true };
    return { amount: Math.round(v), formula: /[+\-*/()]/.test(s) ? s : null };
  } catch (e) { return { error: true }; }
}

function checkLines(arr, date) {
  const lines = [];
  for (const raw of [].concat(arr || []).slice(0, 60)) {
    const l = raw || {};
    const desc = clean(l.desc, 120);
    const a = parseAmount(l.expr != null ? l.expr : l.amount);
    if (!desc && a.amount === null && !clean(l.qty, 1)) continue; // dòng trống
    if (!desc) return { error: "Mỗi món cần có mô tả." };
    if (a.error) return { error: "Số tiền của “" + desc + "” không hợp lệ." };
    const buyer = l.buyer && ID_RE.test(String(l.buyer)) ? String(l.buyer) : null;
    if (!buyer) return { error: "Chọn người mua cho “" + desc + "”." };
    lines.push({ buyer, desc, qty: clean(l.qty, 40), expr: a.formula || (a.amount === null ? "" : String(a.amount)),
                 amount: a.amount, formula: a.formula, left: clean(l.left, 40) });
  }
  const fp = crypto.createHash("sha1").update(JSON.stringify([date, lines])).digest("hex").slice(0, 16);
  return { lines, fp };
}

function checkItem(b) {
  const title = clean(b.title, 80);
  if (!title) return { error: "Cần nội dung note." };
  const date = String(b.date || "");
  if (!DATE_RE.test(date) || isNaN(Date.parse(date))) return { error: "Ngày không hợp lệ." };
  const participants = Array.from(new Set([].concat(b.participants || []).map(String)))
    .filter((x) => ID_RE.test(x)).slice(0, 40);
  if (!participants.length) return { error: "Chọn ít nhất một người tham gia." };
  let amount = null;
  if (b.amount !== null && b.amount !== undefined && b.amount !== "") {
    amount = Number(b.amount);
    if (!isFinite(amount) || amount < 0 || amount > 1e10) return { error: "Số tiền không hợp lệ." };
    amount = Math.round(amount);
  }
  let payer = b.payer && ID_RE.test(String(b.payer)) ? String(b.payer) : null;
  const doc = { title, date, participants, amount, payer, note: clean(b.note, 300), lines: [], linesFp: null };
  if (b.lines !== undefined) {
    const l = checkLines(b.lines, date);
    if (l.error) return { error: l.error };
    doc.lines = l.lines;
    doc.linesFp = l.lines.length ? l.fp : null;
    if (l.lines.length) { doc.amount = l.lines.reduce((a, x) => a + (x.amount || 0), 0); doc.payer = null; }
  }
  return { doc };
}

/* Gọi Apps Script. Google trả về qua một lần chuyển hướng, fetch tự theo. */
async function callScript(body) {
  const url = process.env.SHEET_SCRIPT_URL, secret = process.env.SHEET_SCRIPT_SECRET;
  if (!url || !secret) return { error: "Chưa cài Apps Script: thiếu SHEET_SCRIPT_URL hoặc SHEET_SCRIPT_SECRET trên Vercel.", code: "no_script" };
  let text = "";
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...body, secret }), redirect: "follow", signal: AbortSignal.timeout(25000) });
    text = await r.text();
  } catch (e) {
    return { error: "Không gọi được Apps Script, thử lại sau.", code: "script_unreachable" };
  }
  let j;
  try { j = JSON.parse(text); }
  catch (e) { return { error: "Apps Script không trả lời đúng. Kiểm tra lúc triển khai đã chọn “Bất kỳ ai” (Anyone) được truy cập.", code: "script_bad_reply" }; }
  const MSG = {
    unauthorized: "Mã bí mật trong Code.gs khác SHEET_SCRIPT_SECRET trên Vercel.",
    no_sheet: "Không có tab này trong Google Sheet.",
    no_block: "Tab này không có bảng “Người mua · Mô tả · SL · Số tiền · Dư lại · Ngày”.",
    prev_changed: "Các dòng đã ghi lần trước trên sheet đã bị sửa hoặc xoá.",
    no_lines: "Note chưa có món nào.",
  };
  if (j.error) return { ...j, code: j.error, error: MSG[j.error] || ("Apps Script báo lỗi: " + (j.message || j.error)) };
  return j;
}

module.exports = async (req, res) => {
  const parts = pathParts(req);
  const [coll, id, sub] = parts;
  const method = String(req.method || "GET").toUpperCase();

  if (coll === "health") {
    let db = "no_uri";
    if (mongoUri()) {
      try { await (await getDb()).command({ ping: 1 }); db = "ok"; }
      catch (e) { db = "error"; }
    }
    return send(res, 200, { ok: db === "ok", db, needsToken: !!process.env.APP_TOKEN,
      sheetSync: !!(process.env.SHEET_SCRIPT_URL && process.env.SHEET_SCRIPT_SECRET) });
  }

  const token = process.env.APP_TOKEN;
  if (token && req.headers["x-app-token"] !== token) {
    return send(res, 401, { error: "Sai hoặc thiếu mã truy cập." });
  }

  if (coll === "sheet" && id === "tabs" && method === "GET") {
    const r = await callScript({ action: "tabs" });
    return send(res, r.error ? (r.code === "no_script" ? 503 : 502) : 200, r.error ? { error: r.error, code: r.code } : { tabs: r.tabs || [] });
  }

  if (coll !== "items" && coll !== "members") return send(res, 404, { error: "Không có đường dẫn này." });
  if (id && !ID_RE.test(id)) return bad(res, "Mã không hợp lệ.");

  let db;
  try { db = await getDb(); }
  catch (e) {
    return send(res, 503, { error: e.code === "no_db" ? "Chưa nối database." : "Không kết nối được database.", code: e.code || "db_error" });
  }
  const now = new Date().toISOString();

  try {
    if (coll === "members") {
      const c = db.collection("members");
      if (method === "GET" && !id) {
        const list = await c.find({}).sort({ order: 1, createdAt: 1 }).toArray();
        return send(res, 200, { members: list.map(out) });
      }
      if (method === "PUT" && id) {
        const b = readBody(req);
        const name = clean(b.name, 40);
        if (!name) return bad(res, "Cần tên người.");
        const set = { name, updatedAt: now };
        if (typeof b.order === "number" && isFinite(b.order)) set.order = b.order;
        await c.updateOne({ _id: id }, { $set: set, $setOnInsert: { createdAt: now } }, { upsert: true });
        return send(res, 200, { member: out(await c.findOne({ _id: id })) });
      }
      if (method === "DELETE" && id) {
        const used = await db.collection("items").countDocuments({ $or: [{ participants: id }, { payer: id }, { "lines.buyer": id }] });
        if (used) return send(res, 409, { error: "Người này còn trong " + used + " note. Bỏ khỏi các note đó trước khi xoá." });
        await c.deleteOne({ _id: id });
        return send(res, 200, { ok: true });
      }
    }

    if (coll === "items") {
      const c = db.collection("items");
      if (method === "GET" && !id) {
        const list = await c.find({}).sort({ date: -1, createdAt: -1 }).limit(500).toArray();
        return send(res, 200, { items: list.map(out) });
      }
      if (method === "PUT" && id) {
        const r = checkItem(readBody(req));
        if (r.error) return bad(res, r.error);
        await c.updateOne({ _id: id }, { $set: { ...r.doc, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true });
        return send(res, 200, { item: out(await c.findOne({ _id: id })) });
      }
      if (method === "POST" && id && sub === "sync") {
        const b = readBody(req);
        const sheet = clean(b.sheet, 100);
        if (!sheet) return bad(res, "Chọn tab để ghi.");
        const it = await c.findOne({ _id: id });
        if (!it) return send(res, 404, { error: "Không tìm thấy note." });
        if (!it.lines || !it.lines.length) return bad(res, "Note chưa có món nào.");
        const members = await db.collection("members").find({}).toArray();
        const nameOf = (mid) => (members.find((m) => m._id === mid) || {}).name || "";
        const prev = it.sync && it.sync.sheet === sheet ? { rows: it.sync.rows, descs: it.sync.descs } : null;
        const r = await callScript({
          action: "write", sheet, prev, force: !!b.force,
          lines: it.lines.map((l) => ({ buyer: nameOf(l.buyer), desc: l.desc, qty: l.qty, amount: l.amount,
                                         formula: l.formula, left: l.left, date: it.date })),
        });
        if (r.error) return send(res, r.code === "prev_changed" ? 409 : r.code === "no_script" ? 503 : 502, { error: r.error, code: r.code, row: r.row });
        const sync = { sheet, rows: r.rows, descs: r.descs, fp: it.linesFp, at: now };
        await c.updateOne({ _id: id }, { $set: { sync } });
        return send(res, 200, { item: out({ ...it, sync }) });
      }
      if (method === "DELETE" && id) {
        await c.deleteOne({ _id: id });
        return send(res, 200, { ok: true });
      }
    }
    return send(res, 405, { error: "Không hỗ trợ thao tác này." });
  } catch (e) {
    return send(res, 500, { error: "Lỗi database, thử lại sau." });
  }
};
