// Firebase configuration.
// Values come from Vite env vars (see .env.example). No secrets are committed:
// copy .env.example to .env and fill in your own project's values.
// Until the config is present, the app runs in demo mode (local rules, no AI).

const env = import.meta.env

export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || '',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || '',
  projectId: env.VITE_FIREBASE_PROJECT_ID || '',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: env.VITE_FIREBASE_APP_ID || '',
}

export const recaptchaSiteKey = env.VITE_RECAPTCHA_SITE_KEY || ''
export const appCheckDebug = env.VITE_APPCHECK_DEBUG === 'true'

export function isFirebaseConfigured() {
  return Boolean(
    firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId,
  )
}
