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
const { shiftSync } = require("../lib/shift");

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
  const db = cached.client.db(DB_NAME);
  /* chỉ mục: một lần cho mỗi lần khởi động; tạo rồi thì Mongo bỏ qua */
  if (!cached.indexed) {
    cached.indexed = true;
    const it = db.collection("items");
    Promise.all([
      it.createIndex({ date: -1, createdAt: -1 }),
      it.createIndex({ "lines.src.item": 1 }),
    ]).catch(() => { cached.indexed = false; });
  }
  return db;
}

const PAGE = 200;
/* một trang note mới nhất; note cũ chưa có mã món thì gán mã (để dùng tiếp đồ dư) */
async function itemsPage(c, skip, limit) {
  const list = await c.find({}).sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit + 1).toArray();
  const hasMore = list.length > limit;
  if (hasMore) list.pop();
  for (const it of list) {
    if ((it.lines || []).some((l) => !l.id)) {
      it.lines = it.lines.map((l) => (l.id ? l : { ...l, id: newLineId() }));
      await c.updateOne({ _id: it._id }, { $set: { lines: it.lines } });
    }
  }
  return { items: list.map(out), hasMore };
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

/* "Tính vào chia": cả món, một phần, hoặc không tính */
const PORTIONS = ["1", "1/2", "1/3", "2/3", "1/4", "3/4", "0"];

/* Phần của món tính theo 1/12 để cộng trừ không lệch: "1/2" -> 6, "1" -> 12 */
function twelfths(p) {
  const m = /^(\d{1,2})(?:\/(\d{1,2}))?$/.exec(String(p == null ? "" : p));
  if (!m) return null;
  const a = Number(m[1]), b = m[2] ? Number(m[2]) : 1;
  if (!b || (12 * a) % b) return null;
  const k = (12 * a) / b;
  return k >= 0 && k <= 12 ? k : null;
}
function fracOf(k) {
  if (k === 12) return "1";
  if (k === 0) return "0";
  const g = (x, y) => (y ? g(y, x % y) : x);
  const d = g(k, 12);
  return k / d + "/" + 12 / d;
}
const newLineId = () => "ln_" + crypto.randomBytes(6).toString("hex");
const srcKey = (s) => s.item + ":" + s.line;

function checkLines(arr, date, extra) {
  const lines = [];
  for (const raw of [].concat(arr || []).slice(0, 60)) {
    const l = raw || {};
    const id = l.id && ID_RE.test(String(l.id)) ? String(l.id) : newLineId();
    if (l.kind === "use") {
      /* dùng tiếp đồ dư của một món ở note trước: không có số tiền, chỉ có phần dùng */
      const src = l.src || {};
      if (!ID_RE.test(String(src.item || "")) || !ID_RE.test(String(src.line || ""))) return { error: "Món dùng tiếp không hợp lệ." };
      const desc = clean(l.desc, 120);
      const k = twelfths(l.portion);
      if (!desc || !k) return { error: "Chọn phần dùng cho “" + (desc || "đồ dư") + "”." };
      const buyer = l.buyer && ID_RE.test(String(l.buyer)) ? String(l.buyer) : null;
      const srcDate = DATE_RE.test(String(l.srcDate || "")) ? String(l.srcDate) : "";
      lines.push({ id, kind: "use", src: { item: String(src.item), line: String(src.line) }, srcDate, buyer, desc,
                   qty: "", expr: "", amount: null, formula: null, left: clean(l.left, 40), portion: fracOf(k) });
      continue;
    }
    const desc = clean(l.desc, 120);
    const a = parseAmount(l.expr != null ? l.expr : l.amount);
    if (!desc && a.amount === null && !clean(l.qty, 1)) continue; // dòng trống
    if (!desc) return { error: "Mỗi món cần có mô tả." };
    if (a.error) return { error: "Số tiền của “" + desc + "” không hợp lệ." };
    const buyer = l.buyer && ID_RE.test(String(l.buyer)) ? String(l.buyer) : null;
    if (!buyer) return { error: "Chọn người mua cho “" + desc + "”." };
    const portion = PORTIONS.indexOf(String(l.portion || "1")) >= 0 ? String(l.portion || "1") : "1";
    lines.push({ id, buyer, desc, qty: clean(l.qty, 40), expr: a.formula || (a.amount === null ? "" : String(a.amount)),
                 amount: a.amount, formula: a.formula, left: clean(l.left, 40), portion });
  }
  const fp = crypto.createHash("sha1").update(JSON.stringify([date, lines, extra || null])).digest("hex").slice(0, 16);
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
    const l = checkLines(b.lines, date, participants.slice().sort());
    if (l.error) return { error: l.error };
    doc.lines = l.lines;
    doc.linesFp = l.lines.length ? l.fp : null;
    if (l.lines.length) { doc.amount = l.lines.reduce((a, x) => a + (x.amount || 0), 0); doc.payer = null; }
  }
  return { doc };
}

