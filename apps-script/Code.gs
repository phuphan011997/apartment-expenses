/**
 * Chi Tiêu Nhà Chung — Apps Script gắn vào Google Sheet.
 *
 * App (máy chủ Vercel) gửi dữ liệu tới đây, script ghi các món mua vào khối
 * "Người mua · Mô tả · SL · Số tiền · Dư lại · Ngày" của tab tuần, rồi thêm một
 * dòng vào bảng chia tiền bên phải (Ngày · từng người · Tổng cộng · Người mua):
 * Tổng cộng là công thức cộng các ô Số tiền vừa ghi, phần mỗi người là công thức
 * chia Tổng cộng theo số người tham gia (cột ghép "A + B" nhân theo số người có mặt).
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
/* các khoá để so tên: "Chị Vân Anh" -> ["van anh", "vanh"], "Chị VAnh" -> ["vanh"] */
function personKeys_(s) {
  var k = personKey_(s);
  if (!k) return [];
  var w = k.split(' ');
  var out = [k];
  if (w.length > 1) out.push(w.slice(0, -1).map(function (x) { return x.charAt(0); }).join('') + w[w.length - 1]);
  return out;
}
function samePerson_(a, b) {
  var ka = personKeys_(a), kb = personKeys_(b);
  return ka.some(function (x) { return kb.indexOf(x) >= 0; });
}
function colLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/* Bảng chia tiền: hàng tiêu đề có ô "Ngày" nằm bên phải khối mua hàng, sau đó là
   các cột người, cột "Tổng cộng", có thể có cột "Người mua". */
function findSplit_(sh, minCol) {
  var rows = Math.min(sh.getLastRow(), 40), cols = sh.getLastColumn();
  if (rows < 1 || cols <= minCol) return null;
  var v = sh.getRange(1, 1, rows, cols).getDisplayValues();
  for (var r = 0; r < rows; r++) {
    for (var c = minCol; c < cols; c++) {
      if (norm_(v[r][c]) !== 'ngay') continue;
      var people = [], total = -1, buyer = -1;
      for (var k = c + 1; k < cols; k++) {
        var h = norm_(v[r][k]);
        if (!h) break;
        if (/^tong/.test(h)) { total = k; continue; }
        if (total < 0) people.push({ col: k + 1, name: String(v[r][k]).trim() });
        else if (h === 'nguoi mua') { buyer = k; break; }
        else if (k > total + 3) break;
      }
      if (total < 0 || !people.length) continue;
      var last = Math.max(total, buyer);
      for (var e = last + 1; e < Math.min(cols, total + 4); e++) if (norm_(v[r][e])) last = e;
      return { headerRow: r + 1, dayCol: c + 1, people: people, totalCol: total + 1,
               buyerCol: buyer >= 0 ? buyer + 1 : -1, lastCol: last + 1 };
    }
  }
  return null;
}

/* Mỗi cột người được bao nhiêu người tham gia. Người không có cột -> báo lỗi. */
function splitCounts_(sp, participants) {
  var counts = sp.people.map(function () { return 0; }), missing = [];
  participants.forEach(function (p) {
    var hit = -1;
    sp.people.forEach(function (col, i) {
      if (hit < 0 && col.name.split('+').some(function (part) { return samePerson_(part, p); })) hit = i;
    });
    if (hit < 0) missing.push(p); else counts[hit]++;
  });
  return { counts: counts, missing: missing };
}

function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }

/* Các dòng ngày liền nhau dưới tiêu đề bảng chia */
function dayRows_(sh, sp) {
  var out = [], r = sp.headerRow + 1, max = sh.getLastRow();
  while (r <= max) {
    var v = sh.getRange(r, sp.dayCol).getValue();
    if (!isDate_(v)) break;
    out.push({ row: r, date: v });
    r++;
  }
  return out;
}

