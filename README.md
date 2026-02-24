# Punxsutawney Borough Council Documents Site

A static website for publishing public documents in custom groups (example: `Budgets` with annual budget files).

- Public users can browse all published documents.
- Signed-in admins can add/rename/delete groups.
- Signed-in admins can add/upload/rename/delete documents inside groups.

## Why this works on GitHub Pages

GitHub Pages can host static files, but it cannot run server-side code.

This project uses:
- Firebase Authentication for login.
- Cloud Firestore for storing groups/documents.
- Cloud Storage for uploaded document files.

So the site can be hosted on GitHub Pages while the data/auth live in Firebase.

## File overview

- `index.html`: page structure
- `styles.css`: visual design
- `app.js`: Firebase + CRUD logic
- `firebase-config.js`: your Firebase app settings and admin email allowlist
- `firestore.rules`: Firestore security rules template
- `storage.rules`: Cloud Storage security rules template

## Setup

1. Create a Firebase project at [Firebase Console](https://console.firebase.google.com/).
2. In Firebase, create a **Web app** and copy the config values.
3. Enable **Authentication** with **Google** sign-in.
4. Add the Google account email(s) you want as admins to `adminEmails` in `firebase-config.js`.
5. Enable **Cloud Firestore** and **Cloud Storage** in production mode.
6. Edit `firebase-config.js`:
   - paste your Firebase config
   - replace `adminEmails` with the real admin email(s)
7. Edit `firestore.rules` and `storage.rules` to match your admin email(s), then publish rules:
   - Install Firebase CLI
   - Run `firebase login`
   - Run `firebase init firestore storage` (if needed)
   - Run `firebase deploy --only firestore:rules,storage`
8. Serve locally to test:
   - `python3 -m http.server 8080`
   - open `http://localhost:8080`

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. In GitHub repository settings, enable GitHub Pages with **GitHub Actions** as the source.
3. The workflow is already included at `.github/workflows/pages.yml`.
4. Every push to `main` will deploy the static site.

## Notes on document storage

Admins upload files from the admin panel, and each document entry stores a public download URL in Firestore.
