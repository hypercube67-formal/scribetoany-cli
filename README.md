# scribetoany

Transcribe audio and video files from the command line with
[ScribeToAny](https://scribetoany.com): text with timestamps, SRT or VTT
subtitles, speaker labels, 99 languages. Built for coding agents (Claude
Code, Codex, Gemini CLI, Cursor) as much as for people.

```bash
npm i -g scribetoany          # or: npx scribetoany …
scribetoany auth login        # opens the browser once
scribetoany transcribe meeting.m4a --format srt --speakers
```

Agent skill: `npx skills add scribetoany/skills --skill scribetoany`.

## Commands

| Command | |
|---|---|
| `auth login [--no-browser]` | Sign in with your ScribeToAny account (OAuth in the browser) |
| `auth logout` | Revoke the token and forget it |
| `auth status` | Show the signed-in account |
| `transcribe <file\|url>…` | Upload (or import a public link), wait, save `./<name>.<format>` |
| `get <id> [--wait]` | Save a finished transcript in any format |
| `list [--query q] [--limit n]` | Recent transcripts |
| `usage` | Plan, files today, minutes left this month |

Run `scribetoany --help` for every option. Results go to stdout, progress to
stderr; `--json` gives machine-readable output.

Exit codes: 0 ok, 2 bad input, 3 not signed in, 4 plan limit, 5
transcription failed, 6 network or server error, 7 not ready yet.

## Sign-in and credentials

`auth login` opens ScribeToAny in your browser, where you sign in and allow
"ScribeToAny CLI" (OAuth with PKCE; the browser hands the result back to the
CLI on your own machine).
Tokens are stored in `~/.config/scribetoany/credentials.json` (mode 0600;
`%APPDATA%\scribetoany` on Windows). The access token lasts an hour and is
refreshed automatically; the refresh token expires after 30 days unused.

Environment: `SCRIBETOANY_BASE_URL` (server), `SCRIBETOANY_TOKEN` (use this
access token instead of the stored one), `SCRIBETOANY_CONFIG_DIR`.