function writeSplit_(sh, sp, b, rows, buyers, tz) {
  var n = b.participants.length;
  var cnt = splitCounts_(sp, b.participants).counts;
  var terms = [];
  b.lines.forEach(function (ln, i) {
    var p = String(ln.portion || '1');
    if (p === '0') return;
    terms.push(colLetter_(b.amountCol) + rows[i] + (p === '1' ? '' : /^1\/\d+$/.test(p) ? p.slice(1) : '*' + p));
  });
  var totalF = terms.length ? '=' + terms.join('+') : '=0';
  var days = dayRows_(sh, sp);
  var date = Utilities.parseDate(b.date, tz, 'yyyy-MM-dd');

  /* dòng cũ của note này: tìm theo công thức Tổng cộng đã ghi lần trước */
  var row = -1;
  if (b.prevSplit) {
    days.forEach(function (d) {
      if (row < 0 && sh.getRange(d.row, sp.totalCol).getFormula() === b.prevSplit) row = d.row;
    });
  }
  if (row < 0) {
    /* chèn theo thứ tự ngày, chỉ đẩy các ô của bảng chia xuống, không đụng khối mua hàng */
    var after = sp.headerRow;
    days.forEach(function (d) { if (d.date.getTime() <= date.getTime()) after = d.row; });
    row = after + 1;
    var width = sp.lastCol - sp.dayCol + 1;
    var endRow = days.length ? days[days.length - 1].row + 1 : sp.headerRow + 1;
    var free = row === endRow && sh.getRange(row, sp.dayCol, 1, width).getValues()[0].every(function (x) { return x === '' || x === null; });
    if (!free) {
      sh.getRange(row, sp.dayCol, 1, width).insertCells(SpreadsheetApp.Dimension.ROWS);
      /* dòng tổng ngay dưới bảng: kéo vùng SUM(J4:J17) xuống thêm dòng mới */
      if (row === endRow) {
        var below = sh.getRange(row + 1, sp.dayCol, 1, width);
        var fs = below.getFormulas()[0];
        var changed = false;
        fs = fs.map(function (f) {
          if (!f) return f;
          var g = f.replace(new RegExp('([A-Z]+\\$?)(\\d+):(\\$?[A-Z]+\\$?)' + (row - 1) + '(?!\\d)', 'g'), function (m, a, b2, c) { changed = true; return a + b2 + ':' + c + row; });
          return g;
        });
        if (changed) fs.forEach(function (f, i) { if (f) below.getCell(1, i + 1).setFormula(f); });
      }
    }
    var src = days.length ? (after > sp.headerRow ? after : days[0].row) : -1;
    if (src > 0) sh.getRange(src, sp.dayCol, 1, width).copyFormatToRange(sh, sp.dayCol, sp.lastCol, row, row);
  }

  var T = '$' + colLetter_(sp.totalCol) + row;
  sh.getRange(row, sp.dayCol).setValue(date);
  sp.people.forEach(function (pc, i) {
    var k = cnt[i];
    sh.getRange(row, pc.col).setValue(k ? '=' + T + '/' + n + (k > 1 ? '*' + k : '') : 0);
  });
  sh.getRange(row, sp.totalCol).setFormula(totalF);
  if (sp.buyerCol > 0) {
    var who = [];
    b.lines.forEach(function (ln) {
      var nm = matchBuyer_(ln.buyer || '', buyers);
      if (nm && who.indexOf(nm) < 0) who.push(nm);
    });
    sh.getRange(row, sp.buyerCol).setValue(who.join(' + '));
  }
  return { row: row, formula: totalF };
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

    /* Bảng chia tiền: kiểm tra trước khi ghi gì, để lỗi thì không ghi dở dang */
    var sp = null;
    if (b.participants && b.participants.length) {
      sp = findSplit_(sh, col + 5);
      if (!sp) return { error: 'no_split' };
      var miss = splitCounts_(sp, b.participants).missing;
      if (miss.length) return { error: 'no_split_col', names: miss };
    }

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
    var split = null;
    if (sp) split = writeSplit_(sh, sp, { participants: b.participants, lines: lines, date: b.date || lines[0].date,
      prevSplit: !b.force && b.prev ? b.prev.split : null, amountCol: col + 3 }, rows, buyers, tz);
    SpreadsheetApp.flush();
    var descs = rows.map(function (r) { return String(sh.getRange(r, col + 1).getDisplayValue()).trim(); });
    return { ok: true, sheet: b.sheet, rows: rows, descs: descs, split: split };
  } finally {
    lock.releaseLock();
  }
}
