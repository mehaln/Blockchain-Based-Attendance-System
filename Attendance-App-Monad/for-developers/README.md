# Attendance App: developer notes

The teacher never needs this folder. It holds the contract source, tests and the build step.

## How it works

- `contracts/ClassAttendance.sol` has one contract per class. The website deploys it from
  the teacher's MetaMask ("Create my class"), so the deployer wallet becomes the teacher.
  No private keys or `.env` files are involved.
- The class address travels in the link (`?class=0x…`). The browser also remembers the
  classes you have opened (`localStorage`, key `attendance:classes`).
- Students are added by the teacher with `addStudents(wallets[], names[])`. Any MON sent
  with that call is split equally between them as gas money. Alternatively, students join
  themselves with `joinClass(name)` while `enrolmentOpen` is on.
- `markAttendance()` and `checkAttendance(student, sessionId)` are the core functions,
  plus `getAttendanceCount`, `startSession` and `endSession`. `getClassInfo()` returns
  everything the page polls every 6 s in a single call.

## Commands

```powershell
npm install        # once
npm test           # 16 contract tests
npm run build      # compile and write ../attendance-app/contract.js (ABI + bytecode)
```

Run `npm run build` after changing the contract. The website is plain static files in
`../attendance-app/` (network settings are in `config.js`) and has no build step of its own.

## Verified

- 16/16 contract tests.
- 37/37 browser checks against a local chain: create class, bulk add with gas money, the
  "Add students" preview catching bad lines, typing kept while the page auto-refreshes,
  start and end lecture, one-click marking, self-join, HTML escaping of names, CSV export,
  top-up, removing a student, teacher-only rules, the no-wallet and phone layouts, and
  broken-link handling.
- A real end-to-end run on **Monad Testnet** (29 Sep 2026) through the actual website:
  class `0x58282acff9158C746516879FCB3739E8C3641EC2`. A student marked present using only
  the gas money the teacher sent.

Measured costs (at about 102 gwei; Monad charges the full gas limit):

| Action | Gas | Test MON |
|---|---|---|
| Create class (deploy) | 2,126,241 | ~0.217. The wallet must hold about 0.43 at that moment (limit × max fee) |
| addStudents (1 student) | 238,230 | ~0.024, plus the gas money sent |
| startSession / endSession | 134,441 / 63,023 | ~0.014 / ~0.006 |
| joinClass | 174,769 | ~0.018 |
| markAttendance | 100,155 to 117,223 | ~0.010 to 0.012. The wallet must hold about 0.024 |

## Hosting

`../tools/deploy-vercel.ps1` runs `npx vercel@latest deploy ../attendance-app --prod --yes` (using the laptop's Node.js 20+, or a private copy it downloads once into `%LOCALAPPDATA%\AttendanceApp`)
after a `whoami` or `login` check. The Vercel project is named after the folder
(`attendance-app`). `../tools/serve.ps1` is a dependency-free PowerShell static server
for local use on port 5510.
