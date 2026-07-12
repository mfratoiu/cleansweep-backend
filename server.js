const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// Ensure directories exist
if (!fs.existsSync('data')) fs.mkdirSync('data');
if (!fs.existsSync('public/uploads')) fs.mkdirSync('public/uploads', { recursive: true });

const REPORTS_FILE = path.join(__dirname, 'data', 'reports.json');
const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000; // 14 days in ms
const CLEANED_DELAY = 24 * 60 * 60 * 1000;   // 24 hours in ms

// --- Helpers ---
function getReports() {
  if (!fs.existsSync(REPORTS_FILE)) return [];
  const raw = fs.readFileSync(REPORTS_FILE, 'utf-8');
  return JSON.parse(raw);
}

function saveReports(reports) {
  fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2));
}

// Remove reports that have expired (older than 14 days) or past their deletionTime
function cleanReports(reports) {
  const now = Date.now();
  return reports.filter(r => {
    // Remove if report timestamp is older than 14 days
    if (r.timestamp && (now - r.timestamp > TWO_WEEKS)) return false;
    // Remove if cleaned and deletionTime has passed
    if (r.deletionTime && now > r.deletionTime) return false;
    return true;
  });
}

// --- Multer ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public', 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({ storage });

// --- Routes ---

// GET all reports (auto-clean)
app.get('/api/reports', (req, res) => {
  let reports = getReports();
  const cleanedReports = cleanReports(reports);
  // Only write back if something was removed (optional but keeps file tidy)
  if (cleanedReports.length !== reports.length) {
    saveReports(cleanedReports);
  }
  res.json(cleanedReports);
});

// POST new report
app.post('/api/reports', upload.single('photo'), (req, res) => {
  const { lat, lng, address, time, userName, userId } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

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

// POST a comment
app.post('/api/reports/:id/comments', (req, res) => {
  const { id } = req.params;
  const { author, text } = req.body;
  const reports = getReports();
  const report = reports.find(r => r.id === id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  report.comments.push({ author: author || 'Anonymous', text, timestamp: Date.now() });
  saveReports(reports);
  res.json(report);
});

// POST cleaned photo for a report
app.post('/api/reports/:id/cleaned', upload.single('photo'), (req, res) => {
  const { id } = req.params;
  const { userName } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

  const reports = getReports();
  const report = reports.find(r => r.id === id);
  if (!report) return res.status(404).json({ error: 'Report not found' });

  const cleanedImageUrl = `/uploads/${req.file.filename}`;
  report.cleaned = {
    imageUrl: cleanedImageUrl,
    userName: userName || 'Anonymous',
    timestamp: Date.now()
  };
  // Set deletion time: 24 hours from now
  report.deletionTime = Date.now() + CLEANED_DELAY;
  saveReports(reports);
  res.json(report);
});

// Start server
app.listen(PORT, () => {
  console.log(`CleanSweep backend running on http://localhost:${PORT}`);
  // Clean up on start
  let reports = getReports();
  const cleaned = cleanReports(reports);
  if (cleaned.length !== reports.length) {
    saveReports(cleaned);
    console.log(`Cleaned up ${reports.length - cleaned.length} old reports`);
  }
});