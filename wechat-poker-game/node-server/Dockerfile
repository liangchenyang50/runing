FROM node:20-alpine

WORKDIR /app

COPY node-server/package.json ./node-server/package.json
RUN cd node-server && npm install --omit=dev

COPY js ./js
COPY preview ./preview
COPY node-server ./node-server

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["node", "node-server/server.mjs"]
