const { Pool } = require('pg');

// رابط الاتصال بـ Supabase
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:PASSWORD@db.xxxx.supabase.co:5432/postgres',
    ssl: { rejectUnauthorized: false } // مطلوب للاتصال الآمن بـ Supabase
});

// إنشاء الجداول تلقائياً على Supabase
const initDb = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS doctors (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL
        );

        CREATE TABLE IF NOT EXISTS courses (
            id SERIAL PRIMARY KEY,
            code VARCHAR(50) UNIQUE,
            name VARCHAR(255) NOT NULL,
            doctor_id INT REFERENCES doctors(id)
        );

        CREATE TABLE IF NOT EXISTS students (
            id VARCHAR(50) PRIMARY KEY,
            name VARCHAR(255) NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id SERIAL PRIMARY KEY,
            course_id INT REFERENCES courses(id),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS attendance (
            id SERIAL PRIMARY KEY,
            session_id INT REFERENCES sessions(id),
            student_id VARCHAR(50) REFERENCES students(id),
            scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(session_id, student_id)
        );
    `);
    console.log("تم الاتصال بـ Supabase وإنشاء الجداول بنجاح!");
};

initDb();
