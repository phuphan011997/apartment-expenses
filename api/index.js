// ============================================================
//  /api/index.js — API cho tab "Note", chạy như một serverless function.
//  vercel.json chuyển mọi đường dẫn /api/* về đây kèm tham số ?path=
//  Dữ liệu ở đây độc lập với Google Sheet: app không bao giờ ghi vào sheet.
//
//  Các đường dẫn:
//    GET    /api/health            kiểm tra kết nối, có cần mã truy cập không
//    GET    /api/members           danh sách người
//    PUT    /api/members/:id       thêm hoặc sửa một người   { name }
//    DELETE /api/members/:id       xoá một người (không được nếu còn trong hạng mục)
//    GET    /api/items             danh sách hạng mục, mới nhất trước
//    PUT    /api/items/:id         thêm hoặc sửa một hạng mục
//    DELETE /api/items/:id         xoá một hạng mục
//
//  Biến môi trường trên Vercel:
//    MONGODB_URI  chuỗi kết nối. Integration MongoDB Atlas của Vercel tự thêm biến
//                 này khi bạn nối database vào project. Nếu nó có tiền tố
//                 (ví dụ STORAGE_MONGODB_URI) thì API vẫn tự tìm ra.
//    APP_TOKEN    tuỳ chọn. Có đặt thì mọi lệnh gọi phải gửi kèm mã này,
//                 người dùng nhập một lần trên máy rồi app tự nhớ.
// ============================================================

const { MongoClient } = require("mongodb");

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
  const payer = b.payer && ID_RE.test(String(b.payer)) ? String(b.payer) : null;
  return { doc: { title, date, participants, amount, payer, note: clean(b.note, 300) } };
}

module.exports = async (req, res) => {
  const parts = pathParts(req);
  const [coll, id] = parts;
  const method = String(req.method || "GET").toUpperCase();

  if (coll === "health") {
    let db = "no_uri";
    if (mongoUri()) {
      try { await (await getDb()).command({ ping: 1 }); db = "ok"; }
      catch (e) { db = "error"; }
    }
    return send(res, 200, { ok: db === "ok", db, needsToken: !!process.env.APP_TOKEN });
  }

  const token = process.env.APP_TOKEN;
  if (token && req.headers["x-app-token"] !== token) {
    return send(res, 401, { error: "Sai hoặc thiếu mã truy cập." });
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
        const used = await db.collection("items").countDocuments({ $or: [{ participants: id }, { payer: id }] });
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
