FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY agent ./agent
COPY prompts ./prompts
COPY public ./public
COPY server.mjs ./

RUN mkdir -p /app/data

ENV HOST=0.0.0.0
ENV PORT=5174

EXPOSE 5174

CMD ["node", "server.mjs"]
