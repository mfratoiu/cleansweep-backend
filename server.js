const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');
const { GoogleAuth } = require('google-auth-library');
const nodemailer = require('nodemailer');

// ------------------------------
//  CONFIG – REPLACE WITH YOUR REAL PROJECT ID
// ------------------------------
const FIREBASE_PROJECT_ID = 'cleansweepsg-f6340';   // ← CHANGE THIS

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------------------
// FIREBASE ADMIN SETUP (manual credential via GoogleAuth)
// ------------------------------
let firebaseApp = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const auth = new GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    });

    firebaseApp = admin.initializeApp({
      credential: {
        getAccessToken: () => auth.getAccessToken(),
      },
      projectId: serviceAccount.project_id || FIREBASE_PROJECT_ID,
    });
    console.log('🔥 Firebase Admin initialized (manual credential)');
  } catch (e) {
    console.error('❌ Firebase Admin init error:', e);
  }
}

// ------------------------------
// MIDDLEWARE
// ------------------------------
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// Create required directories
['data', 'public/uploads'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Data files
const REPORTS_FILE = path.join(__dirname, 'data', 'reports.json');
const USERS_FILE = path.join(__dirname, 'data', 'users.json');

// Expiry constants
const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
const CLEANED_DELAY = 24 * 60 * 60 * 1000;

// ------------------------------
// HELPERS
// ------------------------------
const getData = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : [];
const saveData = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

function cleanReports(reports) {
  const now = Date.now();
  return reports.filter(r => {
    if (!r.timestamp) return true;                     // keep legacy reports
    if (r.deletionTime && now > r.deletionTime) return false;   // cleaned & expired
    if (!r.cleaned && (now - r.timestamp > ONE_WEEK)) return false; // older than 7 days
    return true;
  });
}

// ------------------------------
// AUTH MIDDLEWARE (Firebase REST verification)
// ------------------------------
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer '))
    return res.status(401).json({ error: 'Unauthorized' });

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const apiKey = process.env.FIREBASE_API_KEY || (firebaseApp ? firebaseApp.options.apiKey : null);
    if (!apiKey) throw new Error('Missing API key');

    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
    );
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    req.user = data.users[0];   // contains localId, email, etc.
    next();
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ------------------------------
// PUSH NOTIFICATION HELPERS
// ------------------------------
async function getAccessToken() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return null;
  const auth = new GoogleAuth({
    credentials: JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT),
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token;
}

async function sendPushNotification(fcmToken, title, body, dataPayload = {}) {
  if (!fcmToken) return;
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) throw new Error('No access token');

    const message = {
      message: {
        token: fcmToken,
        notification: { title, body },
        data: Object.fromEntries(
          Object.entries(dataPayload).map(([k, v]) => [k, String(v)])
        ),
      },
    };

// ---- Send email notification ----
async function sendEmailNotification(subject, text) {
  // Only send if email credentials are set
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('Email credentials missing, skipping email');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: 'groqclaw@gamil.com',   // ← Change this later to your real NEA email
    subject: subject,
    text: text
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('Email sent to', mailOptions.to);
  } catch (err) {
    console.error('Email send error:', err);
  }
}
    
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify(message),
      }
    );
    const result = await res.json();
    if (!res.ok) console.error('FCM error:', result);
    else console.log('Push sent to', fcmToken);
  } catch (err) {
    console.error('Push send error:', err);
  }
}

// ------------------------------
// MULTER CONFIG
// ------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads'),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// ==============================
// ROUTES
// ==============================

app.get('/ping', (req, res) => res.send('pong'));

// ----- User Profile -----
app.get('/api/user', authMiddleware, (req, res) => {
  const uid = req.user.localId;
  const users = getData(USERS_FILE);
  const user = users.find(u => u.uid === uid);
  res.json({ nickname: user ? user.nickname : null });
});

app.put('/api/user/token', authMiddleware, (req, res) => {
  const { fcmToken } = req.body;
  if (!fcmToken) return res.status(400).json({ error: 'fcmToken required' });
  const uid = req.user.localId;
  const users = getData(USERS_FILE);
  const user = users.find(u => u.uid === uid);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.fcmToken = fcmToken;
  saveData(USERS_FILE, users);
  res.json({ success: true });
});

