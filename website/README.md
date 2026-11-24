# The website

The public website where tutors read about the app and open it: the home page (`index.html`), a
privacy policy and terms of use (both drafts), and a page for addresses that do not exist (`404.html`).
It goes online with the web app, which sits under `app/` on the same address: Log in and Start free
open it there (`app/#/login`, `app/#/signup`).

Plain HTML and one stylesheet in the app's own look (its colours, its Geist fonts, its soft cards).
No scripts, no cookies, no tracking, no build step, and nothing on any page moves. Light and dark
follow the visitor's phone or computer, and every app picture has a dark copy.

## Look at it locally

```powershell
python -m http.server 8099 --directory website
```

Then open http://127.0.0.1:8099/.

## Before it goes online

Everything still to be filled in is marked on the pages: `FILL-IN` in the text, shown in orange.

1. **The plan prices.** Basic and Pro say "Price soon", as the app does, until their prices are set
   in the developer app (Settings, Plans); a comment in the Pricing section says what to write then.
2. **The contact email**, in the footer of every page (a comment on the home page, until there is one)
   and in the privacy policy and terms.
3. **The privacy policy and terms** (`privacy.html`, `terms.html`). They are drafts. They describe
   what the app really does, checked against the code, and leave every decision (refunds, the law,
   parents' consent, how long payment records are kept, who runs the business) as a `FILL-IN`. Have
   a lawyer check them before tutors sign up, then remove the orange "Draft" box.
4. **The names in the pictures.** The app pictures come from the app's screen tests and show sample
   names (a tuition called Priya Maths Classes, a student called Harini Venkatesh, and so on). They
   date from the app's first design work. Make sure none of them is a real person before publishing.
5. **The product's name** is AnyTutor (chosen on 24 November 2026). To change it,
   `node tools/rename-product.mjs "New Name"` renames the apps, the server's messages and these
   pages in one go, and `--check` says whether they agree.

## Online, with the web app

`.github/workflows/web-app.yml` puts this folder on Cloudflare Pages together with the web app: these
pages at the address itself and the app under `app/`. Every push to main that touches the website or
the app updates the dev site, https://dev.anytutor.pages.dev (kept out of search engines by Cloudflare);
the live one, https://anytutor.pages.dev, is a run started by hand once the live server is up. This
README stays out of the upload.

`404.html` carries its own styles, so it still looks right for a missing address deep inside the
site. Its link back to the home page is relative, which is right for an address one level down.

## Redraw the pictures

After the app's screens change, draw them again (in `app/`: `SHOTS=1 flutter test test/shots/screens_test.dart`),
then:

```powershell
python tools/website-pictures.py
```

It needs Python with Pillow. It cuts each phone screen to 1080 × 2400 from the top and scales it to 540
wide, scales the pictures of the app on a computer (`desk-*`, from the test "desk: the app on a computer")
to 2400 wide, and copies the app's icon and fonts here. `--desk` makes the computer pictures alone.

## What the pages claim, and where it was checked (22 November 2026)

Re-check these when the app changes.

- **Runs in a browser, nothing to install:** the web version (the main README, "The web version"), on a computer, a
  tablet or a phone. A window at least 1024 wide gets the sidebar (`app/lib/ui/desk.dart`). The page no longer offers
  the Android app: its download link waits for a release (`tools/release-app.ps1`).
- **A PDF of up to 20 pages:** the paper source "Pick a PDF · Up to 20 pages".
- **English, Hindi and Tamil papers; a printed answer key comes first; two AI models answer and a third settles a tie.**
- **What waits for the tutor:** AI answers that disagree, a figure AI needs, a part it could not read (the paper check screen).
- **Opening and closing times, a time limit, and "Mix the questions up for each student"** (a switch, so "if you choose").
- **Marks and the right answers as soon as a student hands in** (the test settings screen says so).
- **The student page:** average marks, weakest chapters, tests written and missed.
- **Students make their own accounts**, with a username and password (`app/lib/features/auth/signup_screen.dart`; Google too in the Android app, `google_flow.dart`, not yet in a browser), and ask to join with the tuition's code, or the link or QR code a tutor shares for a group or course (`app/lib/features/teacher/invite_screen.dart`); a tutor lets them in. The app keeps no email address (`api/src/lib/google.ts` keeps only Google's account number and the name).
- **Invite students with a link or a QR code:** Invite students on a group's or course's page.
- **Other tutors** are added from the app, each with a login of their own.
- **Plans:** Free (20 students, 1 tutor, ₹20 of AI to start), Basic (100 students, 3 tutors, ₹300 of AI a month) and Pro (300 students, 10 tutors, ₹900 of AI a month), from `api/migrations/040_plans.sql`. Sizes and prices are set in the developer app (Settings, Plans); **the Pricing section's plan prices are FILL-INs until they are set there**, and when anything changes, change the Pricing section too.
- **AI prices:** ₹2.40 a page, ₹0.60 a question, ₹0.40 a worked solution (`credit_*_paise` in the developer app's AI credit settings).
- **No top-ups:** AI credit is not sold on its own; more AI comes with a bigger plan or the plan's next month (`plans_only` in `api/src/routes/credit.ts`).
- **Only finished work is charged:** a page is charged in the same step that saves its questions.
- **The owner can delete the tuition** from Settings, with their password; the app shows the credit that will be lost and a plan that ends with it, and waits while a plan payment is still to be checked.
- **The app updates itself** after the first install.
- **Not claimed:** push notifications (they need Firebase, which is not set up) and particular classes or boards.

The privacy policy's facts come from the database tables and the server's code: no email addresses,
phone numbers or IP addresses are kept; passwords are kept as salted hashes; sign-in records
are deleted after 90 days and server error records after 30. That deletion runs whenever the
developer app shows its Overview tab (`GET /admin/overview`), the tab it opens on, so it happens
each time you open the developer app.
