const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const admin = require('firebase-admin');
const { GoogleAuth } = require('google-auth-library');

// ------------------------------
//  CONFIG
// ------------------------------
const FIREBASE_PROJECT_ID = 'cleansweepsg-f6340';
const STORAGE_BUCKET = 'cleansweepsg-f6340.firebasestorage.app'; // verify this matches Firebase Console > Storage

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------------------
// FIREBASE ADMIN SETUP
// Uses the full service account credential (not just a messaging-scoped
// token) so it can reach Firestore and Storage as well as FCM.
// ------------------------------
let db = null;
let bucket = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id || FIREBASE_PROJECT_ID,
      storageBucket: STORAGE_BUCKET,
    });
    db = admin.firestore();
    bucket = admin.storage().bucket();
    console.log('🔥 Firebase Admin initialized (Firestore + Storage + Messaging)');
  } catch (e) {
    console.error('❌ Firebase Admin init error:', e);
  }
} else {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT env var missing — Firestore/Storage will not work');
}

// ------------------------------
// MIDDLEWARE
// ------------------------------
app.use(cors());
app.use(express.json());

// Expiry constants
const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
const CLEANED_DELAY = 24 * 60 * 60 * 1000;

// ------------------------------
// FIRESTORE HELPERS
// ------------------------------
const usersCol = () => db.collection('users');
const reportsCol = () => db.collection('reports');
const sponsorStatsCol = () => db.collection('sponsorStats');

async function getUserByUid(uid) {
  const doc = await usersCol().doc(uid).get();
  return doc.exists ? { uid, ...doc.data() } : null;
}

