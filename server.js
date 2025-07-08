// server.js - Final Corrected Version for Vercel

require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const { MongoClient, ObjectId } = require('mongodb');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const PDFDocument = require('pdfkit');
const fileUpload = require('express-fileupload');

// --- SETUP ---
const app = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
const mongoUri = process.env.MONGO_URI;
const client = new MongoClient(mongoUri);
let db;

// --- DB CONNECTION HELPER ---
// This function ensures we connect only when needed in a serverless environment.
async function connectToDb() {
    if (db && client.topology && client.topology.isConnected()) {
        return db; // Return existing connection
    }
    try {
        await client.connect();
        db = client.db("resumeOptimizerDB");
        console.log("✅ New connection to MongoDB Atlas established.");
        return db;
    } catch (err) {
        console.error("❌ Failed to connect to MongoDB", err);
        throw err;
    }
}

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());
// Use the /tmp/ directory, which is the only writable one on Vercel
app.use(fileUpload({
    useTempFiles: true,
    tempFileDir: '/tmp/'
}));

// --- API ROUTER ---
// We create a router to prefix all our API endpoints with /api/
const apiRouter = express.Router();

// --- HELPER FUNCTION FOR CALLING GEMINI ---
async function callGemini(prompt) {
    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(text);
    } catch (error) {
        console.error("AI Response Error or JSON Parsing Error:", error);
        return null;
    }
}

// --- API ROUTES ---
apiRouter.post('/upload', async (req, res) => {
    if (!req.files || Object.keys(req.files).length === 0) {
        return res.status(400).json({ error: 'No file was uploaded.' });
    }
    const resumeFile = req.files.resume;
    try {
        const db = await connectToDb(); // Ensure DB is connected
        let rawText;
        if (resumeFile.mimetype === 'application/pdf') {
            rawText = (await pdf(fs.readFileSync(resumeFile.tempFilePath))).text;
        } else if (resumeFile.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            rawText = (await mammoth.extractRawText({ path: resumeFile.tempFilePath })).value;
        } else {
            return res.status(400).json({ error: 'Unsupported file type.' });
        }
        
        const prompt = `You are a resume parsing API. Your only function is to convert the following raw text into a structured JSON object. Do NOT include any introductory text, conversation, or the markdown specifier \`\`\`json. Your response must begin with { and end with }. The JSON object must conform to this schema: "contact_info": { "name", "email", "phone", "linkedin", "github" }, "summary": string, "experience": [ { "job_title", "company", "location", "start_date", "end_date", "responsibilities": [string] } ], "education": [ { "degree", "institution", "graduation_date", "cgpa" } ], "skills": string, "projects": [ { "name", "responsibilities": [string] } ], "certifications": [string]. If a section is not found, its value must be null or an empty array.`;
        
        const parsedResume = await callGemini(prompt + `\n\n"""${rawText}"""`);
        if (!parsedResume) throw new Error("The AI failed to parse the resume into valid JSON.");

        const result = await db.collection("resumes").insertOne(parsedResume);
        res.json({ message: 'Resume parsed successfully!', resumeId: result.insertedId });
    } catch (error) {
        console.error('SERVER ERROR on /upload:', error.message);
        res.status(500).json({ error: 'Failed to process resume.' });
    } finally {
        if(resumeFile && resumeFile.tempFilePath) {
            fs.unlinkSync(resumeFile.tempFilePath); // Clean up temporary file
        }
    }
});

