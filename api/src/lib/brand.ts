/**
 * The product's name, as the API says it in its messages. It must match appName in app/lib/core/brand.dart:
 * `node tools/rename-product.mjs "Name"` changes every copy at once, and `--check` fails when one differs.
 */
export const APP_NAME = 'AnyTutor';

/**
 * The Android app id of the tutors' and students' app (androidAppId in app/lib/core/brand.dart), which a join link's page uses to
 * open the app; its test build is the same id with ".dev", which tools/dev-serve.mjs sets in APP_ID. The ids are changed
 * separately from the name (they can never change once phones have the app), so the rename tool leaves this alone.
 */
export const APP_ID = process.env.APP_ID?.trim() || 'com.anytutor.app';
