FROM node:22-alpine

RUN mkdir -p /data

COPY server.js /app/server.js

WORKDIR /app

ENV DATA_FILE=/data/loc.json
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
