-- Xưởng Gokart Puppy Farm: cơ sở dữ liệu Cloudflare D1
-- d = thời gian (mili-giây), b = 0/1, a = danh sách JSON
CREATE TABLE IF NOT EXISTS Xe (id TEXT PRIMARY KEY, "type" TEXT, num TEXT, active INTEGER, createdAt INTEGER, lastMaintAt INTEGER, lastMaintBy TEXT);
CREATE TABLE IF NOT EXISTS PhuTung (id TEXT PRIMARY KEY, "group" TEXT, name TEXT, unit TEXT, threshold REAL, repairable INTEGER, active INTEGER,
  baseTot REAL, baseCho REAL, baseAt INTEGER, createdAt INTEGER, threshTong REAL, baseTong REAL, baseSua REAL);
CREATE TABLE IF NOT EXISTS PhieuSua (id TEXT PRIMARY KEY, kartId TEXT, kartLabel TEXT, cat TEXT, issue TEXT, blocking INTEGER, reporter TEXT, status TEXT,
  createdAt INTEGER, startedAt INTEGER, doneAt INTEGER, fixer TEXT, waitNote TEXT, waitAt INTEGER, result TEXT, cancelBy TEXT);
CREATE INDEX IF NOT EXISTS ps_status ON PhieuSua(status);
CREATE INDEX IF NOT EXISTS ps_created ON PhieuSua(createdAt);
CREATE INDEX IF NOT EXISTS ps_kart ON PhieuSua(kartId);
CREATE TABLE IF NOT EXISTS GiaoDich (id TEXT PRIMARY KEY, at INTEGER, kind TEXT, partId TEXT, partName TEXT, qty REAL, kartId TEXT, kartLabel TEXT,
  ticketId TEXT, "from" TEXT, "by" TEXT, note TEXT, src TEXT, loc TEXT, old TEXT);
CREATE INDEX IF NOT EXISTS gd_at ON GiaoDich(at);
CREATE INDEX IF NOT EXISTS gd_kart ON GiaoDich(kartId);
CREATE TABLE IF NOT EXISTS Checklist (id TEXT PRIMARY KEY, date TEXT, at INTEGER, "by" TEXT, items TEXT, note TEXT);
CREATE INDEX IF NOT EXISTS ck_date ON Checklist(date);
CREATE TABLE IF NOT EXISTS BaoTri (id TEXT PRIMARY KEY, at INTEGER, kartId TEXT, kartLabel TEXT, items TEXT, "by" TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS XacNhan (id TEXT PRIMARY KEY, at INTEGER, "type" TEXT, partId TEXT, partName TEXT, qty REAL, ok REAL, bad REAL, kartId TEXT,
  kartLabel TEXT, ticketId TEXT, "by" TEXT, note TEXT, status TEXT, duyetBy TEXT, duyetAt INTEGER, lyDo TEXT);
CREATE INDEX IF NOT EXISTS xn_status ON XacNhan(status);
CREATE TABLE IF NOT EXISTS PhieuNhap (id TEXT PRIMARY KEY, ngay INTEGER, createdAt INTEGER, ncc TEXT, soHD TEXT, kiemBy TEXT, "by" TEXT, note TEXT,
  soDong REAL, tongSL REAL, tongTien REAL, chiTiet TEXT, anh TEXT, status TEXT, huyBy TEXT, huyAt INTEGER, lyDoHuy TEXT);
CREATE INDEX IF NOT EXISTS pn_ngay ON PhieuNhap(ngay);
CREATE TABLE IF NOT EXISTS CaiDat ("key" TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS Ops (op TEXT PRIMARY KEY, s TEXT, d TEXT, t INTEGER);
CREATE TABLE IF NOT EXISTS SaiPin (ip TEXT, t INTEGER);
CREATE INDEX IF NOT EXISTS sp_ip ON SaiPin(ip, t);
INSERT OR IGNORE INTO CaiDat("key", value) VALUES ('_ver', '1');