/* Kiểm tra dùng đồ dư: mỗi món gốc không bị dùng quá 100%, món đang được dùng
   tiếp thì không xoá được. items = toàn bộ note sau khi thay note đang sửa. */
function checkUsage(items, editedId) {
  const byId = {};
  items.forEach((it) => { byId[it._id] = it; });
  const used = {};
  for (const it of items) {
    for (const l of it.lines || []) {
      if (l.kind !== "use") continue;
      const src = byId[l.src.item];
      const sl = src && (src.lines || []).find((x) => x.id === l.src.line && x.kind !== "use");
      const mine = it._id === editedId || l.src.item === editedId;
      if (!sl) {
        if (it._id === editedId) return "Món gốc của “" + l.desc + "” không còn nữa.";
        if (l.src.item === editedId) return "Món “" + l.desc + "” đang được dùng tiếp ở note “" + it.title + "”, không xoá hoặc đổi khỏi note này được.";
        continue;
      }
      if (src._id === it._id) return "Không dùng đồ dư của chính note này.";
      const key = srcKey(l.src);
      if (used[key] === undefined) used[key] = { k: twelfths(sl.portion || "1") || 0, mine: false };
      used[key].k += twelfths(l.portion) || 0;
      used[key].mine = used[key].mine || mine;
    }
  }
  for (const key in used) {
    if (used[key].k > 12 && used[key].mine) {
      const [iid, lid] = key.split(":");
      const sl = (byId[iid].lines || []).find((x) => x.id === lid);
      return "“" + sl.desc + "” không còn đủ phần dư để dùng.";
    }
  }
  return "";
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
    src_changed: "Dòng món gốc trên sheet đã bị sửa hoặc dời chỗ. Đồng bộ lại note gốc trước.",
    no_split: "Tab này không có bảng chia tiền (hàng tiêu đề có ô “Ngày” và “Tổng cộng”).",
  };
  if (j.error === "no_split_col") return { ...j, code: j.error, error: "Bảng chia tiền không có cột cho: " + (j.names || []).join(", ") + ". Thêm cột cho người này trên sheet, hoặc đổi tên cho khớp." };
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
  const sheetSync = !!(process.env.SHEET_SCRIPT_URL && process.env.SHEET_SCRIPT_SECRET);

  /* Mở tab Note: một lần gọi lấy đủ trạng thái, danh sách người và trang note đầu tiên */
  if (coll === "bootstrap" && method === "GET") {
    if (!mongoUri()) return send(res, 200, { db: "no_uri" });
    if (token && req.headers["x-app-token"] !== token) return send(res, 401, { error: "Sai hoặc thiếu mã truy cập.", needsToken: true });
    try {
      const db = await getDb();
      const [members, page] = await Promise.all([
        db.collection("members").find({}).sort({ order: 1, createdAt: 1 }).toArray(),
        itemsPage(db.collection("items"), 0, PAGE),
      ]);
      return send(res, 200, { db: "ok", needsToken: !!token, sheetSync, members: members.map(out), items: page.items, hasMore: page.hasMore });
    } catch (e) {
      return send(res, 200, { db: "error" });
    }
  }

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
        const q = req.query || {};
        const skip = Math.max(0, Math.min(100000, parseInt(q.skip, 10) || 0));
        const limit = Math.max(1, Math.min(PAGE, parseInt(q.limit, 10) || PAGE));
        return send(res, 200, await itemsPage(c, skip, limit));
      }
      if (method === "PUT" && id) {
        const r = checkItem(readBody(req));
        if (r.error) return bad(res, r.error);
        /* chỉ cần các note liên quan tới đồ dư: note này, note gốc nó dùng, và note khác dùng chung món gốc */
        const srcIds = [...new Set(r.doc.lines.filter((l) => l.kind === "use").map((l) => l.src.item))];
        const keys = srcIds.concat([id]);
        const all = await c.find({ $or: [{ _id: { $in: keys } }, { "lines.src.item": { $in: keys } }] }).toArray();
        const next = all.filter((x) => x._id !== id).concat([{ _id: id, ...r.doc }]);
        const usageErr = checkUsage(next, id);
        if (usageErr) return send(res, 409, { error: usageErr });
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
        /* món dùng tiếp đồ dư: cần biết dòng của món gốc trên sheet */
        const srcInfo = {};
        for (const l of it.lines) {
          if (l.kind !== "use") continue;
          const src = await c.findOne({ _id: l.src.item });
          const idx = src ? (src.lines || []).findIndex((x) => x.id === l.src.line) : -1;
          if (idx < 0) return send(res, 409, { error: "Không tìm thấy món gốc của “" + l.desc + "”.", code: "src_missing" });
          if (!src.sync || src.sync.fp !== src.linesFp || !src.sync.rows[idx]) {
            return send(res, 409, { error: "Note “" + src.title + "” (món " + l.desc + ") chưa lên sheet hoặc đã sửa mà chưa đồng bộ lại. Đồng bộ note đó trước.", code: "src_unsynced" });
          }
          srcInfo[l.id] = { srcSheet: src.sync.sheet, srcRow: src.sync.rows[idx], srcDesc: src.sync.descs[idx] };
        }
        const dm = (iso) => (iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) : "");
        const prev = it.sync && it.sync.sheet === sheet
          ? { rows: it.sync.rows, descs: it.sync.descs, split: it.sync.split ? it.sync.split.formula : null } : null;
        const r = await callScript({
          action: "write", sheet, prev, force: !!b.force, date: it.date, title: it.title,
          colors: Object.fromEntries(Object.entries(b.colors && typeof b.colors === "object" ? b.colors : {})
            .filter(([k, v]) => typeof k === "string" && k.length < 60 && /^#[0-9a-fA-F]{6}$/.test(String(v))).slice(0, 30)),
          participants: it.participants.map(nameOf).filter(Boolean),
          lines: it.lines.map((l) => (l.kind === "use"
            ? { kind: "use", buyer: nameOf(l.buyer), desc: "↳ " + l.desc + " (dư " + dm(l.srcDate) + ")", qty: "", amount: null,
                formula: null, left: l.left, date: it.date, portion: l.portion, ...srcInfo[l.id] }
            : { buyer: nameOf(l.buyer), desc: l.desc, qty: l.qty, amount: l.amount,
                formula: l.formula, left: l.left, date: it.date, portion: l.portion || "1" })),
        });
        if (r.error) return send(res, r.code === "prev_changed" || r.code === "src_changed" ? 409 : r.code === "no_script" ? 503 : r.code === "no_split_col" || r.code === "no_split" ? 422 : 502, { error: r.error, code: r.code, row: r.row });
        const sync = { sheet, rows: r.rows, descs: r.descs, split: r.split || null, fp: it.linesFp, at: now };
        await c.updateOne({ _id: id }, { $set: { sync } });
        /* dòng bị chèn/xoá trên sheet: sửa số dòng và công thức đã lưu của các note khác */
        if (r.shifts && r.shifts.length) {
          const others = await c.find({ _id: { $ne: id }, sync: { $exists: true } }).toArray();
          for (const x of others) {
            const ns = shiftSync(x.sync, sheet, r.shifts);
            if (ns) await c.updateOne({ _id: x._id }, { $set: { sync: ns } });
          }
        }
        return send(res, 200, { item: out({ ...it, sync }) });
      }
      if (method === "DELETE" && id) {
        const user = await c.findOne({ "lines.src.item": id, _id: { $ne: id } });
        if (user) return send(res, 409, { error: "Đồ dư của note này đang được dùng tiếp ở note “" + user.title + "”. Bỏ món đó ở note kia trước." });
        await c.deleteOne({ _id: id });
        return send(res, 200, { ok: true });
      }
    }
    return send(res, 405, { error: "Không hỗ trợ thao tác này." });
  } catch (e) {
    return send(res, 500, { error: "Lỗi database, thử lại sau." });
  }
};
