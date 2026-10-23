/**
 * Chi Tiêu Nhà Chung — Apps Script gắn vào Google Sheet.
 *
 * App (máy chủ Vercel) gửi dữ liệu tới đây, script ghi các món mua vào khối
 * "Người mua · Mô tả · SL · Số tiền · Dư lại · Ngày" của tab tuần.
 * Script chỉ ghi 6 cột đó, không đụng khối chia tiền hay công thức khác.
 *
 * Cài đặt: xem apps-script/README.md
 *
 * @OnlyCurrentDoc  chỉ xin quyền với đúng file sheet này, không đụng file khác trong Drive
 */

// Đổi chuỗi này thành mã bí mật của bạn, và đặt cùng giá trị vào biến
// SHEET_SCRIPT_SECRET trên Vercel.
var SECRET = 'DOI-THANH-MA-BI-MAT';

var HEADERS = ['nguoi mua', 'mo ta', 'sl', 'so tien', 'du lai', 'ngay'];

function doGet() {
  return json_({ ok: true, app: 'chi-tieu-nha' });
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ error: 'bad_json' }); }
  if (!body || body.secret !== SECRET || SECRET === 'DOI-THANH-MA-BI-MAT') {
    return json_({ error: 'unauthorized' });
  }
  try {
    if (body.action === 'tabs') return json_({ ok: true, tabs: listTabs_() });
    if (body.action === 'write') return json_(write_(body));
    return json_({ error: 'unknown_action' });
  } catch (err) {
    return json_({ error: 'script_error', message: String(err && err.message || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function listTabs_() {
  return SpreadsheetApp.getActive().getSheets()
    .filter(function (s) { return !s.isSheetHidden(); })
    .map(function (s) { return s.getName(); });
}

/* bỏ dấu, viết thường, gọn khoảng trắng */
function norm_(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
}
/* "Chị Vân Anh", "C.Vân Anh", "Em Xuyến" -> "van anh", "xuyen" */
function personKey_(s) {
  return norm_(s).replace(/^(anh|chi|em|a\.|c\.|e\.)\s*/, '').replace(/[^a-z0-9 ]/g, '').trim();
}

/* Tìm hàng tiêu đề có "Người mua" và 5 cột kế tiếp đúng thứ tự */
function findBlock_(sh) {
  var rows = Math.min(sh.getLastRow(), 40), cols = Math.min(sh.getLastColumn(), 20);
  if (rows < 1 || cols < 1) return null;
  var v = sh.getRange(1, 1, rows, cols).getDisplayValues();
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c + 5 < cols; c++) {
      if (norm_(v[r][c]) !== HEADERS[0]) continue;
      var ok = true;
      for (var k = 1; k < 6; k++) if (norm_(v[r][c + k]) !== HEADERS[k]) { ok = false; break; }
      if (ok) return { headerRow: r + 1, col: c + 1 };
    }
  }
  return null;
}

/* Danh sách tên trong ô chọn Người mua của sheet (nếu có) */
function buyerList_(sh, row, col) {
  try {
    var dv = sh.getRange(row, col).getDataValidation();
    if (dv && dv.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
      return dv.getCriteriaValues()[0] || [];
    }
  } catch (e) {}
  return [];
}
function matchBuyer_(name, list) {
  var k = personKey_(name);
  for (var i = 0; i < list.length; i++) if (personKey_(list[i]) === k) return list[i];
  return name;
}

/* Chữ trông giống số hoặc ngày (vd "1/2", "500") thì giữ nguyên là chữ */
function asText_(s) {
  s = String(s == null ? '' : s).trim();
  if (!s) return '';
  return /^[\d\s.,\/\-:]+$/.test(s) ? "'" + s : s;
}

function write_(b) {
  var lines = b.lines || [];
  if (!b.sheet) return { error: 'no_sheet_name' };
  if (!lines.length) return { error: 'no_lines' };

  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActive();
    var sh = ss.getSheetByName(b.sheet);
    if (!sh) return { error: 'no_sheet' };
    var blk = findBlock_(sh);
    if (!blk) return { error: 'no_block' };
    var top = blk.headerRow + 1, col = blk.col;
    var tz = ss.getSpreadsheetTimeZone();

    /* Dòng đã ghi lần trước: kiểm tra cột Mô tả còn đúng thì ghi đè lên đó */
    var reuse = [];
    var prev = b.prev;
    if (prev && prev.rows && prev.rows.length && !b.force) {
      for (var i = 0; i < prev.rows.length; i++) {
        var row = Number(prev.rows[i]);
        if (!(row >= top)) return { error: 'prev_changed', row: row };
        var cur = String(sh.getRange(row, col + 1).getDisplayValue()).trim();
        if (norm_(cur) !== norm_(prev.descs && prev.descs[i])) return { error: 'prev_changed', row: row };
      }
      reuse = prev.rows.map(Number);
      reuse.forEach(function (r) { sh.getRange(r, col, 1, 6).clearContent(); });
    }

    /* Dòng cuối cùng còn dữ liệu trong 6 cột */
    var last = top - 1;
    var height = Math.max(sh.getLastRow() - top + 1, 0);
    if (height) {
      var vals = sh.getRange(top, col, height, 6).getValues();
      for (var r2 = vals.length - 1; r2 >= 0; r2--) {
        if (vals[r2].some(function (x) { return x !== '' && x !== null; })) { last = top + r2; break; }
      }
    }

    var buyers = buyerList_(sh, top, col);
    var rows = [], next = Math.max.apply(null, [last].concat(reuse)) + 1;
    lines.forEach(function (ln, idx) {
      var row = idx < reuse.length ? reuse[idx] : next++;
      if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), row - sh.getMaxRows());
      if (row > top) sh.getRange(top, col, 1, 6).copyFormatToRange(sh, col, col + 5, row, row);
      var amount = ln.formula ? '=' + ln.formula : (ln.amount === null || ln.amount === undefined || ln.amount === '' ? '' : Number(ln.amount));
      var date = ln.date ? Utilities.parseDate(ln.date, tz, 'yyyy-MM-dd') : '';
      sh.getRange(row, col, 1, 6).setValues([[
        matchBuyer_(ln.buyer || '', buyers),
        asText_(ln.desc),
        asText_(ln.qty),
        amount,
        asText_(ln.left),
        date
      ]]);
      rows.push(row);
    });
    SpreadsheetApp.flush();
    var descs = rows.map(function (r) { return String(sh.getRange(r, col + 1).getDisplayValue()).trim(); });
    return { ok: true, sheet: b.sheet, rows: rows, descs: descs };
  } finally {
    lock.releaseLock();
  }
}
