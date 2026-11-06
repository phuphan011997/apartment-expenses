// Khi Apps Script chèn/xoá ô trong khối mua hàng, các dòng bên dưới bị dời.
// Google tự sửa công thức trên sheet; ở đây sửa theo cho số dòng và công thức đã lưu
// trong các note khác, để lần đồng bộ sau vẫn tìm đúng chỗ.
//
// shifts: [{ at, n, c1, c2 }] theo thứ tự đã làm. n > 0: dòng >= at dời xuống n.
// n < 0: xoá -n dòng từ at, dòng bên dưới dời lên. Chỉ áp cho cột c1..c2.

function mapRow(r, shifts) {
  for (const s of shifts || []) {
    if (s.n > 0) { if (r >= s.at) r += s.n; }
    else { const c = -s.n; if (r >= s.at + c) r -= c; else if (r >= s.at) return -1; }
  }
  return r;
}

function colNum(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

/* home: tab chứa công thức; sheet: tab vừa bị dời */
function shiftFormula(f, home, sheet, shifts) {
  if (!f || !shifts || !shifts.length) return f;
  return String(f).replace(/(('(?:[^']|'')+')!)?(\$?)([A-Z]+)(\$?)(\d+)/g, (m, pre, q, d1, cl, d2, row) => {
    const target = q ? q.slice(1, -1).replace(/''/g, "'") : home;
    if (target !== sheet) return m;
    const c = colNum(cl);
    const own = shifts.filter((s) => c >= s.c1 && c <= s.c2);
    if (!own.length) return m;
    const nr = mapRow(Number(row), own);
    return nr < 0 ? m : (pre || "") + d1 + cl + d2 + nr;
  });
}

/* Sửa sync của một note khác sau khi tab `sheet` bị dời. Trả về sync mới hoặc null nếu không đổi. */
function shiftSync(sync, sheet, shifts) {
  if (!sync || !shifts || !shifts.length) return null;
  let changed = false;
  const out = { ...sync };
  if (sync.sheet === sheet && Array.isArray(sync.rows)) {
    const rows = sync.rows.map((r) => {
      const nr = mapRow(Number(r), shifts);
      return nr < 0 ? r : nr;
    });
    if (rows.some((r, i) => r !== sync.rows[i])) { out.rows = rows; changed = true; }
  }
  if (sync.split && sync.split.formula) {
    const f = shiftFormula(sync.split.formula, sync.sheet, sheet, shifts);
    if (f !== sync.split.formula) { out.split = { ...sync.split, formula: f }; changed = true; }
  }
  return changed ? out : null;
}

module.exports = { mapRow, shiftFormula, shiftSync };
