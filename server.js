const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const SECRET_KEY = "super_secret_attendance_key";
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static('public'));

// --- 1. جلب قائمة المحاضرين والمواد ---
app.get('/api/doctors', (req, res) => {
    db.all(`SELECT * FROM doctors`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/courses', (req, res) => {
    db.all(`SELECT c.id, c.name, c.code, d.name as doctor_name 
            FROM courses c 
            LEFT JOIN doctors d ON c.doctor_id = d.id`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// --- 2. إضافة محاضر أو مادة جديدة ---
app.post('/api/doctors', (req, res) => {
    const { name } = req.body;
    db.run(`INSERT INTO doctors (name) VALUES (?)`, [name], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, name });
    });
});

app.post('/api/courses', (req, res) => {
    const { name, code, doctor_id } = req.body;
    db.run(`INSERT INTO courses (name, code, doctor_id) VALUES (?, ?, ?)`, [name, code, doctor_id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, name, code });
    });
});

// --- 3. رفع ملف إكسل الطلاب لربطهم بالمادة ---
app.post('/api/upload-roster', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'يرجى اختيار ملف Excel' });

    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    const stmt = db.prepare(`INSERT OR REPLACE INTO students (id, name) VALUES (?, ?)`);
    let count = 0;

    data.forEach(row => {
        const studentId = String(row['رقم القيد'] || row['id'] || '').trim();
        const studentName = String(row['اسم الطالب'] || row['الاسم'] || row['name'] || '').trim();

        if (studentId && studentName) {
            stmt.run(studentId, studentName);
            count++;
        }
    });

    stmt.finalize();
    res.json({ success: true, message: `تم استيراد ${count} طالب بنجاح!` });
});

// --- 4. إنشاء جلسة محاضرة جديدة لبدء الـ QR ---
app.post('/api/start-session', (req, res) => {
    const { course_id } = req.body;
    db.run(`INSERT INTO sessions (course_id) VALUES (?)`, [course_id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ sessionId: this.lastID });
    });
});

// --- 5. تصدير تقرير الحضور الشامل لـ Excel ---
app.get('/api/export-attendance/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;

    const query = `
        SELECT 
            s.id AS 'رقم القيد',
            s.name AS 'اسم الطالب',
            c.name AS 'المادة',
            d.name AS 'أستاذ المادة',
            datetime(sess.created_at, 'localtime') AS 'تاريخ المحاضرة',
            CASE 
                WHEN a.id IS NOT NULL THEN 'حاضر'
                ELSE 'غائب'
            END AS 'حالة الحضور',
            COALESCE(datetime(a.scanned_at, 'localtime'), '-') AS 'وقت التسجيل'
        FROM students s
        CROSS JOIN sessions sess ON sess.id = ?
        JOIN courses c ON c.id = sess.course_id
        LEFT JOIN doctors d ON d.id = c.doctor_id
        LEFT JOIN attendance a ON a.student_id = s.id AND a.session_id = sess.id
        ORDER BY s.id ASC
    `;

    db.all(query, [sessionId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        const worksheet = XLSX.utils.json_to_sheet(rows);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "كشف الحضور والغياب");

        const exportPath = path.join(__dirname, 'uploads', `attendance_session_${sessionId}.xlsx`);
        XLSX.writeFile(workbook, exportPath);
        res.download(exportPath);
    });
});

// --- Real-time Socket.io لتوليد الـ QR الديناميكي ---
let activeSessionId = null;

io.on('connection', (socket) => {
    socket.on('set-active-session', (sessionId) => {
        activeSessionId = sessionId;
    });

    socket.on('register-attendance', ({ token, studentId }) => {
        try {
            const decoded = jwt.verify(token, SECRET_KEY);
            if (!activeSessionId) {
                return socket.emit('attendance-response', { success: false, message: 'لا توجد محاضرة نشطة حالياً' });
            }

            db.run(`INSERT INTO attendance (session_id, student_id) VALUES (?, ?)`, 
                [activeSessionId, studentId], 
                function(err) {
                    if (err) {
                        if (err.message.includes('UNIQUE')) {
                            return socket.emit('attendance-response', { success: false, message: 'تم تسجيل حضورك سابقاً في هذه المحاضرة' });
                        }
                        return socket.emit('attendance-response', { success: false, message: 'رقم القيد غير مسجل أو حدث خطأ' });
                    }
                    socket.emit('attendance-response', { success: true, message: 'تم تسجيل حضورك بنجاح!' });
                }
            );
        } catch (err) {
            socket.emit('attendance-response', { success: false, message: 'رمز الـ QR انتهت صلاحيته، أعد المسح' });
        }
    });
});

// التحديث التلقائي للـ QR كل 5 ثوانٍ
setInterval(() => {
    if (activeSessionId) {
        const token = jwt.sign({ session: activeSessionId, time: Date.now() }, SECRET_KEY, { expiresIn: '10s' });
        io.emit('qr-update', token);
    }
}, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`السيرفر يعمل بنجاح على البورت ${PORT}`));