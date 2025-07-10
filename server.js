// server.js

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs/promises');
const path = require('path');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const OpenAI = require('openai');
const { MongoClient } = require('mongodb');

const app = express();

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());

// --- MULTER SETUP ---
const uploadDir = '/tmp'; // Required for Vercel
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// --- OPENAI SETUP ---
if (!process.env.OPENAI_API_KEY) {
    console.error("❌ Missing OPENAI_API_KEY");
    process.exit(1);
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- MONGODB SETUP ---
const client = new MongoClient(process.env.MONGO_URI);
let db;

async function connectToDB() {
    if (!db) {
        try {
            await client.connect();
            db = client.db("resumeOptimizerDB");
            console.log("✅ Connected to MongoDB");
        } catch (err) {
            console.error("❌ MongoDB connection failed", err);
        }
    }
}

// --- RESUME UPLOAD AND PARSING ---
app.post('/upload', upload.single('resume'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file was uploaded.' });
    }

    try {
        let rawText = '';
        console.log(`📄 Processing: ${req.file.originalname}`);

        if (req.file.mimetype === 'application/pdf') {
            const buffer = await fs.readFile(req.file.path);
            const data = await pdf(buffer);
            rawText = data.text;
        } else if (req.file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const result = await mammoth.extractRawText({ path: req.file.path });
            rawText = result.value;
        } else {
            await fs.unlink(req.file.path);
            return res.status(400).json({ error: 'Unsupported file type. Upload PDF or DOCX.' });
        }

        await fs.unlink(req.file.path); // Cleanup temp file

        const prompt = `You are a professional resume parsing service. Analyze the following raw text from a resume and extract the information into a structured JSON object. The JSON object must have these exact keys: "contact_info", "summary", "experience", "education", "projects", "skills", "certifications". If a section is not found, its value should be an empty string "" or a note like "Not found".`;

        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo-1106",
            messages: [
                { role: "system", content: "You are a helpful assistant that returns only JSON." },
                { role: "user", content: `${prompt}\n\nResume Text:\n${rawText}` }
            ],
            response_format: { type: "json_object" },
        });

        const parsedResume = JSON.parse(completion.choices[0].message.content);

        await connectToDB();
        const collection = db.collection('resumes');
        await collection.insertOne(parsedResume);

        res.json({
            message: "✅ Resume parsed and saved successfully.",
            parsedData: parsedResume
        });

    } catch (err) {
        console.error("❌ Resume processing error:", err);
        res.status(500).json({ error: 'Resume parsing failed.' });
    }
});

// --- TEST ROUTE ---
app.get('/api/test', (req, res) => {
    res.json({ status: "✅ API is working!" });
});

// --- EXPORT FOR VERCEL ---
module.exports = app;
