/**
* XƯỞNG GOKART — PUPPY FARM · máy chủ trên Cloudflare Workers + D1
* Giao diện (GitHub Pages) gửi POST {fn, args, op} và nhận JSON {ok, data} hoặc {ok:false, error}.
* Logic nghiệp vụ chép từ bản Google Apps Script cũ, chỉ thay chỗ lưu dữ liệu (Google Sheet → D1).
*/
/* ---------------- cấu trúc bảng ---------------- */
// t: s=chuỗi, n=số, d=thời gian (ms), b=đúng/sai, a=danh sách (JSON)
const SCHEMA = {
Xe: { id: "s", type: "s", num: "s", active: "b", createdAt: "d", lastMaintAt: "d", lastMaintBy: "s" },
PhuTung: { id: "s", group: "s", name: "s", unit: "s", threshold: "n", repairable: "b", active: "b", baseTot: "n", baseCho: "n",
baseAt: "d", createdAt: "d", threshTong: "n", baseTong: "n", baseSua: "n" },
PhieuSua: { id: "s", kartId: "s", kartLabel: "s", cat: "s", issue: "s", blocking: "b", reporter: "s", status: "s", createdAt: "d",
startedAt: "d", doneAt: "d", fixer: "s", waitNote: "s", waitAt: "d", result: "s", cancelBy: "s" },
GiaoDich: { id: "s", at: "d", kind: "s", partId: "s", partName: "s", qty: "n", kartId: "s", kartLabel: "s", ticketId: "s", from: "s",
by: "s", note: "s", src: "s", loc: "s", old: "s" },
Checklist: { id: "s", date: "s", at: "d", by: "s", items: "a", note: "s" },
BaoTri: { id: "s", at: "d", kartId: "s", kartLabel: "s", items: "a", by: "s", note: "s" },
XacNhan: { id: "s", at: "d", type: "s", partId: "s", partName: "s", qty: "n", ok: "n", bad: "n", kartId: "s", kartLabel: "s", ticketId: "s",
by: "s", note: "s", status: "s", duyetBy: "s", duyetAt: "d", lyDo: "s" },
PhieuNhap: { id: "s", ngay: "d", createdAt: "d", ncc: "s", soHD: "s", kiemBy: "s", by: "s", note: "s", soDong: "n", tongSL: "n", tongTien: "n",
chiTiet: "s", anh: "a", status: "s", huyBy: "s", huyAt: "d", lyDoHuy: "s" }
};
const PHIEN_BAN = "cf-2026-11-19.1";
const OPEN = ["cho", "dang", "doi"];
const TYPES = { don: "Đơn", doi: "Đôi" };
const q_ = c => '"' + c + '"';
class Loi extends Error {}
function err(msg) { return new Loi(msg); }
/* ---------------- đọc / ghi D1 ---------------- */
function fromDb(name, row) {
const s = SCHEMA[name], o = {};
for (const k in s) {
const v = row[k], t = s[k];
if (t === "d" || t === "n") o[k] = v == null ? 0 : Number(v) || 0;
else if (t === "b") o[k] = v === 1 || v === true || v === "1";
else if (t === "a") { try { o[k] = v ? JSON.parse(v) : []; } catch (e) { o[k] = []; } }
else o[k] = v == null ? "" : String(v);
}
return o;
}
function toDb(t, v) {
if (t === "d") return (typeof v === "number" && v > 0) ? Math.round(v) : null;
if (t === "n") return Number(v) || 0;
if (t === "b") return (v === true || v === "true" || v === 1) ? 1 : 0;
if (t === "a") return JSON.stringify(Array.isArray(v) ? v : (v ? [String(v)] : []));
return v == null ? "" : String(v);
}
class Db {
constructor(env) { this.d = env.DB; this.w = []; }
async all(sql, ...b) { return (await this.d.prepare(sql).bind(...b).all()).results || []; }
async first(sql, ...b) { return await this.d.prepare(sql).bind(...b).first(); }
async rows(name, where, ...b) { return (await this.all("SELECT * FROM " + name + (where ? " WHERE " + where : ""), ...b)).map(r => fromDb(name, r)); }
/* các lệnh ghi được gom lại, chạy một lần (cùng lúc tăng số phiên bản dữ liệu) */
insert(name, objs) {
const cols = Object.keys(SCHEMA[name]);
for (const o of objs) this.w.push(this.d.prepare("INSERT INTO " + name + " (" + cols.map(q_).join(",") + ") VALUES (" + cols.map(() => "?").join(",") + ")")
.bind(...cols.map(c => toDb(SCHEMA[name][c], o[c]))));
}
update(name, id, patch, extraWhere) {
const ks = Object.keys(patch).filter(k => k !== "id" && SCHEMA[name][k]);
if (!ks.length) return;
this.w.push(this.d.prepare("UPDATE " + name + " SET " + ks.map(k => q_(k) + "=?").join(",") + " WHERE id=?" + (extraWhere || ""))
.bind(...ks.map(k => toDb(SCHEMA[name][k], patch[k])), id));
}
raw(sql, ...b) { this.w.push(this.d.prepare(sql).bind(...b)); }
setConfig(patch) { for (const k in patch) this.raw('INSERT INTO CaiDat("key",value) VALUES (?,?) ON CONFLICT("key") DO UPDATE SET value=excluded.value', k, JSON.stringify(patch[k])); }
async commit() {
if (!this.w.length) return [];
this.w.push(this.d.prepare("UPDATE CaiDat SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE \"key\"='_ver'"));
const r = await this.d.batch(this.w); this.w = []; SNAP = null; return r;
}
}
/* ---------------- ảnh chụp dữ liệu hay dùng, giữ trong bộ nhớ tới khi có thay đổi ---------------- */
let SNAP = null;
async function snap(db) {
const v = await db.first("SELECT value FROM CaiDat WHERE \"key\"='_ver'");
const ver = v ? String(v.value) : "0";
if (SNAP && SNAP.ver === ver) return SNAP;
const d = db.d;
const r = await d.batch([
d.prepare('SELECT * FROM CaiDat'),
d.prepare('SELECT * FROM Xe'),
d.prepare('SELECT * FROM PhuTung'),
d.prepare("SELECT * FROM GiaoDich WHERE at > COALESCE((SELECT CAST(value AS INTEGER) FROM CaiDat WHERE \"key\"='closingAt'),0)"),
d.prepare("SELECT * FROM PhieuSua WHERE status IN ('cho','dang','doi') OR id IN (SELECT id FROM PhieuSua ORDER BY createdAt DESC LIMIT 300)"),
d.prepare("SELECT * FROM XacNhan WHERE status='cho'")
]);
const cfg = {};
(r[0].results || []).forEach(x => { try { cfg[x.key] = JSON.parse(x.value); } catch (e) { cfg[x.key] = x.value; } });
SNAP = {
ver: ver, cfg: cfg,
karts: r[1].results.map(x => fromDb("Xe", x)),
parts: r[2].results.map(x => fromDb("PhuTung", x)),
moves: r[3].results.map(x => fromDb("GiaoDich", x)),
tickets: r[4].results.map(x => fromDb("PhieuSua", x)),
pending: r[5].results.map(x => fromDb("XacNhan", x)),
checks: {}
};
return SNAP;
}
/* ---------------- đăng nhập, chống dò PIN ---------------- */
const KHOA = new Map(); // ip -> khóa tới lúc nào (trong bộ nhớ)
async function auth(ctx, pin, need) {
const { db, ip } = ctx;
if ((KHOA.get(ip) || 0) > Date.now()) throw err("Thử sai PIN quá nhiều lần. Đợi 15 phút rồi thử lại.");
const S = await snap(db), c = S.cfg;
const p = String(pin || "").trim();
let role = null;
if (p && p === String(c.adminPin)) role = "admin";
else if (p && c.truongPin && p === String(c.truongPin)) role = "truong";
else if (p && p === String(c.staffPin)) role = "staff";
if (!role) {
const now = Date.now();
await db.d.batch([db.d.prepare("INSERT INTO SaiPin(ip,t) VALUES (?,?)").bind(ip, now), db.d.prepare("DELETE FROM SaiPin WHERE t < ?").bind(now - 86400000)]);
const n = await db.first("SELECT COUNT(*) AS n FROM SaiPin WHERE ip=? AND t>?", ip, now - 900000);
if (n && n.n >= 10) KHOA.set(ip, now + 900000);
throw err("PIN_SAI");
}
if (KHOA.has(ip)) KHOA.delete(ip);
if (need === true && role !== "admin") throw err("Chỉ quản lý mới làm được việc này.");
if (need === "truong" && role === "staff") throw err("Chỉ trưởng bộ phận hoặc quản lý mới làm được việc này.");
return role;
}
/* ---------------- tiện ích ---------------- */
function uid_() { return crypto.randomUUID().replace(/-/g, "").slice(0, 12); }
function str_(v, max) { return String(v == null ? "" : v).slice(0, max || 500); }
function name_(v) { const s = str_(v, 60).trim(); if (!s) throw err("Thiếu tên người thực hiện."); return s; }
function kartLabel_(id, karts) { const k = karts.find(x => x.id === id); return k ? (TYPES[k.type] || k.type) + " " + k.num : ""; }
function slug_(s) {
return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D")
.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "x";
}
const byAtDesc = (a, b) => b.at - a.at;
/* ---------------- tồn kho ---------------- */
function applyMove_(a, m) {
const q = Number(m.qty) || 0;
switch (m.kind) {
case "nhap": a.tong += q; break;
case "cap": a.tong -= q; a.moi += q; break;
case "xuat": if (m.src === "sua") a.sua -= q; else a.moi -= q; break;
case "gom_sua": a.cho += q; break;
case "nhap_sau_sua": a.cho -= q; a.sua += q; break;
case "huy": { const l = m.loc || (m.from === "tot" ? "moi" : "cho"); a[l] -= q; break; }
case "dieu_chinh": { const l = m.loc || "moi"; a[l] += q; break; }
}
}
function base_(p) { return { tong: p.baseTong || 0, moi: p.baseTot || 0, sua: p.baseSua || 0, cho: p.baseCho || 0, at: p.baseAt || 0 }; }
function balances_(parts, moves, T) {
const st = {};
parts.forEach(p => st[p.id] = base_(p));
moves.forEach(m => { const a = st[m.partId]; if (a && m.at > a.at && m.at <= T) applyMove_(a, m); });
return st;
}
/* ================= các chức năng gọi từ app ================= */
const API = {
async login(ctx, pin) { return auth(ctx, pin); },
async phienBan() { return PHIEN_BAN; },
async getAll(ctx, pin, today, known) {
const role = await auth(ctx, pin);
const S = await snap(ctx.db);
const key = S.ver + "|" + String(today || "");
if (known && known === key) return { same: true, role: role, ver: key, serverTime: Date.now() };
if (!S.checks[today]) S.checks[today] = await ctx.db.rows("Checklist", "date=?", String(today || ""));
const c = S.cfg;
return {
role: role, ver: key,
config: { closingAt: Number(c.closingAt) || 0, maintDays: c.maintDays || 7, dailyItems: c.dailyItems || null, maintItems: c.maintItems || null, appUrl: "" },
karts: S.karts,
parts: S.parts.map(p => Object.assign({}, p, { base: { tong: p.baseTong, moi: p.baseTot, sua: p.baseSua, cho: p.baseCho, at: p.baseAt } })),
tOpen: S.tickets.filter(t => OPEN.includes(t.status)),
tRecent: S.tickets.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 300),
moves: S.moves.slice().sort(byAtDesc),
checks: S.checks[today],
pending: S.pending,
serverTime: Date.now()
};
},
async getHistory(ctx, pin, from, to) {
await auth(ctx, pin);
from = Number(from) || 0; to = Number(to) || 0;
const [m, t] = await Promise.all([
ctx.db.rows("GiaoDich", "at>=? AND at<? ORDER BY at DESC", from, to),
ctx.db.rows("PhieuSua", "createdAt>=? AND createdAt<? ORDER BY createdAt DESC", from, to)]);
return { moves: m, tickets: t };
},
async kartHistory(ctx, pin, kartId) {
await auth(ctx, pin);
const [m, t] = await Promise.all([
ctx.db.rows("GiaoDich", "kartId=? ORDER BY at DESC LIMIT 100", String(kartId)),
ctx.db.rows("PhieuSua", "kartId=? ORDER BY createdAt DESC LIMIT 50", String(kartId))]);
return { moves: m, tickets: t };
},
async addTicket(ctx, pin, t) {
await auth(ctx, pin);
const S = await snap(ctx.db);
const o = { id: "P" + uid_(), kartId: str_(t.kartId, 40), kartLabel: kartLabel_(t.kartId, S.karts), cat: str_(t.cat, 60), issue: str_(t.issue),
blocking: t.blocking !== false, reporter: name_(t.reporter), status: "cho", createdAt: Date.now() };
if (!o.kartId || !o.issue) throw err("Thiếu xe hoặc mô tả lỗi.");
ctx.db.insert("PhieuSua", [o]); await ctx.db.commit();
return o.id;
},
async updateTicket(ctx, pin, id, patch) {
await auth(ctx, pin);
const allowed = ["status", "startedAt", "doneAt", "fixer", "waitNote", "waitAt", "result", "cancelBy"];
const p = {};
allowed.forEach(k => { if (patch[k] !== undefined) p[k] = (k.slice(-2) === "At") ? Date.now() : str_(patch[k]); });
if (p.status && !["cho", "dang", "doi", "xong", "huy"].includes(p.status)) throw err("Trạng thái không hợp lệ.");
ctx.db.update("PhieuSua", String(id), p);
const r = await ctx.db.commit();
if (r.length && r[0].meta.changes === 0) throw err("Không tìm thấy phiếu sửa.");
return true;
},
async addMoves(ctx, pin, list) {
const role = await auth(ctx, pin);
return addMoves_(ctx, role, list);
},
async submitKtra(ctx, pin, k) {
const role = await auth(ctx, pin);
const ok = Number(k.ok) || 0, bad = Number(k.bad) || 0;
if (ok < 0 || bad < 0 || ok + bad <= 0 || Math.floor(ok) !== ok || Math.floor(bad) !== bad) throw err("Số lượng không hợp lệ.");
if (role === "staff") throw err("Chỉ trưởng bộ phận hoặc quản lý ghi kết quả kiểm tra hàng hư.");
const list = [];
if (ok) list.push({ kind: "nhap_sau_sua", partId: k.partId, qty: ok, by: k.by, note: k.note || "Thợ kiểm tra: sửa được" });
if (bad) list.push({ kind: "huy", loc: "cho", partId: k.partId, qty: bad, by: k.by, note: k.note || "Thợ kiểm tra: không sửa được" });
return addMoves_(ctx, role, list);
},
async approvePending(ctx, pin, id, fix, by) {
await auth(ctx, pin, "truong");
const who = name_(by);
const x = (await ctx.db.rows("XacNhan", "id=?", String(id)))[0];
if (!x) throw err("Không tìm thấy yêu cầu.");
if (x.status !== "cho") throw err("Yêu cầu này đã được xử lý.");
const now = Date.now(); const rows = [];
const base = { partId: x.partId, partName: x.partName, kartId: x.kartId, kartLabel: x.kartLabel, ticketId: x.ticketId, from: "", src: "", old: "", by: x.by };
const tag = " (xác nhận: " + who + ")";
let patch;
if (x.type === "gom") {
const q = fix && fix.qty !== undefined ? Number(fix.qty) : x.qty;
if (!(q >= 0) || Math.floor(q) !== q) throw err("Số lượng không hợp lệ.");
if (q > 0) rows.push(Object.assign({}, base, { id: "G" + uid_(), at: now, kind: "gom_sua", qty: q, loc: "", note: (x.note || "Gom hàng hư") + tag }));
patch = { status: "duyet", duyetBy: who, duyetAt: now, qty: q };
} else {
const ok = fix && fix.ok !== undefined ? Number(fix.ok) : x.ok, bad = fix && fix.bad !== undefined ? Number(fix.bad) : x.bad;
if (!(ok >= 0 && bad >= 0) || Math.floor(ok) !== ok || Math.floor(bad) !== bad) throw err("Số lượng không hợp lệ.");
if (ok > 0) rows.push(Object.assign({}, base, { id: "G" + uid_(), at: now, kind: "nhap_sau_sua", qty: ok, loc: "", note: (x.note || "Thợ kiểm tra: sửa được") + tag }));
if (bad > 0) rows.push(Object.assign({}, base, { id: "G" + uid_(), at: now + 1, kind: "huy", qty: bad, loc: "cho", note: (x.note || "Thợ kiểm tra: không sửa được") + tag }));
patch = { status: "duyet", duyetBy: who, duyetAt: now, ok: ok, bad: bad };
}
// Đổi trạng thái trước, chỉ khi vẫn đang "chờ": hai người bấm cùng lúc thì chỉ một người được ghi kho
ctx.db.update("XacNhan", String(id), patch, " AND status='cho'");
const r = await ctx.db.commit();
if (r[0].meta.changes === 0) throw err("Yêu cầu này đã được xử lý.");
ctx.db.insert("GiaoDich", rows); await ctx.db.commit();
return rows.length;
},
async rejectPending(ctx, pin, id, lyDo, by) {
await auth(ctx, pin, "truong");
const who = name_(by);
if (!String(lyDo || "").trim()) throw err("Ghi lý do từ chối.");
ctx.db.update("XacNhan", String(id), { status: "tuchoi", duyetBy: who, duyetAt: Date.now(), lyDo: str_(lyDo) }, " AND status='cho'");
const r = await ctx.db.commit();
if (r[0].meta.changes === 0) throw err("Yêu cầu này đã được xử lý.");
return true;
},
async addCheck(ctx, pin, c) {
await auth(ctx, pin);
ctx.db.insert("Checklist", [{ id: "C" + uid_(), date: str_(c.date, 10), at: Date.now(), by: name_(c.by), items: (c.items || []).map(x => str_(x, 120)), note: str_(c.note) }]);
await ctx.db.commit(); return true;
},
async addMaint(ctx, pin, m) {
await auth(ctx, pin);
const S = await snap(ctx.db);
const now = Date.now(), by = name_(m.by), kid = str_(m.kartId, 40);
if (!S.karts.some(k => k.id === kid)) throw err("Không tìm thấy xe.");
ctx.db.insert("BaoTri", [{ id: "B" + uid_(), at: now, kartId: kid, kartLabel: kartLabel_(kid, S.karts), items: (m.items || []).map(x => str_(x, 120)), by: by, note: str_(m.note) }]);
ctx.db.update("Xe", kid, { lastMaintAt: now, lastMaintBy: by });
await ctx.db.commit(); return true;
},
/* ----- quản lý ----- */
async addKarts(ctx, pin, type, nums) {
await auth(ctx, pin, true);
if (!TYPES[type]) throw err("Loại xe không hợp lệ.");
const S = await snap(ctx.db);
const have = {}; S.karts.forEach(k => have[k.id] = 1);
const rows = [];
(nums || []).forEach(n => {
n = String(n).trim();
if (!/^[0-9A-Za-z]{1,8}$/.test(n)) return;
const id = type + "-" + n.toLowerCase();
if (have[id]) return; have[id] = 1;
rows.push({ id: id, type: type, num: n, active: true, createdAt: Date.now() });
});
ctx.db.insert("Xe", rows); await ctx.db.commit();
return rows.length;
},
async updateKart(ctx, pin, id, patch) {
await auth(ctx, pin, true);
ctx.db.update("Xe", String(id), { active: patch.active !== false }); await ctx.db.commit(); return true;
},
async deleteKart(ctx, pin, id) {
await auth(ctx, pin, true);
const a = await ctx.db.first("SELECT (SELECT COUNT(*) FROM PhieuSua WHERE kartId=?1) + (SELECT COUNT(*) FROM GiaoDich WHERE kartId=?1) AS n", String(id));
if (a && a.n > 0) throw err("Xe đã có lịch sử sửa chữa nên không xóa được. Hãy chọn Ngưng dùng.");
ctx.db.raw("DELETE FROM Xe WHERE id=?", String(id)); await ctx.db.commit(); return true;
},
async savePart(ctx, pin, id, d) {
await auth(ctx, pin, true);
const data = { group: str_(d.group, 80) || "Khác", name: str_(d.name, 120), unit: str_(d.unit, 20) || "Cái", threshold: Math.max(0, Number(d.threshold) || 0),
threshTong: Math.max(0, Number(d.threshTong) || 0), repairable: false, active: d.active !== false };
if (!data.name) throw err("Thiếu tên phụ tùng.");
if (id) { ctx.db.update("PhuTung", String(id), data); await ctx.db.commit(); return id; }
const S = await snap(ctx.db);
const have = {}; S.parts.forEach(p => have[p.id] = 1);
let nid = slug_(data.group + "-" + data.name); while (have[nid]) nid += "-2";
const now = Date.now();
ctx.db.insert("PhuTung", [Object.assign({ id: nid, baseTong: 0, baseTot: 0, baseSua: 0, baseCho: 0, baseAt: now, createdAt: now }, data)]);
await ctx.db.commit(); return nid;
},
async hidePart(ctx, pin, id) {
await auth(ctx, pin, true);
ctx.db.update("PhuTung", String(id), { active: false }); await ctx.db.commit(); return true;
},
async importParts(ctx, pin, rows) {
await auth(ctx, pin, true);
const S = await snap(ctx.db);
const exist = {}; S.parts.forEach(p => exist[p.id] = p);
const now = Date.now(); const add = []; let upd = 0; const seen = {};
(rows || []).forEach(r => {
const id = slug_(r.group + "-" + r.name);
const data = { group: str_(r.group, 80) || "Khác", name: str_(r.name, 120), unit: str_(r.unit, 20) || "Cái", threshold: Number(r.threshold) || 0,
threshTong: Number(r.threshTong) || 0, repairable: false, active: true, baseTong: Number(r.tong) || 0, baseTot: Number(r.tot) || 0,
baseSua: Number(r.sua) || 0, baseCho: Number(r.cho) || 0, baseAt: now };
if (!data.name || seen[id]) return; seen[id] = 1;
if (exist[id]) { ctx.db.update("PhuTung", id, data); upd++; }
else add.push(Object.assign({ id: id, createdAt: now }, data));
});
ctx.db.insert("PhuTung", add); await ctx.db.commit();
return { added: add.length, updated: upd };
},
async saveConfig(ctx, pin, patch) {
await auth(ctx, pin, true);
const p = {};
if (Array.isArray(patch.dailyItems)) p.dailyItems = patch.dailyItems.map(x => str_(x, 120)).filter(Boolean);
if (Array.isArray(patch.maintItems)) p.maintItems = patch.maintItems.map(x => str_(x, 120)).filter(Boolean);
if (patch.maintDays) p.maintDays = Math.max(1, Number(patch.maintDays) || 7);
ctx.db.setConfig(p); await ctx.db.commit(); return true;
},
async closeBook(ctx, pin) {
await auth(ctx, pin, true);
const S = await snap(ctx.db);
const T = Date.now();
const st = balances_(S.parts, S.moves, T);
S.parts.forEach(p => { const a = st[p.id]; ctx.db.update("PhuTung", p.id, { baseTong: a.tong, baseTot: a.moi, baseSua: a.sua, baseCho: a.cho, baseAt: T }); });
ctx.db.setConfig({ closingAt: T });
await ctx.db.commit();
return S.parts.length;
},
/** Tồn kho hiện tại của mọi vật tư, tính trên máy chủ (để đối chiếu với app). */
async tonKho(ctx, pin) {
await auth(ctx, pin, "truong");
const S = await snap(ctx.db);
return balances_(S.parts, S.moves, Date.now() + 1000);
},
/** Nạp kiểm kê từ file (app đọc file, gửi các dòng lên). mode "dat": đặt số đầu kỳ; "kiemke": kiểm kê định kỳ. */
async importKiemKe(ctx, pin, mode, by, table) {
const role = await auth(ctx, pin, "truong");
if (mode === "dat" && role !== "admin") throw err("Chỉ quản lý mới đặt số đầu kỳ.");
return napKiemKe_(ctx, mode === "dat" ? "dat" : "kiemke", name_(by), role === "admin", docBangKiemKe_(table));
},
async doiChieu(ctx, pin, from, to) {
await auth(ctx, pin, true);
from = Number(from) || 0; to = Number(to) || 0;
const S = await snap(ctx.db);
const parts = S.parts.filter(p => p.active);
const s0 = balances_(parts, S.moves, from - 1), s1 = balances_(parts, S.moves, to - 1);
const inPeriod = await ctx.db.rows("GiaoDich", "at>=? AND at<?", from, to);
const z = () => ({ nhap: 0, cap: 0, xuatMoi: 0, xuatSua: 0, gom: 0, bo: 0, suaDuoc: 0, huyCho: 0, huyMoi: 0, huySua: 0, huyTong: 0, dcTong: 0, dcMoi: 0, dcSua: 0, dcCho: 0 });
const agg = {}; parts.forEach(p => agg[p.id] = z());
inPeriod.forEach(m => {
const a = agg[m.partId]; if (!a) return;
const q = Number(m.qty) || 0, l = m.loc || (m.kind === "huy" ? (m.from === "tot" ? "moi" : "cho") : "moi");
if (m.kind === "nhap") a.nhap += q;
else if (m.kind === "cap") a.cap += q;
else if (m.kind === "xuat") { if (m.src === "sua") a.xuatSua += q; else a.xuatMoi += q; if (m.old === "bo") a.bo += q; }
else if (m.kind === "gom_sua") a.gom += q;
else if (m.kind === "nhap_sau_sua") a.suaDuoc += q;
else if (m.kind === "huy") a["huy" + l.charAt(0).toUpperCase() + l.slice(1)] += q;
else if (m.kind === "dieu_chinh") a["dc" + l.charAt(0).toUpperCase() + l.slice(1)] += q;
});
return parts.map(p => ({ id: p.id, group: p.group, name: p.name, unit: p.unit, threshold: p.threshold, threshTong: p.threshTong,
start: s0[p.id], end: s1[p.id], a: agg[p.id], baseInPeriod: (p.baseAt || 0) >= from && (p.baseAt || 0) < to }));
},
/* ----- phiếu nhập hàng ----- */
async taoPhieuNhap(ctx, pin, ph) {
await auth(ctx, pin, true);
const by = name_(ph.by);
const lines = Array.isArray(ph.items) ? ph.items : [];
if (!lines.length) throw err("Phiếu chưa có dòng vật tư nào.");
if (lines.length > 100) throw err("Tối đa 100 dòng một phiếu.");
const ngay = Number(ph.ngay) || Date.now();
const S = await snap(ctx.db);
const have = {}; S.parts.forEach(p => have[p.id] = p);
const now = Date.now(); const newParts = []; const items = [];
lines.forEach((l, i) => {
const qty = Number(l.qty), price = Math.max(0, Number(l.price) || 0);
if (!isFinite(qty) || Math.floor(qty) !== qty || qty <= 0) throw err("Dòng " + (i + 1) + ": số lượng không hợp lệ.");
let pid = str_(l.partId, 120);
if (!pid) {
const name = str_(l.newName, 120).trim(); if (!name) throw err("Dòng " + (i + 1) + ": chưa chọn vật tư.");
const group = str_(l.newGroup, 80).trim() || "Khác";
pid = slug_(group + "-" + name);
if (!have[pid]) {
const np = { id: pid, group: group, name: name, unit: str_(l.newUnit, 20) || "Cái", threshold: 0, threshTong: 0, repairable: false, active: true,
baseTong: 0, baseTot: 0, baseSua: 0, baseCho: 0, baseAt: now - 1, createdAt: now, _new: true };
newParts.push(np); have[pid] = np;
}
}
const p = have[pid]; if (!p) throw err("Dòng " + (i + 1) + ": vật tư không tồn tại.");
if (p.active === false) ctx.db.update("PhuTung", pid, { active: true });
items.push({ partId: pid, name: p.name, group: p.group, unit: p.unit || "", qty: qty, price: price, tien: qty * price });
});
const d = new Date(ngay + 7 * 3600000); // ngày theo giờ Việt Nam
const tag = "PN" + String(d.getUTCFullYear()).slice(2) + ("0" + (d.getUTCMonth() + 1)).slice(-2) + ("0" + d.getUTCDate()).slice(-2);
const last = await ctx.db.all("SELECT id FROM PhieuNhap WHERE id LIKE ?", tag + "-%");
let n = 1; last.forEach(r => { n = Math.max(n, Number(String(r.id).split("-")[1]) + 1); });
const id = tag + "-" + ("0" + n).slice(-2);
ctx.db.insert("PhuTung", newParts);
const note = "Phiếu nhập " + id + (ph.ncc ? " · " + str_(ph.ncc, 100) : "") + (ph.soHD ? " · HĐ " + str_(ph.soHD, 60) : "");
ctx.db.insert("GiaoDich", items.map((it, i) => ({ id: "G" + uid_(), at: now + i, kind: "nhap", partId: it.partId, partName: it.name, qty: it.qty,
kartId: "", kartLabel: "", ticketId: id, from: "", by: by, note: note, src: "", loc: "", old: "" })));
ctx.db.insert("PhieuNhap", [{ id: id, ngay: ngay, createdAt: now, ncc: str_(ph.ncc, 100), soHD: str_(ph.soHD, 60), kiemBy: str_(ph.kiemBy, 60), by: by, note: str_(ph.note),
soDong: items.length, tongSL: items.reduce((a, x) => a + x.qty, 0), tongTien: items.reduce((a, x) => a + x.tien, 0),
chiTiet: JSON.stringify(items), anh: [], status: "ok" }]);
await ctx.db.commit();
return { id: id, newParts: newParts.length, images: 0 };
},
async dsPhieuNhap(ctx, pin, from, to) {
await auth(ctx, pin, "truong");
return (await ctx.db.rows("PhieuNhap", "ngay>=? AND ngay<? ORDER BY ngay DESC, createdAt DESC", Number(from) || 0, Number(to) || 0)).map(phieu_);
},
async huyPhieuNhap(ctx, pin, id, lyDo, by) {
await auth(ctx, pin, true);
const who = name_(by); const why = str_(lyDo, 200).trim();
if (!why) throw err("Ghi lý do hủy phiếu.");
const p = (await ctx.db.rows("PhieuNhap", "id=?", String(id)))[0];
if (!p) throw err("Không tìm thấy phiếu " + id + ".");
if (p.status === "huy") throw err("Phiếu này đã hủy trước đó.");
const now = Date.now();
ctx.db.update("PhieuNhap", p.id, { status: "huy", huyBy: who, huyAt: now, lyDoHuy: why }, " AND status<>'huy'");
const r = await ctx.db.commit();
if (r[0].meta.changes === 0) throw err("Phiếu này đã hủy trước đó.");
ctx.db.insert("GiaoDich", phieu_(p).items.map((it, i) => ({ id: "G" + uid_(), at: now + i, kind: "nhap", partId: it.partId, partName: it.name, qty: -it.qty,
kartId: "", kartLabel: "", ticketId: p.id, from: "", by: who, note: "Hủy phiếu nhập " + p.id + ": " + why, src: "", loc: "", old: "" })));
await ctx.db.commit();
return true;
},
/** Toàn bộ dữ liệu (quản lý): tải bản sao lưu về máy / chép sang Google Sheet. */
async saoLuuToanBo(ctx, pin) {
await auth(ctx, pin, true);
const out = {};
for (const name of Object.keys(SCHEMA)) out[name] = await ctx.db.rows(name, "1=1 ORDER BY rowid");
const cfg = await ctx.db.all("SELECT * FROM CaiDat WHERE \"key\" NOT LIKE '%Pin' AND \"key\" NOT LIKE '\\_%' ESCAPE '\\'");
out.CaiDat = cfg;
out.taoLuc = Date.now();
return out;
}
};
function phieu_(p) { const o = Object.assign({}, p); try { o.items = JSON.parse(o.chiTiet || "[]"); } catch (e) { o.items = []; } delete o.chiTiet; return o; }
const KINDS = ["nhap", "cap", "xuat", "gom_sua", "nhap_sau_sua", "huy", "dieu_chinh"];
const LOCS = ["tong", "moi", "sua", "cho"];
async function addMoves_(ctx, role, list) {
const S = await snap(ctx.db);
const karts = S.karts, parts = S.parts;
const now = Date.now();
if (!Array.isArray(list) || !list.length) throw err("Chưa có dòng nào.");
const rows = list.map((m, i) => {
const kind = str_(m.kind, 20);
if (!KINDS.includes(kind)) throw err("Loại giao dịch không hợp lệ.");
const loc = LOCS.includes(m.loc) ? m.loc : (kind === "huy" ? "cho" : "");
if (kind === "nhap" && role !== "admin") throw err("Chỉ quản lý mới nhập hàng mua vào kho tổng.");
if (kind === "cap" && role === "staff") throw err("Chỉ trưởng bộ phận hoặc quản lý mới cấp hàng từ kho tổng.");
if (kind === "dieu_chinh" && loc === "tong" && role !== "admin") throw err("Chỉ quản lý mới kiểm kê kho tổng.");
if (kind === "dieu_chinh" && role === "staff") throw err("Chỉ trưởng bộ phận hoặc quản lý mới kiểm kê.");
if (kind === "huy" && loc === "tong" && role === "staff") throw err("Nhân viên không hủy hàng kho tổng.");
if (kind === "dieu_chinh" && !loc) throw err("Thiếu vị trí kiểm kê.");
if (role === "staff" && (kind === "nhap_sau_sua" || (kind === "huy" && loc === "cho"))) throw err("Kết quả kiểm tra hàng hư phải gửi qua mục Thợ kiểm tra để trưởng bộ phận xác nhận.");
const qty = Number(m.qty);
if (!isFinite(qty) || Math.floor(qty) !== qty || (kind !== "dieu_chinh" && qty <= 0)) throw err("Số lượng không hợp lệ.");
const part = parts.find(p => p.id === m.partId);
if (!part) throw err("Phụ tùng không tồn tại.");
return {
id: "G" + uid_(), at: now + i, kind: kind, partId: m.partId, partName: part.name, qty: qty,
kartId: str_(m.kartId, 40), kartLabel: m.kartId ? kartLabel_(m.kartId, karts) : "", ticketId: str_(m.ticketId, 40),
from: "", by: name_(m.by), note: str_(m.note),
src: kind === "xuat" ? (m.src === "sua" ? "sua" : "moi") : "", loc: (kind === "huy" || kind === "dieu_chinh") ? loc : "",
old: kind === "xuat" ? (m.old === "bo" ? "bo" : m.old === "gom" ? "gom" : "") : ""
};
});
const pend = [], direct = [];
rows.forEach(r => { if (r.kind === "gom_sua" && role === "staff") pend.push(r); else direct.push(r); });
ctx.db.insert("GiaoDich", direct);
ctx.db.insert("XacNhan", pend.map(r => ({ id: "X" + uid_(), at: r.at, type: "gom", partId: r.partId, partName: r.partName, qty: r.qty, ok: 0, bad: 0,
kartId: r.kartId, kartLabel: r.kartLabel, ticketId: r.ticketId, by: r.by, note: r.note, status: "cho" })));
await ctx.db.commit();
return { moves: direct.length, pending: pend.length };
}
/* ----- kiểm kê từ file: app gửi bảng (mảng các dòng), máy chủ tự tìm dòng tiêu đề ----- */
function docBangKiemKe_(v) {
if (!Array.isArray(v) || !v.length) throw err("File kiểm kê trống.");
const norm = x => String(x == null ? "" : x).trim().toLowerCase().normalize("NFC");
let h = -1;
for (let i = 0; i < Math.min(v.length, 10); i++) if ((v[i] || []).some(c => norm(c) === "tên vật tư")) { h = i; break; }
if (h < 0) throw err("Không thấy dòng tiêu đề có cột \"Tên vật tư\" trong file.");
const heads = v[h].map(x => norm(x).replace(/\s*\?$/, ""));
const rows = v.slice(h + 1).map(r => { const o = {}; heads.forEach((k, j) => { if (k) o[k] = (r || [])[j]; }); return o; });
const get = (r, prefix) => { const k = Object.keys(r).find(x => x.indexOf(prefix) === 0); return k ? r[k] : ""; };
const num = x => { if (x === null || x === undefined || String(x).trim() === "") return null; const n = Number(String(x).replace(/[^\d.-]/g, "")); return isFinite(n) ? Math.max(0, n) : null; };
const list = [];
rows.forEach(r => {
const name = String(get(r, "tên vật tư") || "").trim();
if (!name) return;
list.push({
group: String(get(r, "nhóm") || "").trim() || "Khác", name: name, unit: String(get(r, "đơn vị") || "").trim() || "Cái",
threshold: num(get(r, "ngưỡng kệ xưởng")) || 0, threshTong: num(get(r, "ngưỡng kho tổng")) || 0,
tong: num(get(r, "tồn kho tổng")), moi: num(get(r, "kệ xưởng – hàng mới")), sua: num(get(r, "kệ xưởng – hàng đã sửa")), cho: num(get(r, "hư chờ kiểm tra"))
});
});
if (!list.length) throw err("File kiểm kê chưa có dòng vật tư nào.");
if (list.length > 1000) throw err("File quá nhiều dòng.");
return list;
}
async function napKiemKe_(ctx, mode, by, allowTong, list) {
const S = await snap(ctx.db);
const now = Date.now();
const keep = {}; list.forEach(x => keep[slug_(x.group + "-" + x.name)] = 1);
let added = 0, updated = 0, hidden = 0;
const dup = [], diffs = [], add = [], seen = {};
const exist = {}; S.parts.forEach(p => exist[p.id] = p);
const st = balances_(S.parts, S.moves, now);
list.forEach(x => {
const id = slug_(x.group + "-" + x.name);
const info = { group: x.group, name: x.name, unit: x.unit, threshold: x.threshold, threshTong: x.threshTong, active: true, repairable: false };
if (seen[id]) { dup.push(x.name); return; }
seen[id] = 1;
const p = exist[id];
if (!p) {
add.push(Object.assign({ id: id, createdAt: now, baseAt: now, baseTong: x.tong || 0, baseTot: x.moi || 0, baseSua: x.sua || 0, baseCho: x.cho || 0 }, info));
added++; return;
}
let o = Object.assign({}, info);
if (mode === "dat") o = Object.assign(o, { baseTong: x.tong || 0, baseTot: x.moi || 0, baseSua: x.sua || 0, baseCho: x.cho || 0, baseAt: now });
else {
const cur = st[id];
[["tong", "tong"], ["moi", "moi"], ["sua", "sua"], ["cho", "cho"]].forEach(([k, loc]) => {
if (x[k] === null) return;
if (loc === "tong" && !allowTong) return;
const d = x[k] - cur[loc];
if (d !== 0) diffs.push({ id: "G" + uid_(), at: now + diffs.length, kind: "dieu_chinh", partId: id, partName: x.name, qty: d, kartId: "", kartLabel: "", ticketId: "", from: "", by: by, note: "Kiểm kê theo file: sổ " + cur[loc] + " → đếm " + x[k], src: "", loc: loc, old: "" });
});
}
ctx.db.update("PhuTung", id, o);
updated++;
});
S.parts.forEach(p => { if (!keep[p.id] && p.active) { ctx.db.update("PhuTung", p.id, { active: false }); hidden++; } });
ctx.db.insert("PhuTung", add);
ctx.db.insert("GiaoDich", diffs);
await ctx.db.commit();
return (mode === "dat" ? "Đã đặt số đầu kỳ cho " : "Đã kiểm kê ") + list.length + " vật tư (" + added + " mới, " + updated + " cập nhật)." +
(mode === "kiemke" ? " Ghi " + diffs.length + " dòng chênh lệch." : "") + (hidden ? " Ẩn " + hidden + " vật tư không còn trong file." : "") + (dup.length ? " Bỏ qua dòng trùng: " + dup.join(", ") + "." : "");
}
/* ---------------- chống lệnh trùng (bấm đúp, mạng gửi lại) ---------------- */
const GHI = ["addTicket", "updateTicket", "addMoves", "submitKtra", "approvePending", "rejectPending", "addCheck", "addMaint", "addKarts",
"updateKart", "deleteKart", "savePart", "hidePart", "importParts", "saveConfig", "closeBook", "importKiemKe", "taoPhieuNhap", "huyPhieuNhap"];
async function opBatDau(db, op) {
for (let i = 0; i < 40; i++) {
const r = await db.d.prepare("INSERT OR IGNORE INTO Ops(op,s,t) VALUES (?,'run',?)").bind(op, Date.now()).run();
if (r.meta.changes === 1) return null;
const cur = await db.first("SELECT s, d FROM Ops WHERE op=?", op);
if (cur && cur.s === "done") return { ok: true, data: cur.d ? JSON.parse(cur.d) : null };
if (!cur) continue;
await new Promise(res => setTimeout(res, 400)); // lệnh trùng đang chạy: đợi lệnh đầu xong rồi trả cùng kết quả
}
throw err("Lệnh trước chưa xong, thử lại sau ít giây.");
}
async function opKetThuc(db, op, data, ok) {
if (ok) await db.d.prepare("UPDATE Ops SET s='done', d=? WHERE op=?").bind(JSON.stringify(data === undefined ? null : data), op).run();
else await db.d.prepare("DELETE FROM Ops WHERE op=?").bind(op).run();
if (Math.random() < 0.05) await db.d.prepare("DELETE FROM Ops WHERE t < ?").bind(Date.now() - 86400000).run();
}
/* ---------------- cổng vào ---------------- */
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const json = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, CORS) });
export default {
async fetch(request, env) {
if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
if (request.method !== "POST") return json({ ok: true, app: "Xưởng Gokart Puppy Farm", note: "Máy chủ dữ liệu. Mở app tại trang GitHub." });
const db = new Db(env);
const ctx = { db: db, ip: request.headers.get("CF-Connecting-IP") || "?" };
let op = "";
try {
const body = await request.text();
if (body.length > 2000000) throw err("Dữ liệu gửi lên quá lớn.");
const req = JSON.parse(body || "{}");
const f = Object.prototype.hasOwnProperty.call(API, req.fn) ? API[req.fn] : null;
if (!f) throw err("Chức năng không hợp lệ.");
op = GHI.includes(req.fn) && /^[a-z0-9]{6,30}:[A-Za-z]+$/.test(String(req.op || "")) ? String(req.op) : "";
if (op) { const prev = await opBatDau(db, op); if (prev) return json(prev); }
const r = await f(ctx, ...(Array.isArray(req.args) ? req.args : []));
if (op) await opKetThuc(db, op, r, true);
return json({ ok: true, data: r === undefined ? null : r });
} catch (e) {
if (op) { try { await opKetThuc(db, op, null, false); } catch (x) {} }
const msg = e instanceof Loi ? e.message : "Lỗi máy chủ: " + String((e && e.message) || e);
return json({ ok: false, error: msg });
}
}
};
