# SOVEREIGN — Privacy Policy

**Last updated:** March 22, 2026

## Overview

SOVEREIGN is a geopolitical alpha trading pipeline desktop application. This policy explains what data is collected when you run the app, why it is collected, and how it is stored.

---

## What We Collect

When you launch the SOVEREIGN app, the following data is automatically recorded:

| Field | Description |
|---|---|
| **Timestamp** | Date and time of app launch (UTC) |
| **Session ID** | A randomly generated UUID stored on your machine. Cannot identify you personally. |
| **App Version** | The version of SOVEREIGN you are running |
| **Operating System** | Your OS type (`windows`, `macos`, or `linux`) — no version or hardware details |
| **IP Address** | Your public IP address, as seen by Google's servers |
| **Country / City** | Derived from your IP address via Google GeoIP |

---

## What We Do NOT Collect

- Your name, email, or any account information
- Hardware identifiers or device fingerprints
- Files, documents, or clipboard contents
- Keystrokes, mouse movements, or usage behaviour
- Financial data, trading activity, or API keys
- Any data beyond what is listed above

---

## Why We Collect It

| Field | Purpose |
|---|---|
| Timestamp | Understand when the app is used — peak hours, activity trends |
| Session ID | Count unique users accurately (distinguishes 100 users from 1 user launching 100 times) |
| App Version | Know if users are on outdated versions and when to push updates |
| OS | Ensure cross-platform compatibility and diagnose platform-specific issues |
| IP / Country / City | Understand the geographic distribution of users |

This is standard anonymous telemetry. The data is used solely to improve SOVEREIGN.

---

## How It Is Stored

- Data is sent via HTTPS to a Google Apps Script endpoint
- It is stored in a private Google Sheet accessible only to the developer
- Google retains raw HTTP request data per their [Privacy Policy](https://policies.google.com/privacy)
- No data is sold, shared, or disclosed to any third party

---

## Your Rights

- The Session ID is stored locally at `%APPDATA%\com.wardog.sovereign\session_id`
- You may delete this file at any time to reset your session ID
- No account is required to use SOVEREIGN — there is no mechanism to link your data to your identity

---

## Contact

For privacy questions or data removal requests, open an issue at:
**https://github.com/ravisahebstavan/sovereign-war-dogs/issues**

---

*SOVEREIGN is open-source software. This privacy policy applies to the official release builds published at github.com/ravisahebstavan/sovereign-war-dogs/releases.*
