# Store documents

| File | For |
|---|---|
| `MadLabsoiL-store-handover.pdf` | The owner: what you have, what to change first, how to run the store |
| `ADMIN_GUIDE.md` | The owner: every admin screen in plain English |
| `RUNBOOK.md` | Whoever maintains the server: deploy, roll back, backups, keys, Cloudflare, fixes |
| `SERVER_HARDENING.md` | How the server is locked down, and how to check it |
| `SECURITY_REPORT.md` | The security testing done, what was found and how it was fixed |

No passwords or keys are kept in this repository. Secrets live in `/etc/davmad-store/app.env`
on the server and in the owner's password manager.
