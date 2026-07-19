const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const https = require('https');  // or node-fetch if preferred, but using built-in

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// Ensure directories
if (!fs.existsSync('data')) fs.mkdirSync('data');
if (!fs.existsSync('public/uploads')) fs.mkdirSync('public/uploads', { recursive: true });

const REPORTS_FILE = path.join(__dirname, 'data', 'reports.json');
const USERS_FILE = path.join(__dirname, 'data', 'users.json');

const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
const CLEANED_DELAY = 24 * 60 * 60 * 1000;

// ---- HELPERS ----
function getData(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function saveData(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function cleanReports(reports) {
  const now = Date.now();
  return reports.filter(r => {
    // Do NOT delete reports that have no timestamp (older data)
    if (!r.timestamp) return true;
    // Delete if older than 7 days and not cleaned
    if (!r.cleaned && (now - r.timestamp > ONE_WEEK)) return false;
    // Delete if cleaned and 24 hours have passed
    if (r.deletionTime && now > r.deletionTime) return false;
    return true;
  });
}

// ---- VERIFY FIREBASE TOKEN (REST call, no admin SDK) ----
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

async function verifyIdToken(idToken) {
  if (!FIREBASE_API_KEY) throw new Error('Missing FIREBASE_API_KEY');
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`;
  const body = JSON.stringify({ idToken });

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(json.error.message));
          } else {
            // The user info is in json.users[0]
            resolve(json.users[0]);
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---- AUTH MIDDLEWARE (uses REST verification) ----
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const userInfo = await verifyIdToken(idToken);
    req.user = userInfo;   // contains uid, email, etc.
    next();
  } catch (error) {
    console.error('Token verification failed:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ---- MULTER ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public', 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({ storage });

// ========== ROUTES ==========

app.get('/ping', (req, res) => res.send('pong'));

app.get('/api/user', authMiddleware, (req, res) => {
  const uid = req.user.localId;  // 'localId' is the UID in the REST response
  const users = getData(USERS_FILE);
  const user = users.find(u => u.uid === uid);
  res.json({ nickname: user ? user.nickname : null });
});

app.post('/api/users', authMiddleware, (req, res) => {
  const { nickname } = req.body;
  if (!nickname || nickname.trim().length === 0) {
    return res.status(400).json({ error: 'Nickname required' });
  }
  const uid = req.user.localId;
  let users = getData(USERS_FILE);
  if (users.some(u => u.nickname === nickname.trim() && u.uid !== uid)) {
    return res.status(409).json({ error: 'Nickname already taken' });
  }
  const existingUser = users.find(u => u.uid === uid);
  if (existingUser) {
    existingUser.nickname = nickname.trim();
  } else {
    users.push({ uid, nickname: nickname.trim() });
  }
  saveData(USERS_FILE, users);
  res.json({ success: true, nickname: nickname.trim() });
});

app.post('/api/reports', authMiddleware, upload.single('photo'), (req, res) => {
  const { lat, lng, address, time } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

  const uid = req.user.localId;
  const users = getData(USERS_FILE);
  const user = users.find(u => u.uid === uid);
  const nickname = user ? user.nickname : 'Anonymous';

  const imageUrl = `/uploads/${req.file.filename}`;
  const newReport = {
    id: uuidv4(),
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    imageUrl,
    address: address || 'Unknown',
    time: time || new Date().toLocaleString(),
    userId: uid,
    userName: nickname,
    comments: [],
    timestamp: Date.now()
  };

  const reports = getData(REPORTS_FILE);
  reports.push(newReport);
  saveData(REPORTS_FILE, reports);
  res.status(201).json(newReport);
});

app.post('/api/reports/:id/comments', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  const uid = req.user.localId;
  const users = getData(USERS_FILE);
  const user = users.find(u => u.uid === uid);
  const author = user ? user.nickname : 'Anonymous';

  const reports = getData(REPORTS_FILE);
  const report = reports.find(r => r.id === id);
  if (!report) return res.status(404).json({ error: 'Report not found' });

  report.comments.push({ author, text, timestamp: Date.now() });
  saveData(REPORTS_FILE, reports);
  res.json(report);
});

app.post('/api/reports/:id/cleaned', authMiddleware, upload.single('photo'), (req, res) => {
  const { id } = req.params;
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

  const uid = req.user.localId;
  const users = getData(USERS_FILE);
  const user = users.find(u => u.uid === uid);
  const nickname = user ? user.nickname : 'Anonymous';

  const reports = getData(REPORTS_FILE);
  const report = reports.find(r => r.id === id);
  if (!report) return res.status(404).json({ error: 'Report not found' });

  report.cleaned = {
    imageUrl: `/uploads/${req.file.filename}`,
    userName: nickname,
    timestamp: Date.now()
  };
  report.deletionTime = Date.now() + CLEANED_DELAY;
  saveData(REPORTS_FILE, reports);
  res.json(report);
});

app.get('/api/reports', (req, res) => {
  let reports = getData(REPORTS_FILE);
  const cleanedReports = cleanReports(reports);
  if (cleanedReports.length !== reports.length) {
    saveData(REPORTS_FILE, cleanedReports);
  }
  res.json(cleanedReports);
});

// ---- START SERVER ----
app.listen(PORT, () => {
  console.log(`CleanSweep backend running on http://localhost:${PORT}`);
  let reports = getData(REPORTS_FILE);
  const cleaned = cleanReports(reports);
  if (cleaned.length !== reports.length) {
    saveData(REPORTS_FILE, cleaned);
    console.log(`Cleaned up ${reports.length - cleaned.length} old reports`);
  }
});
