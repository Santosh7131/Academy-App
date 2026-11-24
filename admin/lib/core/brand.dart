// Copied from app/lib/core/brand.dart by tools/sync-admin-ui.mjs. Edit the original, not this copy.
/// The product's name: the one place it is set. Both apps show it, both Android launcher labels are read from
/// this line by their android/app/build.gradle.kts, and the "is updated" notice uses the launcher label. The
/// server says it too, from api/src/lib/brand.ts. `node tools/rename-product.mjs "Name"` changes every copy at
/// once, and `node tools/rename-product.mjs --check` fails when any copy differs.
const appName = 'AnyTutor';

/// The developer's app, named after the product.
const adminAppName = '$appName Admin';

/// The Android app ids, read by both android/app/build.gradle.kts. A phone knows an app by its id, so an id can never change
/// once anyone has installed the app: set the final ids together with the final name, before the first release.
/// tools/release-app.ps1 refuses to release while the name is chosen but these are still the stand-in's.
const androidAppId = 'com.anytutor.app';
const adminAndroidAppId = 'com.anytutor.admin';