async function getAllReports() {
  const snap = await reportsCol().get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ------------------------------
// STORAGE HELPER — uploads a photo buffer, returns its public URL
// ------------------------------
async function uploadPhoto(fileBuffer, originalname, mimetype) {
  const filename = `uploads/${uuidv4()}${path.extname(originalname || '') || '.jpg'}`;
  const file = bucket.file(filename);
  const downloadToken = uuidv4();
  await file.save(fileBuffer, {
    metadata: {
      contentType: mimetype,
      metadata: { firebaseStorageDownloadTokens: downloadToken },
    },
    resumable: false,
  });
  const encodedPath = encodeURIComponent(filename);
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${downloadToken}`;
}

// ------------------------------
// AUTO-CLEANUP: remove old/expired reports
// ------------------------------
async function cleanOldReports() {
  const now = Date.now();
  const reports = await getAllReports();
  const batch = db.batch();
  let deletedCount = 0;

  for (const r of reports) {
    if (!r.timestamp) continue; // keep legacy reports with no timestamp
    let shouldDelete = false;

    if (r.cleaned && r.deletionTime && now > r.deletionTime) {
      shouldDelete = true;
      console.log('[CLEANED] Removing report ' + r.id + ' - 24h after cleaning');
    } else if (!r.cleaned && (now - r.timestamp > ONE_WEEK)) {
      shouldDelete = true;
      console.log('[OLD] Removing report ' + r.id + ' - older than 1 week');
    }

    if (shouldDelete) {
      batch.delete(reportsCol().doc(r.id));
      deletedCount++;
    }
  }

  if (deletedCount > 0) await batch.commit();
  return deletedCount;
}

// ------------------------------
// AUTH MIDDLEWARE (Firebase REST verification — unchanged)
// ------------------------------
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer '))
    return res.status(401).json({ error: 'Unauthorized' });

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const apiKey = process.env.FIREBASE_API_KEY;
    if (!apiKey) throw new Error('Missing FIREBASE_API_KEY');

    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
    );
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    req.user = data.users[0]; // contains localId, email, etc.
    next();
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ------------------------------
// PUSH NOTIFICATION HELPERS (unchanged logic, still via FCM REST)
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
        data: Object.fromEntries(Object.entries(dataPayload).map(([k, v]) => [k, String(v)])),
      },
    };

    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
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
// BREVO EMAIL NOTIFICATION FUNCTION (unchanged)
// ------------------------------
async function sendEmailNotification(subject, text) {
  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  if (!BREVO_API_KEY) {
    console.warn('Brevo API key missing, skipping email');
    return;
  }

  const payload = {
    sender: { name: 'CleanSweep SG', email: process.env.BREVO_SENDER_EMAIL || 'noreply@cleansweep.sg' },
    to: [{ email: 'groqclaw@gmail.com', name: 'NEA Officer' }],
    subject: subject,
    textContent: text,
  };

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
      body: JSON.stringify(payload),
    });
    if (response.ok) console.log('Email sent via Brevo');
    else console.error('Brevo email error:', await response.json());
  } catch (err) {
    console.error('Email send error:', err);
  }
}

// ------------------------------
// MULTER CONFIG — buffered in memory, then pushed to Firebase Storage
// ------------------------------
const upload = multer({ storage: multer.memoryStorage() });

// ==============================
// ROUTES
// ==============================

app.get('/ping', (req, res) => res.send('pong'));

// ----- User Profile -----
app.get('/api/user', authMiddleware, async (req, res) => {
  try {
    const user = await getUserByUid(req.user.localId);
    res.json({ nickname: user ? user.nickname : null });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/user/token', authMiddleware, async (req, res) => {
  const { fcmToken } = req.body;
  if (!fcmToken) return res.status(400).json({ error: 'fcmToken required' });
  try {
    const uid = req.user.localId;
    const userDoc = usersCol().doc(uid);
    const snap = await userDoc.get();
    if (!snap.exists) return res.status(404).json({ error: 'User not found' });
    await userDoc.update({ fcmToken });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ----- Nickname Registration -----
app.post('/api/users', authMiddleware, async (req, res) => {
  const { nickname } = req.body;
  if (!nickname || !nickname.trim()) return res.status(400).json({ error: 'Nickname required' });
  try {
    const uid = req.user.localId;
    const trimmed = nickname.trim();

    const existingDoc = await usersCol().doc(uid).get();
    if (existingDoc.exists) {
      return res.status(409).json({ error: 'Nickname already set and cannot be changed.' });
    }

    const dupSnap = await usersCol().where('nickname', '==', trimmed).limit(1).get();
    if (!dupSnap.empty) return res.status(409).json({ error: 'Nickname already taken' });

    await usersCol().doc(uid).set({
      nickname: trimmed,
      email: req.user.email || null,
      createdAt: Date.now(),
      role: 'user',
    });

    res.status(201).json({ uid, nickname: trimmed });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ----- Reports -----
app.post('/api/reports', authMiddleware, upload.single('photo'), async (req, res) => {
  const { lat, lng, address, time } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
  try {
    const uid = req.user.localId;
    const user = await getUserByUid(uid);
    const nickname = user ? user.nickname : 'Anonymous';

    const imageUrl = await uploadPhoto(req.file.buffer, req.file.originalname, req.file.mimetype);

    const newReport = {
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      imageUrl,
      address: address || 'Unknown',
      time: time || new Date().toLocaleString(),
      userId: uid,
      userName: nickname,
      comments: [],
      timestamp: Date.now(),
    };

    const docRef = await reportsCol().add(newReport);
    const savedReport = { id: docRef.id, ...newReport };

    const emailSubject = `New trash report by ${nickname}`;
    const emailBody = `A new trash location was reported:

    Address: ${address || 'Unknown'}
    User: ${nickname}
    Time: ${time || new Date().toLocaleString()}
    Coordinates: ${lat}, ${lng}
    Photo: ${imageUrl}`;
    sendEmailNotification(emailSubject, emailBody);

    res.status(201).json(savedReport);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/reports', async (req, res) => {
  try {
    await cleanOldReports();
    const reports = await getAllReports();
    res.json(reports);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ----- Comments (with notification) -----
app.post('/api/reports/:id/comments', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Comment text required' });
  try {
    const uid = req.user.localId;
    const user = await getUserByUid(uid);
    const author = user ? user.nickname : 'Anonymous';

    const reportDoc = reportsCol().doc(id);
    const reportSnap = await reportDoc.get();
    if (!reportSnap.exists) return res.status(404).json({ error: 'Report not found' });
    const report = reportSnap.data();

    const comment = { author, text, timestamp: Date.now() };
    await reportDoc.update({ comments: admin.firestore.FieldValue.arrayUnion(comment) });

    if (report.userId !== uid) {
      const owner = await getUserByUid(report.userId);
      if (owner && owner.fcmToken) {
        sendPushNotification(owner.fcmToken, 'New comment on your report', `${author} commented: ${text}`, { reportId: id });
      }
    }

    res.json({ id, ...report, comments: [...(report.comments || []), comment] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ----- Mark as Cleaned (with notification) -----
app.post('/api/reports/:id/cleaned', authMiddleware, upload.single('photo'), async (req, res) => {
  const { id } = req.params;
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
  try {
    const uid = req.user.localId;
    const user = await getUserByUid(uid);
    const nickname = user ? user.nickname : 'Anonymous';

    const reportDoc = reportsCol().doc(id);
    const reportSnap = await reportDoc.get();
    if (!reportSnap.exists) return res.status(404).json({ error: 'Report not found' });
    const report = reportSnap.data();

    const cleanedImageUrl = await uploadPhoto(req.file.buffer, req.file.originalname, req.file.mimetype);
    const cleaned = { imageUrl: cleanedImageUrl, userName: nickname, timestamp: Date.now() };
    const deletionTime = Date.now() + CLEANED_DELAY;

    await reportDoc.update({ cleaned, deletionTime });

    if (report.userId !== uid) {
      const reporter = await getUserByUid(report.userId);
      if (reporter && reporter.fcmToken) {
        sendPushNotification(reporter.fcmToken, 'Your report was cleaned!', `${nickname} marked the trash at ${report.address || 'the location'} as cleaned.`, { reportId: id });
      }
    }

    res.json({ id, ...report, cleaned, deletionTime });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ----- Sponsor Stats -----
app.post('/api/sponsors/view', async (req, res) => {
  const { sponsorId } = req.body;
  if (!sponsorId) return res.status(400).json({ error: 'sponsorId required' });
  try {
    await sponsorStatsCol().doc(sponsorId).set(
      { views: admin.firestore.FieldValue.increment(1), clicks: admin.firestore.FieldValue.increment(0) },
      { merge: true }
    );
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/sponsors/click', async (req, res) => {
  const { sponsorId } = req.body;
  if (!sponsorId) return res.status(400).json({ error: 'sponsorId required' });
  try {
    await sponsorStatsCol().doc(sponsorId).set(
      { clicks: admin.firestore.FieldValue.increment(1), views: admin.firestore.FieldValue.increment(0) },
      { merge: true }
    );
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/sponsors/stats', async (req, res) => {
  try {
    const snap = await sponsorStatsCol().get();
    const stats = {};
    snap.docs.forEach(d => { stats[d.id] = d.data(); });
    res.json(stats);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ----- Report user or photo -----
app.post('/api/report', authMiddleware, async (req, res) => {
  const { type, reportId, reportedUserName, imageUrl } = req.body;
  if (!type || !reportId) return res.status(400).json({ error: 'Missing report details' });
  try {
    const uid = req.user.localId || req.user.uid;
    const reporter = await getUserByUid(uid);
    const reporterNickname = reporter ? reporter.nickname : 'Anonymous';

    let subject, body;
    if (type === 'user') {
      subject = 'User Report: ' + reportedUserName;
      body = 'User ' + reporterNickname + ' reported user: ' + reportedUserName + '\nReport ID: ' + reportId;
    } else {
      subject = 'Photo Report: Report ID ' + reportId;
      body = 'User ' + reporterNickname + ' reported this photo:\n' + imageUrl;
    }

    await sendEmailNotification(subject, body);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ==============================
// START SERVER
// ==============================
app.listen(PORT, async () => {
  console.log(`CleanSweep backend running on port ${PORT}`);
  if (db) {
    try {
      const deleted = await cleanOldReports();
      console.log(`Startup cleanup: removed ${deleted} expired report(s)`);
    } catch (e) { console.error('Startup cleanup failed:', e); }
  }
});
