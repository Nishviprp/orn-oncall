# ORN Global – ON CALL (multi-hospital, Stage 1)

On call scheduling for many hospitals and departments, across US states and time zones. Each department sets its own rules on screen; no code changes are needed. It runs on Cloudflare Workers with a Supabase database.

---

## What's new in Stage 1

| | Before | Now |
|---|---|---|
| Hospitals and departments | One department | Any number of organizations → hospitals (any US state) → departments |
| Call times | Fixed in code | Set per department: name, start/end (overnight and 24 h calls are fine), days of the week, first/second/third call |
| Shifts and who can take which call | Fixed (7a–3p, 11a–7p) | Set per department, with a "who can take each call" grid: **Can sign up**, **Vacancies only**, or **No** |
| Periods, groups, minimum hours | Fixed (6 weeks, A/B, 24 h) | Per department: period length, minimum hours, any number of groups (or none), days between groups, sign-up time, how long sign-up stays open, or **sign up any time** |
| Reminders, release cutoff, switch approval | Fixed | Per department: morning reminder hour, minutes-before reminder, release cutoff, and whether switches need manager approval |
| Time zones | Eastern only | Per hospital (set from the state, can be changed); everything follows it |
| Roles | Staff, manager | Staff, department manager, **hospital admin**, **organization admin**, **system admin** |
| A nurse in two departments | – | One sign-in; a department picker; My calls shows every department; a nurse can't hold overlapping calls anywhere |
| Adding staff | One at a time | One at a time, or **paste a list** (from a spreadsheet) |

Department templates give a quick start, and everything stays editable afterwards:
- **OR call sheet:** your department's current rules.
- **24-hour weekend call:** Saturday and Sunday, 7 AM to 7 AM.
- **Simple evening call:** sign up any time.
- **Blank.**

Everything from before still works: email/phone sign-in, slots that fill only once, confirmations, reminders, switches with approval, stay/released notices, the hours report and printing.

---

## Who does what

| Role | How they get it | Can do |
|---|---|---|
| **System admin** (you) | A SQL line, once (Step 4) | Everything: organizations, hospitals, departments, admins |
| **Organization admin** | Admin tab → Add admin | Hospitals and departments in that organization; add org/hospital admins there |
| **Hospital admin** | Admin tab → Add admin | Create and manage departments in that hospital |
| **Department manager** | Tick "Nurse manager" on the department's Staff list | Settings, staff, periods, hours, today's stay/released, switch approvals for that department |
| **Staff** | On a department's Staff list | Sign up, give away, release, print |

Admins can manage departments without being on their staff list.

---

## Files

```
public/oncall/index.html, app.js, styles.css    the page
public/oncall/js/core.js      shared helpers and the form dialog
public/oncall/js/staff.js     Sign up, My calls, Switches
public/oncall/js/manage.js    Manage: Today, Periods, Hours, Staff, Settings
public/oncall/js/admin.js     Admin: organizations, hospitals, departments, admins
src/worker.mjs                Cloudflare entry: page, API, schedule
src/routes.mjs                staff API and switches
src/manage.mjs                manager API, including all Settings
src/admin.mjs                 admin API
src/dept.mjs                  the rules engine (reads each department's settings)
src/access.mjs                who can see and change what
src/messages.mjs              email and text wording
src/templates.mjs             department templates
src/reminders.mjs             every-10-minute job: reminders, notices, switch expiry
supabase/schema.sql           database (run first)
supabase/migrate-from-v3.sql  only if you already ran the earlier version
supabase/staff-roster.csv     your department's roster, ready to fill in and paste
tests/                        49 automated checks (npm test) and a local preview server
```

---

## Launch steps

### 1. Database (Supabase)
1. Create a project at https://supabase.com, in region **East US**.
2. Open **SQL Editor**, paste all of `supabase/schema.sql`, and click **Run**.
3. Under **Project Settings → API**, copy the Project URL, the **anon** key and the **service_role** key. The service_role key is secret.

> **Already ran the earlier version?** After `schema.sql`, open `supabase/migrate-from-v3.sql`, edit the four names at the top (organization, hospital, state, department), and run it once. Your staff, periods, sign-ups and switches move into one department. The old tables stay in place until you delete them.

### 2. Email (Resend)
1. Sign up at https://resend.com and add the domain `ornglobal.com`.
2. Add the DNS records it shows, then verify.
3. Create an API key.

### 3. Sign-in emails
1. In Supabase, open **Authentication → Emails → SMTP Settings** and enter:
   - Host `smtp.resend.com`, port `465`, user `resend`
   - Password: your Resend API key
   - Sender: `oncall@ornglobal.com`
