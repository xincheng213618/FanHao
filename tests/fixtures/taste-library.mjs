import { DatabaseSync } from "node:sqlite";

export function seedTasteLibrary(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE works (id INTEGER PRIMARY KEY, code TEXT, title TEXT, raw_text TEXT, fields_json TEXT, javdb_tags_json TEXT);
    CREATE TABLE local_works (id INTEGER PRIMARY KEY, work_id INTEGER, local_path TEXT);
    CREATE TABLE local_files (id INTEGER PRIMARY KEY, local_work_id INTEGER, file_type TEXT);
    CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, display_name TEXT, gender TEXT, folder_path TEXT);
    CREATE TABLE work_people (work_id INTEGER, person_id INTEGER, role TEXT);
    CREATE TABLE makers (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE work_makers (work_id INTEGER, maker_id INTEGER);
    CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT, kind TEXT);
    CREATE TABLE work_series (work_id INTEGER, series_id INTEGER);
    CREATE TABLE person_redirects (source_id INTEGER, target_id INTEGER);
    INSERT INTO people VALUES (1, '收藏人物甲', '收藏人物甲', 'female', NULL);
    INSERT INTO people VALUES (2, '同场出演者', '同场出演者', 'female', NULL);
    INSERT INTO people VALUES (3, '旧身份', '旧身份', 'female', NULL);
    INSERT INTO person_redirects VALUES (3, 1);
    INSERT INTO makers VALUES (1, '厂牌甲');
    INSERT INTO series VALUES (1, 'ABC', 'prefix'), (2, '系列甲', 'series'), (3, '子厂牌甲', 'label');
  `);
  // SQL backslashes are literal. Bind paths so the JavaScript parser cannot consume them.
  db.prepare("UPDATE people SET folder_path = ? WHERE id = 1").run("X:\\演员甲");
  db.prepare("UPDATE people SET folder_path = ? WHERE id = 3").run("Y:\\旧身份");
  const insertWork = db.prepare("INSERT INTO works VALUES (?, ?, ?, ?, ?, ?)");
  const insertLocal = db.prepare("INSERT INTO local_works VALUES (?, ?, ?)");
  for (let id = 1; id <= 30; id++) {
    const marked = id <= 6;
    insertWork.run(id, `ABC-${String(id).padStart(3, "0")}`, `测试作品 ${id}`, "",
      JSON.stringify([{ label: "类别", value: id <= 10 ? "眼镜, 恋爱" : "剧情" }]), JSON.stringify(["含磁鏈", "4K"]));
    insertLocal.run(id, id, `X:\\演员甲\\${marked ? "[A]." : ""}ABC-${id}`);
    db.prepare("INSERT INTO local_files VALUES (?, ?, 'video')").run(id, id);
    db.prepare("INSERT INTO work_people VALUES (?, 2, 'actor')").run(id);
    db.prepare("INSERT INTO work_makers VALUES (?, 1)").run(id);
    for (const sid of [1, 2, 3]) db.prepare("INSERT INTO work_series VALUES (?, ?)").run(id, sid);
  }
  insertWork.run(31, "UNAVAILABLE-001", "只有图片的记录", "", "[]", "[]");
  insertLocal.run(31, 31, "X:\\演员甲\\[A].图片");
  db.prepare("INSERT INTO local_files VALUES (31, 31, 'image')").run();
  // A second copy/segment of the same release must not add another positive observation.
  insertLocal.run(32, 1, "Y:\\旧身份\\[A].ABC-001");
  db.prepare("INSERT INTO local_files VALUES (32, 32, 'video')").run();
  db.close();
}
