# Javuno

Javuno is a collaborative project-management app for organizing work on boards. Create and manage cards, organize them into lists, track activity, and collaborate with board members.

## Requirements

- Node.js 20.19+ or 22.12+
- A Firebase project with Authentication and Cloud Firestore enabled

## Run locally

1. Install dependencies:

   ```sh
   npm install
   ```

2. Configure the Firebase client settings in `src/firebase.js` for your Firebase project.
3. Start the development server:

   ```sh
   npm run dev
   ```

## Firebase

The Firestore security rules are in `firestore.rules`. Review them and deploy them to your Firebase project before using the app with real users. The Firebase web configuration in `src/firebase.js` is client-side configuration, not a server credential; restrict its API key to the intended services and domains in Google Cloud.

## Checks

```sh
npm run lint
npm run build
```
