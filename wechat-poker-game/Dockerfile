FROM node:20-alpine

WORKDIR /app

COPY . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["node", "preview/server.mjs"]