apiRouter.post('/download-pdf', (req, res) => {
    try {
        const resumeData = req.body;
        if (!resumeData) return res.status(400).json({ error: "No resume data provided." });

        const doc = new PDFDocument({ size: 'A4', margin: 40 });
        
        const buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
            const pdfData = Buffer.concat(buffers);
            res.writeHead(200, {
                'Content-Type': 'application/pdf',
                'Content-Disposition': 'attachment; filename=Optimized-Resume.pdf',
                'Content-Length': pdfData.length
            });
            res.end(pdfData);
        });

        let regularFont = 'Helvetica', boldFont = 'Helvetica-Bold';
        try {
            doc.registerFont('Regular', path.join(__dirname, 'Poppins-Fonts', 'Poppins-Regular.ttf'));
            doc.registerFont('Bold', path.join(__dirname, 'Poppins-Fonts', 'Poppins-Bold.ttf'));
            regularFont = 'Regular';
            boldFont = 'Bold';
        } catch (e) { console.error("Could not load Poppins font, using Helvetica."); }

        const pageMargin = 40;
        const drawSectionHeader = (title) => { doc.font(boldFont).fontSize(10).text(title.toUpperCase(), { characterSpacing: 1.5 }); doc.moveDown(0.3); doc.strokeColor('#333333').lineWidth(0.75).moveTo(pageMargin, doc.y).lineTo(doc.page.width - pageMargin, doc.y).stroke(); doc.moveDown(0.8); };

        // --- PDF Content ---
        doc.font(boldFont).fontSize(26).text(resumeData.contact_info?.name?.toUpperCase() || '', { align: 'center', characterSpacing: 1 });
        doc.moveDown(0.3);
        const contactItems = [resumeData.contact_info?.phone, resumeData.contact_info?.email, resumeData.contact_info?.linkedin, resumeData.contact_info?.github].filter(Boolean);
        doc.font(regularFont).fontSize(9).text(contactItems.join('  •  '), { align: 'center' });
        doc.moveDown(1.5);
        if (resumeData.summary) { drawSectionHeader('Summary'); doc.font(regularFont).fontSize(10).text(resumeData.summary, { align: 'justify' }); doc.moveDown(1.5); }
        if (Array.isArray(resumeData.education) && resumeData.education.length > 0) {
            drawSectionHeader('Education');
            resumeData.education.forEach(edu => {
                const yPos = doc.y;
                doc.font(boldFont).fontSize(10).text(edu.degree || '', { continued: true });
                doc.font(regularFont).fontSize(9).text(edu.graduation_date || '', pageMargin, yPos, { align: 'right' });
                doc.font(regularFont).fontSize(10).text(edu.institution || '', { continued: true });
                doc.font(regularFont).fontSize(9).text(edu.cgpa ? `CGPA: ${edu.cgpa}` : '', { align: 'right' });
                doc.moveDown(1);
            });
            doc.moveDown(0.5);
        }
        if (resumeData.skills) { drawSectionHeader('Technical Skills'); doc.font(regularFont).fontSize(10).text(resumeData.skills); doc.moveDown(1.5); }
        if (Array.isArray(resumeData.experience) && resumeData.experience.length > 0) {
            drawSectionHeader('Experience');
            resumeData.experience.forEach(exp => {
                const yPos = doc.y;
                doc.font(boldFont).fontSize(10).text(exp.job_title || '', { continued: true });
                doc.font(regularFont).fontSize(9).text(`${exp.start_date || ''} - ${exp.end_date || ''}`, pageMargin, yPos, { align: 'right' });
                doc.font(regularFont).fontSize(10).text(`${exp.company || ''}, ${exp.location || ''}`);
                if (Array.isArray(exp.responsibilities)) { doc.moveDown(0.4); doc.font(regularFont).fontSize(10).list(exp.responsibilities, { bulletRadius: 1.5, textIndent: 15, lineGap: 3 }); }
                doc.moveDown(1);
            });
        }
        if (Array.isArray(resumeData.projects) && resumeData.projects.length > 0) {
            drawSectionHeader('Projects');
            resumeData.projects.forEach(proj => {
                doc.font('Bold').fontSize(10).text(proj.name || '');
                if (Array.isArray(proj.responsibilities)) { doc.moveDown(0.4); doc.font('Regular').list(proj.responsibilities, { bulletRadius: 1.5, textIndent: 15, lineGap: 3 }); }
                doc.moveDown(1);
            });
        }
        if (Array.isArray(resumeData.certifications) && resumeData.certifications.length > 0) {
            drawSectionHeader('Certifications');
            doc.font('Regular').fontSize(10).list(resumeData.certifications, { bulletRadius: 1.5, textIndent: 15, lineGap: 3 });
            doc.moveDown(1);
        }
        
        doc.end();
    } catch (error) {
        console.error("SERVER ERROR on /download-pdf:", error);
        if (!res.headersSent) res.status(500).json({ error: "Failed to generate PDF." });
    }
});

// Use the API router under the /api prefix
app.use('/api/', apiRouter);

// Export the app object for Vercel's serverless environment
module.exports = app;