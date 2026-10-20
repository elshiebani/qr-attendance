const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const SECRET_KEY = "super_secret_attendance_key";
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static('public'));

// تحويل الزائر من الرابط الرئيسي تلقائياً إلى صفحة المحاضر
app.get('/', (req, res) => {
    res.redirect('/lecturer.html');
});

// 1. الاتصال بقاعدة بيانات Supabase
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:Suluq2026Password@db.rkjbileaxqxxmbcyhooj.supabase.co:5432/postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000
});

// 2. إنشاء الجداول العلاقية تلقائياً
const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS doctors (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL
            );

            CREATE TABLE IF NOT EXISTS courses (
                id SERIAL PRIMARY KEY,
                code VARCHAR(50) UNIQUE,
                name VARCHAR(255) NOT NULL,
                doctor_id INT REFERENCES doctors(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS students (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(255) NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id SERIAL PRIMARY KEY,
                course_id INT REFERENCES courses(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS attendance (
                id SERIAL PRIMARY KEY,
                session_id INT REFERENCES sessions(id) ON DELETE CASCADE,
                student_id VARCHAR(50) REFERENCES students(id) ON DELETE CASCADE,
                scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(session_id, student_id)
            );
        `);
        console.log("تم الاتصال بـ Supabase وإنشاء الجداول العلاقية بنجاح!");
    } catch (err) {
        console.error("خطأ في الاتصال بقاعدة البيانات:", err.message);
    }
};

initDb();

// 3. مسارات النظام (API Routes)
app.get('/api/doctors', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM doctors ORDER BY id ASC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/courses', async (req, res) => {
    try {
        const query = `
            SELECT c.id, c.name, c.code, d.name as doctor_name 
            FROM courses c 
            LEFT JOIN doctors d ON c.doctor_id = d.id
            ORDER BY c.id ASC
        `;
        const { rows } = await pool.query(query);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/doctors', async (req, res) => {
    const { name } = req.body;
    try {
        const { rows } = await pool.query('INSERT INTO doctors (name) VALUES ($1) RETURNING *', [name]);
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/courses', async (req, res) => {
    const { name, code, doctor_id } = req.body;
    try {
        const { rows } = await pool.query(
            'INSERT INTO courses (name, code, doctor_id) VALUES ($1, $2, $3) RETURNING *',
            [name, code, doctor_id || null]
        );
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/upload-roster', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'يرجى اختيار ملف Excel' });

    try {
        const workbook = XLSX.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

        let count = 0;
        for (const row of data) {
            const studentId = String(row['رقم القيد'] || row['id'] || '').trim();
            const studentName = String(row['اسم الطالب'] || row['الاسم'] || row['name'] || '').trim();

            if (studentId && studentName) {
                await pool.query(
                    `INSERT INTO students (id, name) VALUES ($1, $2)
                     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
                    [studentId, studentName]
                );
                count++;
            }
        }
        res.json({ success: true, message: `تم استيراد ${count} طالب بنجاح إلى Supabase!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/start-session', async (req, res) => {
    const { course_id } = req.body;
    try {
        const { rows } = await pool.query(
            'INSERT INTO sessions (course_id) VALUES ($1) RETURNING id',
            [course_id]
        );
        activeSessionId = rows[0].id;
        res.json({ sessionId: rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/export-attendance/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;

    const query = `
        SELECT 
            s.id AS "رقم القيد",
            s.name AS "اسم الطالب",
            c.name AS "المادة",
            d.name AS "أستاذ المادة",
            to_char(sess.created_at, 'YYYY-MM-DD HH12:MI AM') AS "تاريخ المحاضرة",
            CASE 
                WHEN a.id IS NOT NULL THEN 'حاضر'
                ELSE 'غائب'
            END AS "حالة الحضور",
            COALESCE(to_char(a.scanned_at, 'HH12:MI:SS AM'), '-') AS "وقت التسجيل"
        FROM students s
        CROSS JOIN sessions sess
        JOIN courses c ON c.id = sess.course_id
        LEFT JOIN doctors d ON d.id = c.doctor_id
        LEFT JOIN attendance a ON a.student_id = s.id AND a.session_id = sess.id
        WHERE sess.id = $1
        ORDER BY s.id ASC
    `;

    try {
        const { rows } = await pool.query(query, [sessionId]);
        const worksheet = XLSX.utils.json_to_sheet(rows);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "كشف الحضور");

        const exportPath = path.join(__dirname, 'uploads', `attendance_session_${sessionId}.xlsx`);
        XLSX.writeFile(workbook, exportPath);
        res.download(exportPath);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Socket.io وتوليد الـ QR
let activeSessionId = 1; // جلسة افتراضية لضمان توليد الـ QR مباشرة عند فتح الصفحة

io.on('connection', (socket) => {
    socket.on('set-active-session', (sessionId) => {
        activeSessionId = sessionId;
    });

    socket.on('register-attendance', async ({ token, studentId }) => {
        try {
            jwt.verify(token, SECRET_KEY);

            if (!activeSessionId) {
                return socket.emit('attendance-response', { success: false, message: 'لا توجد محاضرة نشطة حالياً' });
            }

            await pool.query(
                'INSERT INTO attendance (session_id, student_id) VALUES ($1, $2)',
                [activeSessionId, studentId]
            );

            socket.emit('attendance-response', { success: true, message: 'تم تسجيل حضورك بنجاح!' });
        } catch (err) {
            if (err.code === '23505') {
                socket.emit('attendance-response', { success: false, message: 'تم تسجيل حضورك سابقاً في هذه المحاضرة' });
            } else if (err.code === '23503') {
                socket.emit('attendance-response', { success: false, message: 'رقم القيد غير مسجل في قائمة المادة' });
            } else {
                socket.emit('attendance-response', { success: false, message: 'رمز الـ QR انتهت صلاحيته، أعد المسح' });
            }
        }
    });
});

// إرسال رمز QR يتغير كل 5 ثوانٍ
setInterval(() => {
    if (activeSessionId) {
        const token = jwt.sign({ session: activeSessionId, time: Date.now() }, SECRET_KEY, { expiresIn: '10s' });
        io.emit('qr-update', token);
    }
}, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`السيرفر يعمل بنجاح على البورت ${PORT}`));
