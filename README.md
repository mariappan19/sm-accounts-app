# SM Accounts app

A phone app for adding and checking SM Technologies office transactions. It saves straight into the **Office_Accounts_Master_2026** Google Sheet.

- `apps-script/Code.gs` is the backend. It runs inside the Google Sheet and is the only part that can read or write the sheet.
- `docs/` is the app itself. GitHub Pages publishes it, and you install it on your phone from there.
- `test/` holds local tests that run the real backend code against a copy of the sheet's layout.

## What the app does

| Screen | What it does |
|---|---|
| Home | Shows bank balance, card owed, net cash, card use and next due date, all read from the **App_Summary** tab |
| Add | Adds a row to **Transactions**. The dropdowns come from **Settings_&_Lists**. You can attach a receipt photo or PDF, which is saved in Drive under `Receipts/<yyyy-mm>/`. |
| Entries | Lists pending items (Pending / To Receive) and recent entries |
| More | Lock the app, forget the saved PIN, disconnect this phone |

The app fills in only the input columns (B, D–K, N–O, R–U). The sheet's own formulas calculate Txn ID, Month, GST Amount, Total, Card Due Date, Running Balance and Bank Movement.

## Step 1: Set up the backend (one time, about 5 minutes)

1. Open the Google Sheet and go to **Extensions → Apps Script**.
2. Delete what is in `Code.gs`, paste in the full contents of `apps-script/Code.gs` from this repository, then click **Save**.
3. Click **Project Settings** (the gear icon):
   - Set **Time zone** to *(GMT+05:30) India Standard Time*.
   - Under **Script Properties**, click **Add script property**. Set Property to `APP_PIN` and Value to a PIN of 4–12 digits. Don't reuse your bank or card PIN.
4. Go back to **Editor**, choose `testSetup` in the function menu and click **Run**.
   - Google asks for permission. Click **Review permissions**, choose your account, then **Advanced → Go to … (unsafe)** → **Allow**. The warning appears because you wrote the script yourself and Google hasn't reviewed it.
   - The log should list your summary figures, dropdown lists and `PIN set: true`.
5. Click **Deploy → New deployment**, then the gear icon → **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**. The app has no Google sign-in, so the PIN protects it. After 5 wrong PINs it blocks access for 15 minutes.
   - Click **Deploy** and copy the **Web app URL**. It ends in `/exec`.

**When you change the code later:** go to **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same.

## Step 2: Install on your phone

1. Open the app's GitHub Pages address (`https://<your-username>.github.io/<repo-name>/`) in **Chrome** on Android or **Safari** on iPhone.
2. Paste the Web app URL, enter your PIN and tap **Connect**.
3. Install it:
   - **Android:** menu ⋮ → **Add to Home screen → Install**, or tap **Install app** on the More tab.
   - **iPhone:** Share → **Add to Home Screen**.

The app opens full screen from its own icon.

### Optional: Android APK

Go to https://www.pwabuilder.com, enter the GitHub Pages address and choose **Package for stores → Android**. It builds an `.apk` file you can install directly.

## Rules that keep the sheet correct

- Don't delete rows in the middle of **Transactions**, and don't re-sort it. Txn IDs and the running balance follow row order.
- To add a new dropdown option, add it to its column in **Settings_&_Lists**. The app picks it up the next time it opens.
- The sheet holds up to 1,000 transactions. The app will tell you when it is full.

## Running the tests

```bash
node test/backend.test.js
```

```bash
node test/e2e.test.js
```

The end-to-end test needs Playwright with Chromium.
