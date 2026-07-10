const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());                     // Allow requests from the frontend
app.use(express.json());             // Parse JSON request bodies

// Serve uploaded photos as static files
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// --------------------------------------------------------------
// File paths
const REPORTS_FILE = path.join(__dirname, 'data', 'reports.json');

// Helper: read reports from file
function getReports() {
  if (!fs.existsSync(REPORTS_FILE)) return [];
  const raw = fs.readFileSync(REPORTS_FILE, 'utf-8');
  return JSON.parse(raw);
}

// Helper: write reports to file
function saveReports(reports) {
  fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2));
}

// --------------------------------------------------------------
// Multer configuration: save photos in 'public/uploads'
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public', 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);   // e.g. '.jpg'
    cb(null, uuidv4() + ext);                     // unique filename
  }
});
const upload = multer({ storage });

// --------------------------------------------------------------
// 1. GET all reports
app.get('/api/reports', (req, res) => {
  const reports = getReports();
  res.json(reports);
});

// 2. POST a new report (photo + location + username)
app.post('/api/reports', upload.single('photo'), (req, res) => {
  const { lat, lng, address, time, userName, userId } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: 'No photo uploaded.' });
  }

  const imageUrl = `/uploads/${req.file.filename}`;

  const newReport = {
    id: uuidv4(),
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    imageUrl,
    address: address || 'Unknown',
    time: time || new Date().toLocaleString(),
    userName: userName || 'Anonymous',
    userId: userId || 'unknown',
    comments: [],
    timestamp: Date.now()
  };

  const reports = getReports();
  reports.push(newReport);
  saveReports(reports);

  res.status(201).json(newReport);
});

// 3. POST a comment to a specific report
app.post('/api/reports/:id/comments', (req, res) => {
  const { id } = req.params;
  const { author, text } = req.body;

  const reports = getReports();
  const report = reports.find(r => r.id === id);

  if (!report) {
    return res.status(404).json({ error: 'Report not found' });
  }

  report.comments.push({
    author: author || 'Anonymous',
    text: text || '',
    timestamp: Date.now()
  });
  saveReports(reports);

  res.json(report);
});

// --------------------------------------------------------------
// Start server
app.listen(PORT, () => {
  console.log(`CleanSweep backend running on http://localhost:${PORT}`);
});