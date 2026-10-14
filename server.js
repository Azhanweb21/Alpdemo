require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'DEV-ONLY-change-this-secret-before-deploying';
const db = new Database(path.join(__dirname, 'schoolos.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('principal','teacher','admin')),
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT, student_code TEXT UNIQUE, name TEXT NOT NULL,
      class_name TEXT NOT NULL, guardian_name TEXT DEFAULT '', guardian_phone TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL REFERENCES students(id),
      attendance_date TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('present','absent','late','leave')),
      marked_by INTEGER NOT NULL REFERENCES users(id), note TEXT DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(student_id, attendance_date)
    );
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, class_name TEXT NOT NULL,
      activity_date TEXT NOT NULL, details TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'planned',
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS lesson_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, class_name TEXT NOT NULL, subject TEXT NOT NULL,
      week_start TEXT NOT NULL, objectives TEXT DEFAULT '', plan_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', teacher_id INTEGER NOT NULL REFERENCES users(id),
      reviewed_by INTEGER REFERENCES users(id), review_note TEXT DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL REFERENCES students(id),
      subject TEXT NOT NULL, assessment TEXT NOT NULL, obtained REAL NOT NULL, total REAL NOT NULL,
      entered_by INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, CHECK(total > 0), CHECK(obtained >= 0 AND obtained <= total)
    );
    CREATE TABLE IF NOT EXISTS communication_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER REFERENCES students(id),
      channel TEXT NOT NULL DEFAULT 'manual', recipient TEXT DEFAULT '', reason TEXT DEFAULT '',
      outcome TEXT NOT NULL DEFAULT 'queued', notes TEXT DEFAULT '', created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS training_modules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT DEFAULT '',
      content_url TEXT DEFAULT '', created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS training_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT, module_id INTEGER NOT NULL REFERENCES training_modules(id),
      user_id INTEGER NOT NULL REFERENCES users(id), completed INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(module_id,user_id)
    );
  `);
  const count = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (!count) {
    const addUser = db.prepare('INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)');
    addUser.run('School Principal', 'principal@demo.school', bcrypt.hashSync('Admin@123', 10), 'principal');
    addUser.run('Saba Ahmed', 'saba@demo.school', bcrypt.hashSync('Teacher@123', 10), 'teacher');
    addUser.run('Ali Raza', 'ali@demo.school', bcrypt.hashSync('Teacher@123', 10), 'teacher');
    const addStudent = db.prepare('INSERT INTO students(student_code,name,class_name,guardian_name,guardian_phone) VALUES(?,?,?,?,?)');
    [
      ['S-1001','Ayesha Khan','Grade 5','Farah Khan',''],['S-1002','Hamza Ali','Grade 5','Imran Ali',''],
      ['S-1003','Zoya Ahmed','Grade 5','Sana Ahmed',''],['S-1004','Bilal Hussain','Grade 6','Nadia Hussain',''],
      ['S-1005','Maham Shah','Grade 6','Usman Shah',''],['S-1006','Rayyan Malik','Grade 7','Amina Malik','']
    ].forEach(s => addStudent.run(...s));
    db.prepare('INSERT INTO activities(title,class_name,activity_date,details,created_by) VALUES(?,?,?,?,1)')
      .run('Science observation journal','Grade 5',new Date(Date.now()+86400000).toISOString().slice(0,10),'Students record and discuss plant observations.');
    db.prepare('INSERT INTO training_modules(title,description,created_by) VALUES(?,?,1)')
      .run('Lesson planning basics','School workshop: objectives, lesson sequence, and assessment.');
  }
}
initDb();

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try {
    if (!token) throw new Error('Missing token');
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id,name,email,role,active FROM users WHERE id=?').get(payload.id);
    if (!user || !user.active) return res.status(401).json({ error: 'Account inactive or not found' });
    req.user = user; next();
  } catch { return res.status(401).json({ error: 'Please sign in again.' }); }
}
const principalOnly = (req,res,next) => ['principal','admin'].includes(req.user.role) ? next() : res.status(403).json({error:'Principal/admin permission required'});
const emitChange = (entity, action='updated') => io.emit('school:update', { entity, action, at: new Date().toISOString() });
const today = () => new Date().toISOString().slice(0,10);

app.get('/api/health', (_req,res) => res.json({ok:true, service:'SchoolOS API', realtime:'Socket.IO enabled'}));
app.post('/api/login', (req,res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({error:'Email and password are required.'});
  const user = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(String(email).trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({error:'Incorrect email or password.'});
  const token = jwt.sign({id:user.id}, JWT_SECRET, {expiresIn:'8h'});
  res.json({token,user:{id:user.id,name:user.name,email:user.email,role:user.role}});
});
app.get('/api/me', auth, (req,res) => res.json({user:req.user}));
app.get('/api/users', auth, principalOnly, (_req,res) => res.json(db.prepare('SELECT id,name,email,role,active,created_at FROM users ORDER BY name').all()));
app.post('/api/users', auth, principalOnly, (req,res) => {
  const {name,email,password,role='teacher'} = req.body || {};
  if (!name || !email || !password || password.length < 10 || !['teacher','admin'].includes(role)) return res.status(400).json({error:'Provide name, email, a 10+ character password, and teacher/admin role.'});
  try { const r=db.prepare('INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)').run(name.trim(),email.trim().toLowerCase(),bcrypt.hashSync(password,10),role); emitChange('users','created'); res.status(201).json({id:r.lastInsertRowid,name,email,role}); }
  catch { res.status(409).json({error:'That email is already in use.'}); }
});
app.get('/api/students', auth, (req,res) => {
  const {class_name} = req.query;
  const rows = class_name ? db.prepare('SELECT * FROM students WHERE active=1 AND class_name=? ORDER BY name').all(class_name) : db.prepare('SELECT * FROM students WHERE active=1 ORDER BY class_name,name').all();
  res.json(rows);
});
app.post('/api/students', auth, principalOnly, (req,res) => {
  const {student_code,name,class_name,guardian_name='',guardian_phone=''} = req.body || {};
  if (!name || !class_name) return res.status(400).json({error:'Student name and class are required.'});
  try { const r=db.prepare('INSERT INTO students(student_code,name,class_name,guardian_name,guardian_phone) VALUES(?,?,?,?,?)').run(student_code||null,name,class_name,guardian_name,guardian_phone); emitChange('students','created'); res.status(201).json({id:r.lastInsertRowid}); }
  catch { res.status(409).json({error:'Student code already exists.'}); }
});
app.get('/api/attendance', auth, (req,res) => {
  const date = req.query.date || today();
  res.json(db.prepare(`SELECT s.id student_id,s.student_code,s.name,s.class_name,a.status,a.note,a.updated_at,a.marked_by,u.name marked_by_name
    FROM students s LEFT JOIN attendance a ON a.student_id=s.id AND a.attendance_date=? LEFT JOIN users u ON u.id=a.marked_by
    WHERE s.active=1 ORDER BY s.class_name,s.name`).all(date));
});
app.post('/api/attendance/bulk', auth, (req,res) => {
  const {date=today(), records=[]} = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(records) || records.length>500) return res.status(400).json({error:'Invalid date or attendance list.'});
  const stmt=db.prepare(`INSERT INTO attendance(student_id,attendance_date,status,marked_by,note,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(student_id,attendance_date) DO UPDATE SET status=excluded.status,marked_by=excluded.marked_by,note=excluded.note,updated_at=CURRENT_TIMESTAMP`);
  const tx=db.transaction(rows=>{ for(const r of rows){ if(!['present','absent','late','leave'].includes(r.status)) throw new Error('Invalid attendance status'); if(!db.prepare('SELECT id FROM students WHERE id=? AND active=1').get(Number(r.student_id))) throw new Error('Student not found'); stmt.run(Number(r.student_id),date,r.status,req.user.id,String(r.note||'')); }});
  try { tx(records); emitChange('attendance','saved'); res.json({saved:records.length,date}); } catch(e){res.status(400).json({error:e.message});}
});
app.get('/api/activities', auth, (_req,res) => res.json(db.prepare(`SELECT a.*,u.name creator_name FROM activities a JOIN users u ON u.id=a.created_by ORDER BY activity_date DESC,a.id DESC`).all()));
app.post('/api/activities', auth, (req,res) => {
  const {title,class_name,activity_date,details=''}=req.body||{};
  if(!title||!class_name||!/^\d{4}-\d{2}-\d{2}$/.test(activity_date||'')) return res.status(400).json({error:'Title, class and a valid date are required.'});
  const r=db.prepare('INSERT INTO activities(title,class_name,activity_date,details,created_by) VALUES(?,?,?,?,?)').run(title,class_name,activity_date,details,req.user.id); emitChange('activities','created'); res.status(201).json({id:r.lastInsertRowid});
});
app.get('/api/lesson-plans', auth, (req,res) => {
  const sql=`SELECT l.*,u.name teacher_name,r.name reviewer_name FROM lesson_plans l JOIN users u ON u.id=l.teacher_id LEFT JOIN users r ON r.id=l.reviewed_by ${req.user.role==='teacher'?'WHERE l.teacher_id=?':''} ORDER BY l.week_start DESC,l.id DESC`;
  res.json(req.user.role==='teacher'?db.prepare(sql).all(req.user.id):db.prepare(sql).all());
});
app.post('/api/lesson-plans', auth, (req,res) => {
  const {class_name,subject,week_start,objectives='',plan_text}=req.body||{};
  if(!class_name||!subject||!/^\d{4}-\d{2}-\d{2}$/.test(week_start||'')||!plan_text) return res.status(400).json({error:'Class, subject, week start and plan are required.'});
  const r=db.prepare('INSERT INTO lesson_plans(class_name,subject,week_start,objectives,plan_text,teacher_id) VALUES(?,?,?,?,?,?)').run(class_name,subject,week_start,objectives,plan_text,req.user.id); emitChange('lesson-plans','created'); res.status(201).json({id:r.lastInsertRowid});
});
app.patch('/api/lesson-plans/:id/review', auth, principalOnly, (req,res) => {
  const {status,review_note=''}=req.body||{}; if(!['approved','changes_requested'].includes(status)) return res.status(400).json({error:'Invalid review status.'});
  const r=db.prepare('UPDATE lesson_plans SET status=?,reviewed_by=?,review_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,req.user.id,review_note,req.params.id);
  if(!r.changes) return res.status(404).json({error:'Lesson plan not found.'}); emitChange('lesson-plans','reviewed'); res.json({ok:true});
});
app.get('/api/marks', auth, (req,res) => {
  const sql=`SELECT m.*,s.name student_name,s.class_name,u.name teacher_name FROM marks m JOIN students s ON s.id=m.student_id JOIN users u ON u.id=m.entered_by ${req.user.role==='teacher'?'WHERE m.entered_by=?':''} ORDER BY m.updated_at DESC,m.id DESC`;
  res.json(req.user.role==='teacher'?db.prepare(sql).all(req.user.id):db.prepare(sql).all());
});
app.post('/api/marks', auth, (req,res) => {
  const {student_id,subject,assessment,obtained,total}=req.body||{};
  if(!student_id||!subject||!assessment||!Number.isFinite(Number(obtained))||!Number.isFinite(Number(total))||Number(total)<=0||Number(obtained)<0||Number(obtained)>Number(total)) return res.status(400).json({error:'Check student, subject, assessment and marks range.'});
  const r=db.prepare('INSERT INTO marks(student_id,subject,assessment,obtained,total,entered_by) VALUES(?,?,?,?,?,?)').run(student_id,subject,assessment,obtained,total,req.user.id); emitChange('marks','created'); res.status(201).json({id:r.lastInsertRowid,percentage:Math.round(Number(obtained)/Number(total)*10000)/100});
});
app.patch('/api/marks/:id/approve', auth, principalOnly, (req,res) => { const r=db.prepare("UPDATE marks SET status='approved',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.params.id); if(!r.changes)return res.status(404).json({error:'Mark entry not found.'}); emitChange('marks','approved'); res.json({ok:true}); });
app.get('/api/communications', auth, (_req,res) => res.json(db.prepare(`SELECT c.*,s.name student_name,u.name created_by_name FROM communication_logs c LEFT JOIN students s ON s.id=c.student_id LEFT JOIN users u ON u.id=c.created_by ORDER BY c.id DESC LIMIT 200`).all()));
app.post('/api/communications', auth, (req,res) => {
  const {student_id=null,channel='manual',recipient='',reason='',outcome='queued',notes=''}=req.body||{};
  if(!['manual','call','sms','whatsapp'].includes(channel)||!['queued','simulated','sent','answered','no_answer','failed'].includes(outcome))return res.status(400).json({error:'Invalid channel or outcome.'});
  const r=db.prepare('INSERT INTO communication_logs(student_id,channel,recipient,reason,outcome,notes,created_by) VALUES(?,?,?,?,?,?,?)').run(student_id,channel,recipient,reason,outcome,notes,req.user.id); emitChange('communications','logged'); res.status(201).json({id:r.lastInsertRowid,liveIntegration:false,message:'Logged only; no real call or message was sent.'});
});
app.get('/api/training', auth, (req,res) => res.json(db.prepare(`SELECT t.*,p.completed,p.updated_at progress_updated FROM training_modules t LEFT JOIN training_progress p ON p.module_id=t.id AND p.user_id=? ORDER BY t.id DESC`).all(req.user.id)));
app.post('/api/training', auth, principalOnly, (req,res) => {const {title,description='',content_url=''}=req.body||{}; if(!title)return res.status(400).json({error:'Title is required.'});const r=db.prepare('INSERT INTO training_modules(title,description,content_url,created_by) VALUES(?,?,?,?)').run(title,description,content_url,req.user.id);emitChange('training','created');res.status(201).json({id:r.lastInsertRowid});});
app.patch('/api/training/:id/progress', auth, (req,res) => {const completed=req.body?.completed?1:0;db.prepare(`INSERT INTO training_progress(module_id,user_id,completed) VALUES(?,?,?) ON CONFLICT(module_id,user_id) DO UPDATE SET completed=excluded.completed,updated_at=CURRENT_TIMESTAMP`).run(req.params.id,req.user.id,completed);emitChange('training-progress','updated');res.json({ok:true});});
app.get('/api/dashboard', auth, (req,res) => {
  const date=req.query.date||today();
  const students=db.prepare('SELECT COUNT(*) n FROM students WHERE active=1').get().n;
  const attendance=db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) present, SUM(CASE WHEN status='absent' THEN 1 ELSE 0 END) absent, SUM(CASE WHEN status='late' THEN 1 ELSE 0 END) late, SUM(CASE WHEN status='leave' THEN 1 ELSE 0 END) leave_count FROM attendance WHERE attendance_date=?`).get(date);
  const pendingPlans=db.prepare("SELECT COUNT(*) n FROM lesson_plans WHERE status='pending'").get().n;
  const pendingMarks=db.prepare("SELECT COUNT(*) n FROM marks WHERE status='pending'").get().n;
  const recent=db.prepare(`SELECT 'attendance' kind, s.name title, a.status detail, a.updated_at at FROM attendance a JOIN students s ON s.id=a.student_id WHERE a.attendance_date=? UNION ALL SELECT 'lesson plan', subject, status, updated_at FROM lesson_plans UNION ALL SELECT 'marks',s.name, m.subject||' • '||m.obtained||'/'||m.total,m.updated_at FROM marks m JOIN students s ON s.id=m.student_id ORDER BY at DESC LIMIT 12`).all(date);
  res.json({date,students,attendance:{total:attendance.total||0,present:attendance.present||0,absent:attendance.absent||0,late:attendance.late||0,leave:attendance.leave_count||0},pendingPlans,pendingMarks, recent, role:req.user.role});
});
io.on('connection', socket => socket.emit('school:connected',{at:new Date().toISOString()}));
app.get('*', (_req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
server.listen(PORT, () => console.log(`SchoolOS running at http://localhost:${PORT}`));
