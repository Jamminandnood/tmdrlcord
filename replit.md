# Workspace

## Overview

Real-time multi-user chat web application built in a pnpm workspace monorepo. The user-facing app is the `api-server` artifact, which serves a Discord-style dark-themed chat UI at `/` and uses Socket.io for real-time messaging.

## Features

- **Public chat room** — open to everyone connected
- **1:1 private DMs** — click any user in the sidebar to start a private conversation
- **Anonymous or named entry** — set a nickname or join anonymously
- **Browser notifications** — toggleable; honors `silent: true` for "무음 모드"
- **Typing indicators** for the public room
- **Live presence list** with unread badges per DM

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5 + Socket.io 4
- **Database**: PostgreSQL + Drizzle ORM (available; not used by chat — chat is in-memory)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: Plain HTML/CSS/JS served as static files from `artifacts/api-server/public/`

## Project Layout (chat-relevant)

- `artifacts/api-server/src/app.ts` — Express app: API routes, static file serving, SPA fallback
- `artifacts/api-server/src/index.ts` — HTTP server bootstrap + Socket.io attachment
- `artifacts/api-server/src/chat.ts` — Socket.io chat server (rooms, DMs, presence, typing)
- `artifacts/api-server/public/index.html` — chat UI markup (login screen + main app)
- `artifacts/api-server/public/style.css` — dark Discord-style theme
- `artifacts/api-server/public/app.js` — client-side chat logic (Socket.io client, notifications, channel switching)
- `artifacts/api-server/build.mjs` — esbuild bundle + copies `public/` into `dist/public/`

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run the chat server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