2. In the **Magic Link**, **Confirm signup** and **Change Email Address** templates, show the code with `{{ .Token }}`.
3. Under **URL Configuration**, set **Site URL** to your ON CALL address.

### 4. Make yourself the system admin
In the SQL Editor, put in your own name and email, then run:
```sql
insert into public.oc_admins (scope, full_name, email) values ('system', 'Your Name', 'you@example.com');
```

### 5. Deploy to Cloudflare
```
npm install
npx wrangler login
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put RESEND_API_KEY
npm run deploy
```
Before deploying, set `SITE_URL` in `wrangler.toml` to the address people will use. To use `oncall.ornglobal.com`, move the domain's DNS to Cloudflare and add it under **Workers → orn-oncall → Domains & Routes**.

### 6. Set up your first hospital and department (in the app)
1. Sign in with your email, enter your name, and open the **Admin** tab.
2. Click **Add organization**, e.g. your health system.
3. Click **Add hospital** and choose the state. The time zone fills in automatically.
4. Click **Add department**:
   - Pick a template, e.g. **OR call sheet**.
   - Enter the first nurse manager's name and email.
5. The department opens on **Manage**. Under **Settings**, check or adjust:
   - general rules
   - call times
   - shifts
   - who can take each call
6. Under **Staff**, click **Paste a list**. For your current department, open `supabase/staff-roster.csv`, replace `EMAIL-OR-MOBILE` and `SHIFT` (`7a–3p` or `11a–7p`) for each person, and paste it in.
7. Under **Periods**, open the first period. Staff are emailed when their group's sign-up opens.

Add more hospitals and departments the same way, in any state. Each department can be completely different.

### 7. Texts and phone sign-in (after Twilio approval)
1. Add the Twilio secrets: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and either `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM`.
2. In Supabase, turn on the **Phone** provider with Twilio.
3. Set `PHONE_LOGIN_ENABLED = "true"` in `wrangler.toml` and redeploy.

---

## Changing rules later (managers)

**Manage → Settings** has four sections:

- **General rules:** department name; how staff sign up (in periods or any time); period length; minimum hours; groups; days between groups; sign-up open time; how long sign-up stays open; release cutoff; reminder times; whether switches need approval. A summary line shows what the rules mean in plain words before you save.
- **Call times:** add, edit, turn off or delete.
  - Ends earlier than it starts → it ends the next day.
  - Same start and end → a 24-hour call.
  - Existing sign-ups keep their times when you change a call time, and the app tells you how many are affected.
  - A call time with past sign-ups is turned off instead of deleted, so history is kept.
  - You can't remove a second or third call while upcoming sign-ups use it.
- **Shifts:** add, rename, remove. Without shifts, anyone on the staff list can take any call.
- **Who can take each call:** a grid of call times × shifts.

Changes apply to new periods and new sign-ups. Periods already opened keep their dates and group order.

---

## Testing before you announce it

Developers can run:
- `npm test`: 49 checks, including a full end-to-end run through the real API on a test database. It covers admin setup, settings changes, sign-ups, switches, reminders, a second hospital in California, and the migration.
- `npm run preview`: the full app at http://localhost:8787/oncall/ with sample data, no Supabase needed. Sign-in is simulated, so use it for clicking through screens, not for real sign-in.

Then on the live site, with two test nurses and yourself:
1. Create a test department.
2. Change a call time.
3. Open a period that's already open for sign-up.
4. Sign up as each nurse.
5. Give a call away and approve the switch.
6. Send a "released" notice.
7. Check the hours report.
8. Turn the test department off.

## Security
- Every table has row-level security with no browser access. All reads and writes go through the Worker, which checks the person's role for that specific department, hospital or organization on every request.
- A manager can only change their own departments, and a hospital admin only their own hospital. Managers can't remove their own manager access or approve their own switches.
- The database itself blocks double-booked slots and overlapping calls for one person.
- Secrets are stored as Cloudflare secrets. No patient data is stored.

## Troubleshooting
| Problem | Check |
|---|---|
| No Admin tab | Your email must be in `oc_admins` exactly as you sign in (lowercase) |
| A nurse sees "not on any staff list" | Add their email or mobile on the department's Staff list |
| Slots say "Not open yet" | Open a period (Manage → Periods), or switch the department to "Any time" |
| Slots say "Shift not set" | Set the nurse's shift on the Staff list |
| A shift can't take a call | Manage → Settings → Who can take each call |
| Reminders at the wrong hour | Check the hospital's time zone (Admin → Edit hospital) |
| No emails | Resend domain verified, `RESEND_API_KEY` set; Cloudflare Logs |
