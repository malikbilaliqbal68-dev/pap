import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();

// ES module dirname fix
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================= UTILITY =================
const loadSyllabus = (board) => {
    try {
        const filePath = path.join(
            __dirname,
            '..',
            'syllabus',
            `${board}_board_syllabus.json`
        );
        if (!fs.existsSync(filePath)) return [];
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.error("Error loading syllabus:", err);
        return [];
    }
};

// Helper to safely get English text from either a string or an object
const getEn = (data) => {
    if (!data) return '';
    return typeof data === 'object' ? data.en : data;
};

// ================= SUBJECTS =================
router.get('/subjects/:board/:class', (req, res) => {
    try {
        const { board, class: className } = req.params;
        const syllabus = loadSyllabus(board);

        const classData = syllabus.find(c => c.class === className);
        if (!classData) {
            return res.status(404).json({ error: 'Class not found' });
        }

        // Standardize output so 'name' always includes an 'en' property for the frontend
        const subjects = classData.subjects.map(subject => ({
            name: { en: getEn(subject.name) },
            chapters: subject.chapters.map(ch => getEn(ch.title))
        }));

        res.json(subjects);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load subjects' });
    }
});

// ================= CHAPTERS =================
router.get('/chapters/:board/:class/:subject', (req, res) => {
    try {
        const { board, class: className, subject } = req.params;
        const syllabus = loadSyllabus(board);

        const classData = syllabus.find(c => c.class === className);
        if (!classData) return res.json([]);

        const subjectData = classData.subjects.find(
            s => getEn(s.name).toLowerCase() === decodeURIComponent(subject).toLowerCase()
        );

        if (!subjectData) return res.json([]);

        res.json(
            subjectData.chapters.map(ch => ({
                title: { en: getEn(ch.title) }
            }))
        );
    } catch (err) {
        res.json([]);
    }
});

// ================= TOPICS (CLASS 11 & 12 ONLY) =================
router.get('/topics/:board/:class/:subject/:chapter', (req, res) => {
    try {
        const { board, class: className, subject, chapter } = req.params;

        if (!['11', '12'].includes(className)) {
            return res.json([]);
        }

        const syllabus = loadSyllabus(board);
        const classData = syllabus.find(c => c.class === className);
        if (!classData) return res.json([]);

        const subjectData = classData.subjects.find(
            s => getEn(s.name).toLowerCase() === decodeURIComponent(subject).toLowerCase()
        );
        if (!subjectData) return res.json([]);

        const chapterData = subjectData.chapters.find(
            ch => getEn(ch.title).toLowerCase() === decodeURIComponent(chapter).toLowerCase()
        );
        if (!chapterData) return res.json([]);

        res.json(
            Array.isArray(chapterData.topics)
                ? chapterData.topics.map(t => ({
                      topic: t.topic,
                      status: t.status || 'active'
                  }))
                : []
        );
    } catch (err) {
        console.error(err);
        res.json([]);
    }
});

// ================= GENERATE BOOK =================
router.post('/generate', express.json(), (req, res) => {
    try {
        const { board, class: className, selections } = req.body;
        const syllabus = loadSyllabus(board);

        const classData = syllabus.find(c => c.class === className);
        if (!classData) {
            return res.status(404).json({ error: 'Class not found' });
        }

        const customBook = {
            title: `Custom Book - Class ${className}`,
            board,
            class: className,
            subjects: []
        };

        selections.forEach(sel => {
            const subject = classData.subjects.find(
                s => getEn(s.name) === sel.subject
            );
            if (!subject) return;

            const customSubject = {
                name: subject.name,
                chapters: []
            };

            sel.chapters.forEach(chTitle => {
                const chapter = subject.chapters.find(
                    ch => getEn(ch.title) === chTitle
                );
                if (!chapter) return;

                const customChapter = {
                    title: chapter.title,
                    content: {}
                };

                if (sel.includeTypes.includes('mcqs')) {
                    customChapter.content.mcqs = chapter.mcqs || [];
                }
                if (sel.includeTypes.includes('short_questions')) {
                    customChapter.content.short_questions = chapter.short_questions || [];
                    customChapter.content.short_questions_ur = chapter.short_questions_ur || [];
                }
                if (sel.includeTypes.includes('long_questions')) {
                    customChapter.content.long_questions = chapter.long_questions || [];
                    customChapter.content.long_questions_ur = chapter.long_questions_ur || [];
                }

                customSubject.chapters.push(customChapter);
            });

            if (customSubject.chapters.length > 0) {
                customBook.subjects.push(customSubject);
            }
        });

        res.json(customBook);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to generate book' });
    }
});

export default router;