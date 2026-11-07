# Dibs

Friends log in with a name and password, call dibs on my stuff, and bid against each other (minimum +€0.10) when more than one person wants the same item. I manage items at `/admin`. See `PLAN.md` for the design.

## Run locally

```sh
docker run -d --name dibs-pg -e POSTGRES_USER=dibs -e POSTGRES_PASSWORD=dibs -e POSTGRES_DB=dibs -p 5432:5432 postgres:17-alpine
cp .env.example .env
npm install
npm run dev          # http://localhost:3000, admin at /admin (any username, password from .env)
```

Tables are created automatically on startup.

## Deploy (Render + Neon)

1. Push this repo to GitHub.
2. In Render: **New → Blueprint** and pick the repo. It reads `render.yaml`.
3. Fill in `DATABASE_URL` (Neon connection string) and `ADMIN_PASSWORD`. `SESSION_SECRET` is generated for you.
4. Open `https://<app>.onrender.com/admin` and add items.

## Env vars

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `ADMIN_PASSWORD` | Password for `/admin` |
| `SESSION_SECRET` | Signs the login cookie. Changing it logs everyone out |
