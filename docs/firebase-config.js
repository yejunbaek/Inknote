/* Firebase settings for shared rooms.
 *
 * Leave this as-is and InkNote works exactly as before: every visitor keeps a
 * private notebook in their own browser and nothing is shared. Fill it in and
 * the Share button appears.
 *
 * Get these values from console.firebase.google.com:
 *   Project settings -> General -> Your apps -> Web app -> SDK setup
 *
 * These keys are meant to be public — they identify the project, they don't
 * grant access. Access is controlled by the Firestore security rules in
 * PUBLISHING.md. Treat them like a URL, not a password.
 */
window.INKNOTE_FIREBASE = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  appId: ''
};
