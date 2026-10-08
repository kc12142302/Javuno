import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";


const firebaseConfig = {
  apiKey: "AIzaSyCzRHe11oOoZpAMeo3CCpXl-Hbly0ovIY0",
  authDomain: "javuno-2839a.firebaseapp.com",
  projectId: "javuno-2839a",
  storageBucket: "javuno-2839a.firebasestorage.app",
  messagingSenderId: "405194395330",
  appId: "1:405194395330:web:62297f8277fcfc0fdeb55b"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

export default app;