// ----- Nickname Registration -----
app.post('/api/users', authMiddleware, (req, res) => {
  const { nickname } = req.body;
  if (!nickname || !nickname.trim()) return res.status(400).json({ error: 'Nickname required' });
  const uid = req.user.localId;
  let users = getData(USERS_FILE);
  if (users.some(u => u.nickname === nickname.trim() && u.uid !== uid))
    return res.status(409).json({ error: 'Nickname already taken' });
  const existing = users.find(u => u.uid === uid);
  if (existing) existing.nickname = nickname.trim();
  else users.push({ uid, nickname: nickname.trim() });
  saveData(USERS_FILE, users);
  res.json({ success: true, nickname: nickname.trim() });
});

// ----- Reports -----
app.post('/api/reports', authMiddleware, upload.single('photo'), (req, res) => {
  const { lat, lng, address, time } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
  const uid = req.user.localId;
  const users = getData(USERS_FILE);
  const user = users.find(u => u.uid === uid);
  const nickname = user ? user.nickname : 'Anonymous';

  const newReport = {
    id: uuidv4(),
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    imageUrl: `/uploads/${req.file.filename}`,
    address: address || 'Unknown',
    time: time || new Date().toLocaleString(),
    userId: uid,
    userName: nickname,
    comments: [],
    timestamp: Date.now(),
  };

  const reports = getData(REPORTS_FILE);
  reports.push(newReport);
  saveData(REPORTS_FILE, reports);
  // --- Send email notification about the new report ---
  const emailSubject = 'New trash report by ${nickname}';
  const emailBody = `A new trash location was reported:

    Address: ${address || 'Unknown'}
    User: ${nickname}
    Time: ${time || new Date().toLocaleString()}
    Coordinates: ${lat}, ${lng}
    Photo: https://cleansweep-backend.onrender.com${imageUrl};

  sendEmailNotification'(emailSubject, emailBody)';
  res.status(201).json(newReport);
});

app.get('/api/reports', (req, res) => {
  let reports = getData(REPORTS_FILE);
  reports = cleanReports(reports);
  saveData(REPORTS_FILE, reports);   // persist cleaned list
  res.json(reports);
});

// ----- Comments (with notification) -----
app.post('/api/reports/:id/comments', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Comment text required' });

  const uid = req.user.localId;
  const users = getData(USERS_FILE);
  const user = users.find(u => u.uid === uid);
  const author = user ? user.nickname : 'Anonymous';

  const reports = getData(REPORTS_FILE);
  const report = reports.find(r => r.id === id);
  if (!report) return res.status(404).json({ error: 'Report not found' });

  report.comments.push({ author, text, timestamp: Date.now() });
  saveData(REPORTS_FILE, reports);

  // Notify report owner (if not the same user)
  const owner = users.find(u => u.uid === report.userId);
  if (owner && owner.fcmToken && owner.uid !== uid) {
    const notifTitle = 'New comment on your report';
    const notifBody = `${author} commented: ${text}`;
    sendPushNotification(owner.fcmToken, notifTitle, notifBody, { reportId: id });
  }

  res.json(report);
});

// ----- Mark as Cleaned (with notification) -----
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
    timestamp: Date.now(),
  };
  report.deletionTime = Date.now() + CLEANED_DELAY;
  saveData(REPORTS_FILE, reports);

  // Notify original reporter
  const reporter = users.find(u => u.uid === report.userId);
  if (reporter && reporter.fcmToken) {
    const notifTitle = 'Your report was cleaned!';
    const notifBody = `${nickname} marked the trash at ${report.address || 'the location'} as cleaned.`;
    sendPushNotification(reporter.fcmToken, notifTitle, notifBody, { reportId: id });
  }

  res.json(report);
});

// ==============================
// START SERVER
// ==============================
app.listen(PORT, () => {
  console.log(`CleanSweep backend running on port ${PORT}`);
  // Initial cleanup
  let reports = getData(REPORTS_FILE);
  reports = cleanReports(reports);
  saveData(REPORTS_FILE, reports);
});
