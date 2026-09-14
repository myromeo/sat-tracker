FROM node:18-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY app.js .

# Document the SBS TCP stream port
EXPOSE 30003

CMD ["node", "app.js"]
