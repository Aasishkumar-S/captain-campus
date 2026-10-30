import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getDatabase, connectDatabaseEmulator } from 'firebase/database';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'mock-api-key',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'captain-campus-dev.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'captain-campus-dev',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'captain-campus-dev.appspot.com',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '1234567890',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:1234567890:web:abcdef123456',
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL || 'https://captain-campus-dev-default-rtdb.firebaseio.com',
};

// Initialize Firebase once
export const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const rtdb = getDatabase(app);

// Connect to Emulators if flagged
const useEmulator = import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true';

if (useEmulator && typeof window !== 'undefined') {
  // Check if emulators haven't been connected yet (avoid re-connecting on hot reload)
  const emulatorsConnectedKey = '__FIREBASE_EMULATORS_CONNECTED__';
  if (!(window as unknown as Record<string, boolean>)[emulatorsConnectedKey]) {
    try {
      connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
      connectFirestoreEmulator(db, 'localhost', 8080);
      connectDatabaseEmulator(rtdb, 'localhost', 9000);
      (window as unknown as Record<string, boolean>)[emulatorsConnectedKey] = true;
      console.log('Connected to Firebase Emulators (Auth: 9099, Firestore: 8080, RTDB: 9000)');
    } catch (e) {
      console.warn('Firebase emulator connection warning:', e);
    }
  }
}
