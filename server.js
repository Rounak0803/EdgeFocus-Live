const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Redis } = require('@upstash/redis');
const Groq = require('groq-sdk');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// 1. PostgreSQL Connection (Neon / Supabase)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Auto-create exams table on startup
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS exams (
        id SERIAL PRIMARY KEY,
        topic TEXT NOT NULL,
        format TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        question_count INT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ PostgreSQL connected & exams table ready');
  } catch (err) {
    console.error('❌ PostgreSQL init error:', err.message);
  }
}
initDB();

// 2. Upstash Redis Connection (optional if keys aren't set yet)
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

if (redis) console.log('✅ Upstash Redis enabled');

// 3. Groq AI Client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Exam Generation Route
app.post('/api/generate-exam', async (req, res) => {
  try {
    const {
      topic,
      format = 'Mixed',
      difficulty = 'Medium',
      questionCount = 3,
    } = req.body;

    if (!topic) {
      return res.status(400).json({ error: 'Topic is required' });
    }

    const cacheKey = `exam:${topic.toLowerCase().trim()}:${format}:${difficulty}:${questionCount}`;

    // Check Redis cache first
    if (redis) {
      const cachedExam = await redis.get(cacheKey);
      if (cachedExam) {
        return res.status(200).json({ data: cachedExam, source: 'redis' });
      }
    }

    // Call Groq if not cached
    const prompt = `Generate a ${difficulty} level mock exam about "${topic}" with exactly ${questionCount} questions in "${format}" format.
Format the questions cleanly.
IMPORTANT: At the very end, include a separate "Answer Key" block containing the correct answers for all questions.`;

    const response = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'openai/gpt-oss-120b',
    });

    const examText = response.choices[0].message.content;

    // Save to PostgreSQL
    await pool.query(
      `INSERT INTO exams (topic, format, difficulty, question_count, content)
       VALUES ($1, $2, $3, $4, $5)`,
      [topic, format, difficulty, questionCount, examText]
    );

    // Cache in Redis for 24 hours
    if (redis) {
      await redis.set(cacheKey, examText, { ex: 86400 });
    }

    res.status(200).json({ data: examText, source: 'groq' });
  } catch (error) {
    console.error('❌ Error generating exam:', error);
    res.status(500).json({ error: 'Failed to generate exam' });
  }
});

// Optional: Fetch recent exam history from PostgreSQL
app.get('/api/exams', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, topic, format, question_count, created_at FROM exams ORDER BY created_at DESC LIMIT 20'
    );
    res.status(200).json({ exams: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch exam history' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});