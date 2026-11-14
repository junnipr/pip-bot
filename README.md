# Pip Discord Bot: Beginner Setup

Pip is your RP activity-check and staff audit bot. You do **not** upload these files to the Discord Developer Portal. The Portal gives you the bot token and invites the bot; Node.js runs it on your computer.

## Contents
- `bot.js`: Pip's actual bot script
- `package.json`: dependencies and `npm start` command
- `.env.example`: template for your secret token; rename to `.env`
- `.gitignore`: helps keep tokens and config out of Git
- `START-PIP-WINDOWS.bat`: easy Windows launcher
- `README.md`: these instructions

## Windows: Start Pip
1. Install Node.js **24.17.0 or later** from https://nodejs.org/ . Restart your terminal afterward.
2. Extract `Pip-Bot-Files.zip` and open the `Pip-Bot` folder.
3. In Windows File Explorer, turn on **View > Show > File name extensions** if needed. Rename `.env.example` to `.env` (not `.env.txt`). Open `.env` in Notepad.
4. Visit https://discord.com/developers/applications , open your existing application for **Pip**, go to **Bot**, and copy/reset the bot token. If you reset the token, the old one stops working.
5. Set `DISCORD_TOKEN=YOUR_REAL_TOKEN` inside `.env`. Never share this token or put it into the public code.
6. In the Developer Portal **Bot** page enable **Message Content Intent**. Configure **Guild Install** in **Installation**, with `bot` scope and **View Channels**, **Send Messages**, **Read Message History**, and **Add Reactions** permissions. Invite Pip to your server.
7. In the Pip-Bot folder, double-click `START-PIP-WINDOWS.bat`. On the first launch, it installs dependencies. Keep the window running while you want Pip online.

Alternative terminal commands (in the Pip-Bot folder):
```
npm install
npm start
```

## In Discord: Configure your channels
Make a **private staff-only** log channel, e.g. `#rp-audit-logs`, and an activity channel, e.g. `#activity-check`. Give Pip access to them and any RP channels it should scan. Then, as a server member with **Manage Server** permission, type these **in Discord**, not the Node.js terminal:
```
!rplogchannel #rp-audit-logs
!rpcheckchannel #activity-check
!rpadd #your-rp-channel
!rphours 48
!rplist
```
Members type `!rpcheck` in your activity check channel. Pip sends the log and reacts ✅ when the log is posted. Staff can type `!rplog @member` for a specific check.

Other commands: `!rpremove #channel`, `!rplist`, `!rphours 72`. If you want staff who do not have Manage Server to run audits, put those role IDs after `STAFF_ROLE_IDS=` in `.env`, comma-separated.

## Key information
- It checks recent message history in the *configured* channels at the time of a request, not every channel in your server.
- Reports contain timestamps, message counts and message links; the ✅ acknowledges that the log was posted, not that the member passed staff requirements.
- Monitored channels must be text channels (forum posts and threads are not scanned by this version).
- If there are more than 5,000 newer messages per monitored channel, the report is marked incomplete.
- Pip's server settings are automatically saved to `rpcheck-config.json` as you run commands.
- Do not make audit logs visible to everyone. Never publish your `.env` file.
- If the window closes or the computer is off, Pip goes offline. You'll need to host it if you want 24/7 uptime.

## If Pip does not respond
- Check that `npm start` is running and shows `Logged in as ...`.
- Enable Message Content Intent in Discord Developer Portal.
- Make sure Pip can **View Channel**, **Read Message History**, **Send Messages**, **Add Reactions** in its relevant channels.
- Check `.env` has the current token and is not named `.env.txt`.
